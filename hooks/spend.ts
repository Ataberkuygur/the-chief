// Who spends the quota: API prices, a chat that says it waits, and the scan of Claude Code's transcripts behind the
// "Çok harcayanlar" panel. Plain TypeScript with no imports, so a node child process can run it as it is.

export type Price = { inp: number; out: number; read: number }
export type StepUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** API list prices per million tokens by model family: input, output, cache read. The only price table; the first family that matches wins. */
const PRICES: readonly { re: RegExp; price: Price }[] = [
  { re: /fable/i, price: { inp: 10, out: 50, read: 0.25 } },
  { re: /sonnet/i, price: { inp: 2, out: 10, read: 0.2 } },
  { re: /haiku/i, price: { inp: 1, out: 5, read: 0.1 } },
  { re: /^/, price: { inp: 4, out: 20, read: 0.2 } },
]

/** Per million tokens: input, output, cache read (a 5m cache write is 1.25 × input, a 1h one 2 ×). */
export function priceOf(model: string): Price {
  return PRICES.find(p => p.re.test(model))!.price
}

/** What one model request cost at API prices. The chat writes its cache for an hour (2 ×), a subagent for 5 minutes. */
export function stepUsd(model: string, u: StepUsage, isSub: boolean): number {
  const p = priceOf(model)
  return (u.input_tokens * p.inp + u.cache_creation_input_tokens * p.inp * (isSub ? 1.25 : 2) + u.cache_read_input_tokens * p.read + u.output_tokens * p.out) / 1e6
}

/** A chief that says it waits (for the owner, a file, another chief). */
export const WAITING_RE = /^\s*(bekliyorum|bekleniyor|bekleme(de)?|waiting|still waiting|on hold|sahibin)/i

/** The start of The Chief's nudge; a transcript line holding it is one nudge. */
export const NUDGE_MARK = 'Keep going on your goal'

/** A transcript line is worth reading only when it holds one of these. */
export const INTERESTING: readonly string[] = ['"cache_read_input_tokens"', NUDGE_MARK, '"custom-title"', '"agent-name"']

export const FLAGS = { open: '8+ saat açık', context: '150K+ bağlam', nudges: 'çok dürtme', subagents: 'alt ajan ağırlıklı', waiting: "çoğu tur 'bekliyorum'" } as const
const OPEN_MS = 8 * 3600_000
const CONTEXT_TOKENS = 150_000
const NUDGES = 3
const WAITING_TURNS = 3

export type SpendRow = { sid: string; title: string; model: string; usd: number; cacheRead: number; share: number; flags: string[]; lastAt: number }
export type SpendWindow = { totalUsd: number; top3Share: number; rows: SpendRow[] }
/** `7d` is the current week: from the weekly limit's last reset (`weekKnown`), else the last 7 days. `weekFrom` is where it starts. */
export type SpendResult = { at: number; weekFrom: number; weekKnown: boolean; windows: { '24h': SpendWindow; '7d': SpendWindow } }

const WEEK_MS = 7 * 86400_000

/**
 * Where the current weekly window began: the limit's reset time minus 7 days. A reset time already past (a reading from
 * before the reset) is moved forward by whole weeks, so the week still starts at the latest reset. Unknown or unreadable:
 * the last 7 days, and `known` is false.
 */
export function weekStartOf(resetsAt: string | number | null | undefined, now: number): { from: number; known: boolean } {
  const t = typeof resetsAt === 'number' ? resetsAt : Date.parse(String(resetsAt ?? ''))
  if (!Number.isFinite(t) || t <= 0) return { from: now - WEEK_MS, known: false }
  let end = t
  while (end <= now) end += WEEK_MS
  return { from: end - WEEK_MS, known: true }
}

/** One model message, merged over the transcript lines that carry it. */
type Msg = { sid: string; at: number; model: string; usd: number; cacheRead: number; ctx: number; side: boolean; tool: boolean; wait: boolean }
type Meta = { title: string; agent: string; cwd: string }

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''

/** The 5-minute and 1-hour cache writes are priced apart when the transcript says which is which. */
function cacheWriteUsd(model: string, u: Record<string, any>, side: boolean): number {
  const p = priceOf(model)
  const split = u.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined
  if (split) return (((split.ephemeral_5m_input_tokens ?? 0) * 1.25 + (split.ephemeral_1h_input_tokens ?? 0) * 2) * p.inp) / 1e6
  return ((u.cache_creation_input_tokens ?? 0) * p.inp * (side ? 1.25 : 2)) / 1e6
}

const blocksOf = (content: unknown): Record<string, any>[] => (Array.isArray(content) ? (content as Record<string, any>[]) : [])

/** Whether a model message only says it waits: text that starts like a waiting line, and no tool call. */
function messageFlags(content: unknown): { tool: boolean; wait: boolean } {
  const blocks = blocksOf(content)
  const tool = blocks.some(b => b.type === 'tool_use')
  const text = blocks.find(b => b.type === 'text' && typeof b.text === 'string' && b.text.trim())
  return { tool, wait: !tool && !!text && WAITING_RE.test(String(text.text)) }
}

/** What a scan has read so far: every message once by its id, the sessions' titles and the nudges seen. */
type Scan = { now: number; msgs: Map<string, Msg>; meta: Map<string, Meta>; nudges: { sid: string; at: number }[] }

const metaOf = (st: Scan, sid: string) => {
  let m = st.meta.get(sid)
  if (!m) st.meta.set(sid, (m = { title: '', agent: '', cwd: '' }))
  return m
}

function addMessage(st: Scan, o: Record<string, any>, at: number) {
  const msg = o.message as Record<string, any>
  const u = msg.usage as Record<string, any> | undefined
  if (!u || !o.sessionId || typeof msg.model !== 'string' || msg.model.startsWith('<')) return
  const id = String(msg.id ?? o.requestId ?? o.uuid)
  const flags = messageFlags(msg.content)
  const seen = st.msgs.get(id)
  if (seen) {
    seen.tool ||= flags.tool
    seen.wait ||= flags.wait
    return
  }
  const side = o.isSidechain === true
  const use: StepUsage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: 0 }
  const usd = stepUsd(msg.model, use, side) + cacheWriteUsd(msg.model, u, side)
  const ctx = use.input_tokens + use.cache_read_input_tokens + (u.cache_creation_input_tokens ?? 0)
  st.msgs.set(id, { sid: String(o.sessionId), at, model: msg.model, usd, cacheRead: use.cache_read_input_tokens, ctx, side, ...flags })
  if (typeof o.cwd === 'string' && o.cwd) metaOf(st, String(o.sessionId)).cwd = o.cwd
}

/** Feeds one transcript line; anything that is not a usage message, a nudge or a title is ignored. */
function addLine(st: Scan, line: string) {
  let o: Record<string, any>
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  const at = Date.parse(String(o.timestamp ?? ''))
  const recent = at > st.now - 7 * 86400_000
  if (o.type === 'custom-title' && o.sessionId) metaOf(st, String(o.sessionId)).title = String(o.customTitle ?? '')
  else if (o.type === 'agent-name' && o.sessionId) metaOf(st, String(o.sessionId)).agent = String(o.agentName ?? '')
  else if (o.type === 'assistant' && o.message && recent) addMessage(st, o, at)
  else if (o.type === 'user' && o.sessionId && recent && line.includes(NUDGE_MARK)) st.nudges.push({ sid: String(o.sessionId), at })
}

/** One session's row for a window: its cost, main model, cache reads and the flags that say why it costs. */
function rankRow(st: Scan, sid: string, list: Msg[], nudgeCount: number, titles: Record<string, string>): SpendRow {
  const m = st.meta.get(sid)
  const usd = list.reduce((sum, x) => sum + x.usd, 0)
  const byModel = new Map<string, number>()
  for (const x of list) byModel.set(x.model, (byModel.get(x.model) ?? 0) + x.usd)
  const times = list.map(x => x.at)
  const ends = list.filter(x => !x.side && !x.tool)
  const flags: string[] = []
  if (Math.max(...times) - Math.min(...times) >= OPEN_MS) flags.push(FLAGS.open)
  if (Math.max(...list.filter(x => !x.side).map(x => x.ctx), 0) >= CONTEXT_TOKENS) flags.push(FLAGS.context)
  if (nudgeCount >= NUDGES) flags.push(FLAGS.nudges)
  if (usd > 0 && list.filter(x => x.side).reduce((sum, x) => sum + x.usd, 0) / usd >= 0.5) flags.push(FLAGS.subagents)
  if (ends.length >= WAITING_TURNS && ends.filter(x => x.wait).length / ends.length >= 0.5) flags.push(FLAGS.waiting)
  const title = titles[sid] || m?.title || m?.agent || baseName(m?.cwd ?? '') || sid.slice(0, 8)
  const model = [...byModel].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  return { sid, title, model, usd, cacheRead: list.reduce((sum, x) => sum + x.cacheRead, 0), share: 0, flags, lastAt: Math.max(...times) }
}

/** The top 15 sessions since `from` by cost, with each one's share of the window's whole. */
function windowOf(st: Scan, from: number, titles: Record<string, string>): SpendWindow {
  const bySession = new Map<string, Msg[]>()
  for (const m of st.msgs.values()) if (m.at >= from) bySession.set(m.sid, [...(bySession.get(m.sid) ?? []), m])
  const rows = [...bySession].map(([sid, list]) => rankRow(st, sid, list, st.nudges.filter(n => n.sid === sid && n.at >= from).length, titles))
  const totalUsd = rows.reduce((sum, r) => sum + r.usd, 0)
  rows.sort((a, b) => b.usd - a.usd)
  const top3 = rows.slice(0, 3).reduce((sum, r) => sum + r.usd, 0)
  return { totalUsd, top3Share: totalUsd > 0 ? top3 / totalUsd : 0, rows: rows.slice(0, 15).map(r => ({ ...r, share: totalUsd > 0 ? r.usd / totalUsd : 0 })) }
}

/**
 * Reads transcript lines one at a time and, at the end, ranks the sessions by what they cost in the last 24 hours
 * and in the current week (from `weekReset`, the weekly limit's reset time; the last 7 days when it is unknown). A message Claude Code wrote on several lines (one per content block) counts once, by its id.
 * `result(titles)`: the app's own session titles, by id, win over the transcript's.
 */
export function createSpendScan(now: number, weekReset?: string | number | null) {
  const week = weekStartOf(weekReset, now)
  const st: Scan = { now, msgs: new Map(), meta: new Map(), nudges: [] }
  return {
    addLine: (line: string) => addLine(st, line),
    result: (titles: Record<string, string> = {}): SpendResult => ({ at: now, weekFrom: week.from, weekKnown: week.known, windows: { '24h': windowOf(st, now - 86400_000, titles), '7d': windowOf(st, week.from, titles) } }),
  }
}

export const fmtUsd = (n: number) => `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`
