// Picks the media out of a message and checks it against spec 3.2.
import type { MediaItem, MediaType, MetadataSource, TgMessage } from "./types"
import { createHash } from "node:crypto"

const IMAGE_DOC_TYPES = new Set(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"])
const VIDEO_DOC_TYPES = new Set(["video/mp4", "video/quicktime"])

export type MediaCheck =
  | { kind: "none" }
  | { kind: "unsupported" }
  | { kind: "ok"; item: Omit<MediaItem, "captionRedacted"> }

/** Internal, non-reversible chat reference (the raw chat id is never stored). */
export function chatRef(chatId: number): string {
  return createHash("sha256").update(`chat:${chatId}`).digest("hex").slice(0, 12)
}

export function extractMedia(msg: TgMessage, updateId: number): MediaCheck {
  const base = {
    updateId,
    messageId: msg.message_id,
    date: msg.date,
    mediaGroupId: msg.media_group_id ?? null,
    chatRef: chatRef(msg.chat.id),
  }
  const make = (
    f: { file_id: string; file_unique_id: string; file_size?: number },
    mediaType: MediaType,
    metadataSource: MetadataSource,
    mimeType: string,
    extra: Partial<MediaItem>,
  ): MediaCheck => ({
    kind: "ok",
    item: {
      ...base,
      fileId: f.file_id,
      fileUniqueId: f.file_unique_id,
      fileSize: f.file_size ?? null,
      mimeType,
      mediaType,
      metadataSource,
      originalFilename: null,
      width: null,
      height: null,
      durationS: null,
      ...extra,
    },
  })

  // Animations (GIFs) also carry a document field, so check them first.
  if (msg.animation || msg.video_note || msg.voice || msg.audio || msg.sticker) return { kind: "unsupported" }
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]
    return make(largest, "photo", "stripped-by-Telegram", "image/jpeg", { width: largest.width, height: largest.height })
  }
  if (msg.video) {
    const v = msg.video
    return make(v, "video", "stripped-by-Telegram", v.mime_type ?? "video/mp4", {
      width: v.width, height: v.height, durationS: v.duration, originalFilename: v.file_name ?? null,
    })
  }
  if (msg.document) {
    const d = msg.document
    const mime = (d.mime_type ?? "").toLowerCase()
    if (IMAGE_DOC_TYPES.has(mime)) {
      return make(d, "image_document", "original", mime, { originalFilename: d.file_name ?? null })
    }
    if (VIDEO_DOC_TYPES.has(mime)) {
      return make(d, "video", "original", mime, { originalFilename: d.file_name ?? null })
    }
    return { kind: "unsupported" }
  }
  return { kind: "none" }
}
