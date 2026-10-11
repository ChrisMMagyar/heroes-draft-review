// Strips personal contact details (emails, phone numbers) from caption text before
// it is stored or logged (spec 4.3).
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_CANDIDATE = /\+?\(?\d[\d\s().-]{6,}\d/g
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function redact(text: string, maxLength = 500): string {
  const out = text
    .replace(EMAIL, "[redacted]")
    .replace(PHONE_CANDIDATE, (m) => {
      const digits = m.replace(/\D/g, "").length
      if (ISO_DATE.test(m.trim())) return m
      return digits >= 10 && digits <= 15 ? "[redacted]" : m
    })
  return out.length > maxLength ? out.slice(0, maxLength) : out
}
