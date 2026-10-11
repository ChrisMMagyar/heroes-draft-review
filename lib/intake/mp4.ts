// Tiny MP4/MOV (ISO-BMFF / QuickTime) reader for video metadata. Pure TypeScript,
// no native tools: duration, resolution, frame rate, codec, creation time, and
// device/GPS from QuickTime keys or udta tags where present.

export interface Mp4Info {
  durationS: number | null
  width: number | null
  height: number | null
  frameRate: number | null
  codec: string | null
  creationTime: string | null
  make: string | null
  model: string | null
  location: { latitude: number; longitude: number; altitude: number | null } | null
}

const MAC_EPOCH_OFFSET = 2_082_844_800 // seconds between 1904-01-01 and 1970-01-01
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "edts"])

interface Box { type: string; start: number; payload: number; end: number }

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
}

function* boxes(b: Uint8Array, dv: DataView, start: number, end: number): Generator<Box> {
  let o = start
  while (o + 8 <= end) {
    let size = dv.getUint32(o)
    const type = fourcc(b, o + 4)
    let header = 8
    if (size === 1) {
      if (o + 16 > end) return
      size = Number(dv.getBigUint64(o + 8))
      header = 16
    } else if (size === 0) {
      size = end - o
    }
    if (size < header || o + size > end) return
    yield { type, start: o, payload: o + header, end: o + size }
    o += size
  }
}

export function parseIso6709(s: string): Mp4Info["location"] {
  const m = s.trim().match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/)
  if (!m) return null
  return { latitude: Number(m[1]), longitude: Number(m[2]), altitude: m[3] !== undefined ? Number(m[3]) : null }
}

function macTime(secs: number): string | null {
  if (!secs) return null
  const unix = secs - MAC_EPOCH_OFFSET
  if (unix <= 0) return null
  return new Date(unix * 1000).toISOString()
}

const utf8 = new TextDecoder()

export function parseMp4(bytes: Uint8Array): Mp4Info {
  const info: Mp4Info = {
    durationS: null, width: null, height: null, frameRate: null, codec: null,
    creationTime: null, make: null, model: null, location: null,
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const keys: string[] = []
  let videoFound = false

  const readTrak = (trak: Box) => {
    let handler = ""
    let tk: { w: number; h: number } | null = null
    let mdhd: { scale: number; dur: number } | null = null
    let codec: string | null = null
    let samples = 0
    const walk = (start: number, end: number) => {
      for (const box of boxes(bytes, dv, start, end)) {
        const p = box.payload
        if (box.type === "tkhd") {
          const v = bytes[p]
          const base = p + (v === 1 ? 4 + 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4 + 4) + 8 + 2 + 2 + 2 + 2 + 36
          if (base + 8 <= box.end) tk = { w: dv.getUint32(base) / 65536, h: dv.getUint32(base + 4) / 65536 }
        } else if (box.type === "mdhd") {
          const v = bytes[p]
          mdhd = v === 1
            ? { scale: dv.getUint32(p + 20), dur: Number(dv.getBigUint64(p + 24)) }
            : { scale: dv.getUint32(p + 12), dur: dv.getUint32(p + 16) }
        } else if (box.type === "hdlr") {
          handler = fourcc(bytes, p + 8)
        } else if (box.type === "stsd") {
          if (dv.getUint32(p + 4) > 0 && p + 16 <= box.end) codec = fourcc(bytes, p + 12).trim()
        } else if (box.type === "stts") {
          const n = dv.getUint32(p + 4)
          for (let i = 0; i < n && p + 8 + i * 8 + 8 <= box.end; i++) samples += dv.getUint32(p + 8 + i * 8)
        } else if (CONTAINERS.has(box.type)) {
          walk(box.payload, box.end)
        }
      }
    }
    walk(trak.payload, trak.end)
    if (handler !== "vide" || videoFound) return
    videoFound = true
    const t = tk as { w: number; h: number } | null
    const m = mdhd as { scale: number; dur: number } | null
    if (t && t.w > 0) { info.width = Math.round(t.w); info.height = Math.round(t.h) }
    info.codec = codec
    if (m && m.scale > 0 && m.dur > 0 && samples > 0) {
      info.frameRate = Math.round((samples / (m.dur / m.scale)) * 100) / 100
    }
  }

  const setTag = (name: string, value: string) => {
    const n = name.toLowerCase()
    if (n.endsWith("make") || n === "©mak") info.make ??= value
    else if (n.endsWith("model") || n === "©mod") info.model ??= value
    else if (n.includes("location") || n === "©xyz") info.location ??= parseIso6709(value)
    else if (n.endsWith("creationdate")) info.creationTime = value
  }

  const readMeta = (meta: Box) => {
    // QuickTime 'meta' has no version/flags; ISO 'meta' does. Detect by the hdlr child.
    const first = fourcc(bytes, meta.payload + 4) === "hdlr" ? meta.payload : meta.payload + 4
    for (const box of boxes(bytes, dv, first, meta.end)) {
      if (box.type === "keys") {
        const n = dv.getUint32(box.payload + 4)
        let o = box.payload + 8
        for (let i = 0; i < n && o + 8 <= box.end; i++) {
          const size = dv.getUint32(o)
          if (size < 8) break
          keys.push(utf8.decode(bytes.subarray(o + 8, o + size)))
          o += size
        }
      } else if (box.type === "ilst") {
        for (const item of boxes(bytes, dv, box.payload, box.end)) {
          const index = dv.getUint32(item.start + 4)
          const name = keys[index - 1] ?? fourcc(bytes, item.start + 4)
          for (const data of boxes(bytes, dv, item.payload, item.end)) {
            if (data.type === "data" && data.payload + 8 <= data.end) {
              setTag(name, utf8.decode(bytes.subarray(data.payload + 8, data.end)))
            }
          }
        }
      }
    }
  }

  const readUdta = (udta: Box) => {
    for (const box of boxes(bytes, dv, udta.payload, udta.end)) {
      if (box.type === "meta") readMeta(box)
      else if (box.type.charCodeAt(0) === 0xa9 && box.payload + 4 <= box.end) {
        const len = dv.getUint16(box.payload)
        const text = utf8.decode(bytes.subarray(box.payload + 4, Math.min(box.end, box.payload + 4 + len)))
        setTag(box.type, text)
      }
    }
  }

  for (const top of boxes(bytes, dv, 0, bytes.byteLength)) {
    if (top.type !== "moov") continue
    for (const box of boxes(bytes, dv, top.payload, top.end)) {
      const p = box.payload
      if (box.type === "mvhd") {
        const v = bytes[p]
        const created = v === 1 ? Number(dv.getBigUint64(p + 4)) : dv.getUint32(p + 4)
        const scale = v === 1 ? dv.getUint32(p + 20) : dv.getUint32(p + 12)
        const dur = v === 1 ? Number(dv.getBigUint64(p + 24)) : dv.getUint32(p + 16)
        if (scale > 0 && dur > 0) info.durationS = Math.round((dur / scale) * 1000) / 1000
        info.creationTime = macTime(created)
      } else if (box.type === "trak") readTrak(box)
      else if (box.type === "udta") readUdta(box)
      else if (box.type === "meta") readMeta(box)
    }
  }
  return info
}
