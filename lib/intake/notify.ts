// One-line notices to Chris, at most once per day per kind.
import type { IntakeContext } from "./context"
import { oncePerDay } from "./state"

export async function tellChrisOnce(ctx: IntakeContext, kind: string, text: string): Promise<void> {
  const chris = ctx.cfg.chrisUserId
  if (!chris) return
  const first = await oncePerDay(ctx.stores, "chris", kind, ctx.now()).catch(() => true)
  if (first) await ctx.telegram.sendMessage(chris, text)
}
