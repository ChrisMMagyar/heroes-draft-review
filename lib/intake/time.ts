// America/Chicago date helpers (the spec's "CT").
export const TZ = "America/Chicago"

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
})

/** YYYY-MM-DD in CT. */
export function ctDate(d: Date): string {
  return dateFmt.format(d)
}

/** "YYYY-MM-DD HH:mm:ss" in CT. */
export function ctDateTime(d: Date): string {
  return `${ctDate(d)} ${timeFmt.format(d)}`
}

/** Shift a YYYY-MM-DD string by whole days. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`)
  const tb = Date.parse(`${b}T00:00:00Z`)
  return Math.round(Math.abs(ta - tb) / 86_400_000)
}

export function isValidYmd(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false
  const t = new Date(`${ymd}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === ymd
}
