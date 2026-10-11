// De-dupe markers, daily caps, daily counters and the worker lock, all in Blobs.
import type { KV, Stores } from "./store"
import { addDays, ctDate } from "./time"

/** True the first time an update_id is seen (two daily buckets cover the spec's 48 h). */
export async function markUpdateSeen(stores: Stores, updateId: number, now: Date): Promise<boolean> {
  const today = ctDate(now)
  const yesterday = addDays(today, -1)
  if (await stores.seen.getJSON(`u/${yesterday}/${updateId}`)) return false
  return stores.seen.setJSON(`u/${today}/${updateId}`, { at: now.getTime() }, { onlyIfNew: true })
}

/** True only once per key per CT day (refusal replies, one-line alerts to Chris). */
export async function oncePerDay(stores: Stores, kind: string, id: string | number, now: Date): Promise<boolean> {
  return stores.seen.setJSON(`d/${ctDate(now)}/${kind}/${id}`, { at: now.getTime() }, { onlyIfNew: true })
}

const DAY_MS = 86_400_000
export const FILE_DEDUPE_DAYS = 30

export async function fileSeenRecently(stores: Stores, senderKey: string, fileUniqueId: string, now: Date) {
  const r = await stores.seen.getJSON<{ at: number }>(`f/${senderKey}/${fileUniqueId}`)
  return !!r && now.getTime() - r.value.at < FILE_DEDUPE_DAYS * DAY_MS
}

export async function markFileSeen(stores: Stores, senderKey: string, fileUniqueId: string, now: Date) {
  await stores.seen.setJSON(`f/${senderKey}/${fileUniqueId}`, { at: now.getTime() })
}

/** Compare-and-swap counter. Returns false (and changes nothing) if `limit` would be exceeded. */
export async function incrementCounter(kv: KV, key: string, by: number, limit = Infinity): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await kv.getJSON<{ n: number }>(key)
    const n = cur?.value.n ?? 0
    if (n + by > limit) return false
    const ok = cur
      ? await kv.setJSON(key, { n: n + by }, { onlyIfMatch: cur.etag })
      : await kv.setJSON(key, { n: by }, { onlyIfNew: true })
    if (ok) return true
  }
  throw new Error("counter_contention")
}

export type CapResult = "ok" | "user_cap" | "global_cap"

export async function reserveCaps(
  stores: Stores, senderKey: string, userCap: number, globalCap: number, now: Date,
): Promise<CapResult> {
  const day = ctDate(now)
  if (!(await incrementCounter(stores.caps, `caps/${day}/user/${senderKey}`, 1, userCap))) return "user_cap"
  if (!(await incrementCounter(stores.caps, `caps/${day}/global`, 1, globalCap))) {
    await incrementCounter(stores.caps, `caps/${day}/user/${senderKey}`, -1).catch(() => {})
    return "global_cap"
  }
  return "ok"
}

/** Daily totals for the Daily tab. Numbers only, no identifiers. Best effort. */
export async function bumpDaily(stores: Stores, field: string, now: Date, by = 1): Promise<void> {
  try {
    await incrementCounter(stores.caps, `daily/${ctDate(now)}/${field}`, by)
  } catch {
    // Counters are informational; never fail a request over them.
  }
}

export async function readDaily(stores: Stores, day: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const key of await stores.caps.list(`daily/${day}/`)) {
    const r = await stores.caps.getJSON<{ n: number }>(key)
    out[key.slice(`daily/${day}/`.length)] = r?.value.n ?? 0
  }
  return out
}

// ---- Worker lock (10-minute expiry, conditional writes) ----

export const LOCK_KEY = "worker"
export const LOCK_TTL_MS = 10 * 60 * 1000

interface LockValue { owner: string; expiresAt: number }

export async function acquireLock(kv: KV, owner: string, now: number): Promise<boolean> {
  const value: LockValue = { owner, expiresAt: now + LOCK_TTL_MS }
  if (await kv.setJSON(LOCK_KEY, value, { onlyIfNew: true })) return true
  const cur = await kv.getJSON<LockValue>(LOCK_KEY)
  if (!cur) return kv.setJSON(LOCK_KEY, value, { onlyIfNew: true })
  if (cur.value.expiresAt > now) return false
  return kv.setJSON(LOCK_KEY, value, { onlyIfMatch: cur.etag })
}

export async function refreshLock(kv: KV, owner: string, now: number): Promise<boolean> {
  const cur = await kv.getJSON<LockValue>(LOCK_KEY)
  if (!cur || cur.value.owner !== owner) return false
  return kv.setJSON(LOCK_KEY, { owner, expiresAt: now + LOCK_TTL_MS }, { onlyIfMatch: cur.etag })
}

export async function releaseLock(kv: KV, owner: string): Promise<void> {
  const cur = await kv.getJSON<LockValue>(LOCK_KEY)
  if (cur && cur.value.owner === owner) await kv.delete(LOCK_KEY)
}

export async function lockIsStale(kv: KV, now: number): Promise<boolean> {
  const cur = await kv.getJSON<LockValue>(LOCK_KEY)
  return !cur || cur.value.expiresAt <= now
}
