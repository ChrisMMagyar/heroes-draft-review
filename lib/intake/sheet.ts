// Column layouts for the "Telegram Intake Log" Sheet (spec 8, 8A, 11A) and row builders.
// The log row never contains coordinates: only gps_present yes/no.
import type { IntakeJob } from "./types"
import type { MediaMetadata } from "./metadata"
import { personPart } from "./naming"

export const INTAKE_TAB = "Intake"
export const DAILY_TAB = "Daily"
export const CHANGE_REQUESTS_TAB = "Change Requests"

export const INTAKE_COLUMNS = [
  "intake_id", "received_at_ct", "filed_at_ct", "path", "sender_name", "sender_roster_id",
  "media_type", "mime_type", "file_size_bytes", "media_group_id", "telegram_file_unique_id",
  "caption_redacted", "roster_project", "caption_project", "final_project", "mapping_reason",
  "person", "description", "photo_date", "drive_file_name", "drive_file_id", "drive_link", "drive_folder",
  "minors_answer", "consent_status", "status", "clarification_asked_at", "clarification_answered_at",
  "handoff_to", "handoff_status", "handoff_by", "handoff_at", "error",
  "metadata_source", "capture_time_ct", "device", "width_px", "height_px", "orientation", "duration_s",
  "gps_present", "original_filename", "sidecar_file_name", "sidecar_drive_id", "sidecar_link",
  "metadata_error", "notes",
] as const

export const DAILY_COLUMNS = [
  "date", "files_filed", "heroes", "tfc", "kraken", "unsorted", "held_minor",
  "rejected_total", "rejected_by_reason", "ignored_business", "cap_hits", "failures",
] as const

export const CHANGE_REQUEST_COLUMNS = [
  "tracking_id", "received_at_ct", "requester_roster_id", "requester_name", "channel", "chat_ref",
  "original_request", "project", "page_url", "owning_bot", "status", "chris_approval",
  "chris_approval_date", "change_log_link", "published_verified_at_ct", "reply_sent_at_ct",
  "reply_text", "notes",
] as const

export type IntakeColumn = (typeof INTAKE_COLUMNS)[number]

export const HANDOFF_BOT: Record<string, string> = {
  heroes: "Heroes Web Content",
  tfc: "TFC Web Content",
  kraken: "Kraken Web Content",
  unsorted: "Chris",
}

export type IntakeStatus = "filed" | "filed_unsorted" | "held_minor" | "failed"

export function statusFor(job: IntakeJob): IntakeStatus {
  if (job.resolution.hold) return "held_minor"
  if (job.resolution.project === "unsorted") return "filed_unsorted"
  return "filed"
}

export interface RowInput {
  job: IntakeJob
  receivedAtCt: string
  filedAtCt: string
  status: IntakeStatus
  metadata: MediaMetadata | null
  metadataError: string | null
  error: string
  notes: string
}

export function buildIntakeRow(input: RowInput): string[] {
  const { job, metadata } = input
  const r = job.resolution
  const p = job.progress
  const asked = r.clarifications.map((c) => c.askedAt)
  const answered = r.clarifications.map((c) => c.answeredAt).filter(Boolean)
  const device = [metadata?.device_make, metadata?.device_model].filter(Boolean).join(" ")
  const values: Record<IntakeColumn, string | number | null | undefined> = {
    intake_id: job.intakeId,
    received_at_ct: input.receivedAtCt,
    filed_at_ct: input.filedAtCt,
    path: job.path,
    sender_name: job.sender.name,
    sender_roster_id: job.sender.rosterKey,
    media_type: job.item.mediaType,
    mime_type: job.item.mimeType,
    file_size_bytes: job.item.fileSize,
    media_group_id: job.item.mediaGroupId,
    telegram_file_unique_id: job.item.fileUniqueId,
    caption_redacted: job.item.captionRedacted,
    roster_project: r.rosterProject,
    caption_project: r.captionProject,
    final_project: r.project,
    mapping_reason: r.mappingReason,
    person: personPart(r.people),
    description: r.description,
    photo_date: r.photoDate,
    drive_file_name: p.mediaFileName,
    drive_file_id: p.mediaFileId,
    drive_link: p.mediaLink,
    drive_folder: p.folderId,
    minors_answer: r.minorsAnswer,
    consent_status: r.consentStatus,
    status: input.status,
    clarification_asked_at: asked[0],
    clarification_answered_at: answered[answered.length - 1],
    handoff_to: r.hold ? "Chris" : HANDOFF_BOT[r.project],
    handoff_status: input.status === "failed" ? "" : "pending",
    handoff_by: "",
    handoff_at: "",
    error: input.error,
    metadata_source: job.item.metadataSource,
    capture_time_ct: metadata?.capture_time_ct ?? metadata?.capture_time,
    device,
    width_px: metadata?.width_px,
    height_px: metadata?.height_px,
    orientation: metadata?.orientation,
    duration_s: metadata?.video?.duration_s,
    gps_present: metadata ? (metadata.gps ? "yes" : "no") : "",
    original_filename: job.item.originalFilename,
    sidecar_file_name: p.sidecarFileName,
    sidecar_drive_id: p.sidecarFileId,
    sidecar_link: p.sidecarLink,
    metadata_error: input.metadataError,
    notes: input.notes,
  }
  return INTAKE_COLUMNS.map((c) => {
    const v = values[c]
    return v === null || v === undefined ? "" : String(v)
  })
}

export function buildDailyRow(day: string, counts: Record<string, number>): (string | number)[] {
  const rejected = Object.entries(counts)
    .filter(([k]) => k.startsWith("rejected_"))
    .map(([k, v]) => `${k.slice("rejected_".length)}:${v}`)
  const rejectedTotal = Object.entries(counts)
    .filter(([k]) => k.startsWith("rejected_"))
    .reduce((a, [, v]) => a + v, 0)
  return [
    day, counts.filed ?? 0, counts.filed_heroes ?? 0, counts.filed_tfc ?? 0, counts.filed_kraken ?? 0,
    counts.filed_unsorted ?? 0, counts.held_minor ?? 0, rejectedTotal, rejected.join(" "),
    counts.ignored_business ?? 0, counts.cap_hits ?? 0, counts.failures ?? 0,
  ]
}
