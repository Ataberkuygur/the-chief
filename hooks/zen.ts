import { L } from './lang'
/**
 * OpenCode Zen's free models, tracked without touching anything private.
 *
 * The tracker reads the public docs page (which says which models are free and for a limited time) and the public
 * models endpoint (which says what is still offered), then sends each free model one tiny completion as a health
 * ping: `ok`, `401` (it wants a key; the tracker asks for the saved one once), `429` (rate limited), `0-BYTE` (the
 * endpoint answered but gave nothing) or `error`. Results carry timestamps and live in the plugin store
 * (`lane:zen`), so the route table can skip models that are down without a network call on the spawn path.
 *
 * Pure parsing/classification plus one `collectZen(net, …)` that takes its network as an argument: tests mock it,
 * the plugin passes `$.http.fetch`. A key, when one is needed, is read lazily by the caller and never logged or
 * stored here; `redact` is the only place text is written down.
 */

export const ZEN_DOCS_URL = 'https://opencode.ai/docs/zen'
export const ZEN_MODELS_URL = 'https://opencode.ai/inference/v1/models'
export const ZEN_CHAT_URL = 'https://opencode.ai/inference/openai/v1/chat/completions'
/** Three scans a day are enough (a scan every 8 h); a failed scan is tried again after an hour. */
export const ZEN_REFRESH_MS = 8 * 3600_000
export const ZEN_RETRY_MS = 3600_000
/** A health result older than this is no evidence: the model is not used on that alone. */
export const ZEN_STALE_MS = 36 * 3600_000
/** Each ping asks for one token; free models answer it without a real completion bill. */
export const ZEN_PING_MAX_TOKENS = 1
/** Free models pinged per scan (the docs list ~14; a new stealth model still gets in on the next scan). */
export const ZEN_MAX_PINGS = 16
export const ZEN_PING_TIMEOUT_MS = 20000

export type ZenHealth = 'ok' | '401' | '429' | '0-BYTE' | 'error'

export type ZenCheck = {
  at: number
  health: ZenHealth
  /** The HTTP status the ping got (0 when there was no answer). */
  status: number
}

export type ZenModel = {
  id: string
  /** Free for a limited time (the docs' free list); all of Zen's free models are. */
  limited: boolean
  /** Still offered by the models endpoint (true when that endpoint could not be read). */
  inCatalog: boolean
  firstSeen: number
  lastSeen: number
  check?: ZenCheck
}

export type ZenRecord = {
  /** When the tracker last ran (successful or not): the refresh gate reads this. */
  at: number
  /** When the docs and/or the model list were last read: the route table only trusts this. */
  fetchedAt: number
  /** What the scan changed, why it fell short: one redacted line, never a key. */
  error: string
  models: ZenModel[]
}

export type ZenResponse = { status: number; ok?: boolean; text?: string }
export type ZenNet = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<ZenResponse>

export type ZenDocModel = { id: string; limited: boolean; from: 'pricing' | 'list' }

/** A record that has never been written: the route table stays the built-in one. */
export const emptyZen = (): ZenRecord => ({ at: 0, fetchedAt: 0, error: '', models: [] })

/** Whether a scan is due now (8 h after a good one, 1 h after a failed one). */
export function zenDue(r: ZenRecord | null | undefined, now: number): boolean {
  if (!r || !r.at) return true
  return now - r.at >= (r.fetchedAt ? ZEN_REFRESH_MS : ZEN_RETRY_MS)
}

/** Whether the record's data is fresh enough to build a route table from. */
export function zenTrusted(r: ZenRecord | null | undefined, now: number): boolean {
  return !!r && r.fetchedAt > 0 && r.models.length > 0 && now - r.fetchedAt < ZEN_STALE_MS
}

// ---------- the docs page: names, ids and the free list ----------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    const c = code.toLowerCase()
    if (c.startsWith('#')) {
      const n = c.startsWith('#x') ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
    }
    return ENTITIES[c] ?? m
  })

/** Text of an HTML fragment: tags dropped, entities decoded, whitespace one space. */
const clean = (html: string): string => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/** The cells of every table row on the page. */
function tableRows(html: string): string[][] {
  const rows: string[][] = []
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => clean(c[1]!))
    if (cells.length) rows.push(cells)
  }
  return rows
}

/** "GLM-5.3-Flash Free" as an id when the page does not name one: glm-5.3-flash-free. */
export const zenSlug = (name: string): string =>
  name
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')

const keyName = (name: string) => name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
const looksId = (s: string) => /^[a-z0-9][a-z0-9._:-]*$/.test(s) && !/^(free|input|output|model)$/i.test(s)

/**
 * The free models the docs page names: a pricing row whose price cells say Free, plus the bullets of the
 * "Free models" section (the stealth models are only there). Ids come from the page's Model ID table, else from
 * the name.
 */
export function parseZenDocs(html: string): ZenDocModel[] {
  if (!html.trim()) return []
  const rows = tableRows(html)
  const ids = new Map<string, string>()
  for (const r of rows) if (r.length >= 2 && r[0] && looksId(r[1]!)) ids.set(keyName(r[0]), r[1]!)
  const out = new Map<string, ZenDocModel>()
  const add = (name: string, limited: boolean, from: ZenDocModel['from']) => {
    if (!name) return
    const id = ids.get(keyName(name)) ?? zenSlug(name)
    if (id) out.set(id, { id, limited, from })
  }
  for (const r of rows) {
    if (r.length < 2 || !r[0]) continue
    if (r.slice(1).some(c => /^free$/i.test(c))) add(r[0], /free|limited/i.test(r[0]), 'pricing')
  }
  const head = html.search(/id=["']free-models["']/i)
  if (head >= 0) {
    const end = html.indexOf('</ul>', head)
    const section = html.slice(head, end < 0 ? html.length : end)
    for (const li of section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
      const text = clean(li[1]!)
      // "GLM-5.3-Flash Free is free on OpenCode for a limited time." → "GLM-5.3-Flash Free"
      const name = (text.split(/\s+(?:is|are)\s+|:\s/)[0] ?? '').trim()
      add(name, /limited|free/i.test(text), 'list')
    }
  }
  return [...out.values()]
}

/** The ids the models endpoint lists (`{data:[{id}]}`, `{models:[{id}]}` or a bare array). */
export function parseZenModels(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const holder = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { data?: unknown; models?: unknown }) : null
  const list = Array.isArray(parsed) ? parsed : holder?.data ?? holder?.models
  if (!Array.isArray(list)) return []
  const ids = list.flatMap(x => {
    if (typeof x === 'string') return [x]
    if (!x || typeof x !== 'object') return []
    const o = x as { id?: unknown; name?: unknown }
    return typeof o.id === 'string' ? [o.id] : typeof o.name === 'string' ? [o.name] : []
  })
  return [...new Set(ids.map(s => s.trim()).filter(Boolean))]
}

/** The free list as stored: kept models keep their first-seen time and their last health result. */
export function mergeZenFree(docs: readonly ZenDocModel[], listed: readonly string[], now: number, prev: readonly ZenModel[] = []): ZenModel[] {
  const catalog = new Set(listed)
  const before = new Map(prev.map(m => [m.id, m]))
  return docs.map(d => {
    const old = before.get(d.id)
    return {
      id: d.id,
      limited: d.limited,
      inCatalog: catalog.size === 0 || catalog.has(d.id),
      firstSeen: old?.firstSeen ?? now,
      lastSeen: now,
      check: old?.check,
    }
  })
}

// ---------- the health ping ----------
/** A 2xx answer with a choice or usage in it is a working endpoint; an empty or non-JSON body is 0-BYTE. */
function usableBody(text: string): boolean {
  const body = text.trim()
  if (!body) return false
  try {
    const o = JSON.parse(body) as { choices?: unknown; message?: unknown; usage?: unknown }
    return (Array.isArray(o.choices) && o.choices.length > 0) || !!o.message || !!o.usage
  } catch {
    return false
  }
}

/** The health class of one ping answer: `ok`, `401`, `429`, `0-BYTE`, `error`. Pure, so it is tested. */
export function classifyPing(res: { status?: number; text?: string } | null | undefined): ZenHealth {
  const status = Number(res?.status ?? 0)
  if (!status) return 'error'
  if (status === 401 || status === 403) return '401'
  if (status === 429) return '429'
  if (status < 200 || status >= 300) return 'error'
  return usableBody(String(res?.text ?? '')) ? 'ok' : '0-BYTE'
}

/** What a ping sends: one token, one user message, and the key only when the caller has one to give. */
export function pingRequest(id: string, key = ''): { url: string; init: { method: 'POST'; headers: Record<string, string>; body: string } } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  return {
    url: ZEN_CHAT_URL,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: ZEN_PING_MAX_TOKENS, temperature: 0 }),
    },
  }
}

/** Text with a key or a bearer token taken out: the only form the store or a report ever sees. */
export function redact(text: string, key = ''): string {
  const out = key && text.includes(key) ? text.split(key).join('[redacted]') : text
  return out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]').replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
}

/** A promise that gives a fallback after `ms`, so a model that never answers cannot hold the scan. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms) })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export type ZenPingOptions = {
  at: number
  /** Read lazily, only when a ping comes back 401: a free model that answers needs no key. */
  key?: () => string | Promise<string>
  timeoutMs?: number
}

/** One model's health: no key first, the saved key once if it says 401; the key is never kept. */
export async function pingZen(net: ZenNet, id: string, o: ZenPingOptions): Promise<ZenCheck> {
  const send = async (key: string): Promise<ZenResponse | null> => {
    const req = pingRequest(id, key)
    try {
      return await within(net(req.url, req.init), o.timeoutMs ?? ZEN_PING_TIMEOUT_MS, null)
    } catch {
      return null
    }
  }
  let res = await send('')
  if (res && (res.status === 401 || res.status === 403) && o.key) {
    const key = await Promise.resolve(o.key()).catch(() => '')
    if (key) res = await send(key)
  }
  return { at: o.at, health: classifyPing(res), status: Number(res?.status ?? 0) }
}

// ---------- one scan ----------
export type ZenOptions = {
  now: number
  prev?: ZenRecord | null
  key?: () => string | Promise<string>
  maxPings?: number
  timeoutMs?: number
}

/**
 * One full scan: docs + model list (read-only, no key), then one ping per free model. A failed fetch keeps the
 * previous list (and its health results) and records why; a good one replaces the list. Never throws.
 */
export async function collectZen(net: ZenNet, o: ZenOptions): Promise<ZenRecord> {
  const prev = o.prev ?? null
  const timeoutMs = o.timeoutMs ?? ZEN_PING_TIMEOUT_MS
  const read = async (url: string): Promise<{ text: string; error: string }> => {
    try {
      const res = await within(net(url, { method: 'GET' }), timeoutMs, null)
      if (!res) return { text: '', error: L('no answer', 'yanıt yok') }
      if (res.status < 200 || res.status >= 300) return { text: '', error: `HTTP ${res.status}` }
      return { text: String(res.text ?? ''), error: '' }
    } catch (err) {
      return { text: '', error: redact(err instanceof Error ? err.message : String(err)) }
    }
  }
  const [docsRes, listRes] = await Promise.all([read(ZEN_DOCS_URL), read(ZEN_MODELS_URL)])
  const docs = parseZenDocs(docsRes.text)
  const listed = parseZenModels(listRes.text)
  const notes = [docs.length ? '' : `docs: ${docsRes.error || L('no free model found', 'ücretsiz model bulunamadı')}`, listRes.error ? `models: ${listRes.error}` : ''].filter(Boolean)
  let models = docs.length ? mergeZenFree(docs, listed, o.now, prev?.models ?? []) : prev?.models ?? []
  if (docs.length) {
    // the key is asked for at most once per scan, and only after a ping said 401
    let asking: Promise<string> | null = null
    const key = () => (asking ??= Promise.resolve(o.key ? o.key() : '').then(k => k).catch(() => ''))
    const pinged = models.slice(0, Math.max(0, o.maxPings ?? ZEN_MAX_PINGS))
    const checks = await Promise.all(pinged.map(m => pingZen(net, m.id, { at: o.now, key, timeoutMs })))
    const byId = new Map(pinged.map((m, i) => [m.id, checks[i]!]))
    models = models.map(m => (byId.has(m.id) ? { ...m, check: byId.get(m.id)! } : m))
  }
  const fetched = docs.length > 0 || listed.length > 0
  return {
    at: o.now,
    fetchedAt: fetched ? o.now : prev?.fetchedAt ?? 0,
    error: redact(notes.join(' · ')),
    models,
  }
}

/** The ids that answered `ok` recently: the route table's free list, unhealthy ones skipped. */
export function healthyZenIds(r: ZenRecord | null | undefined, now: number): string[] {
  if (!r) return []
  return r.models.filter(m => m.check?.health === 'ok' && now - m.check.at < ZEN_STALE_MS).map(m => m.id)
}
