// The only logger the gateway uses. It writes allowlisted fields only, so message
// text, chat ids, usernames, tokens and file URLs can never reach the Netlify log.
export interface SafeLogFields {
  event: string
  outcome?: string
  intent?: string
  update_kind?: string
  path?: string
  sender?: string
  intake_id?: string
  status?: string
  error_code?: string
  count?: number
  text_length?: number
  http_status?: number
  received_at?: string
  message_date?: string
}

const ALLOWED = new Set<keyof SafeLogFields>([
  "event", "outcome", "intent", "update_kind", "path", "sender", "intake_id", "status",
  "error_code", "count", "text_length", "http_status", "received_at", "message_date",
])

export type Logger = (fields: SafeLogFields) => void

export const safeLog: Logger = (fields) => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.has(k as keyof SafeLogFields) && v !== undefined) out[k] = v
  }
  console.log(JSON.stringify(out))
}
