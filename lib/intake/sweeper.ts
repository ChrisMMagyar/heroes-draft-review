// Scheduled every 5 minutes (spec 2, 5.2): clarification reminders and timeouts,
// restarting a stuck worker, the Daily tab row, and pruning old de-dupe markers.
import type { IntakeContext } from "./context"
import type { Pending } from "./resolve"
import { intakeReady } from "./config"
import { reminderText, timeoutPending } from "./resolve"
import { DAILY_TAB, buildDailyRow } from "./sheet"
import { FILE_DEDUPE_DAYS, lockIsStale, readDaily } from "./state"
import { addDays, ctDate } from "./time"

export interface SweepResult { reminders: number; timeouts: number; workerKicked: boolean; pruned: number; dailyWritten: boolean }

export async function runSweeper(ctx: IntakeContext): Promise<SweepResult> {
  const result: SweepResult = { reminders: 0, timeouts: 0, workerKicked: false, pruned: 0, dailyWritten: false }
  const now = ctx.now()
  // Pruning runs at most once an hour, even while intake is off (the webhook's
  // update_id de-dupe uses the same store).
  if (now.getUTCMinutes() < 5) result.pruned = await prune(ctx, now.getUTCHours() === 9)
  if (!intakeReady(ctx.cfg)) return result

  // One active clarification per answerer: the first key under each prefix.
  const keys = await ctx.stores.pending.list()
  const firstPerAnswerer = new Map<string, string>()
  for (const k of keys) {
    const a = k.split("/")[0]
    if (!firstPerAnswerer.has(a)) firstPerAnswerer.set(a, k)
  }
  for (const key of firstPerAnswerer.values()) {
    const p = (await ctx.stores.pending.getJSON<Pending>(key))?.value
    if (!p || p.askedAt === null) continue
    const age = now.getTime() - p.askedAt
    if (age >= ctx.cfg.timeoutMs) {
      await timeoutPending(ctx, p)
      result.timeouts++
    } else if (age >= ctx.cfg.reminderMs && p.reminderSentAt === null) {
      await ctx.telegram.sendMessage(p.origin.replyChatId, reminderText(p))
      p.reminderSentAt = now.getTime()
      await ctx.stores.pending.setJSON(p.key, p)
      result.reminders++
    }
  }

  const work = (await ctx.stores.queue.list()).length + (await ctx.stores.incoming.list()).length
  if (work > 0 && (await lockIsStale(ctx.stores.lock, now.getTime()))) {
    await ctx.kickWorker()
    result.workerKicked = true
  }

  const yesterday = addDays(ctDate(now), -1)
  if (ctx.google && ctx.cfg.logSheetId && !(await ctx.stores.seen.getJSON(`daily-written/${yesterday}`))) {
    const counts = await readDaily(ctx.stores, yesterday)
    await ctx.google.appendRows(ctx.cfg.logSheetId, DAILY_TAB, [buildDailyRow(yesterday, counts)])
    await ctx.stores.seen.setJSON(`daily-written/${yesterday}`, { at: now.getTime() })
    result.dailyWritten = true
  }
  return result
}

async function prune(ctx: IntakeContext, includeFiles: boolean): Promise<number> {
  const now = ctx.now()
  const cutoffDay = addDays(ctDate(now), -1)
  let n = 0
  for (const prefix of ["u/", "d/"]) {
    for (const k of await ctx.stores.seen.list(prefix)) {
      const day = k.split("/")[1]
      if (day < cutoffDay) { await ctx.stores.seen.delete(k); n++ }
    }
  }
  for (const k of await ctx.stores.caps.list("caps/")) {
    if (k.split("/")[1] < cutoffDay) { await ctx.stores.caps.delete(k); n++ }
  }
  if (includeFiles) {
    const limit = now.getTime() - FILE_DEDUPE_DAYS * 86_400_000
    for (const k of await ctx.stores.seen.list("f/")) {
      const r = await ctx.stores.seen.getJSON<{ at: number }>(k)
      if (!r || r.value.at < limit) { await ctx.stores.seen.delete(k); n++ }
    }
    const dailyCutoff = addDays(ctDate(now), -14)
    for (const k of await ctx.stores.caps.list("daily/")) {
      if (k.split("/")[1] < dailyCutoff) { await ctx.stores.caps.delete(k); n++ }
    }
    for (const k of await ctx.stores.seen.list("daily-written/")) {
      if (k.split("/")[1] < dailyCutoff) { await ctx.stores.seen.delete(k); n++ }
    }
  }
  return n
}
