// Google Drive + Sheets over plain REST with an OAuth refresh token (drive.file scope).
// No Google SDK dependency. Errors carry short codes only, never URLs or tokens.

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"
const FOLDER_MIME = "application/vnd.google-apps.folder"

export class GoogleAuthError extends Error {
  constructor(public code = "google_auth_failed") {
    super(code)
  }
}

export class GoogleApiError extends Error {
  constructor(public code: string, public status?: number) {
    super(code)
  }
}

export interface UploadInput {
  name: string
  parentId: string
  mimeType: string
  bytes: Uint8Array
  appProperties?: Record<string, string>
}

export interface GoogleClient {
  findChild(parentId: string, name: string, foldersOnly?: boolean): Promise<string | null>
  createFolder(name: string, parentId?: string): Promise<string>
  uploadFile(input: UploadInput): Promise<{ id: string; webViewLink: string }>
  createSpreadsheet(title: string, tabs: { title: string; headers: string[] }[]): Promise<string>
  moveToFolder(fileId: string, folderId: string): Promise<void>
  appendRows(spreadsheetId: string, tab: string, rows: (string | number)[][]): Promise<void>
}

interface Credentials { clientId: string; clientSecret: string; refreshToken: string }

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

export function createGoogle(creds: Credentials, doFetch: typeof fetch = fetch): GoogleClient {
  let token: { value: string; expiresAt: number } | null = null

  async function accessToken(force = false): Promise<string> {
    if (!force && token && token.expiresAt > Date.now() + 60_000) return token.value
    let res: Response
    try {
      res = await doFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          refresh_token: creds.refreshToken,
        }),
      })
    } catch {
      throw new GoogleApiError("google_token_network_error")
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }
    if (!res.ok || !json.access_token) {
      if (json.error === "invalid_grant" || json.error === "invalid_client" || res.status === 401) {
        throw new GoogleAuthError(`google_${json.error ?? "unauthorized"}`)
      }
      throw new GoogleApiError("google_token_failed", res.status)
    }
    token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 }
    return token.value
  }

  async function request(url: string, init: RequestInit = {}, raw = false): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(init.headers)
      headers.set("authorization", `Bearer ${await accessToken(attempt > 0)}`)
      let res: Response
      try {
        res = await doFetch(url, { ...init, headers })
      } catch {
        throw new GoogleApiError("google_network_error")
      }
      if (res.status === 401 && attempt === 0) continue
      if (res.status === 401) throw new GoogleAuthError("google_unauthorized")
      if (!res.ok && !raw) throw new GoogleApiError("google_api_error", res.status)
      return res
    }
    throw new GoogleAuthError("google_unauthorized")
  }

  async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await request(url, init)
    return (await res.json()) as T
  }

  return {
    async findChild(parentId, name, foldersOnly = false) {
      const q = [`'${escapeQuery(parentId)}' in parents`, `name = '${escapeQuery(name)}'`, "trashed = false"]
      if (foldersOnly) q.push(`mimeType = '${FOLDER_MIME}'`)
      const params = new URLSearchParams({ q: q.join(" and "), fields: "files(id)", pageSize: "1", spaces: "drive" })
      const r = await json<{ files?: { id: string }[] }>(`https://www.googleapis.com/drive/v3/files?${params}`)
      return r.files?.[0]?.id ?? null
    },

    async createFolder(name, parentId) {
      const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME }
      if (parentId) body.parents = [parentId]
      const r = await json<{ id: string }>("https://www.googleapis.com/drive/v3/files?fields=id", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      return r.id
    },

    async uploadFile(input) {
      const meta: Record<string, unknown> = { name: input.name, parents: [input.parentId], mimeType: input.mimeType }
      if (input.appProperties) meta.appProperties = input.appProperties
      const start = await request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",
        {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-type": input.mimeType,
            "x-upload-content-length": String(input.bytes.byteLength),
          },
          body: JSON.stringify(meta),
        },
      )
      const location = start.headers.get("location")
      if (!location) throw new GoogleApiError("google_upload_no_session")
      let res: Response
      try {
        res = await doFetch(location, {
          method: "PUT",
          headers: { "content-type": input.mimeType, "content-length": String(input.bytes.byteLength) },
          body: input.bytes as Uint8Array<ArrayBuffer>,
        })
      } catch {
        throw new GoogleApiError("google_upload_network_error")
      }
      if (!res.ok) throw new GoogleApiError("google_upload_failed", res.status)
      const r = (await res.json()) as { id: string; webViewLink?: string }
      return { id: r.id, webViewLink: r.webViewLink ?? `https://drive.google.com/file/d/${r.id}/view` }
    },

    async createSpreadsheet(title, tabs) {
      const r = await json<{ spreadsheetId: string }>("https://sheets.googleapis.com/v4/spreadsheets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ properties: { title }, sheets: tabs.map((t) => ({ properties: { title: t.title } })) }),
      })
      await request(`https://sheets.googleapis.com/v4/spreadsheets/${r.spreadsheetId}/values:batchUpdate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          valueInputOption: "RAW",
          data: tabs.map((t) => ({ range: `'${t.title}'!A1`, values: [t.headers] })),
        }),
      })
      return r.spreadsheetId
    },

    async moveToFolder(fileId, folderId) {
      const cur = await json<{ parents?: string[] }>(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=parents`,
      )
      const params = new URLSearchParams({ addParents: folderId, fields: "id" })
      if (cur.parents?.length) params.set("removeParents", cur.parents.join(","))
      await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    },

    async appendRows(spreadsheetId, tab, rows) {
      const range = encodeURIComponent(`'${tab}'!A1`)
      await request(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: rows }) },
      )
    },
  }
}
