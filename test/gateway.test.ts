import { describe, expect, it } from "vitest"
import { handleUpdate, handleWebhook, TEXT } from "../lib/intake/gateway"
import {
  BUSINESS_CONTACT, CHRIS, COACH, ENABLED_CHAT, STRANGER, WEBHOOK_SECRET, document, makeCtx, msg, photo, request, update,
} from "./helpers"

describe("webhook basics", () => {
  it("rejects a wrong or missing secret with 401 (T14)", async () => {
    const ctx = makeCtx()
    expect((await handleWebhook(request(update({}), "wrong"), ctx)).status).toBe(401)
    expect((await handleWebhook(request(update({}), null), ctx)).status).toBe(401)
    expect(ctx.telegram.sent).toHaveLength(0)
  })
  it("rejects non-POST with 405 and bad JSON with 400", async () => {
    const ctx = makeCtx()
    expect((await handleWebhook(request(null, WEBHOOK_SECRET, "GET"), ctx)).status).toBe(405)
    const bad = new Request("https://x.test/", { method: "POST", headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET }, body: "{" })
    expect((await handleWebhook(bad, ctx)).status).toBe(400)
  })
  it("de-dupes update_id so Telegram retries are not answered twice", async () => {
    const ctx = makeCtx()
    const u = update({ message: msg(CHRIS, { text: "hello" }) })
    await handleWebhook(request(u), ctx)
    await handleWebhook(request(u), ctx)
    expect(ctx.telegram.to(CHRIS)).toHaveLength(1)
    expect(ctx.logs.some((l) => l.outcome === "duplicate_ignored")).toBe(true)
  })
  it("returns 200 even when a handler throws", async () => {
    const ctx = makeCtx()
    ctx.telegram.sendMessage = async () => { throw new Error("boom") }
    const res = await handleWebhook(request(update({ message: msg(CHRIS, { text: "x" }) })), ctx)
    expect(res.status).toBe(200)
  })
  it("ignores edited messages (F5), groups and channels", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ edited_message: msg(CHRIS, { text: "edit" }) }), ctx)
    await handleUpdate(update({ message: { ...msg(CHRIS, { text: "in group" }), chat: { id: -100, type: "supergroup" } } }), ctx)
    await handleUpdate(update({ channel_post: msg(CHRIS, { text: "c" }) }), ctx)
    expect(ctx.telegram.sent).toHaveLength(0)
  })
  it("keeps the existing text reply but logs no text", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(CHRIS, { text: "secret plans 615-555-0199" }) }), ctx)
    expect(ctx.telegram.to(CHRIS)[0].text).toBe("Got it, Chris Magyar. Message logged.")
    const line = JSON.stringify(ctx.logs)
    expect(line).not.toContain("secret plans")
    expect(line).not.toContain(String(CHRIS))
    expect(ctx.logs.find((l) => l.event === "message")?.text_length).toBe(25)
  })
  it("legacy roster entries without user_id still get the text reply (safe to merge)", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: { ...msg(4444, { text: "hi" }), from: { id: 4444, username: "legacypal" } } }), ctx)
    expect(ctx.telegram.to(4444)[0].text).toBe("Got it, Legacy Pal. Message logged.")
  })
  it("refuses a non-roster DM once per day, then stays silent (T11)", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(STRANGER, { text: "hi" }) }), ctx)
    await handleUpdate(update({ message: msg(STRANGER, { photo: photo(ctx.telegram) }) }), ctx)
    expect(ctx.telegram.to(STRANGER).map((m) => m.text)).toEqual([TEXT.refusal])
    expect(ctx.google.files).toHaveLength(0)
    expect(await ctx.stores.queue.list()).toHaveLength(0)
    expect(await ctx.stores.pending.list()).toHaveLength(0)
  })
  it("a malformed roster fails closed with one alert to Chris", async () => {
    const ctx = makeCtx({ ROSTER_JSON: "{oops" })
    await handleUpdate(update({ message: msg(STRANGER, { text: "hi" }) }), ctx)
    await handleUpdate(update({ message: msg(CHRIS, { text: "hi" }) }), ctx)
    expect(ctx.telegram.to(STRANGER)).toHaveLength(0)
    expect(ctx.telegram.to(CHRIS)).toHaveLength(1)
    expect(ctx.telegram.to(CHRIS)[0].text).toContain("ROSTER_JSON")
  })
})

describe("kill switch (T17) and safe defaults", () => {
  it("INTAKE_ENABLED unset: photos get the paused line and nothing is queued", async () => {
    const ctx = makeCtx({ INTAKE_ENABLED: undefined })
    await handleUpdate(update({ message: msg(COACH, { photo: photo(ctx.telegram), caption: "#kraken who: Test Person drill" }) }), ctx)
    expect(ctx.telegram.to(COACH).map((m) => m.text)).toEqual([TEXT.paused])
    expect(await ctx.stores.queue.list()).toHaveLength(0)
    expect(ctx.kicks).toBe(0)
  })
  it("INTAKE_ENABLED=false: business messages are dropped completely", async () => {
    const ctx = makeCtx({ INTAKE_ENABLED: "false" })
    await handleUpdate(update({ business_message: msg(COACH, { photo: photo(ctx.telegram), business_connection_id: "bc" }, BUSINESS_CONTACT) }), ctx)
    expect(ctx.telegram.sent).toHaveLength(0)
    expect(ctx.logs).toHaveLength(0)
    expect(await ctx.stores.caps.list()).toHaveLength(0)
  })
  it("switch on but settings missing: paused, and Chris is told which names are missing", async () => {
    const ctx = makeCtx({ GOOGLE_OAUTH_REFRESH_TOKEN: undefined })
    await handleUpdate(update({ message: msg(COACH, { photo: photo(ctx.telegram) }) }), ctx)
    expect(ctx.telegram.to(COACH)[0].text).toBe(TEXT.paused)
    expect(ctx.telegram.to(CHRIS)[0].text).toContain("GOOGLE_OAUTH_REFRESH_TOKEN")
    expect(ctx.telegram.to(CHRIS)[0].text).not.toContain("rtoken")
  })
})

describe("Secretary Mode privacy filter (spec 3.1 rules 4-5, T12)", () => {
  it("(a) non-roster business sender: nothing downloaded, stored, replied or logged; only a counter", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ business_message: msg(STRANGER, { text: "private words", business_connection_id: "bc" }, STRANGER) }), ctx)
    await handleUpdate(update({ business_message: msg(STRANGER, { photo: photo(ctx.telegram), caption: "family pic", business_connection_id: "bc" }, STRANGER) }), ctx)
    expect(ctx.telegram.sent).toHaveLength(0)
    expect(ctx.logs).toHaveLength(0)
    expect(await ctx.stores.queue.list()).toHaveLength(0)
    expect(await ctx.stores.incoming.list()).toHaveLength(0)
    expect(await ctx.stores.caps.list()).toEqual(["daily/2026-10-10/ignored_business"])
  })
  it("(b) Chris's outgoing message in a non-enabled chat is ignored", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ business_message: msg(CHRIS, { photo: photo(ctx.telegram), business_connection_id: "bc" }, BUSINESS_CONTACT) }), ctx)
    expect(ctx.telegram.sent).toHaveLength(0)
    expect(await ctx.stores.queue.list()).toHaveLength(0)
  })
  it("(c) intake-enabled coach in a business chat: filed, ack goes to Chris's bot chat, never the business chat", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ business_message: msg(COACH, { photo: photo(ctx.telegram), caption: "who: Test Person drill #nominors", business_connection_id: "bc" }, COACH) }), ctx)
    expect(await ctx.stores.queue.list()).toHaveLength(1)
    expect(ctx.telegram.to(COACH)).toHaveLength(0)
    expect(ctx.telegram.to(CHRIS)[0].text).toBe("Got it: 1 photo from Mike for Kraken. Filing now.")
  })
  it("(d) Chris's outgoing photo in an enabled chat is filed", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ business_message: msg(CHRIS, { photo: photo(ctx.telegram), caption: "#tfc who: Chris Magyar range", business_connection_id: "bc" }, ENABLED_CHAT) }), ctx)
    expect(await ctx.stores.queue.list()).toHaveLength(1)
  })
  it("(e) business updates are parsed from update.business_message (F1); edits and deletes are ignored", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ edited_business_message: msg(COACH, { photo: photo(ctx.telegram) }, COACH) }), ctx)
    await handleUpdate(update({ deleted_business_messages: { chat: { id: 1 }, message_ids: [1] } }), ctx)
    expect(await ctx.stores.queue.list()).toHaveLength(0)
    expect(ctx.telegram.sent).toHaveLength(0)
  })
  it("business text from a roster coach gets no reply and no log", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ business_message: msg(COACH, { text: "see you at practice", business_connection_id: "bc" }, COACH) }), ctx)
    expect(ctx.telegram.sent).toHaveLength(0)
    expect(ctx.logs).toHaveLength(0)
  })
})

describe("media checks (spec 3.2, 10)", () => {
  it("refuses voice notes, stickers and PDFs politely (T7)", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(COACH, { voice: { file_id: "v" } }) }), ctx)
    await handleUpdate(update({ message: msg(COACH, { sticker: { file_id: "s" } }) }), ctx)
    await handleUpdate(update({ message: msg(COACH, { document: document(ctx.telegram, new Uint8Array(3), "application/pdf", "a.pdf") }) }), ctx)
    await handleUpdate(update({ message: msg(COACH, { animation: {}, document: document(ctx.telegram, new Uint8Array(3), "video/mp4", "a.gif.mp4") }) }), ctx)
    expect(ctx.telegram.to(COACH).map((m) => m.text)).toEqual(Array(4).fill(TEXT.unsupported))
    expect(await ctx.stores.queue.list()).toHaveLength(0)
  })
  it("refuses files over 20 MB with the size message (T6)", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(COACH, { video: { file_id: "big", file_unique_id: "bigu", width: 1, height: 1, duration: 60, file_size: 25 * 1024 * 1024, mime_type: "video/mp4" } }) }), ctx)
    expect(ctx.telegram.to(COACH)[0].text).toBe(TEXT.tooBig)
    expect(await ctx.stores.queue.list()).toHaveLength(0)
  })
  it("same photo twice: 'Already have that one' (T8)", async () => {
    const ctx = makeCtx()
    const p = photo(ctx.telegram)
    await handleUpdate(update({ message: msg(COACH, { photo: p, caption: "who: A B drill #nominors" }) }), ctx)
    await handleUpdate(update({ message: msg(COACH, { photo: p, caption: "who: A B drill #nominors" }) }), ctx)
    expect(ctx.telegram.to(COACH).map((m) => m.text)[1]).toBe(TEXT.duplicate)
    expect(await ctx.stores.queue.list()).toHaveLength(1)
  })
  it("daily cap: the fourth is refused when the cap is 3 (T9)", async () => {
    const ctx = makeCtx({ INTAKE_DEFAULT_DAILY_CAP: "3" })
    for (let i = 0; i < 4; i++) await handleUpdate(update({ message: msg(COACH, { photo: photo(ctx.telegram), caption: "who: A B drill #nominors" }) }), ctx)
    expect(await ctx.stores.queue.list()).toHaveLength(3)
    expect(ctx.telegram.to(COACH).at(-1)?.text).toBe(TEXT.userCap(3))
  })
  it("global cap pauses intake and tells Chris once", async () => {
    const ctx = makeCtx({ INTAKE_GLOBAL_DAILY_CAP: "1" })
    for (let i = 0; i < 3; i++) await handleUpdate(update({ message: msg(COACH, { photo: photo(ctx.telegram), caption: "who: A B x #nominors" }) }), ctx)
    expect(await ctx.stores.queue.list()).toHaveLength(1)
    expect(ctx.telegram.to(CHRIS).filter((m) => m.text.includes("overall daily limit"))).toHaveLength(1)
  })
  it("authorized but not intake-enabled senders get 'Photos aren't handled yet.'", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: { ...msg(4444, { photo: photo(ctx.telegram) }), from: { id: 4444, username: "legacypal" } } }), ctx)
    expect(ctx.telegram.to(4444)[0].text).toBe(TEXT.notHandled)
  })
})

describe("log hygiene (T15)", () => {
  it("no token, secret, caption text, phone number or chat id ever reaches the log", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(COACH, { photo: photo(ctx.telegram), caption: "who: Jo Lee call 615-555-0199 #nominors" }) }), ctx)
    await handleUpdate(update({ business_message: msg(STRANGER, { text: "personal", business_connection_id: "bc" }, STRANGER) }), ctx)
    await handleUpdate(update({ message: msg(CHRIS, { text: "my words" }) }), ctx)
    const all = JSON.stringify(ctx.logs)
    for (const bad of ["TEST-BOT-TOKEN", WEBHOOK_SECRET, "615-555", "Jo Lee", "personal", "my words", String(COACH), String(STRANGER), "api.telegram.org"]) {
      expect(all).not.toContain(bad)
    }
  })
  it("never sends anything with business_connection_id", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ business_message: msg(COACH, { photo: photo(ctx.telegram), business_connection_id: "bc" }, COACH) }), ctx)
    expect(JSON.stringify(ctx.telegram.sent)).not.toContain("business_connection_id")
  })
})

