// The Telegram webhook (spec 3.1). Order: secret -> update_id de-dupe -> privacy
// filter -> classify -> intake / clarification / existing text reply.
import type { IntakeContext } from "./context"
import type { IntakeOrigin, IncomingItem, Pending } from "./resolve"
import type { RosterEntry } from "./roster"
import type { MediaItem, TgCallbackQuery, TgMessage, TgUpdate } from "./types"
import { intakeReady, missingIntakeSettings } from "./config"
import { parseCaption } from "./caption"
import { extractMedia } from "./media"
import { tellChrisOnce } from "./notify"
import { redact } from "./redact"
import { activePending, applyAnswer, projectOptions, questionText, startResolution } from "./resolve"
import {
  allowedProjects, dailyCapFor, findByUserId, findByUsername, isIntakeEnabled, loadRoster, senderRef,
} from "./roster"
import { safeEqual } from "./secure"
import { bumpDaily, fileSeenRecently, markFileSeen, markUpdateSeen, oncePerDay, reserveCaps } from "./state"
import { ulid } from "./ulid"

export const TEXT = {
  refusal: "Sorry, you're not on the authorized list.",
  notHandled: "Photos aren't handled yet.",
  paused: "Photo intake is paused.",
  unsupported: "I only take photos and videos right now.",
  tooBig: "That file is over 20 MB, so I can't pull it from Telegram. Please send a shorter clip, or ask Chris for a Drive upload link.",
  duplicate: "Already have that one.",
  userCap: (n: number) => `You've hit today's limit of ${n}. Send the rest tomorrow.`,
  globalCap: "Photo intake has hit today's overall limit. Send the rest tomorrow.",
  expired: "That question has expired.",
  tapButton: "Please tap one of the buttons.",
} as const

export const SECRET_HEADER = "x-telegram-bot-api-secret-token"

export async function handleWebhook(req: Request, ctx: IntakeContext): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 })
  if (!safeEqual(req.headers.get(SECRET_HEADER), ctx.cfg.webhookSecret)) {
    return new Response("unauthorized", { status: 401 })
  }
  let update: TgUpdate
  try {
    update = (await req.json()) as TgUpdate
  } catch {
    return new Response("bad request", { status: 400 })
  }
  try {
    await handleUpdate(update, ctx)
  } catch (e) {
    // Always 200 so Telegram doesn't re-send (and re-answer) the same update.
    ctx.log({ event: "update", outcome: "error", error_code: e instanceof Error ? e.constructor.name : "unknown" })
  }
  return new Response("ok")
}

export function updateKind(u: TgUpdate): string {
  for (const k of [
    "message", "edited_message", "business_message", "edited_business_message", "deleted_business_messages",
    "callback_query", "channel_post", "edited_channel_post", "business_connection", "my_chat_member",
  ]) if (u[k] !== undefined) return k
  return "other"
}

export async function handleUpdate(update: TgUpdate, ctx: IntakeContext): Promise<void> {
  if (typeof update?.update_id !== "number") return
  const fresh = await markUpdateSeen(ctx.stores, update.update_id, ctx.now()).catch(() => true)
  if (!fresh) {
    ctx.log({ event: "update", outcome: "duplicate_ignored" })
    return
  }
  const kind = updateKind(update)

  // Business updates are filtered before anything else touches them (spec 3.1 rules 4-5, 9.2).
  if (kind === "business_message") return handleBusinessMessage(update.business_message as TgMessage, update.update_id, ctx)
  if (kind === "edited_business_message" || kind === "deleted_business_messages" || kind === "business_connection") return

  const roster = loadRoster(ctx.cfg.rosterJson)
  if (!roster.ok) {
    await tellChrisOnce(ctx, "roster_invalid", "The gateway can't read ROSTER_JSON, so it is ignoring everyone until that's fixed.")
    ctx.log({ event: "update", outcome: "roster_invalid", error_code: roster.error })
    return
  }
  if (kind === "message") return handlePrivateMessage(update.message as TgMessage, update.update_id, roster.entries, ctx)
  if (kind === "callback_query") return handleCallback(update.callback_query as TgCallbackQuery, roster.entries, ctx)
  // edited_message, channel posts, member updates and anything else: ignored (F5).
  ctx.log({ event: "update", update_kind: kind, outcome: "ignored" })
}

function originFor(entry: RosterEntry, ctx: IntakeContext, path: "bot_dm" | "business"): IntakeOrigin {
  const sender = senderRef(entry, ctx.cfg)
  const chris = ctx.cfg.chrisUserId as number
  return {
    path,
    sender,
    defaultProject: entry.default_project ?? null,
    allowedProjects: allowedProjects(entry, ctx.cfg),
    isMinor: entry.is_minor === true,
    replyChatId: path === "business" ? chris : sender.userId,
    answererId: path === "business" ? chris : sender.userId,
  }
}

async function handlePrivateMessage(msg: TgMessage, updateId: number, entries: RosterEntry[], ctx: IntakeContext): Promise<void> {
  if (msg.chat?.type !== "private") {
    ctx.log({ event: "message", outcome: "non_private_ignored" })
    return
  }
  const from = msg.from
  if (!from || from.is_bot) return
  const byId = findByUserId(entries, from.id)
  const person = byId ?? (ctx.cfg.legacyUsernameMatch ? findByUsername(entries, from) : undefined)

  if (person?.authorized !== true) {
    // Refuse once per user per day, then stay silent. No download, no storage of content.
    if (await oncePerDay(ctx.stores, "refusal", from.id, ctx.now()).catch(() => false)) {
      await ctx.telegram.sendMessage(msg.chat.id, TEXT.refusal)
    }
    ctx.log({ event: "message", outcome: "refused" })
    return
  }

  const media = extractMedia(msg, updateId)
  if (media.kind !== "none") {
    if (!byId || !isIntakeEnabled(byId, ctx.cfg)) {
      await ctx.telegram.sendMessage(msg.chat.id, TEXT.notHandled)
      return
    }
    if (!intakeReady(ctx.cfg)) {
      await ctx.telegram.sendMessage(msg.chat.id, TEXT.paused)
      if (ctx.cfg.intakeEnabled) {
        await tellChrisOnce(ctx, "settings_missing", `Photo intake is switched on but missing settings: ${missingIntakeSettings(ctx.cfg).join(", ")}.`)
      }
      return
    }
    if (media.kind === "unsupported") {
      await ctx.telegram.sendMessage(msg.chat.id, TEXT.unsupported)
      await bumpDaily(ctx.stores, "rejected_unsupported", ctx.now())
      return
    }
    await acceptMedia(ctx, originFor(byId, ctx, "bot_dm"), byId, media.item, msg.caption)
    return
  }

  if (byId && msg.text !== undefined && intakeReady(ctx.cfg) && isIntakeEnabled(byId, ctx.cfg)) {
    if (await handleTextAnswer(ctx, byId.user_id as number, msg)) return
  }

  ctx.log({
    event: "message",
    sender: senderRef(person, ctx.cfg).rosterKey,
    intent: "unclassified",
    outcome: "received",
    text_length: (msg.text ?? "").length,
    received_at: ctx.now().toISOString(),
    message_date: new Date(msg.date * 1000).toISOString(),
  })
  await ctx.telegram.sendMessage(msg.chat.id, `Got it, ${person.name}. Message logged.`)
}

async function handleBusinessMessage(msg: TgMessage, updateId: number, ctx: IntakeContext): Promise<void> {
  // Secretary Mode privacy filter. Never replies in a business chat, never logs
  // content or identity for anything that isn't intake.
  if (!intakeReady(ctx.cfg)) return
  if (msg?.chat?.type !== "private" || !msg.from) return
  const roster = loadRoster(ctx.cfg.rosterJson)
  if (!roster.ok) return
  const chris = ctx.cfg.chrisUserId as number
  let entry: RosterEntry | undefined
  if (msg.from.id === chris) {
    // Rule 4: Chris's own outgoing message. Only chats he listed count.
    if (!ctx.cfg.enabledChatIds.has(msg.chat.id)) return
    entry = findByUserId(roster.entries, chris)
    if (!isIntakeEnabled(entry, ctx.cfg)) return
  } else {
    // Rule 5: anyone who isn't an intake-enabled roster entry is dropped silently.
    entry = findByUserId(roster.entries, msg.from.id)
    if (!isIntakeEnabled(entry, ctx.cfg)) {
      await bumpDaily(ctx.stores, "ignored_business", ctx.now())
      return
    }
  }
  const media = extractMedia(msg, updateId)
  if (media.kind !== "ok") return
  await acceptMedia(ctx, originFor(entry, ctx, "business"), entry, media.item, msg.caption)
}

async function acceptMedia(
  ctx: IntakeContext,
  origin: IntakeOrigin,
  entry: RosterEntry,
  item: Omit<MediaItem, "captionRedacted">,
  rawCaption: string | undefined,
): Promise<void> {
  const now = ctx.now()
  const business = origin.path === "business"
  const toReply = (text: string) => ctx.telegram.sendMessage(origin.replyChatId, text)
  const who = business ? `${origin.sender.name}: ` : ""

  if (item.fileSize !== null && item.fileSize > ctx.cfg.maxBytes) {
    await toReply(who + TEXT.tooBig)
    await bumpDaily(ctx.stores, "rejected_too_large", now)
    return
  }
  if (await fileSeenRecently(ctx.stores, origin.sender.rosterKey, item.fileUniqueId, now)) {
    if (!business) await toReply(TEXT.duplicate)
    await bumpDaily(ctx.stores, "rejected_duplicate", now)
    return
  }
  const userCap = dailyCapFor(entry, ctx.cfg)
  const cap = await reserveCaps(ctx.stores, origin.sender.rosterKey, userCap, ctx.cfg.globalDailyCap, now)
  if (cap !== "ok") {
    await bumpDaily(ctx.stores, "cap_hits", now)
    if (cap === "user_cap") {
      if (business) await tellChrisOnce(ctx, `user_cap_${origin.sender.rosterKey}`, `${origin.sender.name} hit today's photo limit of ${userCap}.`)
      else await toReply(TEXT.userCap(userCap))
    } else {
      if (!business) await toReply(TEXT.globalCap)
      await tellChrisOnce(ctx, "global_cap", `Photo intake hit the overall daily limit of ${ctx.cfg.globalDailyCap} and is paused until tomorrow.`)
    }
    return
  }
  await markFileSeen(ctx.stores, origin.sender.rosterKey, item.fileUniqueId, now)

  const caption = rawCaption ? parseCaption(rawCaption, now) : null
  const incoming: IncomingItem = {
    item: { ...item, captionRedacted: rawCaption ? redact(rawCaption) : "" },
    caption,
    receivedAt: now.getTime(),
    origin,
  }
  if (item.mediaGroupId) {
    // Albums arrive as separate messages; the worker groups them after a short settle time.
    const groupKey = `${origin.answererId}:${origin.sender.userId}:${item.mediaGroupId}`
    await ctx.stores.incoming.setJSON(`${groupKey}/${ulid(now.getTime())}`, incoming)
    await ctx.kickWorker()
    return
  }
  await startResolution(ctx, [incoming])
}

// ---- Clarification answers ----

const CALLBACK = /^([pm]):([0-9A-HJKMNP-TV-Z]{26}):([a-z]+)$/

async function handleCallback(cq: TgCallbackQuery, entries: RosterEntry[], ctx: IntakeContext): Promise<void> {
  const m = cq.data?.match(CALLBACK)
  if (!m) {
    await ctx.telegram.answerCallbackQuery(cq.id)
    return
  }
  if (!intakeReady(ctx.cfg)) {
    await ctx.telegram.answerCallbackQuery(cq.id, TEXT.paused)
    return
  }
  const entry = findByUserId(entries, cq.from.id)
  if (!entry || entry.authorized !== true) {
    await ctx.telegram.answerCallbackQuery(cq.id)
    return
  }
  const [, kind, id, value] = m
  const pending = (await ctx.stores.pending.getJSON<Pending>(`${cq.from.id}/${id}`))?.value
  const expected = kind === "p" ? "project" : "minors"
  const options = pending ? (kind === "p" ? projectOptions(pending) : ["yes", "no"]) : []
  if (!pending || pending.current !== expected || pending.askedAt === null || !options.includes(value)) {
    await ctx.telegram.answerCallbackQuery(cq.id, TEXT.expired)
    return
  }
  await ctx.telegram.answerCallbackQuery(cq.id)
  await applyAnswer(ctx, pending, value)
}

const LABEL_TO_OPTION: Record<string, string> = {
  heroes: "heroes", tfc: "tfc", firearms: "tfc", kraken: "kraken", kc: "kraken",
  "not sure": "unsure", unsure: "unsure", "?": "unsure", yes: "yes", y: "yes", no: "no", n: "no",
}

/** Text fallback for questions: a name for "who", or "1/2/3" or a label for button questions. */
async function handleTextAnswer(ctx: IntakeContext, userId: number, msg: TgMessage): Promise<boolean> {
  const p = await activePending(ctx, userId)
  if (!p || p.askedAt === null || p.current === null) return false
  const text = (msg.text ?? "").trim()
  if (p.current === "person") {
    if (!text) return false
    await applyAnswer(ctx, p, text)
    return true
  }
  const options = p.current === "project" ? projectOptions(p) : ["yes", "no"]
  const n = Number(text)
  const choice = Number.isInteger(n) && n >= 1 && n <= options.length
    ? options[n - 1]
    : LABEL_TO_OPTION[text.toLowerCase()]
  if (choice && options.includes(choice)) {
    await applyAnswer(ctx, p, choice)
    return true
  }
  if (msg.reply_to_message && msg.reply_to_message.message_id === p.questionMessageId) {
    const q = questionText(p)
    await ctx.telegram.sendMessage(p.origin.replyChatId, TEXT.tapButton, q.buttons ? { buttons: q.buttons } : undefined)
    return true
  }
  return false
}

