import { describe, expect, it } from "vitest"
import { parseCaption } from "../lib/intake/caption"
import { loadConfig } from "../lib/intake/config"
import { decideMinors, decideProject } from "../lib/intake/mapping"
import { capabilitiesFor, findByUserId, findByUsername, isIntakeEnabled, parseRoster } from "../lib/intake/roster"
import { BASE_ENV, CHRIS, COACH, ROSTER, TFC_COACH } from "./helpers"

const cfg = loadConfig((n) => BASE_ENV[n])
const NOW = new Date("2026-10-10T17:00:00Z")
const entries = parseRoster(JSON.stringify(ROSTER))
if (!entries.ok) throw new Error("bad roster")
const chris = findByUserId(entries.entries, CHRIS)!
const coach = findByUserId(entries.entries, COACH)!
const tfc = findByUserId(entries.entries, TFC_COACH)!

describe("roster", () => {
  it("matches by numeric id only", () => {
    expect(findByUserId(entries.entries, COACH)?.name).toBe("Mike Ross")
    expect(findByUserId(entries.entries, 424242)).toBeUndefined()
  })
  it("legacy username match never matches a sender without a username (F4)", () => {
    expect(findByUsername(entries.entries, { id: 1 })).toBeUndefined()
    expect(findByUsername(entries.entries, { id: 1, username: "LegacyPal" })?.name).toBe("Legacy Pal")
    expect(findByUsername(parseRoster(JSON.stringify([{ name: "No Username", authorized: true }])).ok ? [{ name: "No Username", authorized: true }] : [], { id: 1 })).toBeUndefined()
  })
  it("malformed roster fails closed", () => {
    expect(parseRoster("{not json").ok).toBe(false)
    expect(parseRoster("{}").ok).toBe(false)
    expect(parseRoster(JSON.stringify([{ name: "A", user_id: "12" }])).ok).toBe(false)
    expect(parseRoster(undefined)).toEqual({ ok: true, entries: [] })
  })
  it("capability tiers: owner everything, coach four, others none", () => {
    expect(capabilitiesFor(chris, cfg).has("all")).toBe(true)
    expect([...capabilitiesFor(coach, cfg)].sort()).toEqual(["course_pdf", "doctrine_question", "own_bio_proposal", "photo_intake"])
    expect(capabilitiesFor(undefined, cfg).size).toBe(0)
    expect(capabilitiesFor({ name: "x", authorized: false }, cfg).size).toBe(0)
  })
  it("intake needs authorized + intake + numeric id", () => {
    expect(isIntakeEnabled(coach, cfg)).toBe(true)
    expect(isIntakeEnabled({ name: "x", username: "x", authorized: true, intake: true, default_project: "tfc" }, cfg)).toBe(false)
    expect(isIntakeEnabled({ name: "x", user_id: 5, authorized: true, default_project: "tfc" }, cfg)).toBe(false)
  })
})

describe("project precedence (spec 4.2)", () => {
  it("caption tag wins when allowed", () => {
    expect(decideProject(parseCaption("#heroes x", NOW), coach, cfg)).toEqual({ kind: "resolved", project: "heroes", reason: "caption" })
  })
  it("roster default when no tag", () => {
    expect(decideProject(parseCaption("drill", NOW), coach, cfg)).toEqual({ kind: "resolved", project: "kraken", reason: "roster_default" })
  })
  it("asks when the tag isn't allowed", () => {
    expect(decideProject(parseCaption("#kraken sparring", NOW), tfc, cfg)).toMatchObject({ kind: "ask", reason: "not_allowed", suggested: "tfc" })
  })
  it("asks when two tags", () => {
    expect(decideProject(parseCaption("#kraken #heroes", NOW), coach, cfg)).toMatchObject({ kind: "ask", reason: "ambiguous" })
  })
  it("asks Chris (no default) when nothing says", () => {
    expect(decideProject(parseCaption("", NOW), chris, cfg)).toMatchObject({ kind: "ask", reason: "missing", allowed: ["heroes", "tfc", "kraken"] })
  })
})

describe("minors question (spec 9.1)", () => {
  it("asked for Heroes and Kraken, TFC only with a youth hint", () => {
    expect(decideMinors("kraken", parseCaption("x", NOW), coach, cfg)).toEqual({ kind: "ask" })
    expect(decideMinors("tfc", parseCaption("range", NOW), tfc, cfg)).toEqual({ kind: "known", answer: "not_asked" })
    expect(decideMinors("tfc", parseCaption("youth range", NOW), tfc, cfg)).toEqual({ kind: "ask" })
  })
  it("caption answer and minor senders", () => {
    expect(decideMinors("heroes", parseCaption("#nominors", NOW), coach, cfg)).toEqual({ kind: "known", answer: "no" })
    expect(decideMinors("tfc", parseCaption("", NOW), { is_minor: true }, cfg)).toEqual({ kind: "known", answer: "yes" })
  })
})
