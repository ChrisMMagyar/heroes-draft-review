// Reads every setting from environment variables, with the spec's recommended
// defaults. Values marked "pending Chris's confirmation" in the PR are here.
import type { Project } from "./types"
import { PROJECTS } from "./types"

export type EnvSource = (name: string) => string | undefined

export interface IntakeConfig {
  /** Kill switch. Intake only runs when INTAKE_ENABLED is exactly "true". */
  intakeEnabled: boolean
  botToken: string | undefined
  webhookSecret: string | undefined
  workerSecret: string | undefined
  rosterJson: string | undefined
  chrisUserId: number | null
  enabledChatIds: Set<number>
  maxBytes: number
  defaultDailyCap: number
  ownerDailyCap: number
  globalDailyCap: number
  reminderMs: number
  timeoutMs: number
  albumSettleMs: number
  askPerson: boolean
  minorsProjects: Set<Project>
  legacyUsernameMatch: boolean
  blobsPrefix: string
  google: {
    clientId: string | undefined
    clientSecret: string | undefined
    refreshToken: string | undefined
  }
  folders: Record<Project | "unsorted", string | undefined>
  logSheetId: string | undefined
  siteUrl: string | undefined
}

function int(env: EnvSource, name: string, fallback: number): number {
  const raw = env(name)
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function bool(env: EnvSource, name: string, fallback: boolean): boolean {
  const raw = env(name)?.trim().toLowerCase()
  if (raw === undefined || raw === "") return fallback
  return raw === "true"
}

function idList(raw: string | undefined): Set<number> {
  const out = new Set<number>()
  for (const part of (raw ?? "").split(",")) {
    const n = Number(part.trim())
    if (part.trim() !== "" && Number.isSafeInteger(n)) out.add(n)
  }
  return out
}

function projectList(raw: string | undefined, fallback: Project[]): Set<Project> {
  if (raw === undefined) return new Set(fallback)
  const parts = raw.split(",").map((p) => p.trim().toLowerCase())
  return new Set(PROJECTS.filter((p) => parts.includes(p)))
}

export function loadConfig(env: EnvSource): IntakeConfig {
  const chris = Number(env("CHRIS_TELEGRAM_USER_ID"))
  const hours = 60 * 60 * 1000
  return {
    intakeEnabled: env("INTAKE_ENABLED")?.trim().toLowerCase() === "true",
    botToken: env("TELEGRAM_BOT_TOKEN"),
    webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
    workerSecret: env("INTAKE_WORKER_SECRET"),
    rosterJson: env("ROSTER_JSON"),
    chrisUserId: Number.isSafeInteger(chris) && chris > 0 ? chris : null,
    enabledChatIds: idList(env("INTAKE_ENABLED_CHAT_IDS")),
    maxBytes: int(env, "INTAKE_MAX_BYTES", 20 * 1024 * 1024),
    defaultDailyCap: int(env, "INTAKE_DEFAULT_DAILY_CAP", 30),
    ownerDailyCap: int(env, "INTAKE_OWNER_DAILY_CAP", 100),
    globalDailyCap: int(env, "INTAKE_GLOBAL_DAILY_CAP", 200),
    reminderMs: int(env, "INTAKE_REMINDER_HOURS", 4) * hours,
    timeoutMs: int(env, "INTAKE_TIMEOUT_HOURS", 24) * hours,
    albumSettleMs: int(env, "INTAKE_ALBUM_SETTLE_MS", 5000),
    askPerson: bool(env, "INTAKE_ASK_PERSON", true),
    minorsProjects: projectList(env("INTAKE_MINORS_PROJECTS"), ["heroes", "kraken"]),
    legacyUsernameMatch: bool(env, "ROSTER_LEGACY_USERNAME_MATCH", true),
    blobsPrefix: env("INTAKE_BLOBS_PREFIX") ?? "",
    google: {
      clientId: env("GOOGLE_OAUTH_CLIENT_ID"),
      clientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
      refreshToken: env("GOOGLE_OAUTH_REFRESH_TOKEN"),
    },
    folders: {
      heroes: env("DRIVE_FOLDER_HEROES"),
      tfc: env("DRIVE_FOLDER_TFC"),
      kraken: env("DRIVE_FOLDER_KRAKEN"),
      unsorted: env("DRIVE_FOLDER_UNSORTED"),
    },
    logSheetId: env("INTAKE_LOG_SHEET_ID"),
    siteUrl: env("URL"),
  }
}

/** Names (never values) of settings intake needs before it can run. */
export function missingIntakeSettings(cfg: IntakeConfig): string[] {
  const missing: string[] = []
  const need: [string, unknown][] = [
    ["TELEGRAM_BOT_TOKEN", cfg.botToken],
    ["INTAKE_WORKER_SECRET", cfg.workerSecret],
    ["CHRIS_TELEGRAM_USER_ID", cfg.chrisUserId],
    ["GOOGLE_OAUTH_CLIENT_ID", cfg.google.clientId],
    ["GOOGLE_OAUTH_CLIENT_SECRET", cfg.google.clientSecret],
    ["GOOGLE_OAUTH_REFRESH_TOKEN", cfg.google.refreshToken],
    ["DRIVE_FOLDER_HEROES", cfg.folders.heroes],
    ["DRIVE_FOLDER_TFC", cfg.folders.tfc],
    ["DRIVE_FOLDER_KRAKEN", cfg.folders.kraken],
    ["DRIVE_FOLDER_UNSORTED", cfg.folders.unsorted],
    ["INTAKE_LOG_SHEET_ID", cfg.logSheetId],
  ]
  for (const [name, value] of need) if (value === undefined || value === null || value === "") missing.push(name)
  return missing
}

/** Intake is live only when the switch is on AND every required setting exists. */
export function intakeReady(cfg: IntakeConfig): boolean {
  return cfg.intakeEnabled && missingIntakeSettings(cfg).length === 0
}
