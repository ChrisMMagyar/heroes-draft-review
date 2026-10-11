// Turns received media into queued jobs: project mapping, one-question-at-a-time
// clarification (spec 5), timeouts, and the "Got it" acknowledgment.
import type { IntakeContext } from "./context"
import type { ParsedCaption } from "./caption"
import type { InlineButton } from "./telegram"
import type {
  ClarificationLogEntry, Destination, IntakeJob, IntakePath, MappingReason, MediaItem, MinorsAnswer,
  Project, Resolution, SenderRef,
} from "./types"
import { PROJECT_LABEL } from "./types"
import { decideMinors, decideProject, holdFor } from "./mapping"
import { firstName } from "./roster"
import { ctDate } from "./time"
import { ulid } from "./ulid"

export interface IntakeOrigin {
  path: IntakePath
  sender: SenderRef
  defaultProject: Project | null
  allowedProjects: Project[]
  isMinor: boolean
  /** Where acknowledgments and questions go (sender's bot chat, or Chris for business-path media). */
  replyChatId: number
  /** Telegram user id of whoever answers questions (the sender, or Chris). */
  answererId: number
}

export interface IncomingItem {
  item: MediaItem
  caption: ParsedCaption | null
  receivedAt: number
  origin: IntakeOrigin
}

export type Question = "project" | "person" | "minors"

export interface Draft {
  project: Destination | null
  mappingReason: MappingReason | null
  people: string[]
  personDone: boolean
  minors: MinorsAnswer | null
  clarifications: ClarificationLogEntry[]
}

export interface Pending {
  id: string
  key: string
  createdAt: number
  origin: IntakeOrigin
  items: MediaItem[]
  caption: ParsedCaption
  draft: Draft
  askReason: "missing" | "ambiguous" | "not_allowed" | null
  suggested: Project | null
  current: Question | null
  askedAt: number | null
  reminderSentAt: number | null
  questionMessageId: number | null
}

const EMPTY_CAPTION: ParsedCaption = { projects: [], people: [], description: "", date: null, minors: null, youthHint: false }

function pickCaption(items: IncomingItem[]): ParsedCaption {
  const withText = items.find((i) => i.caption && (i.caption.description || i.caption.projects.length || i.caption.people.length || i.caption.date || i.caption.minors))
  return withText?.caption ?? items.find((i) => i.caption)?.caption ?? EMPTY_CAPTION
}

export function nounFor(items: MediaItem[]): string {
  const n = items.length
  const videos = items.filter((i) => i.mediaType === "video").length
  const word = videos === 0 ? "photo" : videos === n ? "video" : "file"
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

function thisOrThese(items: MediaItem[]): string {
  return items.length === 1 ? "this" : `these ${nounFor(items)}`
}

function rosterEntryLike(origin: IntakeOrigin) {
  return { is_minor: origin.isMinor, default_project: origin.defaultProject, allowed_projects: origin.allowedProjects, name: origin.sender.name }
}

/** Fills in minors when it can be decided without asking; returns the next question or null. */
function advance(ctx: IntakeContext, p: Pick<Pending, "draft" | "caption" | "origin">): Question | null {
  const d = p.draft
  if (d.project === null) return "project"
  if (!d.personDone) return "person"
  if (d.minors === null) {
    const m = decideMinors(d.project, p.caption, rosterEntryLike(p.origin), ctx.cfg)
    if (m.kind === "ask") return "minors"
    d.minors = m.answer
  }
  return null
}

export async function startResolution(ctx: IntakeContext, items: IncomingItem[]): Promise<void> {
  const origin = items[0].origin
  const caption = pickCaption(items)
  const decision = decideProject(caption, rosterEntryLike(origin), ctx.cfg)
  const draft: Draft = {
    project: decision.kind === "resolved" ? decision.project : null,
    mappingReason: decision.kind === "resolved" ? decision.reason : null,
    people: [...caption.people],
    personDone: caption.people.length > 0 || !ctx.cfg.askPerson,
    minors: null,
    clarifications: [],
  }
  const media = items.map((i) => i.item)
  const id = ulid(ctx.now().getTime())
  const pending: Pending = {
    id,
    key: `${origin.answererId}/${id}`,
    createdAt: ctx.now().getTime(),
    origin,
    items: media,
    caption,
    draft,
    askReason: decision.kind === "ask" ? decision.reason : null,
    suggested: decision.kind === "ask" ? decision.suggested : null,
    current: null,
    askedAt: null,
    reminderSentAt: null,
    questionMessageId: null,
  }
  const next = advance(ctx, pending)
  if (next === null) {
    await finalize(ctx, pending, { ack: true, timedOut: false })
    return
  }
  pending.current = next
  await ctx.stores.pending.setJSON(pending.key, pending)
  const active = await activePending(ctx, origin.answererId)
  if (active && active.id === pending.id) await ask(ctx, pending)
}

/** The oldest open clarification for this answerer; later ones wait behind it. */
export async function activePending(ctx: IntakeContext, answererId: number): Promise<Pending | null> {
  const keys = await ctx.stores.pending.list(`${answererId}/`)
  if (keys.length === 0) return null
  return (await ctx.stores.pending.getJSON<Pending>(keys[0]))?.value ?? null
}

export function questionText(p: Pending): { text: string; buttons?: InlineButton[][] } {
  const prefix = p.origin.path === "business" ? `From ${firstName(p.origin.sender.name)}: ` : ""
  const cb = (q: string, v: string) => `${q}:${p.id}:${v}`
  if (p.current === "project") {
    const buttons = [[
      ...p.origin.allowedProjects.map((proj) => ({ text: PROJECT_LABEL[proj], callback_data: cb("p", proj) })),
      { text: "Not sure", callback_data: cb("p", "unsure") },
    ]]
    if (p.askReason === "not_allowed") {
      const set = p.origin.allowedProjects.map((x) => PROJECT_LABEL[x]).join(" and ")
      const suggest = PROJECT_LABEL[p.suggested ?? p.origin.allowedProjects[0]]
      return { text: `${prefix}You're set up for ${set}. File ${thisOrThese(p.items)} under ${suggest}?`, buttons }
    }
    const q = p.items.length === 1 ? "Which project is this for?" : `Which project are ${thisOrThese(p.items)} for?`
    return { text: prefix + q, buttons }
  }
  if (p.current === "person") return { text: `${prefix}Who's in it? Reply with a name, 'group', or 'skip'.` }
  return {
    text: `${prefix}Is anyone under 18 in ${thisOrThese(p.items)}?`,
    buttons: [[{ text: "Yes", callback_data: cb("m", "yes") }, { text: "No", callback_data: cb("m", "no") }]],
  }
}

async function ask(ctx: IntakeContext, p: Pending): Promise<void> {
  const q = questionText(p)
  const sent = await ctx.telegram.sendMessage(p.origin.replyChatId, q.text, q.buttons ? { buttons: q.buttons } : undefined)
  const now = ctx.now()
  p.askedAt = now.getTime()
  p.reminderSentAt = null
  p.questionMessageId = sent.messageId ?? null
  p.draft.clarifications.push({ question: p.current as Question, askedAt: now.toISOString() })
  await ctx.stores.pending.setJSON(p.key, p)
}

export function projectOptions(p: Pending): string[] {
  return [...p.origin.allowedProjects, "unsure"]
}

/** Records an answer and either asks the next question or files the items. */
export async function applyAnswer(ctx: IntakeContext, p: Pending, value: string): Promise<void> {
  const now = ctx.now()
  const last = p.draft.clarifications[p.draft.clarifications.length - 1]
  if (last && !last.answeredAt) {
    last.answer = value
    last.answeredAt = now.toISOString()
  }
  const d = p.draft
  if (p.current === "project") {
    if (value === "unsure") {
      d.project = "unsorted"
      d.mappingReason = "not_sure"
      d.personDone = true
      d.minors = "not_asked"
    } else {
      d.project = value as Project
      d.mappingReason = "clarified"
    }
  } else if (p.current === "person") {
    const v = value.trim()
    if (/^skip$/i.test(v)) d.people = []
    else if (/^group$/i.test(v)) d.people = ["Group"]
    else d.people = v.split(/\s*(?:,|;|&|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean).slice(0, 10)
    d.personDone = true
  } else if (p.current === "minors") {
    d.minors = value === "yes" ? "yes" : "no"
  }
  const next = advance(ctx, p)
  if (next === null) {
    await finalize(ctx, p, { ack: true, timedOut: false })
    await activateNext(ctx, p.origin.answererId)
    return
  }
  p.current = next
  await ask(ctx, p)
}

export async function activateNext(ctx: IntakeContext, answererId: number): Promise<void> {
  const next = await activePending(ctx, answererId)
  if (next && next.askedAt === null) await ask(ctx, next)
}

/** 24-hour timeout: file with what is known (spec 5.2). An unanswered minors question means held. */
export async function timeoutPending(ctx: IntakeContext, p: Pending): Promise<void> {
  const d = p.draft
  if (d.project === null) {
    d.project = "unsorted"
    d.mappingReason = "timeout"
  }
  d.personDone = true
  if (d.minors === null) {
    const m = decideMinors(d.project, p.caption, rosterEntryLike(p.origin), ctx.cfg)
    d.minors = m.kind === "ask" || p.current === "minors" ? "unknown" : m.answer
  }
  await finalize(ctx, p, { ack: false, timedOut: true })
  await activateNext(ctx, p.origin.answererId)
}

export function reminderText(p: Pending): string {
  if (p.current === "project") return `Still need to know which project ${thisOrThese(p.items)} ${p.items.length === 1 ? "is" : "are"} for.`
  return `Still need an answer: ${questionText(p).text}`
}

export interface GroupMeta {
  size: number
  project: Destination
  hold: boolean
  path: IntakePath
  replyChatId: number
  senderName: string
  senderIsOwner: boolean
}

async function finalize(ctx: IntakeContext, p: Pending, opts: { ack: boolean; timedOut: boolean }): Promise<void> {
  const d = p.draft
  const now = ctx.now()
  const project: Destination = d.project ?? "unsorted"
  const minors: MinorsAnswer = d.minors ?? "not_asked"
  const hold = holdFor(minors)
  const caption = p.caption
  const firstItem = p.items[0]
  const resolution: Resolution = {
    project,
    mappingReason: d.mappingReason ?? "timeout",
    rosterProject: p.origin.defaultProject,
    captionProject: caption.projects.length === 1 ? caption.projects[0] : null,
    people: d.people,
    description: caption.description,
    photoDate: caption.date ?? ctDate(new Date(firstItem.date * 1000)),
    minorsAnswer: minors,
    consentStatus: hold ? "pending" : "n/a",
    hold,
    clarifications: d.clarifications,
    timedOut: opts.timedOut,
  }
  const groupId = ulid(now.getTime())
  const meta: GroupMeta = {
    size: p.items.length,
    project,
    hold,
    path: p.origin.path,
    replyChatId: p.origin.replyChatId,
    senderName: p.origin.sender.name,
    senderIsOwner: p.origin.sender.isOwner,
  }
  await ctx.stores.groups.setJSON(`${groupId}/meta`, meta)
  const ordered = [...p.items].sort((a, b) => a.messageId - b.messageId)
  for (let i = 0; i < ordered.length; i++) {
    const key = ulid(now.getTime())
    const job: IntakeJob = {
      intakeId: `INT-${key}`,
      key,
      createdAt: now.toISOString(),
      attempts: 0,
      nextAttemptAt: now.getTime(),
      path: p.origin.path,
      sender: p.origin.sender,
      replyChatId: p.origin.replyChatId,
      item: ordered[i],
      resolution,
      group: { id: groupId, size: ordered.length, index: ordered.length > 1 ? i + 1 : 0 },
      progress: {},
    }
    await ctx.stores.queue.setJSON(key, job)
  }
  await ctx.stores.pending.delete(p.key)
  ctx.log({ event: "intake_queued", sender: p.origin.sender.rosterKey, path: p.origin.path, count: p.items.length, status: hold ? "held_minor" : project })
  if (opts.ack) await ctx.telegram.sendMessage(p.origin.replyChatId, ackText(meta, p.items))
  await ctx.kickWorker()
}

export function ackText(meta: GroupMeta, items: MediaItem[]): string {
  const label = PROJECT_LABEL[meta.project]
  const held = meta.hold ? ", held until consent is recorded" : ""
  if (meta.path === "business") {
    return `Got it: ${nounFor(items)} from ${firstName(meta.senderName)} for ${label}${held}. Filing now.`
  }
  return `Got it, ${firstName(meta.senderName)}: ${nounFor(items)} for ${label}${held}. Filing now.`
}

