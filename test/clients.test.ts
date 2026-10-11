import { describe, expect, it } from "vitest"
import type { SafeLogFields } from "../lib/intake/log"
import { changeRequestRow, completionReplyText, newChangeRequest, replyTarget } from "../lib/intake/changeRequests"
import { GoogleAuthError, createGoogle } from "../lib/intake/google"
import { CHANGE_REQUEST_COLUMNS, INTAKE_COLUMNS } from "../lib/intake/sheet"
import { createTelegram } from "../lib/intake/telegram"
import { BOT_TOKEN } from "./helpers"

type Call = { url: string; init?: RequestInit }

function fakeFetch(responses: (Response | Error)[], calls: Call[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = responses.shift()
    if (!r) throw new Error("no more responses")
    if (r instanceof Error) throw r
    return r
  }) as typeof fetch
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

describe("Telegram client", () => {
  it("honours one 429 retry_after, then succeeds", async () => {
    const calls: Call[] = []
    const slept: number[] = []
    const tg = createTelegram({
      token: BOT_TOKEN, log: () => {}, sleep: async (ms) => { slept.push(ms) },
      fetch: fakeFetch([json({ ok: false, parameters: { retry_after: 2 } }, 429), json({ ok: true, result: { message_id: 7 } })], calls),
    })
    expect(await tg.sendMessage(1, "hi")).toEqual({ ok: true, messageId: 7 })
    expect(slept).toEqual([2000])
    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ chat_id: 1, text: "hi" })
  })
  it("does not wait for a long retry_after; failures are logged without the token or URL", async () => {
    const logs: SafeLogFields[] = []
    const tg = createTelegram({ token: BOT_TOKEN, log: (f) => logs.push(f), maxRetryAfterS: 3, fetch: fakeFetch([json({ ok: false, parameters: { retry_after: 60 } }, 429)], []) })
    expect(await tg.sendMessage(1, "hi")).toEqual({ ok: false })
    expect(logs[0]).toMatchObject({ event: "telegram_send", outcome: "failed", error_code: "tg_rate_limited", http_status: 429 })
    expect(JSON.stringify(logs)).not.toContain(BOT_TOKEN)
  })
  it("network errors and 403s never throw from sendMessage", async () => {
    const tg = createTelegram({ token: BOT_TOKEN, log: () => {}, fetch: fakeFetch([new Error("net"), json({ ok: false }, 403)], []) })
    expect(await tg.sendMessage(1, "a")).toEqual({ ok: false })
    expect(await tg.sendMessage(1, "b")).toEqual({ ok: false })
  })
  it("inline buttons go out as reply_markup", async () => {
    const calls: Call[] = []
    const tg = createTelegram({ token: BOT_TOKEN, log: () => {}, fetch: fakeFetch([json({ ok: true, result: { message_id: 1 } })], calls) })
    await tg.sendMessage(1, "q", { buttons: [[{ text: "Yes", callback_data: "m:x:yes" }]] })
    expect(JSON.parse(String(calls[0].init?.body)).reply_markup).toEqual({ inline_keyboard: [[{ text: "Yes", callback_data: "m:x:yes" }]] })
  })
  it("getFile + download; errors carry codes, not URLs", async () => {
    const calls: Call[] = []
    const tg = createTelegram({ token: BOT_TOKEN, log: () => {}, fetch: fakeFetch([json({ ok: true, result: { file_path: "photos/a.jpg", file_size: 3 } }), new Response(new Uint8Array([1, 2, 3]))], calls) })
    expect(await tg.getFile("F")).toEqual({ filePath: "photos/a.jpg", fileSize: 3 })
    expect(await tg.downloadFile("photos/a.jpg")).toEqual(new Uint8Array([1, 2, 3]))
    const bad = createTelegram({ token: BOT_TOKEN, log: () => {}, fetch: fakeFetch([new Response("", { status: 404 })], []) })
    await expect(bad.downloadFile("x")).rejects.toMatchObject({ code: "tg_download_failed" })
    await expect(bad.downloadFile("x")).rejects.not.toHaveProperty("message", expect.stringContaining(BOT_TOKEN))
  })
})

describe("Google client", () => {
  const creds = { clientId: "c", clientSecret: "s", refreshToken: "r" }
  it("refreshes the token once and does a resumable upload", async () => {
    const calls: Call[] = []
    const g = createGoogle(creds, fakeFetch([
      json({ access_token: "AT", expires_in: 3600 }),
      new Response(null, { status: 200, headers: { location: "https://upload.example/session1" } }),
      json({ id: "FILE1", webViewLink: "https://drive.google.com/file/d/FILE1/view" }),
      json({ files: [] }),
    ], calls))
    const r = await g.uploadFile({ name: "a.jpg", parentId: "P", mimeType: "image/jpeg", bytes: new Uint8Array([9, 9]), appProperties: { intake_id: "INT-1" } })
    expect(r.id).toBe("FILE1")
    expect(String(calls[0].init?.body)).toContain("grant_type=refresh_token")
    expect(calls[1].url).toContain("uploadType=resumable")
    expect(new Headers(calls[1].init?.headers).get("authorization")).toBe("Bearer AT")
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ name: "a.jpg", parents: ["P"], appProperties: { intake_id: "INT-1" } })
    expect(calls[2]).toMatchObject({ url: "https://upload.example/session1" })
    expect(calls[2].init?.method).toBe("PUT")
    await g.findChild("P", "it's.jpg")
    expect(new URL(calls[3].url).searchParams.get("q")).toContain("name = 'it\\'s.jpg'")
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1)
  })
  it("invalid_grant (revoked or expired grant) raises GoogleAuthError", async () => {
    const g = createGoogle(creds, fakeFetch([json({ error: "invalid_grant" }, 400)], []))
    await expect(g.appendRows("S", "Intake", [["a"]])).rejects.toBeInstanceOf(GoogleAuthError)
  })
  it("a 401 refreshes once, then gives up with GoogleAuthError", async () => {
    const g = createGoogle(creds, fakeFetch([json({ access_token: "A1" }), new Response("", { status: 401 }), json({ access_token: "A2" }), new Response("", { status: 401 })], []))
    await expect(g.createFolder("x")).rejects.toBeInstanceOf(GoogleAuthError)
  })
  it("appends rows to a quoted tab range with RAW input", async () => {
    const calls: Call[] = []
    const g = createGoogle(creds, fakeFetch([json({ access_token: "AT" }), json({})], calls))
    await g.appendRows("SHEET", "Change Requests", [["a", 1]])
    expect(decodeURIComponent(calls[1].url)).toContain("/SHEET/values/'Change Requests'!A1:append?valueInputOption=RAW")
  })
})

describe("log sheet layout", () => {
  it("has the spec 8 + 8A columns and never a coordinate column", () => {
    for (const c of ["intake_id", "handoff_status", "metadata_source", "gps_present", "sidecar_link", "metadata_error"]) expect(INTAKE_COLUMNS).toContain(c)
    expect(INTAKE_COLUMNS.some((c) => /lat|lon|gps_(lat|lon)|coord/.test(c))).toBe(false)
  })
})

describe("webpage change requests (spec 11A, data structures only)", () => {
  it("creates a tracked request with a CR- id and a redacted request text", () => {
    const cr = newChangeRequest({
      receivedAtCt: "2026-10-11 08:00:00", requesterRosterId: "mike-ross", requesterName: "Mike Ross", requesterUserId: 2002,
      channel: "telegram_business", chatRef: "abc", project: "kraken", originalRequest: "update my bio, call 615-555-0199",
    })
    expect(cr.trackingId).toMatch(/^CR-[0-9A-Z]{26}$/)
    expect(cr.status).toBe("received")
    expect(cr.originalRequest).not.toContain("555")
    expect(changeRequestRow(cr)).toHaveLength(CHANGE_REQUEST_COLUMNS.length)
    // Business-chat requests are answered in the requester's private bot chat, never the business chat.
    expect(replyTarget(cr)).toEqual({ via: "telegram", chatId: 2002 })
    expect(replyTarget({ ...cr, channel: "email" })).toEqual({ via: "human_connector" })
  })
  it("reply wording: live link, password-protected note (no password), declined, held", () => {
    expect(completionReplyText("your bio update", { kind: "published", pageUrl: "https://x.test/p", passwordProtected: false })).toBe("Your bio update is live: https://x.test/p")
    expect(completionReplyText("your bio update", { kind: "published", pageUrl: "https://k.test/p", passwordProtected: true, siteName: "Kraken draft" }))
      .toBe("Your bio update is on the Kraken draft site, which isn't public yet: https://k.test/p")
    expect(completionReplyText("your bio update", { kind: "declined" })).toBe("Your bio update wasn't made. Chris has the details.")
    expect(completionReplyText("your bio update", { kind: "held" })).toBe("Your bio update is waiting on review.")
  })
})
