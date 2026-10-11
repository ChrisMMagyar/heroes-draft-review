// Forgiving, case-insensitive caption grammar (spec 4.3).
import type { Project } from "./types"
import { addDays, ctDate, isValidYmd } from "./time"

export interface ParsedCaption {
  projects: Project[]
  people: string[]
  description: string
  date: string | null
  minors: "yes" | "no" | null
  youthHint: boolean
}

const PROJECT_WORDS: Record<string, Project> = {
  heroes: "heroes", tfc: "tfc", firearms: "tfc", kraken: "kraken", kc: "kraken",
}
const NAME_TOKEN = /^\p{Lu}[\p{L}'’.-]*$/u
const YOUTH = /\b(kids?|youth|juniors?|teens?|children|child)\b/i

function addProject(list: Project[], p: Project | undefined) {
  if (p && !list.includes(p)) list.push(p)
}

export function parseCaptionDate(value: string, now: Date): string | null {
  const v = value.trim().toLowerCase()
  const today = ctDate(now)
  if (v === "today") return today
  if (v === "yesterday") return addDays(today, -1)
  if (isValidYmd(v)) return v
  const md = v.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/)
  if (md) {
    const month = Number(md[1])
    const day = Number(md[2])
    let year = md[3] ? Number(md[3].length === 2 ? `20${md[3]}` : md[3]) : Number(today.slice(0, 4))
    let ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    if (!md[3] && ymd > today) {
      year -= 1
      ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    }
    return isValidYmd(ymd) ? ymd : null
  }
  return null
}

function splitNames(segment: string): { people: string[]; rest: string[] } {
  const tokens = segment.split(/\s+/).filter(Boolean)
  if (tokens.length === 1 && /^group$/i.test(tokens[0])) return { people: ["Group"], rest: [] }
  const people: string[] = []
  let current: string[] = []
  let i = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (NAME_TOKEN.test(t)) { current.push(t); continue }
    if ((t.toLowerCase() === "and" || t === "&") && current.length > 0 && NAME_TOKEN.test(tokens[i + 1] ?? "")) {
      people.push(current.join(" "))
      current = []
      continue
    }
    break
  }
  if (current.length > 0) people.push(current.join(" "))
  return { people, rest: tokens.slice(i) }
}

export function parseCaption(caption: string | undefined, now: Date): ParsedCaption {
  const result: ParsedCaption = { projects: [], people: [], description: "", date: null, minors: null, youthHint: false }
  if (!caption || caption.trim() === "") return result
  result.youthHint = YOUTH.test(caption)
  let s = ` ${caption.replace(/[\r\n]+/g, ", ")} `
  const leftovers: string[] = []

  // Minors flags.
  s = s.replace(/#nominors\b|\bminors?:\s*no\b/gi, () => { result.minors = "no"; return " " })
  s = s.replace(/#minors?\b|\bminors?:\s*yes\b/gi, () => { result.minors = "yes"; return " " })

  // Project tags: #heroes, heroes:, #tfc, #firearms, #kraken, #kc.
  s = s.replace(/#(heroes|tfc|firearms|kraken|kc)\b/gi, (_m, w: string) => {
    addProject(result.projects, PROJECT_WORDS[w.toLowerCase()]); return " "
  })
  s = s.replace(/\b(heroes|tfc|kraken):/gi, (_m, w: string) => {
    addProject(result.projects, PROJECT_WORDS[w.toLowerCase()]); return " "
  })

  // date: value
  s = s.replace(/\bdate:\s*([^\s,;]+)/gi, (_m, v: string) => {
    result.date = parseCaptionDate(v, now) ?? result.date; return " "
  })
  s = s.replace(/\b(yesterday|today)\b/gi, (m) => {
    if (!result.date) result.date = parseCaptionDate(m, now)
    return " "
  })

  // who: names (up to the next comma/semicolon). Lower-case words after the names are description.
  s = s.replace(/\bwho:\s*([^,;]*)/gi, (_m, seg: string) => {
    const { people, rest } = splitNames(seg.trim())
    for (const p of people) if (!result.people.includes(p)) result.people.push(p)
    leftovers.push(...rest)
    return " "
  })

  // @Name mentions.
  s = s.replace(/@([\p{L}\d_]+)/gu, (_m, n: string) => {
    if (!result.people.includes(n)) result.people.push(n)
    return " "
  })

  // A leading project word ("Heroes kids class", "TFC range day").
  s = s.replace(/^[\s,;]*(heroes|tfc|kraken)\b/i, (_m, w: string) => {
    addProject(result.projects, PROJECT_WORDS[w.toLowerCase()]); return " "
  })

  const words = [...s.split(/[\s,;]+/), ...leftovers]
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean)
  result.description = words.slice(0, 6).join(" ")
  return result
}
