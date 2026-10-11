// Shared types for the Telegram gateway and photo intake.
// Only the Telegram fields this code actually reads are modelled.

export type Project = "heroes" | "tfc" | "kraken"
export type Destination = Project | "unsorted"
export const PROJECTS: readonly Project[] = ["heroes", "tfc", "kraken"]

export const PROJECT_LABEL: Record<Destination, string> = {
  heroes: "Heroes",
  tfc: "TFC",
  kraken: "Kraken",
  unsorted: "Unsorted",
}

export interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  username?: string
}

export interface TgChat {
  id: number
  type: "private" | "group" | "supergroup" | "channel"
}

export interface TgPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TgDocument {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TgVideo extends TgDocument {
  width: number
  height: number
  duration: number
}

export interface TgMessage {
  message_id: number
  date: number
  chat: TgChat
  from?: TgUser
  text?: string
  caption?: string
  media_group_id?: string
  photo?: TgPhotoSize[]
  document?: TgDocument
  video?: TgVideo
  animation?: unknown
  video_note?: unknown
  voice?: unknown
  audio?: unknown
  sticker?: unknown
  reply_to_message?: { message_id: number }
  business_connection_id?: string
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  data?: string
  message?: { message_id: number; chat: TgChat }
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  channel_post?: TgMessage
  edited_channel_post?: TgMessage
  business_message?: TgMessage
  edited_business_message?: TgMessage
  deleted_business_messages?: unknown
  callback_query?: TgCallbackQuery
  [other: string]: unknown
}

export type IntakePath = "bot_dm" | "business"
export type MediaType = "photo" | "image_document" | "video"
export type MetadataSource = "original" | "stripped-by-Telegram"
export type MinorsAnswer = "yes" | "no" | "unknown" | "not_asked"
export type ConsentStatus = "n/a" | "pending"
export type MappingReason = "caption" | "clarified" | "roster_default" | "timeout" | "not_sure"

/** One media item as received. No raw caption is stored, only the redacted one. */
export interface MediaItem {
  updateId: number
  messageId: number
  date: number
  fileId: string
  fileUniqueId: string
  fileSize: number | null
  mimeType: string
  mediaType: MediaType
  metadataSource: MetadataSource
  originalFilename: string | null
  width: number | null
  height: number | null
  durationS: number | null
  mediaGroupId: string | null
  captionRedacted: string
  chatRef: string
}

export interface SenderRef {
  rosterKey: string
  name: string
  userId: number
  isOwner: boolean
}

export interface ClarificationLogEntry {
  question: "project" | "person" | "minors"
  askedAt: string
  answer?: string
  answeredAt?: string
}

export interface Resolution {
  project: Destination
  mappingReason: MappingReason
  rosterProject: Project | null
  captionProject: Project | null
  people: string[]
  description: string
  photoDate: string
  minorsAnswer: MinorsAnswer
  consentStatus: ConsentStatus
  hold: boolean
  clarifications: ClarificationLogEntry[]
  timedOut: boolean
}

export interface JobProgress {
  mediaFileId?: string
  mediaFileName?: string
  mediaLink?: string
  folderId?: string
  sidecarFileId?: string
  sidecarFileName?: string
  sidecarLink?: string
  rowAppended?: boolean
}

export interface IntakeJob {
  intakeId: string
  key: string
  createdAt: string
  attempts: number
  nextAttemptAt: number
  path: IntakePath
  sender: SenderRef
  replyChatId: number
  item: MediaItem
  resolution: Resolution
  group: { id: string; size: number; index: number }
  progress: JobProgress
}
