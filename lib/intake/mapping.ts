// Project precedence (spec 4.2): caption tag > clarification answer > roster default > Unsorted.
import type { ParsedCaption } from "./caption"
import type { IntakeConfig } from "./config"
import type { MinorsAnswer, Project } from "./types"
import type { RosterEntry } from "./roster"
import { allowedProjects } from "./roster"

export type ProjectDecision =
  | { kind: "resolved"; project: Project; reason: "caption" | "roster_default" }
  | { kind: "ask"; reason: "missing" | "ambiguous" | "not_allowed"; allowed: Project[]; suggested: Project | null }

export function decideProject(caption: ParsedCaption, entry: RosterEntry, cfg: IntakeConfig): ProjectDecision {
  const allowed = allowedProjects(entry, cfg)
  const fallbackSuggestion = entry.default_project ?? (allowed.length === 1 ? allowed[0] : null)
  if (caption.projects.length > 1) return { kind: "ask", reason: "ambiguous", allowed, suggested: null }
  if (caption.projects.length === 1) {
    const p = caption.projects[0]
    if (allowed.includes(p)) return { kind: "resolved", project: p, reason: "caption" }
    return { kind: "ask", reason: "not_allowed", allowed, suggested: fallbackSuggestion }
  }
  if (entry.default_project && allowed.includes(entry.default_project)) {
    return { kind: "resolved", project: entry.default_project, reason: "roster_default" }
  }
  return { kind: "ask", reason: "missing", allowed, suggested: null }
}

export type MinorsDecision = { kind: "known"; answer: MinorsAnswer } | { kind: "ask" }

/** Spec 9.1: ask for Heroes/Kraken unless the caption says; TFC only if the caption suggests youth. */
export function decideMinors(
  project: Project | "unsorted",
  caption: ParsedCaption,
  entry: Pick<RosterEntry, "is_minor">,
  cfg: IntakeConfig,
): MinorsDecision {
  if (entry.is_minor) return { kind: "known", answer: "yes" }
  if (caption.minors) return { kind: "known", answer: caption.minors }
  if (project === "unsorted") return { kind: "known", answer: "not_asked" }
  if (cfg.minorsProjects.has(project)) return { kind: "ask" }
  if (caption.youthHint) return { kind: "ask" }
  return { kind: "known", answer: "not_asked" }
}

export function holdFor(answer: MinorsAnswer): boolean {
  return answer === "yes" || answer === "unknown"
}
