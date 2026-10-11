// Telegram webhook for kraken_gateway_bot. Route unchanged (/telegram-gateway), so the
// Telegram webhook registration does not need to change.
// All photo intake behaviour stays OFF unless INTAKE_ENABLED is "true" (see docs/telegram-intake.md).
import type { Config, Context } from "@netlify/functions"
import { buildContext } from "../../lib/intake/context"
import { handleWebhook } from "../../lib/intake/gateway"

export default async (req: Request, _context: Context) => {
  // The worker is started on this same deploy (keeps branch deploys away from production).
  const ctx = buildContext((name) => Netlify.env.get(name), { baseUrl: new URL(req.url).origin, maxRetryAfterS: 3 })
  return handleWebhook(req, ctx)
}

export const config: Config = { path: "/telegram-gateway" }
