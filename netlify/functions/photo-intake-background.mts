// Background worker (the "-background" filename makes Netlify run it for up to 15 minutes
// and answer the caller with 202 at once). Started by the webhook and the sweeper with
// the INTAKE_WORKER_SECRET header. Does nothing unless INTAKE_ENABLED is "true".
import type { Context } from "@netlify/functions"
import { WORKER_SECRET_HEADER, buildContext } from "../../lib/intake/context"
import { safeEqual } from "../../lib/intake/secure"
import { runWorker } from "../../lib/intake/worker"

export default async (req: Request, _context: Context) => {
  const ctx = buildContext((name) => Netlify.env.get(name), { baseUrl: new URL(req.url).origin, maxRetryAfterS: 30 })
  if (req.method !== "POST" || !safeEqual(req.headers.get(WORKER_SECRET_HEADER), ctx.cfg.workerSecret)) {
    ctx.log({ event: "worker", outcome: "unauthorized" })
    return
  }
  try {
    const r = await runWorker(ctx)
    ctx.log({ event: "worker", outcome: r.stopped, count: r.processed })
  } catch (e) {
    // Never throw: Netlify retries failed background invocations, and the sweeper restarts us anyway.
    ctx.log({ event: "worker", outcome: "error", error_code: e instanceof Error ? e.constructor.name : "unknown" })
  }
}
