// Webpage change requests: data structures and reply wording only (spec 11A).
// The full routing flow (Master Chief -> content bot -> Squarespace Publisher) is
// deferred; nothing here sends anything yet.
import { ulid } from "./ulid"
import { redact } from "./redact"
import { CHANGE_REQUEST_COLUMNS } from "./sheet"

export type ChangeRequestChannel = "telegram_bot" | "telegram_business" | "email"
export type ChangeRequestStatus =
  | "received" | "routed" | "approved" | "declined" | "in progress" | "published" | "closed"

export interface ChangeRequest {
  trackingId: string
  receivedAtCt: string
  requesterRosterId: string
  requesterName: string
  /** Telegram user id of the requester (internal; replies go to their private bot chat). */
  requesterUserId: number | null
  channel: ChangeRequestChannel
  chatRef: string
  originalRequest: string
  project: string
  pageUrl: string
  owningBot: string
  status: ChangeRequestStatus
  chrisApproval: "yes" | "no" | ""
  chrisApprovalDate: string
  changeLogLink: string
  publishedVerifiedAtCt: string
  replySentAtCt: string
  replyText: string
  notes: string
}

export function newTrackingId(now = Date.now()): string {
  return `CR-${ulid(now)}`
}

export function newChangeRequest(
  input: Pick<ChangeRequest, "receivedAtCt" | "requesterRosterId" | "requesterName" | "requesterUserId" | "channel" | "chatRef" | "project">
    & { originalRequest: string },
): ChangeRequest {
  return {
    ...input,
    trackingId: newTrackingId(),
    originalRequest: redact(input.originalRequest),
    pageUrl: "",
    owningBot: "",
    status: "received",
    chrisApproval: "",
    chrisApprovalDate: "",
    changeLogLink: "",
    publishedVerifiedAtCt: "",
    replySentAtCt: "",
    replyText: "",
    notes: "",
  }
}

export function changeRequestRow(cr: ChangeRequest): string[] {
  const v: Record<(typeof CHANGE_REQUEST_COLUMNS)[number], string> = {
    tracking_id: cr.trackingId,
    received_at_ct: cr.receivedAtCt,
    requester_roster_id: cr.requesterRosterId,
    requester_name: cr.requesterName,
    channel: cr.channel,
    chat_ref: cr.chatRef,
    original_request: cr.originalRequest,
    project: cr.project,
    page_url: cr.pageUrl,
    owning_bot: cr.owningBot,
    status: cr.status,
    chris_approval: cr.chrisApproval,
    chris_approval_date: cr.chrisApprovalDate,
    change_log_link: cr.changeLogLink,
    published_verified_at_ct: cr.publishedVerifiedAtCt,
    reply_sent_at_ct: cr.replySentAtCt,
    reply_text: cr.replyText,
    notes: cr.notes,
  }
  return CHANGE_REQUEST_COLUMNS.map((c) => v[c])
}

export type CompletionOutcome =
  | { kind: "published"; pageUrl: string; passwordProtected: boolean; siteName?: string }
  | { kind: "declined" }
  | { kind: "held" }

/** One plain line. Never includes a password, other people's details, internal links or IDs. */
export function completionReplyText(what: string, outcome: CompletionOutcome): string {
  const What = what.charAt(0).toUpperCase() + what.slice(1)
  switch (outcome.kind) {
    case "published":
      return outcome.passwordProtected
        ? `${What} is on the ${outcome.siteName ?? "draft"} site, which isn't public yet: ${outcome.pageUrl}`
        : `${What} is live: ${outcome.pageUrl}`
    case "declined":
      return `${What} wasn't made. Chris has the details.`
    case "held":
      return `${What} is waiting on review.`
  }
}

/** Where the close-the-loop reply goes: always the requester's own private chat, never a business chat. */
export function replyTarget(cr: ChangeRequest): { via: "telegram"; chatId: number } | { via: "human_connector" } | null {
  if (cr.channel === "email") return { via: "human_connector" }
  return cr.requesterUserId ? { via: "telegram", chatId: cr.requesterUserId } : null
}
