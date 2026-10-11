// Background worker (spec 2, 6): one at a time under a Blobs lock. For each job:
// getFile -> download -> metadata (8A) -> upload media -> upload .json sidecar ->
// log row -> "Filed" reply when the whole group is done. Progress is saved after
// every step so a retry never uploads the same file twice.
import type { IntakeContext } from "./context"
import type { GroupMeta, IncomingItem } from "./resolve"
import type { IntakeJob } from "./types"
import type { MediaMetadata } from "./metadata"
import { PROJECT_LABEL } from "./types"
import { intakeReady } from "./config"
import { GoogleAuthError } from "./google"
import { extractMetadata } from "./metadata"
import { buildBaseName, extensionFor, uniqueBaseName } from "./naming"
import { tellChrisOnce } from "./notify"
import { startResolution } from "./resolve"
import { firstName } from "./roster"
import { INTAKE_TAB, buildIntakeRow, statusFor } from "./sheet"
import { buildSidecar } from "./sidecar"
import { acquireLock, bumpDaily, refreshLock, releaseLock } from "./state"
import { ctDateTime, daysBetween } from "./time"
import { ulid } from "./ulid"

export const HOLD_FOLDER_NAME = "HOLD — Minor Consent Pending"
export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000]
export const FAILURE_REPLY = "Something went wrong saving that; Chris has been told."

class PermanentError extends Error {}

interface StoredProgress { metadata?: MediaMetadata; metadataError?: string | null; baseName?: string; ext?: string }
type WorkingJob = IntakeJob & { progress: IntakeJob["progress"] & StoredProgress }

export interface WorkerResult { processed: number; stopped: "idle" | "locked" | "disabled" | "auth_paused" | "deadline" }

export async function runWorker(ctx: IntakeContext, budgetMs = 13 * 60 * 1000): Promise<WorkerResult> {
  if (!intakeReady(ctx.cfg) || !ctx.google) return { processed: 0, stopped: "disabled" }
  const owner = ulid()
  const started = ctx.now().getTime()
  if (!(await acquireLock(ctx.stores.lock, owner, started))) return { processed: 0, stopped: "locked" }
  let processed = 0
  try {
    for (;;) {
      const now = ctx.now().getTime()
      const remaining = budgetMs - (now - started)
      if (remaining < 60_000) return { processed, stopped: "deadline" }
      const nextSettle = await settleAlbums(ctx)
      const { job, nextDue } = await nextJob(ctx)
      if (job) {
        const r = await processJob(ctx, job)
        processed++
        await refreshLock(ctx.stores.lock, owner, ctx.now().getTime())
        if (r === "auth_paused") return { processed, stopped: "auth_paused" }
        continue
      }
      const wake = [nextSettle, nextDue].filter((x): x is number => x !== null).sort((a, b) => a - b)[0]
      if (wake === undefined) return { processed, stopped: "idle" }
      const wait = Math.max(0, wake - ctx.now().getTime())
      if (wait > 3 * 60_000 || wait > remaining - 60_000) return { processed, stopped: "idle" }
      await ctx.sleep(Math.min(wait, 30_000) || 250)
    }
  } finally {
    await releaseLock(ctx.stores.lock, owner)
  }
}

/** Groups album items once no new item has arrived for albumSettleMs. Returns the next settle time. */
export async function settleAlbums(ctx: IntakeContext): Promise<number | null> {
  const keys = await ctx.stores.incoming.list()
  const groups = new Map<string, string[]>()
  for (const k of keys) {
    const g = k.slice(0, k.lastIndexOf("/"))
    groups.set(g, [...(groups.get(g) ?? []), k])
  }
  let next: number | null = null
  const now = ctx.now().getTime()
  for (const [, groupKeys] of groups) {
    const items: IncomingItem[] = []
    for (const k of groupKeys) {
      const r = await ctx.stores.incoming.getJSON<IncomingItem>(k)
      if (r) items.push(r.value)
    }
    if (items.length === 0) continue
    const latest = Math.max(...items.map((i) => i.receivedAt))
    if (now - latest < ctx.cfg.albumSettleMs) {
      const at = latest + ctx.cfg.albumSettleMs
      next = next === null ? at : Math.min(next, at)
      continue
    }
    for (const k of groupKeys) await ctx.stores.incoming.delete(k)
    items.sort((a, b) => a.item.messageId - b.item.messageId)
    await startResolution(ctx, items)
  }
  return next
}

async function nextJob(ctx: IntakeContext): Promise<{ job: WorkingJob | null; nextDue: number | null }> {
  const now = ctx.now().getTime()
  let nextDue: number | null = null
  for (const key of await ctx.stores.queue.list()) {
    const r = await ctx.stores.queue.getJSON<WorkingJob>(key)
    if (!r) continue
    if (r.value.nextAttemptAt <= now) return { job: r.value, nextDue }
    nextDue = nextDue === null ? r.value.nextAttemptAt : Math.min(nextDue, r.value.nextAttemptAt)
  }
  return { job: null, nextDue }
}

const folderCache = new Map<string, string>()

async function folderFor(ctx: IntakeContext, job: IntakeJob): Promise<string> {
  const base = ctx.cfg.folders[job.resolution.project]
  if (!base) throw new PermanentError("folder_not_configured")
  if (!job.resolution.hold) return base
  const cached = folderCache.get(base)
  if (cached) return cached
  const google = ctx.google!
  const id = (await google.findChild(base, HOLD_FOLDER_NAME, true)) ?? (await google.createFolder(HOLD_FOLDER_NAME, base))
  folderCache.set(base, id)
  return id
}

async function save(ctx: IntakeContext, job: WorkingJob) {
  await ctx.stores.queue.setJSON(job.key, job)
}

function notesFor(job: WorkingJob): string[] {
  const notes: string[] = []
  const capture = job.progress.metadata?.capture_time
  if (capture && /^\d{4}-\d{2}-\d{2}/.test(capture)) {
    const exifDate = capture.slice(0, 10)
    if (daysBetween(exifDate, job.resolution.photoDate) > 2) notes.push(`exif_date_differs:${exifDate}`)
  }
  if (job.resolution.timedOut) notes.push("clarification_timeout")
  return notes
}

async function fileJob(ctx: IntakeContext, job: WorkingJob): Promise<void> {
  const google = ctx.google!
  const p = job.progress
  if (!p.mediaFileId) {
    const file = await ctx.telegram.getFile(job.item.fileId)
    if (file.fileSize !== null && file.fileSize > ctx.cfg.maxBytes) throw new PermanentError("too_large")
    const bytes = await ctx.telegram.downloadFile(file.filePath)
    if (bytes.byteLength > ctx.cfg.maxBytes) throw new PermanentError("too_large")
    const meta = await extractMetadata(bytes, job.item)
    const folderId = await folderFor(ctx, job)
    const ext = extensionFor(job.item.mimeType, job.item.originalFilename)
    const base = buildBaseName({
      people: job.resolution.people,
      description: job.resolution.description,
      descriptionFallback: job.item.mediaType === "video" ? "video" : "photo",
      date: job.resolution.photoDate,
      hold: job.resolution.hold,
      index: job.group.index,
    })
    const baseName = await uniqueBaseName(base, ext, async (name) => (await google.findChild(folderId, name)) !== null)
    const uploaded = await google.uploadFile({
      name: `${baseName}.${ext}`,
      parentId: folderId,
      mimeType: job.item.mimeType,
      bytes,
      appProperties: { intake_id: job.intakeId, telegram_file_unique_id: job.item.fileUniqueId },
    })
    Object.assign(p, {
      mediaFileId: uploaded.id, mediaFileName: `${baseName}.${ext}`, mediaLink: uploaded.webViewLink,
      folderId, baseName, ext, metadata: meta.metadata, metadataError: meta.error,
    })
    await save(ctx, job)
  }
  if (!p.sidecarFileId) {
    const sidecar = buildSidecar(job, p.metadata!, p.metadataError ?? null, ctx.now(), notesFor(job))
    const name = `${p.baseName}.json`
    const uploaded = await google.uploadFile({
      name,
      parentId: p.folderId!,
      mimeType: "application/json",
      bytes: new TextEncoder().encode(JSON.stringify(sidecar, null, 2)),
      appProperties: { intake_id: job.intakeId, sidecar_for: p.mediaFileId! },
    })
    Object.assign(p, { sidecarFileId: uploaded.id, sidecarFileName: name, sidecarLink: uploaded.webViewLink })
    await save(ctx, job)
  }
  if (!p.rowAppended) {
    const row = buildIntakeRow({
      job,
      receivedAtCt: ctDateTime(new Date(job.item.date * 1000)),
      filedAtCt: ctDateTime(ctx.now()),
      status: statusFor(job),
      metadata: p.metadata ?? null,
      metadataError: p.metadataError ?? null,
      error: p.metadataError ?? "",
      notes: notesFor(job).join(" "),
    })
    await google.appendRows(ctx.cfg.logSheetId!, INTAKE_TAB, [row])
    p.rowAppended = true
  }
}

export async function processJob(ctx: IntakeContext, job: WorkingJob): Promise<"filed" | "retry" | "failed" | "auth_paused"> {
  try {
    await fileJob(ctx, job)
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      // Revoked or expired grant (test T13): keep the job, tell Chris once, stop.
      await save(ctx, job)
      await tellChrisOnce(ctx, "google_auth", "Photo intake can't reach Google Drive because the Google grant was refused. Files are waiting in the queue; nothing is lost.")
      ctx.log({ event: "intake_job", intake_id: job.intakeId, outcome: "auth_paused", error_code: e.code })
      return "auth_paused"
    }
    const code = e instanceof PermanentError ? e.message : (e as { code?: string }).code ?? "unexpected_error"
    job.attempts++
    if (!(e instanceof PermanentError) && job.attempts <= RETRY_BACKOFF_MS.length) {
      job.nextAttemptAt = ctx.now().getTime() + RETRY_BACKOFF_MS[job.attempts - 1]
      await save(ctx, job)
      ctx.log({ event: "intake_job", intake_id: job.intakeId, outcome: "retry", count: job.attempts, error_code: code })
      return "retry"
    }
    await failJob(ctx, job, code)
    return "failed"
  }
  await ctx.stores.queue.delete(job.key)
  const now = ctx.now()
  const status = statusFor(job)
  await bumpDaily(ctx.stores, "filed", now)
  await bumpDaily(ctx.stores, `filed_${job.resolution.project}`, now)
  if (status === "held_minor") await bumpDaily(ctx.stores, "held_minor", now)
  ctx.log({ event: "intake_job", intake_id: job.intakeId, outcome: "filed", status })
  await groupProgress(ctx, job, "filed")
  return "filed"
}

async function failJob(ctx: IntakeContext, job: WorkingJob, code: string) {
  await ctx.stores.queue.delete(job.key)
  await bumpDaily(ctx.stores, "failures", ctx.now())
  ctx.log({ event: "intake_job", intake_id: job.intakeId, outcome: "failed", error_code: code })
  try {
    const row = buildIntakeRow({
      job, receivedAtCt: ctDateTime(new Date(job.item.date * 1000)), filedAtCt: "", status: "failed",
      metadata: job.progress.metadata ?? null, metadataError: job.progress.metadataError ?? null, error: code, notes: "",
    })
    await ctx.google!.appendRows(ctx.cfg.logSheetId!, INTAKE_TAB, [row])
  } catch {
    // The Chris notice below still goes out.
  }
  const chris = ctx.cfg.chrisUserId
  if (job.replyChatId !== chris) await ctx.telegram.sendMessage(job.replyChatId, FAILURE_REPLY)
  if (chris) await ctx.telegram.sendMessage(chris, `Photo intake couldn't file ${job.intakeId} (${code}).`)
  await groupProgress(ctx, job, "failed")
}

/** Sends one "Filed N to X intake." line once every item in the group is done. */
async function groupProgress(ctx: IntakeContext, job: IntakeJob, status: "filed" | "failed") {
  const g = ctx.stores.groups
  await g.setJSON(`${job.group.id}/${job.key}`, { status })
  const keys = (await g.list(`${job.group.id}/`)).filter((k) => !k.endsWith("/meta"))
  if (keys.length < job.group.size) return
  const meta = (await g.getJSON<GroupMeta>(`${job.group.id}/meta`))?.value
  let filed = 0
  for (const k of keys) if ((await g.getJSON<{ status: string }>(k))?.value.status === "filed") filed++
  for (const k of [...keys, `${job.group.id}/meta`]) await g.delete(k)
  if (!meta || filed === 0) return
  const label = PROJECT_LABEL[meta.project]
  const held = meta.hold ? " (held until consent is recorded)" : ""
  const toChris = meta.replyChatId === ctx.cfg.chrisUserId
  const link = toChris && job.progress.folderId ? ` https://drive.google.com/drive/folders/${job.progress.folderId}` : ""
  const from = meta.path === "business" ? ` from ${firstName(meta.senderName)}` : ""
  await ctx.telegram.sendMessage(meta.replyChatId, `Filed ${filed}${from} to ${label} intake${held}.${link}`)
}
