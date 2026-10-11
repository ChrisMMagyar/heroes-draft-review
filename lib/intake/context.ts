// Everything a handler needs, injected so tests can swap in fakes.
import type { IntakeConfig, EnvSource } from "./config"
import type { GoogleClient } from "./google"
import type { Logger } from "./log"
import type { Stores } from "./store"
import type { TelegramClient } from "./telegram"
import { loadConfig } from "./config"
import { createGoogle } from "./google"
import { safeLog } from "./log"
import { blobStores } from "./store"
import { createTelegram } from "./telegram"

export interface IntakeContext {
  cfg: IntakeConfig
  stores: Stores
  telegram: TelegramClient
  google: GoogleClient | null
  log: Logger
  now: () => Date
  sleep: (ms: number) => Promise<void>
  /** Starts the background worker (fire and forget; the sweeper is the safety net). */
  kickWorker: () => Promise<void>
}

export const WORKER_PATH = "/.netlify/functions/photo-intake-background"
export const WORKER_SECRET_HEADER = "x-intake-worker-secret"

export function buildContext(env: EnvSource, opts: { baseUrl?: string; maxRetryAfterS: number }): IntakeContext {
  const cfg = loadConfig(env)
  const log = safeLog
  const g = cfg.google
  const baseUrl = opts.baseUrl ?? cfg.siteUrl
  return {
    cfg,
    stores: blobStores(cfg.blobsPrefix),
    telegram: createTelegram({ token: cfg.botToken ?? "", log, maxRetryAfterS: opts.maxRetryAfterS }),
    google: g.clientId && g.clientSecret && g.refreshToken
      ? createGoogle({ clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: g.refreshToken })
      : null,
    log,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    kickWorker: async () => {
      if (!baseUrl || !cfg.workerSecret) return
      try {
        await fetch(new URL(WORKER_PATH, baseUrl), {
          method: "POST",
          headers: { [WORKER_SECRET_HEADER]: cfg.workerSecret },
        })
      } catch {
        log({ event: "worker_kick", outcome: "failed" })
      }
    },
  }
}
