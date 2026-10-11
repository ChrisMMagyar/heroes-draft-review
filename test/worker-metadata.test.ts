import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { IntakeJob } from "../lib/intake/types"
import type { Pending } from "../lib/intake/resolve"
import { handleUpdate } from "../lib/intake/gateway"
import { extractMetadata, exifDateToIso } from "../lib/intake/metadata"
import { parseIso6709, parseMp4 } from "../lib/intake/mp4"
import { INTAKE_COLUMNS } from "../lib/intake/sheet"
import { runSweeper } from "../lib/intake/sweeper"
import { FAILURE_REPLY, runWorker } from "../lib/intake/worker"
import { CHRIS, COACH, document, fixture, makeCtx, msg, photo, update, type TestCtx } from "./helpers"

const col = (row: (string | number)[], name: (typeof INTAKE_COLUMNS)[number]) => row[INTAKE_COLUMNS.indexOf(name)]
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const COORD_PATTERNS = ["36.16", "86.78", "-86", "36°"]

async function send(ctx: TestCtx, fields: Record<string, unknown>, from = COACH) {
  await handleUpdate(update({ message: msg(from, fields) }), ctx)
}

describe("metadata extraction (spec 8A)", () => {
  it("reads EXIF capture time with offset, device and GPS from an original file", async () => {
    const r = await extractMetadata(fixture("exif-original.jpg"), { mediaType: "image_document", width: null, height: null, durationS: null } as never)
    expect(r.error).toBeNull()
    expect(r.metadata).toMatchObject({
      capture_time: "2026-10-08T14:30:05-05:00",
      capture_time_ct: "2026-10-08 14:30:05",
      device_make: "TestCam",
      device_model: "Model T1",
    })
    expect(r.metadata.gps?.latitude).toBeCloseTo(36.1627, 3)
    expect(r.metadata.gps?.longitude).toBeCloseTo(-86.7816, 3)
    expect(r.metadata.gps?.altitude).toBe(150)
  })
  it("a Telegram-compressed photo has no EXIF: fields are null, never guessed", async () => {
    const r = await extractMetadata(fixture("exif-stripped.jpg"), { mediaType: "photo", width: 32, height: 24, durationS: null } as never)
    expect(r.error).toBeNull()
    expect(r.metadata).toMatchObject({ capture_time: null, device_make: null, gps: null, width_px: 32, height_px: 24 })
  })
  it("garbage bytes: filing goes ahead with metadata_error", async () => {
    const r = await extractMetadata(new Uint8Array([1, 2, 3]), { mediaType: "image_document", width: null, height: null, durationS: null } as never)
    expect(r.metadata.capture_time).toBeNull()
  })
  it("exif date conversion", () => {
    expect(exifDateToIso("2026:10:08 14:30:05", undefined)).toBe("2026-10-08T14:30:05")
    expect(exifDateToIso("nope", undefined)).toBeNull()
  })
})

describe("MP4 reader", () => {
  it("reads duration, size, frame rate, codec, creation time, device and location", () => {
    const v = parseMp4(fixture("video-original.mp4"))
    expect(v).toMatchObject({ durationS: 1, width: 64, height: 48, frameRate: 10, codec: "mp4v", creationTime: "2026-10-08T15:30:00.000Z", make: "TestCam", model: "Model T1" })
    expect(v.location).toEqual({ latitude: 36.1627, longitude: -86.7816, altitude: null })
  })
  it("a stripped video still has duration and resolution but no device or location", () => {
    const v = parseMp4(fixture("video-stripped.mp4"))
    expect(v).toMatchObject({ durationS: 1, width: 64, height: 48, make: null, model: null, location: null })
  })
  it("ISO 6709 parsing and non-MP4 input", () => {
    expect(parseIso6709("+37.3317-122.0302+010.000/")).toEqual({ latitude: 37.3317, longitude: -122.0302, altitude: 10 })
    expect(parseMp4(new Uint8Array([0, 0, 0, 1, 2, 3])).durationS).toBeNull()
  })
})

describe("worker", () => {
  it("T18: same image as compressed photo vs as file -> stripped vs original; no coordinates in log rows", async () => {
    const ctx = makeCtx()
    const original = fixture("exif-original.jpg")
    await send(ctx, { photo: photo(ctx.telegram, fixture("exif-stripped.jpg")), caption: "who: Test Person compressed #nominors" })
    await send(ctx, { document: document(ctx.telegram, original, "image/jpeg", "IMG_0001.JPG"), caption: "who: Test Person asfile #nominors" })
    await runWorker(ctx)
    const photoSide = ctx.google.sidecarFor("Test-Person_compressed_2026-10-10.jpg")
    const fileSide = ctx.google.sidecarFor("Test-Person_asfile_2026-10-10.jpg")
    expect(photoSide).toMatchObject({ schema: "intake-metadata/1", metadata_source: "stripped-by-Telegram" })
    expect(photoSide.metadata).toMatchObject({ capture_time: null, device_make: null, gps: null })
    expect(fileSide.metadata_source).toBe("original")
    expect(fileSide.metadata.capture_time).toBe("2026-10-08T14:30:05-05:00")
    expect(fileSide.metadata.device_model).toBe("Model T1")
    expect(fileSide.metadata.gps.latitude).toBeCloseTo(36.1627, 3)
    expect(fileSide.telegram.original_filename).toBe("IMG_0001.JPG")
    const rows = ctx.google.rows.filter((r) => r.tab === "Intake").map((r) => r.row)
    expect(rows.map((r) => col(r, "gps_present"))).toEqual(["no", "yes"])
    expect(rows.map((r) => col(r, "metadata_source"))).toEqual(["stripped-by-Telegram", "original"])
    expect(col(rows[1], "device")).toBe("TestCam Model T1")
    expect(col(rows[1], "notes")).toBe("")
    for (const r of rows) for (const c of COORD_PATTERNS) expect(r.join("|")).not.toContain(c)
    // No send-as-file tip, ever (Chris, 2026-10-10).
    for (const m of ctx.telegram.sent) expect(m.text.toLowerCase()).not.toMatch(/as (a )?file|send.*file|document/)
  })

  it("T2: a document is saved byte-for-byte (checksum matches)", async () => {
    const ctx = makeCtx()
    const bytes = fixture("exif-original.jpg")
    await send(ctx, { document: document(ctx.telegram, bytes, "image/jpeg", "a.jpg"), caption: "who: A B x #nominors" })
    await runWorker(ctx)
    expect(sha(ctx.google.files[0].bytes)).toBe(sha(bytes))
    expect(ctx.google.files[0].appProperties).toMatchObject({ telegram_file_unique_id: expect.any(String), intake_id: expect.stringMatching(/^INT-/) })
  })

  it("T19: MP4 sent as video vs as file -> duration/resolution both, device only where kept", async () => {
    const ctx = makeCtx()
    const vid = fixture("video-original.mp4")
    ctx.telegram.files.set("vid1", fixture("video-stripped.mp4"))
    await send(ctx, { video: { file_id: "vid1", file_unique_id: "vid1u", width: 64, height: 48, duration: 1, file_size: 5000, mime_type: "video/mp4" }, caption: "who: A B asvideo #nominors" })
    await send(ctx, { document: document(ctx.telegram, vid, "video/mp4", "clip.mp4"), caption: "who: A B asfile #nominors" })
    await runWorker(ctx)
    const asVideo = ctx.google.sidecarFor("A-B_asvideo_2026-10-10.mp4")
    const asFile = ctx.google.sidecarFor("A-B_asfile_2026-10-10.mp4")
    expect(asVideo.metadata_source).toBe("stripped-by-Telegram")
    expect(asVideo.metadata.video.duration_s).toBe(1)
    expect(asVideo.metadata.width_px).toBe(64)
    expect(asVideo.metadata.device_make).toBeNull()
    expect(asFile.metadata_source).toBe("original")
    expect(asFile.metadata).toMatchObject({ device_make: "TestCam", capture_time: "2026-10-08T15:30:00.000Z", video: { duration_s: 1, frame_rate: 10, codec: "mp4v" } })
    const rows = ctx.google.rows.filter((r) => r.tab === "Intake").map((r) => r.row)
    expect(rows.map((r) => col(r, "duration_s"))).toEqual(["1", "1"])
    expect(rows.map((r) => col(r, "gps_present"))).toEqual(["no", "yes"])
  })

  it("T20: held item with GPS -> photo and sidecar both in HOLD; coordinates only in that sidecar", async () => {
    const ctx = makeCtx()
    await send(ctx, { document: document(ctx.telegram, fixture("exif-original.jpg"), "image/jpeg", "k.jpg"), caption: "#heroes kids who: Group #minor" })
    await runWorker(ctx)
    const hold = ctx.google.folders.find((f) => f.name === "HOLD — Minor Consent Pending")!
    expect(ctx.google.files.map((f) => [f.name, f.parentId])).toEqual([
      ["HOLD_Group_kids_2026-10-10.jpg", hold.id],
      ["HOLD_Group_kids_2026-10-10.json", hold.id],
    ])
    const everythingElse = JSON.stringify([ctx.google.rows, ctx.telegram.sent, ctx.logs])
    for (const c of ["36.16", "-86.78"]) expect(everythingElse).not.toContain(c)
    expect(JSON.stringify(ctx.google.sidecarFor("HOLD_Group_kids_2026-10-10.jpg"))).toContain("36.16")
  })

  it("T21: every filed item has a same-name .json sidecar in the same folder, linked from the row", async () => {
    const ctx = makeCtx()
    for (let i = 0; i < 3; i++) await send(ctx, { photo: photo(ctx.telegram), caption: "who: A B same #nominors" })
    await runWorker(ctx)
    const media = ctx.google.files.filter((f) => f.name.endsWith(".jpg"))
    expect(media.map((m) => m.name)).toEqual(["A-B_same_2026-10-10.jpg", "A-B_same_2026-10-10-02.jpg", "A-B_same_2026-10-10-03.jpg"])
    const rows = ctx.google.rows.filter((r) => r.tab === "Intake").map((r) => r.row)
    for (const m of media) {
      const side = ctx.google.files.find((f) => f.name === m.name.replace(".jpg", ".json"))!
      expect(side.parentId).toBe(m.parentId)
      const row = rows.find((r) => col(r, "drive_file_id") === m.id)!
      expect(col(row, "sidecar_drive_id")).toBe(side.id)
      expect(col(row, "sidecar_link")).toContain(side.id)
      expect(col(row, "handoff_status")).toBe("pending")
      expect(col(row, "handoff_to")).toBe("Kraken Web Content")
      expect(ctx.google.sidecarFor(m.name).media_drive_file_id).toBe(m.id)
    }
  })

  it("EXIF date more than 2 days from the name date is noted, name unchanged", async () => {
    const ctx = makeCtx()
    await send(ctx, { document: document(ctx.telegram, fixture("exif-original.jpg"), "image/jpeg", "a.jpg"), caption: "who: A B x date: 2026-10-01 #nominors" })
    await runWorker(ctx)
    expect(ctx.google.files[0].name).toBe("A-B_x_2026-10-01.jpg")
    expect(col(ctx.google.rows[0].row, "notes")).toBe("exif_date_differs:2026-10-08")
  })

  it("T13: revoked Google grant -> job stays queued, Chris told once, nothing lost", async () => {
    const ctx = makeCtx()
    await send(ctx, { photo: photo(ctx.telegram), caption: "who: A B x #nominors" })
    ctx.google.authError = true
    expect((await runWorker(ctx)).stopped).toBe("auth_paused")
    expect((await runWorker(ctx)).stopped).toBe("auth_paused")
    expect(await ctx.stores.queue.list()).toHaveLength(1)
    expect(ctx.telegram.to(CHRIS).filter((m) => m.text.includes("Google grant"))).toHaveLength(1)
    ctx.google.authError = false
    await runWorker(ctx)
    expect(await ctx.stores.queue.list()).toHaveLength(0)
    expect(ctx.google.files).toHaveLength(2)
  })

  it("retries with backoff, then fails: sender gets the failure line, Chris gets the intake_id", async () => {
    const ctx = makeCtx()
    await send(ctx, { photo: photo(ctx.telegram), caption: "who: A B x #nominors" })
    ctx.telegram.failGetFile = 99
    // 30 s and 2 min retries happen inside one run; the 10 min one waits for a later run (sweeper).
    await runWorker(ctx)
    expect(await ctx.stores.queue.list()).toHaveLength(1)
    ctx.clock.t += 11 * 60_000
    await runWorker(ctx)
    expect(await ctx.stores.queue.list()).toHaveLength(0)
    const job = ctx.google.rows.find((r) => r.tab === "Intake")!.row
    expect(col(job, "status")).toBe("failed")
    expect(ctx.telegram.to(COACH).at(-1)?.text).toBe(FAILURE_REPLY)
    expect(ctx.telegram.to(CHRIS).at(-1)?.text).toMatch(/^Photo intake couldn't file INT-[0-9A-Z]+ \(tg_api_error\)\.$/)
  })

  it("a transient failure recovers on retry without duplicate uploads", async () => {
    const ctx = makeCtx()
    await send(ctx, { photo: photo(ctx.telegram), caption: "who: A B x #nominors" })
    const append = ctx.google.appendRows.bind(ctx.google)
    let fails = 1
    ctx.google.appendRows = async (...a) => { if (fails-- > 0) throw Object.assign(new Error("x"), { code: "google_api_error" }); return append(...a) }
    await runWorker(ctx)
    expect(ctx.google.files).toHaveLength(2)
    expect(ctx.google.rows.filter((r) => r.tab === "Intake")).toHaveLength(1)
    expect(await ctx.stores.queue.list()).toHaveLength(0)
  })

  it("a second worker does nothing while the lock is held; the sweeper restarts a stuck one", async () => {
    const ctx = makeCtx()
    await send(ctx, { photo: photo(ctx.telegram), caption: "who: A B x #nominors" })
    await ctx.stores.lock.setJSON("worker", { owner: "other", expiresAt: ctx.clock.t + 60_000 })
    expect((await runWorker(ctx)).stopped).toBe("locked")
    const kicksBefore = ctx.kicks
    expect((await runSweeper(ctx)).workerKicked).toBe(false)
    ctx.clock.t += 11 * 60_000
    expect((await runSweeper(ctx)).workerKicked).toBe(true)
    expect(ctx.kicks).toBe(kicksBefore + 1)
    expect((await runWorker(ctx)).processed).toBe(1)
  })

  it("the sweeper prunes old de-dupe markers even while intake is off", async () => {
    const ctx = makeCtx({ INTAKE_ENABLED: "false" })
    await ctx.stores.seen.setJSON("u/2026-10-01/5", { at: 0 })
    await ctx.stores.seen.setJSON("u/2026-10-10/6", { at: 0 })
    ctx.clock.t = Date.parse("2026-10-10T18:01:00Z")
    const r = await runSweeper(ctx)
    expect(r.pruned).toBe(1)
    expect(await ctx.stores.seen.list("u/")).toEqual(["u/2026-10-10/6"])
    expect(ctx.google.rows).toHaveLength(0)
  })
})

export type { IntakeJob, Pending }
