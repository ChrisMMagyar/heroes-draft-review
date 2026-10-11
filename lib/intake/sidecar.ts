// The JSON sidecar stored next to each Drive file (spec 8A, schema "intake-metadata/1").
// It is internal: it is the ONLY place GPS coordinates are kept.
import type { IntakeJob } from "./types"
import type { MediaMetadata } from "./metadata"
import { ctDateTime } from "./time"
import { personPart } from "./naming"

export const SIDECAR_SCHEMA = "intake-metadata/1"

export function buildSidecar(
  job: IntakeJob,
  metadata: MediaMetadata,
  metadataError: string | null,
  now: Date,
  notes: string[],
): Record<string, unknown> {
  const r = job.resolution
  return {
    schema: SIDECAR_SCHEMA,
    intake_id: job.intakeId,
    media_drive_file_id: job.progress.mediaFileId ?? null,
    media_file_name: job.progress.mediaFileName ?? null,
    generated_at_ct: ctDateTime(now),
    metadata_source: job.item.metadataSource,
    metadata_error: metadataError,
    metadata,
    telegram: {
      sender_roster_id: job.sender.rosterKey,
      path: job.path,
      chat_ref: job.item.chatRef,
      message_date_ct: ctDateTime(new Date(job.item.date * 1000)),
      caption_redacted: job.item.captionRedacted,
      media_group_id: job.item.mediaGroupId,
      file_unique_id: job.item.fileUniqueId,
      original_filename: job.item.originalFilename,
      mime_type: job.item.mimeType,
      file_size_bytes: job.item.fileSize,
      width: job.item.width,
      height: job.item.height,
      duration_s: job.item.durationS,
    },
    intake: {
      final_project: r.project,
      mapping_reason: r.mappingReason,
      person_tags: r.people,
      person: personPart(r.people),
      description: r.description,
      photo_date: r.photoDate,
      minors_answer: r.minorsAnswer,
      consent_status: r.consentStatus,
      clarifications: r.clarifications,
    },
    notes,
  }
}
