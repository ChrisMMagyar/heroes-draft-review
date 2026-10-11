import { describe, expect, it } from "vitest"
import type { IntakeJob } from "../lib/intake/types"
import type { Pending } from "../lib/intake/resolve"
import { handleUpdate } from "../lib/intake/gateway"
import { runSweeper } from "../lib/intake/sweeper"
import { runWorker, settleAlbums } from "../lib/intake/worker"
import { CHRIS, COACH, TFC_COACH, makeCtx, msg, photo, update, type TestCtx } from "./helpers"

async function jobs(ctx: TestCtx): Promise<IntakeJob[]> {
  const out: IntakeJob[] = []
  for (const k of await ctx.stores.queue.list()) out.push((await ctx.stores.queue.getJSON<IntakeJob>(k))!.value)
  return out
}

async function onlyPending(ctx: TestCtx): Promise<Pending> {
  const keys = await ctx.stores.pending.list()
  expect(keys).toHaveLength(1)
  return (await ctx.stores.pending.getJSON<Pending>(keys[0]))!.value
}

function tap(from: number, data: string) {
  return update({ callback_query: { id: `cb${Math.random()}`, from: { id: from }, data } })
}

describe("photo intake flow", () => {
  it("T1: roster coach, #kraken who: Test Person drill -> queued with the right name and one-line reply", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(COACH, { photo: photo(ctx.telegram), caption: "#kraken who: Test Person drill" }) }), ctx)
    // Kraken asks the minors question first.
    const p = await onlyPending(ctx)
    expect(p.current).toBe("minors")
    expect(ctx.telegram.to(COACH)[0].text).toBe("Is anyone under 18 in this?")
    await handleUpdate(tap(COACH, `m:${p.id}:no`), ctx)
    const [job] = await jobs(ctx)
    expect(job.resolution).toMatchObject({ project: "kraken", mappingReason: "caption", people: ["Test Person"], description: "drill", minorsAnswer: "no", hold: false })
    expect(ctx.telegram.to(COACH).at(-1)?.text).toBe("Got it, Mike: 1 photo for Kraken. Filing now.")
    expect(ctx.kicks).toBe(1)

    await runWorker(ctx)
    expect(ctx.google.files.map((f) => f.name)).toEqual(["Test-Person_drill_2026-10-10.jpg", "Test-Person_drill_2026-10-10.json"])
    expect(ctx.google.files[0].parentId).toBe("F_KRAKEN")
    expect(ctx.google.rows).toHaveLength(1)
    expect(ctx.telegram.to(COACH).at(-1)?.text).toBe("Filed 1 to Kraken intake.")
    expect(await ctx.stores.queue.list()).toHaveLength(0)
  })

  it("T3: no caption from Chris -> project question -> person question -> filed", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(CHRIS, { photo: photo(ctx.telegram) }) }), ctx)
    let p = await onlyPending(ctx)
    expect(p.current).toBe("project")
    const q = ctx.telegram.to(CHRIS)[0]
    expect(q.text).toBe("Which project is this for?")
    expect(q.opts?.buttons?.[0].map((b) => b.text)).toEqual(["Heroes", "TFC", "Kraken", "Not sure"])
    await handleUpdate(tap(CHRIS, `p:${p.id}:tfc`), ctx)
    p = await onlyPending(ctx)
    expect(p.current).toBe("person")
    await handleUpdate(update({ message: msg(CHRIS, { text: "Chris Magyar" }) }), ctx)
    const [job] = await jobs(ctx)
    expect(job.resolution).toMatchObject({ project: "tfc", mappingReason: "clarified", people: ["Chris Magyar"], minorsAnswer: "not_asked" })
    await runWorker(ctx)
    expect(ctx.google.files[0].name).toBe("Chris-Magyar_photo_2026-10-10.jpg")
    expect(ctx.telegram.to(CHRIS).at(-1)?.text).toBe("Filed 1 to TFC intake. https://drive.google.com/drive/folders/F_TFC")
  })

  it("'Not sure' files to Unsorted right away", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(CHRIS, { photo: photo(ctx.telegram) }) }), ctx)
    const p = await onlyPending(ctx)
    await handleUpdate(tap(CHRIS, `p:${p.id}:unsure`), ctx)
    const [job] = await jobs(ctx)
    expect(job.resolution).toMatchObject({ project: "unsorted", mappingReason: "not_sure" })
  })

  it("text fallback answers (1/2/3) work without buttons", async () => {
    const ctx = makeCtx({ INTAKE_ASK_PERSON: "false" })
    await handleUpdate(update({ message: msg(CHRIS, { photo: photo(ctx.telegram) }) }), ctx)
    await handleUpdate(update({ message: msg(CHRIS, { text: "2" }) }), ctx)
    const [job] = await jobs(ctx)
    expect(job.resolution.project).toBe("tfc")
  })

  it("stale or foreign button taps are refused", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(CHRIS, { photo: photo(ctx.telegram) }) }), ctx)
    const p = await onlyPending(ctx)
    await handleUpdate(tap(COACH, `p:${p.id}:kraken`), ctx)
    await handleUpdate(tap(CHRIS, `m:${p.id}:yes`), ctx)
    expect(ctx.telegram.answered.map((a) => a.text)).toEqual(["That question has expired.", "That question has expired."])
    expect(await jobs(ctx)).toHaveLength(0)
  })

  it("caption names a project the sender can't post for -> asks instead of guessing", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(TFC_COACH, { photo: photo(ctx.telegram), caption: "#kraken sparring who: Al B" }) }), ctx)
    expect(ctx.telegram.to(TFC_COACH)[0].text).toBe("You're set up for TFC. File this under TFC?")
  })

  it("T4: reminder at 4 h, Unsorted at 24 h with clarification_timeout", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(CHRIS, { photo: photo(ctx.telegram) }) }), ctx)
    ctx.clock.t += 4 * 3600_000 + 1000
    await runSweeper(ctx)
    expect(ctx.telegram.to(CHRIS).at(-1)?.text).toBe("Still need to know which project this is for.")
    ctx.clock.t += 3600_000
    expect((await runSweeper(ctx)).reminders).toBe(0)
    ctx.clock.t += 20 * 3600_000
    expect((await runSweeper(ctx)).timeouts).toBe(1)
    const [job] = await jobs(ctx)
    expect(job.resolution).toMatchObject({ project: "unsorted", mappingReason: "timeout", timedOut: true, people: [] })
    await runWorker(ctx)
    expect(ctx.google.files[0]).toMatchObject({ name: "Unnamed_photo_2026-10-10.jpg", parentId: "F_UNSORTED" })
    const row = ctx.google.rows.find((r) => r.tab === "Intake")!.row
    expect(row).toContain("filed_unsorted")
    // The sweeper writes one Daily row per finished day (numbers only).
    expect(ctx.google.rows.filter((r) => r.tab === "Daily").map((r) => r.row[0])).toEqual(["2026-10-09", "2026-10-10"])
    expect(row.join(" ")).toContain("clarification_timeout")
  })

  it("an unanswered minors question at timeout means held", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(COACH, { photo: photo(ctx.telegram), caption: "who: A B drill" }) }), ctx)
    ctx.clock.t += 25 * 3600_000
    await runSweeper(ctx)
    const [job] = await jobs(ctx)
    expect(job.resolution).toMatchObject({ project: "kraken", minorsAnswer: "unknown", hold: true, consentStatus: "pending" })
  })

  it("questions never overlap: a second upload waits behind the open one", async () => {
    const ctx = makeCtx({ INTAKE_ASK_PERSON: "false" })
    await handleUpdate(update({ message: msg(CHRIS, { photo: photo(ctx.telegram) }) }), ctx)
    await handleUpdate(update({ message: msg(CHRIS, { photo: photo(ctx.telegram) }) }), ctx)
    expect(ctx.telegram.to(CHRIS)).toHaveLength(1)
    const first = (await ctx.stores.pending.getJSON<Pending>((await ctx.stores.pending.list())[0]))!.value
    await handleUpdate(tap(CHRIS, `p:${first.id}:tfc`), ctx)
    const texts = ctx.telegram.to(CHRIS).map((m) => m.text)
    expect(texts.slice(1)).toEqual(["Got it, Chris: 1 photo for TFC. Filing now.", "Which project is this for?"])
  })

  it("T5: album of 5, caption on item 1 -> one question at most, shared caption, 5 files -01..-05", async () => {
    const ctx = makeCtx()
    for (let i = 0; i < 5; i++) {
      await handleUpdate(update({ message: msg(COACH, { photo: photo(ctx.telegram), media_group_id: "album1", ...(i === 0 ? { caption: "who: Mike Ross open mat #nominors" } : {}) }) }), ctx)
    }
    expect(await ctx.stores.incoming.list()).toHaveLength(5)
    expect(await settleAlbums(ctx)).not.toBeNull()
    ctx.clock.t += 6000
    await settleAlbums(ctx)
    expect(ctx.telegram.to(COACH).map((m) => m.text)).toEqual(["Got it, Mike: 5 photos for Kraken. Filing now."])
    await runWorker(ctx)
    const media = ctx.google.files.filter((f) => f.name.endsWith(".jpg")).map((f) => f.name)
    expect(media).toEqual([1, 2, 3, 4, 5].map((n) => `Mike-Ross_open-mat_2026-10-10-0${n}.jpg`))
    expect(ctx.google.files.filter((f) => f.name.endsWith(".json"))).toHaveLength(5)
    expect(ctx.telegram.to(COACH).at(-1)?.text).toBe("Filed 5 to Kraken intake.")
  })

  it("T10: minors = yes -> HOLD folder, HOLD_ prefix, consent pending", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(COACH, { photo: photo(ctx.telegram), caption: "#heroes kids class warmup who: Group" }) }), ctx)
    const p = await onlyPending(ctx)
    await handleUpdate(tap(COACH, `m:${p.id}:yes`), ctx)
    expect(ctx.telegram.to(COACH).at(-1)?.text).toBe("Got it, Mike: 1 photo for Heroes, held until consent is recorded. Filing now.")
    await runWorker(ctx)
    const hold = ctx.google.folders.find((f) => f.name === "HOLD — Minor Consent Pending")!
    expect(hold.parentId).toBe("F_HEROES")
    expect(ctx.google.files[0]).toMatchObject({ name: "HOLD_Group_kids-class-warmup_2026-10-10.jpg", parentId: hold.id })
    const row = ctx.google.rows[0].row
    expect(row).toContain("held_minor")
    expect(row).toContain("pending")
  })

  it("kill switch flipped while a question is open: taps get 'paused', nothing happens", async () => {
    const ctx = makeCtx()
    await handleUpdate(update({ message: msg(CHRIS, { photo: photo(ctx.telegram) }) }), ctx)
    const p = await onlyPending(ctx)
    ctx.cfg.intakeEnabled = false
    await handleUpdate(tap(CHRIS, `p:${p.id}:tfc`), ctx)
    expect(ctx.telegram.answered.at(-1)?.text).toBe("Photo intake is paused.")
    expect(await jobs(ctx)).toHaveLength(0)
    expect((await runWorker(ctx)).stopped).toBe("disabled")
    expect((await runSweeper(ctx)).timeouts).toBe(0)
  })
})
