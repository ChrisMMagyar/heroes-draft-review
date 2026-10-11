// Small key-value interface over Netlify Blobs, so tests can use an in-memory store.
import { getStore } from "@netlify/blobs"

export interface KV {
  getJSON<T>(key: string): Promise<{ value: T; etag: string } | null>
  /** Returns false when a conditional write did not happen. */
  setJSON(key: string, value: unknown, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }): Promise<boolean>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
}

export interface Stores {
  queue: KV
  pending: KV
  seen: KV
  caps: KV
  lock: KV
  incoming: KV
  groups: KV
}

export const STORE_NAMES: Record<keyof Stores, string> = {
  queue: "intake-queue",
  pending: "intake-pending",
  seen: "intake-seen",
  caps: "intake-caps",
  lock: "intake-lock",
  incoming: "intake-incoming",
  groups: "intake-groups",
}

class BlobsKV implements KV {
  private store
  constructor(name: string) {
    this.store = getStore({ name, consistency: "strong" })
  }
  async getJSON<T>(key: string) {
    const r = await this.store.getWithMetadata(key, { type: "json" })
    if (!r) return null
    return { value: r.data as T, etag: r.etag ?? "" }
  }
  async setJSON(key: string, value: unknown, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }) {
    const r = opts?.onlyIfMatch
      ? await this.store.setJSON(key, value, { onlyIfMatch: opts.onlyIfMatch })
      : opts?.onlyIfNew
        ? await this.store.setJSON(key, value, { onlyIfNew: true })
        : await this.store.setJSON(key, value)
    return r.modified
  }
  async delete(key: string) {
    await this.store.delete(key)
  }
  async list(prefix?: string) {
    const keys: string[] = []
    for await (const page of this.store.list({ prefix, paginate: true })) {
      for (const b of page.blobs) keys.push(b.key)
    }
    return keys.sort()
  }
}

export function blobStores(prefix = ""): Stores {
  const out = {} as Stores
  for (const [k, name] of Object.entries(STORE_NAMES)) out[k as keyof Stores] = new BlobsKV(prefix + name)
  return out
}

export class MemoryKV implements KV {
  data = new Map<string, { value: string; etag: string }>()
  private n = 0
  async getJSON<T>(key: string) {
    const r = this.data.get(key)
    return r ? { value: JSON.parse(r.value) as T, etag: r.etag } : null
  }
  async setJSON(key: string, value: unknown, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }) {
    const cur = this.data.get(key)
    if (opts?.onlyIfNew && cur) return false
    if (opts?.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return false
    this.data.set(key, { value: JSON.stringify(value), etag: `e${++this.n}` })
    return true
  }
  async delete(key: string) {
    this.data.delete(key)
  }
  async list(prefix = "") {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}

export function memoryStores(): Stores {
  const out = {} as Stores
  for (const k of Object.keys(STORE_NAMES)) out[k as keyof Stores] = new MemoryKV()
  return out
}
