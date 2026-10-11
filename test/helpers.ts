import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { IntakeContext } from "../lib/intake/context"
import type { GoogleClient, UploadInput } from "../lib/intake/google"
import { GoogleAuthError } from "../lib/intake/google"
import type { SafeLogFields } from "../lib/intake/log"
import type { SendOptions, TelegramClient } from "../lib/intake/telegram"
import type { TgMessage, TgUpdate } from "../lib/intake/types"
import { loadConfig } from "../lib/intake/config"
import { memoryStores } from "../lib/intake/store"

export const CHRIS = 1001
export const COACH = 2002
export const TFC_COACH = 3003
export const STRANGER = 9009
export const BUSINESS_CONTACT = 7007
export const ENABLED_CHAT = 5555
export const WEBHOOK_SECRET = "test-webhook-secret"
export const BOT_TOKEN = "123456:TEST-BOT-TOKEN"

export const ROSTER = [
  { name: "Chris Magyar", user_id: CHRIS, authorized: true, intake: true, role: "owner", default_project: null },
  { name: "Mike Ross", user_id: COACH, authorized: true, intake: true, role: "coach", default_project: "kraken", allowed_projects: ["kraken", "heroes"] },
  { name: "Tina Fey", user_id: TFC_COACH, authorized: true, intake: true, role: "coach", default_project: "tfc", allowed_projects: ["tfc"] },
  { name: "Legacy Pal", username: "legacypal", authorized: true },
]

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))))
}

export interface SentMessage { chatId: number; text: string; opts?: SendOptions }

export class FakeTelegram implements TelegramClient {
  sent: SentMessage[] = []
  answered: { id: string; text?: string }[] = []
  files = new Map<string, Uint8Array>()
  failGetFile = 0
  private n = 100
  async sendMessage(chatId: number, text: string, opts?: SendOptions) {
    this.sent.push({ chatId, text, opts })
    return { ok: true, messageId: ++this.n }
  }
  async answerCallbackQuery(id: string, text?: string) {
    this.answered.push({ id, text })
  }
  async getFile(fileId: string) {
    if (this.failGetFile > 0) { this.failGetFile--; throw Object.assign(new Error("x"), { code: "tg_api_error" }) }
    const bytes = this.files.get(fileId)
    if (!bytes) throw Object.assign(new Error("x"), { code: "tg_no_file_path" })
    return { filePath: `path/${fileId}`, fileSize: bytes.byteLength }
  }
  async downloadFile(filePath: string) {
    return this.files.get(filePath.replace("path/", ""))!
  }
  to(chatId: number) {
    return this.sent.filter((m) => m.chatId === chatId)
  }
}

export interface DriveFile { id: string; name: string; parentId: string; mimeType: string; bytes: Uint8Array; appProperties?: Record<string, string> }

export class FakeGoogle implements GoogleClient {
  files: DriveFile[] = []
  folders: { id: string; name: string; parentId?: string }[] = []
  rows: { sheet: string; tab: string; row: (string | number)[] }[] = []
  authError = false
  private n = 0
  private check() {
    if (this.authError) throw new GoogleAuthError("google_invalid_grant")
  }
  async findChild(parentId: string, name: string, foldersOnly = false) {
    this.check()
    const f = this.folders.find((x) => x.parentId === parentId && x.name === name)
    if (f) return f.id
    if (foldersOnly) return null
    return this.files.find((x) => x.parentId === parentId && x.name === name)?.id ?? null
  }
  async createFolder(name: string, parentId?: string) {
    this.check()
    const id = `folder${++this.n}`
    this.folders.push({ id, name, parentId })
    return id
  }
  async uploadFile(input: UploadInput) {
    this.check()
    const id = `file${++this.n}`
    this.files.push({ id, name: input.name, parentId: input.parentId, mimeType: input.mimeType, bytes: input.bytes, appProperties: input.appProperties })
    return { id, webViewLink: `https://drive.google.com/file/d/${id}/view` }
  }
  async createSpreadsheet() { return "sheet" }
  async moveToFolder() {}
  async appendRows(sheet: string, tab: string, rows: (string | number)[][]) {
    this.check()
    for (const row of rows) this.rows.push({ sheet, tab, row })
  }
  sidecarFor(mediaName: string): Record<string, any> {
    const base = mediaName.replace(/\.[^.]+$/, "")
    const f = this.files.find((x) => x.name === `${base}.json`)
    if (!f) throw new Error(`no sidecar for ${mediaName}`)
    return JSON.parse(new TextDecoder().decode(f.bytes))
  }
}

export const BASE_ENV: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ROSTER_JSON: JSON.stringify(ROSTER),
  CHRIS_TELEGRAM_USER_ID: String(CHRIS),
  INTAKE_ENABLED: "true",
  INTAKE_WORKER_SECRET: "worker-secret",
  GOOGLE_OAUTH_CLIENT_ID: "cid",
  GOOGLE_OAUTH_CLIENT_SECRET: "csecret",
  GOOGLE_OAUTH_REFRESH_TOKEN: "rtoken",
  DRIVE_FOLDER_HEROES: "F_HEROES",
  DRIVE_FOLDER_TFC: "F_TFC",
  DRIVE_FOLDER_KRAKEN: "F_KRAKEN",
  DRIVE_FOLDER_UNSORTED: "F_UNSORTED",
  INTAKE_LOG_SHEET_ID: "SHEET",
  INTAKE_ENABLED_CHAT_IDS: String(ENABLED_CHAT),
}

export interface TestCtx extends IntakeContext {
  telegram: FakeTelegram
  google: FakeGoogle
  logs: SafeLogFields[]
  clock: { t: number }
  kicks: number
}

export function makeCtx(envOverrides: Record<string, string | undefined> = {}): TestCtx {
  const env = { ...BASE_ENV, ...envOverrides }
  const clock = { t: Date.parse("2026-10-10T17:00:00Z") }
  const logs: SafeLogFields[] = []
  const ctx: TestCtx = {
    cfg: loadConfig((n) => env[n]),
    stores: memoryStores(),
    telegram: new FakeTelegram(),
    google: new FakeGoogle(),
    log: (f) => logs.push(f),
    logs,
    now: () => new Date(clock.t),
    sleep: async (ms) => { clock.t += ms },
    clock,
    kicks: 0,
    kickWorker: async () => { ctx.kicks++ },
  }
  return ctx
}

let updateId = 1
let messageId = 1

export function msg(from: number, extra: Partial<TgMessage> = {}, chatId = from): TgMessage {
  return { message_id: messageId++, date: Math.floor(Date.parse("2026-10-10T16:00:00Z") / 1000), chat: { id: chatId, type: "private" }, from: { id: from, first_name: "X" }, ...extra }
}

export function update(fields: Partial<TgUpdate>): TgUpdate {
  return { update_id: updateId++, ...fields }
}

let fileN = 1
export function photo(tg: FakeTelegram, bytes = fixture("exif-stripped.jpg")) {
  const id = `photo${fileN++}`
  tg.files.set(id, bytes)
  return [{ file_id: `${id}-small`, file_unique_id: `${id}-u-small`, width: 90, height: 90 }, { file_id: id, file_unique_id: `${id}-u`, width: 32, height: 24, file_size: bytes.byteLength }]
}

export function document(tg: FakeTelegram, bytes: Uint8Array, mime: string, name: string) {
  const id = `doc${fileN++}`
  tg.files.set(id, bytes)
  return { file_id: id, file_unique_id: `${id}-u`, file_name: name, mime_type: mime, file_size: bytes.byteLength }
}

export function request(body: unknown, secret: string | null = WEBHOOK_SECRET, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret
  return new Request("https://example.test/telegram-gateway", { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined })
}
