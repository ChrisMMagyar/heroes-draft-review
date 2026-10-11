// <Person>_<description>_<YYYY-MM-DD>.<ext> (spec 4.4).

/** Letters, digits and hyphens only; diacritics are folded to ASCII. Case is kept. */
export function slug(text: string, maxLength = 60): string {
  const ascii = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  const s = ascii.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return s.length > maxLength ? s.slice(0, maxLength).replace(/-+$/g, "") : s
}

export function personPart(people: string[]): string {
  const clean = people.map((p) => slug(p)).filter(Boolean)
  if (clean.length === 0) return "Unnamed"
  if (clean.length === 1) return clean[0]
  const others = clean.length - 1
  return `${clean[0]}-and-${others}-${others === 1 ? "other" : "others"}`
}

export function descriptionPart(description: string, fallback: string): string {
  return slug(description) || fallback
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
}

export function extensionFor(mimeType: string, originalFilename: string | null): string {
  const byMime = EXT_BY_MIME[mimeType.toLowerCase()]
  if (byMime) return byMime
  const m = originalFilename?.match(/\.([A-Za-z0-9]{1,5})$/)
  return m ? m[1].toLowerCase() : "bin"
}

export interface BaseNameParts {
  people: string[]
  description: string
  descriptionFallback: string
  date: string
  hold: boolean
  /** 1-based album index; 0 for a single item. */
  index: number
}

export function buildBaseName(p: BaseNameParts): string {
  const idx = p.index > 0 ? `-${String(p.index).padStart(2, "0")}` : ""
  const base = `${personPart(p.people)}_${descriptionPart(p.description, p.descriptionFallback)}_${p.date}${idx}`
  return p.hold ? `HOLD_${base}` : base
}

/** Adds -02, -03 ... until neither the media name nor its .json sidecar name is taken. */
export async function uniqueBaseName(
  base: string,
  ext: string,
  exists: (name: string) => Promise<boolean>,
  maxTries = 50,
): Promise<string> {
  for (let n = 1; n <= maxTries; n++) {
    const candidate = n === 1 ? base : `${base}-${String(n).padStart(2, "0")}`
    if (!(await exists(`${candidate}.${ext}`)) && !(await exists(`${candidate}.json`))) return candidate
  }
  throw new Error("name_clash_limit")
}
