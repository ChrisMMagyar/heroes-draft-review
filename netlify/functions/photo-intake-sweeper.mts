// Scheduled every 5 minutes. Scheduled functions run only on the published production
// deploy, never on branch or preview deploys. While INTAKE_ENABLED is not "true" it only
// prunes old de-dupe markers (at most once an hour) and exits.
import type { Config, Context } from "@netlify/functions"
import { buildContext } from "../../lib/intake/context"
import { runSweeper } from "../../lib/intake/sweeper"

export default async (_req: Request, context: Context) => {
  const ctx = buildContext((name) => Netlify.env.get(name), { baseUrl: context.site?.url, maxRetryAfterS: 5 })
  try {
    const r = await runSweeper(ctx)
    if (r.reminders || r.timeouts || r.workerKicked || r.dailyWritten) {
      ctx.log({ event: "sweeper", outcome: "ok", count: r.reminders + r.timeouts })
    }
  } catch (e) {
    ctx.log({ event: "sweeper", outcome: "error", error_code: e instanceof Error ? e.constructor.name : "unknown" })
  }
}

export const config: Config = { schedule: "*/5 * * * *" }
