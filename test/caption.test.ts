import { describe, expect, it } from "vitest"
import { parseCaption, parseCaptionDate } from "../lib/intake/caption"
import { redact } from "../lib/intake/redact"

const NOW = new Date("2026-10-10T17:00:00Z")

describe("caption parser (spec 4.3 / 4.5)", () => {
  it("who: name then description", () => {
    const c = parseCaption("who: Mike Ross clinch drill at Heroes 280", NOW)
    expect(c.people).toEqual(["Mike Ross"])
    expect(c.description).toBe("clinch drill at Heroes 280")
    expect(c.projects).toEqual([])
  })
  it("project hashtag with kids hint", () => {
    const c = parseCaption("#heroes kids class warmup", NOW)
    expect(c.projects).toEqual(["heroes"])
    expect(c.people).toEqual([])
    expect(c.description).toBe("kids class warmup")
    expect(c.youthHint).toBe(true)
  })
  it("leading project word, who and date", () => {
    const c = parseCaption("TFC range day, who: Chris Magyar, date: 10/8", NOW)
    expect(c.projects).toEqual(["tfc"])
    expect(c.people).toEqual(["Chris Magyar"])
    expect(c.description).toBe("range day")
    expect(c.date).toBe("2026-10-08")
  })
  it("two project tags are ambiguous", () => {
    expect(parseCaption("#kraken #tfc seminar", NOW).projects).toEqual(["kraken", "tfc"])
  })
  it("aliases and key form", () => {
    expect(parseCaption("#firearms qual", NOW).projects).toEqual(["tfc"])
    expect(parseCaption("#KC open mat", NOW).projects).toEqual(["kraken"])
    expect(parseCaption("kraken: sparring", NOW).projects).toEqual(["kraken"])
  })
  it("minors flags", () => {
    expect(parseCaption("#minor kids", NOW).minors).toBe("yes")
    expect(parseCaption("minors: no", NOW).minors).toBe("no")
    expect(parseCaption("#nominors adults", NOW).minors).toBe("no")
  })
  it("several people and mentions", () => {
    expect(parseCaption("who: Jane Doe and Bob Smith sparring", NOW).people).toEqual(["Jane Doe", "Bob Smith"])
    expect(parseCaption("drill with @MikeR", NOW).people).toEqual(["MikeR"])
  })
  it("description is cut to 6 words", () => {
    expect(parseCaption("one two three four five six seven eight", NOW).description).toBe("one two three four five six")
  })
  it("dates", () => {
    expect(parseCaptionDate("2026-10-08", NOW)).toBe("2026-10-08")
    expect(parseCaptionDate("yesterday", NOW)).toBe("2026-10-09")
    expect(parseCaptionDate("12/25", NOW)).toBe("2025-12-25")
    expect(parseCaptionDate("2/30", NOW)).toBeNull()
    expect(parseCaption("warmup yesterday", NOW).date).toBe("2026-10-09")
  })
  it("empty caption", () => {
    expect(parseCaption(undefined, NOW)).toMatchObject({ projects: [], people: [], description: "", date: null })
  })
})

describe("redaction", () => {
  it("removes emails and phone numbers but keeps dates and short numbers", () => {
    const r = redact("call 615-555-0199 or +1 (615) 555 0100, mail jo@example.com, date: 2026-10-08, Heroes 280")
    expect(r).not.toContain("555")
    expect(r).not.toContain("jo@example.com")
    expect(r).toContain("2026-10-08")
    expect(r).toContain("Heroes 280")
  })
  it("caps length at 500", () => {
    expect(redact("a".repeat(900))).toHaveLength(500)
  })
})
