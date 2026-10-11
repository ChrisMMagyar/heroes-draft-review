// Roster parsing, numeric-id matching and capability tiers (one shared bot).
import type { IntakeConfig } from "./config"
import type { Project, SenderRef, TgUser } from "./types"
import { PROJECTS } from "./types"
import { slug } from "./naming"

export interface RosterEntry {
  name: string
  /** Numeric Telegram from.id. Required for intake. */
  user_id?: number
  /** Display only (legacy entries may still rely on it for plain text replies). */
  username?: string
  /** Stable roster key written to the log instead of the Telegram id. */
  key?: string
  authorized?: boolean
  intake?: boolean
  role?: "owner" | "coach"
  default_project?: Project | null
  allowed_projects?: Project[]
  daily_cap?: number
  is_minor?: boolean
}

export type Capability = "own_bio_proposal" | "photo_intake" | "doctrine_question" | "course_pdf"
export const COACH_CAPABILITIES: readonly Capability[] = [
  "own_bio_proposal", "photo_intake", "doctrine_question", "course_pdf",
]

export type RosterLoad = { ok: true; entries: RosterEntry[] } | { ok: false; error: string }

let cache: { raw: string | undefined; result: RosterLoad } | null = null

/** Parses and validates ROSTER_JSON once per cold start (re-parses only if the value changes). */
export function loadRoster(raw: string | undefined): RosterLoad {
  if (cache && cache.raw === raw) return cache.result
  const result = parseRoster(raw)
  cache = { raw, result }
  return result
}

export function parseRoster(raw: string | undefined): RosterLoad {
  if (raw === undefined || raw.trim() === "") return { ok: true, entries: [] }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: "roster_not_json" }
  }
  if (!Array.isArray(data)) return { ok: false, error: "roster_not_array" }
  const entries: RosterEntry[] = []
  for (const e of data) {
    if (!e || typeof e !== "object" || typeof (e as RosterEntry).name !== "string") {
      return { ok: false, error: "roster_entry_invalid" }
    }
    const entry = e as RosterEntry
    if (entry.user_id !== undefined && !Number.isSafeInteger(entry.user_id)) {
      return { ok: false, error: "roster_user_id_invalid" }
    }
    for (const p of [...(entry.allowed_projects ?? []), ...(entry.default_project ? [entry.default_project] : [])]) {
      if (!PROJECTS.includes(p)) return { ok: false, error: "roster_project_invalid" }
    }
    entries.push(entry)
  }
  return { ok: true, entries }
}

export function findByUserId(entries: RosterEntry[], userId: number): RosterEntry | undefined {
  return entries.find((e) => e.user_id === userId)
}

/**
 * Legacy username match, used ONLY for plain-text replies in the bot's private chat,
 * and only for entries that have no user_id yet. Both sides must be non-empty, which
 * fixes the old "undefined === undefined" bug (F4).
 */
export function findByUsername(entries: RosterEntry[], user: TgUser): RosterEntry | undefined {
  const u = user.username?.trim().toLowerCase()
  if (!u) return undefined
  return entries.find((e) => e.user_id === undefined && !!e.username && e.username.trim().toLowerCase() === u)
}

export function isOwner(entry: RosterEntry, cfg: IntakeConfig): boolean {
  return entry.role === "owner" || (cfg.chrisUserId !== null && entry.user_id === cfg.chrisUserId)
}

/** Owner gets everything; authorized coaches get the four coach capabilities; others none. */
export function capabilitiesFor(entry: RosterEntry | undefined, cfg: IntakeConfig): Set<Capability | "all"> {
  if (!entry || entry.authorized !== true) return new Set()
  if (isOwner(entry, cfg)) return new Set<Capability | "all">(["all", ...COACH_CAPABILITIES])
  return new Set(COACH_CAPABILITIES)
}

export function allowedProjects(entry: RosterEntry, cfg: IntakeConfig): Project[] {
  if (entry.allowed_projects && entry.allowed_projects.length > 0) return [...entry.allowed_projects]
  if (entry.default_project) return [entry.default_project]
  return isOwner(entry, cfg) ? [...PROJECTS] : []
}

/** "Intake-enabled roster entry": authorized, intake: true, photo_intake capability, numeric id, a project. */
export function isIntakeEnabled(entry: RosterEntry | undefined, cfg: IntakeConfig): entry is RosterEntry {
  if (!entry || entry.authorized !== true || entry.intake !== true) return false
  if (entry.user_id === undefined) return false
  if (!capabilitiesFor(entry, cfg).has("photo_intake")) return false
  return allowedProjects(entry, cfg).length > 0
}

export function rosterKey(entry: RosterEntry): string {
  return entry.key ?? (slug(entry.name) || "unnamed")
}

export function dailyCapFor(entry: RosterEntry, cfg: IntakeConfig): number {
  if (typeof entry.daily_cap === "number" && entry.daily_cap >= 0) return entry.daily_cap
  return isOwner(entry, cfg) ? cfg.ownerDailyCap : cfg.defaultDailyCap
}

export function senderRef(entry: RosterEntry, cfg: IntakeConfig): SenderRef {
  return { rosterKey: rosterKey(entry), name: entry.name, userId: entry.user_id ?? 0, isOwner: isOwner(entry, cfg) }
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}
