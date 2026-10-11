// Metadata capture at intake (spec 8A). Missing fields are null, never guessed.
import exifr from "exifr"
import type { MediaItem } from "./types"
import { parseMp4 } from "./mp4"
import { ctDateTime } from "./time"

export interface MediaMetadata {
  capture_time: string | null
  capture_time_ct: string | null
  device_make: string | null
  device_model: string | null
  lens: string | null
  width_px: number | null
  height_px: number | null
  orientation: string | null
  /** Sensitive: written ONLY to the internal sidecar, never to the log row or messages. */
  gps: { latitude: number; longitude: number; altitude: number | null } | null
  iptc_xmp: { caption: string | null; creator: string | null; copyright: string | null }
  video: { duration_s: number | null; frame_rate: number | null; codec: string | null } | null
}

export interface MetadataResult {
  metadata: MediaMetadata
  error: string | null
}

function emptyMetadata(item: MediaItem): MediaMetadata {
  return {
    capture_time: null,
    capture_time_ct: null,
    device_make: null,
    device_model: null,
    lens: null,
    width_px: item.width,
    height_px: item.height,
    orientation: null,
    gps: null,
    iptc_xmp: { caption: null, creator: null, copyright: null },
    video: item.mediaType === "video" ? { duration_s: item.durationS, frame_rate: null, codec: null } : null,
  }
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v === "string") return v.trim() || null
  if (typeof v === "number") return String(v)
  if (Array.isArray(v)) return v.map(String).join(", ") || null
  if (typeof v === "object" && "value" in (v as object)) return str((v as { value: unknown }).value)
  return null
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** EXIF "YYYY:MM:DD HH:MM:SS" (+ optional offset) to ISO 8601. */
export function exifDateToIso(value: unknown, offset: unknown): string | null {
  const s = str(value)
  const m = s?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const off = str(offset)
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  return off && /^[+-]\d{2}:\d{2}$/.test(off) ? iso + off : iso
}

/** CT rendering only when the time is absolute (has an offset or Z). */
export function toCt(iso: string | null): string | null {
  if (!iso || !/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : ctDateTime(d)
}

async function imageMetadata(bytes: Uint8Array, base: MediaMetadata): Promise<MediaMetadata> {
  const tags = (await exifr.parse(bytes, {
    tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false,
    reviveValues: false, translateValues: true, mergeOutput: true,
  })) as Record<string, unknown> | undefined
  if (!tags) return base
  const capture = exifDateToIso(tags.DateTimeOriginal ?? tags.CreateDate, tags.OffsetTimeOriginal ?? tags.OffsetTime)
  const lat = num(tags.latitude)
  const lon = num(tags.longitude)
  return {
    ...base,
    capture_time: capture,
    capture_time_ct: toCt(capture),
    device_make: str(tags.Make),
    device_model: str(tags.Model),
    lens: str(tags.LensModel ?? tags.Lens),
    width_px: num(tags.ExifImageWidth) ?? num(tags.ImageWidth) ?? base.width_px,
    height_px: num(tags.ExifImageHeight) ?? num(tags.ImageHeight) ?? base.height_px,
    orientation: str(tags.Orientation),
    gps: lat !== null && lon !== null ? { latitude: lat, longitude: lon, altitude: num(tags.GPSAltitude) } : null,
    iptc_xmp: {
      caption: str(tags.ImageDescription ?? tags.Caption ?? tags.description),
      creator: str(tags.Artist ?? tags.Creator ?? tags.creator ?? tags.Byline),
      copyright: str(tags.Copyright ?? tags.rights ?? tags.CopyrightNotice),
    },
  }
}

function videoMetadata(bytes: Uint8Array, base: MediaMetadata): MediaMetadata {
  const v = parseMp4(bytes)
  return {
    ...base,
    capture_time: v.creationTime,
    capture_time_ct: toCt(v.creationTime),
    device_make: v.make,
    device_model: v.model,
    width_px: v.width ?? base.width_px,
    height_px: v.height ?? base.height_px,
    gps: v.location,
    video: { duration_s: v.durationS ?? base.video?.duration_s ?? null, frame_rate: v.frameRate, codec: v.codec },
  }
}

export async function extractMetadata(bytes: Uint8Array, item: MediaItem): Promise<MetadataResult> {
  const base = emptyMetadata(item)
  try {
    const metadata = item.mediaType === "video" ? videoMetadata(bytes, base) : await imageMetadata(bytes, base)
    return { metadata, error: null }
  } catch {
    // Filing still goes ahead; the sidecar and row record the error (spec 8A).
    return { metadata: base, error: "metadata_parse_failed" }
  }
}
