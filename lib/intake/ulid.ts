// Minimal monotonic ULID (sortable by time, so queue keys process in arrival order).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
let lastTime = -1
let lastRandom: number[] = []

function randomDigits(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b % 32)
}

export function ulid(now: number = Date.now()): string {
  let random: number[]
  if (now === lastTime) {
    random = [...lastRandom]
    for (let i = random.length - 1; i >= 0; i--) {
      if (random[i] < 31) { random[i]++; break }
      random[i] = 0
    }
  } else {
    random = randomDigits()
  }
  lastTime = now
  lastRandom = random
  let time = ""
  let t = now
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time
    t = Math.floor(t / 32)
  }
  return time + random.map((d) => ALPHABET[d]).join("")
}
