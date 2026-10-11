// Telegram Bot API client. Every call checks the response, honours one 429
// retry_after, and never logs a URL (URLs contain the bot token). There is no way to
// pass business_connection_id: the gateway never sends anything as Chris.
import type { Logger } from "./log"

export interface InlineButton { text: string; callback_data: string }

export interface SendOptions {
  buttons?: InlineButton[][]
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<{ ok: boolean; messageId?: number }>
  answerCallbackQuery(id: string, text?: string): Promise<void>
  getFile(fileId: string): Promise<{ filePath: string; fileSize: number | null }>
  downloadFile(filePath: string): Promise<Uint8Array>
}

export class TelegramError extends Error {
  constructor(public code: string, public status?: number) {
    super(code)
  }
}

interface ClientOptions {
  token: string
  log: Logger
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Longest retry_after we are willing to wait (webhook keeps this short). */
  maxRetryAfterS?: number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createTelegram(opts: ClientOptions): TelegramClient {
  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const maxWait = opts.maxRetryAfterS ?? 5
  const api = (method: string) => `https://api.telegram.org/bot${opts.token}/${method}`

  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response
      try {
        res = await doFetch(api(method), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      } catch {
        throw new TelegramError("tg_network_error")
      }
      let json: { ok?: boolean; result?: T; parameters?: { retry_after?: number } } = {}
      try {
        json = await res.json()
      } catch {
        // Non-JSON body; handled by status below.
      }
      if (res.ok && json.ok) return json.result as T
      const retryAfter = json.parameters?.retry_after
      if (res.status === 429 && attempt === 0 && typeof retryAfter === "number" && retryAfter <= maxWait) {
        await sleep(retryAfter * 1000)
        continue
      }
      throw new TelegramError(res.status === 429 ? "tg_rate_limited" : "tg_api_error", res.status)
    }
    throw new TelegramError("tg_rate_limited", 429)
  }

  return {
    async sendMessage(chatId, text, sendOpts) {
      const body: Record<string, unknown> = { chat_id: chatId, text }
      if (sendOpts?.buttons) body.reply_markup = { inline_keyboard: sendOpts.buttons }
      try {
        const r = await call<{ message_id: number }>("sendMessage", body)
        return { ok: true, messageId: r?.message_id }
      } catch (e) {
        const err = e as TelegramError
        opts.log({ event: "telegram_send", outcome: "failed", error_code: err.code, http_status: err.status })
        return { ok: false }
      }
    },
    async answerCallbackQuery(id, text) {
      try {
        await call("answerCallbackQuery", text ? { callback_query_id: id, text } : { callback_query_id: id })
      } catch (e) {
        const err = e as TelegramError
        opts.log({ event: "telegram_answer_callback", outcome: "failed", error_code: err.code, http_status: err.status })
      }
    },
    async getFile(fileId) {
      const r = await call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId })
      if (!r?.file_path) throw new TelegramError("tg_no_file_path")
      return { filePath: r.file_path, fileSize: r.file_size ?? null }
    },
    async downloadFile(filePath) {
      let res: Response
      try {
        res = await doFetch(`https://api.telegram.org/file/bot${opts.token}/${filePath}`)
      } catch {
        throw new TelegramError("tg_download_network_error")
      }
      if (!res.ok) throw new TelegramError("tg_download_failed", res.status)
      return new Uint8Array(await res.arrayBuffer())
    },
  }
}
