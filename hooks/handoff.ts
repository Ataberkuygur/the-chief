import { L } from './lang'
/**
 * Automatic handoff and session housekeeping.
 *
 * A long chat is not compacted again and again: after two normal compacts (or eight hours with a big context) it
 * writes a detailed handoff file and a fresh session takes over. Around it the plugin keeps the sidebar tidy: pin
 * on the first real work, Remote Control, a short Turkish title, archive when the work is finished.
 *
 * Everything here talks to the outside only through `Ports`, so the whole chain runs under test with the app's
 * tools mocked. Rules every action follows:
 * - idempotent: one `act:<sid>:<name>` key in the store per action, set only after the action worked, so a redo of
 *   a rewound turn or a reload replays nothing;
 * - one try (`attempt` repeats a failed call once at once, no timer ever repeats it); a failure marks the action given
 *   up for that session, and the owner hears at most ONE line a day for all of them, never the raw error;
 * - state is keyed by the app's session id (`sid`), which survives an undo; the engine id does not.
 */

export const HANDOFF_DEBOUNCE_MS = 30 * 60_000
export const LONG_SESSION_MS = 8 * 3600_000
export const LONG_CONTEXT = 200_000
/** The owner typed into a session within this long: it is not archived. */
export const TYPED_QUIET_MS = 30 * 60_000
export const START_WAIT_MS = 60_000
const START_STEP_MS = 2_000
const RETRY_PAUSE_MS = 1_500
/** The one title the Leader of Chiefs has, whatever goal it once carried. */
export const LEADER_TITLE = 'Lider · Şef Yönetimi'
export const LEADER_TITLE_EN = 'Leader · Chief Management'

export const APP = {
  pin: 'mcp__ccd_sidebar__set_pinned',
  remote: 'mcp__ccd_session_mgmt__set_remote_control',
  title: 'mcp__ccd_session_mgmt__set_session_title',
  archive: 'mcp__ccd_session_mgmt__archive_session',
  get: 'mcp__ccd_session_mgmt__get_session',
} as const

export type Ports = {
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  /** An app tool: ok is false on a deny, an error result or a throw. */
  app: (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>
  /** One short line the owner sees: in this session, or in the leader when this session is a chief. */
  say: (line: string) => Promise<void>
}

// ---------- settings ----------

/** `handoff_after_compacts`: empty is 2, 0 or off is never. */
export function parseCompactLimit(v: string): number {
  const s = v.trim().toLowerCase()
  if (!s) return 2
  if (s === 'off' || s === 'none') return 0
  const n = Math.floor(Number(s))
  return Number.isFinite(n) && n >= 0 ? n : 2
}

/** `handoff_after_hours`: empty is 8, 0 or off is never. */
export function parseHours(v: string): number {
  const s = v.trim().toLowerCase()
  if (!s) return 8
  if (s === 'off' || s === 'none') return 0
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : 8
}

// ---------- per-session state ----------

/** What one session keeps across reloads, an undo and a redo: counters and clocks, never actions (those are `act:` keys). */
export type Sess = {
  /** First time the plugin saw this session (its age counts from here). */
  startedAt: number
  /** Normal (size guard) compacts; cold and manual ones do not count. */
  compacts: number
  /** Context size right after the last compact the guard ran. */
  lastCompactAfter: number
  /** When the last handoff began (the 30-minute debounce). */
  handoffAt: number
  /** The session that took over, once it has. */
  handedOffTo: string
  /**
   * When the handoff PROVED itself (the new session started its first turn): set together with `handedOffTo`, and the
   * only thing that lets the archive guard put the old session away. A handoff that failed leaves it 0.
   */
  handoffOkAt: number
  /** The last time the owner typed into this session. */
  ownerTypedAt: number
  /** The title The Chief set, to tell a hand rename from its own. */
  title: string
  userRenamed: boolean
  /** Unused since 1.30.2 (Remote Control is tried once); kept so an old record still reads. */
  rcFails: number
  rcRetryAt: number
  /** The owner interrupted the handoff's writing turn: this session is never handed off automatically again. */
  autoOff: boolean
  /** The sub-agent tier note last sent, so an undo does not send it again. */
  tierNote: string
  /** A handoff in progress, for a reload to finish or drop. */
  flow: { stage: 'writing' | 'opening' | 'waiting'; path: string; newSid: string; at: number } | null
}

export const emptySess = (now: number): Sess => ({ startedAt: now, compacts: 0, lastCompactAfter: 0, handoffAt: 0, handedOffTo: '', handoffOkAt: 0, ownerTypedAt: 0, title: '', userRenamed: false, rcFails: 0, rcRetryAt: 0, autoOff: false, tierNote: '', flow: null })

const sessKey = (sid: string) => `sess:${sid}`
const actKey = (sid: string, name: string) => `act:${sid}:${name}`

/** Serialises read-modify-write on one session's record, so two async tasks never overwrite each other. */
const chains = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  chains.set(key, run)
  return run
}

export async function readSess(p: Ports, sid: string): Promise<Sess> {
  const raw = await p.get(sessKey(sid)).catch(() => undefined)
  const base = emptySess(await p.now())
  return raw && typeof raw === 'object' ? { ...base, ...(raw as Partial<Sess>) } : base
}

/** Changes a session's record; the first write also stamps its start. */
export function patchSess(p: Ports, sid: string, fn: (s: Sess) => Partial<Sess>): Promise<Sess> {
  return serial(sessKey(sid), async () => {
    const cur = await readSess(p, sid)
    const next = { ...cur, ...fn(cur) }
    await p.set(sessKey(sid), next)
    return next
  })
}

/** A normal compact finished: counted, and its size kept so a reload cannot re-run the anti-thrash check blind. */
export const recordCompact = (p: Ports, sid: string, after: number, isCold: boolean) =>
  patchSess(p, sid, s => ({ lastCompactAfter: after, compacts: isCold ? s.compacts : s.compacts + 1 }))

export async function hasDone(p: Ports, sid: string, name: string): Promise<boolean> {
  return !!(await p.get(actKey(sid, name)).catch(() => undefined))
}

/** The action log: a store line per automatic action, newest last, for finding out what happened afterwards. */
export async function logAction(p: Ports, sid: string, name: string, ok: boolean, detail = '') {
  try {
    const raw = await p.get('housekeeping:log')
    const list = Array.isArray(raw) ? (raw as unknown[]) : []
    await p.set('housekeeping:log', [...list, { at: await p.now(), sid, name, ok, detail: detail.slice(0, 200) }].slice(-200))
  } catch {
    // the log is a help, never a failure
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, 160)

/** Runs `fn`, once more after a short pause if it failed. Never throws. */
export async function attempt<T>(p: Ports, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let error = ''
  for (let i = 0; i < 2; i++) {
    try {
      return { ok: true, value: await fn() }
    } catch (e) {
      error = message(e)
    }
    if (i === 0) await p.sleep(RETRY_PAUSE_MS).catch(() => undefined)
  }
  return { ok: false, error }
}

/** An app tool that must work: a deny or an error result throws, so `attempt` retries it. */
export async function must(p: Ports, tool: string, input: Record<string, unknown>): Promise<string> {
  const r = await p.app(tool, input)
  if (!r.ok) throw new Error(r.text || `${tool} failed`)
  return r.text
}

const KIND_WORDS: Record<string, string> = { pin: 'sabitleme', rc: 'Remote Control', rename: 'ad verme', archive: 'arşivleme' }
const KIND_WORDS_EN: Record<string, string> = { pin: 'pinning', rc: 'Remote Control', rename: 'renaming', archive: 'archiving' }
const dayOf = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * An app action the app would not approve (the auto mode classifier gave no verdict, a deny, an error) is given up for
 * that session at once: no timer tries it again. The owner hears ONE plain line a day for all sessions and kinds,
 * with the titles known by then; the raw error stays in the log, never in a chat.
 */
export async function giveUp(p: Ports, sid: string, name: string, title = '') {
  try {
    const now = await p.now()
    await p.set(actKey(sid, `${name}:gaveup`), now)
    const day = dayOf(now)
    const rec = (await p.get(actKey('all', 'gaveup'))) as { day: string; told: boolean; titles: string[] } | undefined
    const cur = rec && rec.day === day ? rec : { day, told: false, titles: [] as string[] }
    const label = title || (await readSess(p, sid)).title || sid.slice(0, 8)
    if (!cur.titles.includes(label)) cur.titles = [...cur.titles, label].slice(-8)
    const first = !cur.told
    cur.told = true
    await p.set(actKey('all', 'gaveup'), cur)
    if (!first) return
    const list = cur.titles.join(', ')
    const line = name === 'archive' ? L(`Some sessions could not be archived automatically; you can archive them by hand: ${list}`, `Bazı oturumlar otomatik arşivlenemedi; elle arşivleyebilirsin: ${list}`) : `Bazı oturumlarda otomatik ${KIND_WORDS[name] ?? name} yapılamadı; gerekirse elle yapabilirsin: ${list}`
    await p.say(line).catch(() => undefined)
  } catch {
    // telling is a help, never a failure
  }
}

/**
 * The idempotent unit: skip when the action already worked or was given up, else run it (repeated once at once) and
 * mark it. A failure is logged and given up (see `giveUp`). Returns what happened.
 */
export async function once(p: Ports, sid: string, name: string, fn: () => Promise<void>, said: string, title = ''): Promise<'done' | 'skipped' | 'failed'> {
  try {
    if ((await hasDone(p, sid, name)) || (await hasDone(p, sid, `${name}:gaveup`))) return 'skipped'
    const r = await attempt(p, fn)
    if (r.ok) {
      await p.set(actKey(sid, name), await p.now())
      await logAction(p, sid, name, true)
      if (said) await p.say(said).catch(() => undefined)
      return 'done'
    }
    await logAction(p, sid, name, false, r.error)
    await giveUp(p, sid, name, title)
    return 'failed'
  } catch {
    return 'failed'
  }
}

// ---------- pin, Remote Control, title, archive ----------

/** What the app says about a session now. A field it does not give is undefined. */
export type AppState = { pinned?: boolean; remote?: 'on' | 'off' | 'connecting' | 'unavailable'; archived?: boolean }

export async function stateOf(p: Ports, target: string): Promise<AppState> {
  const r = await p.app(APP.get, { session_id: target }).catch(() => ({ ok: false, text: '' }))
  if (!r.ok) return {}
  const flag = (k: string) => {
    const m = new RegExp(`"${k}"\s*:\s*(true|false)`).exec(r.text)
    return m ? m[1] === 'true' : undefined
  }
  const state = /"remoteControlState"\s*:\s*"(on|off|connecting|unavailable)"/.exec(r.text)?.[1] as AppState['remote']
  return { pinned: flag('pinned'), archived: flag('archived'), remote: flag('remoteControlActive') ? 'on' : state }
}

/** Marks an action as done because the app already shows it done: nothing is called, nothing is said. */
async function alreadyDone(p: Ports, sid: string, name: string) {
  await p.set(actKey(sid, name), await p.now())
  await logAction(p, sid, name, true, 'already so')
}

export async function pinSession(p: Ports, sid: string, target: string): Promise<'done' | 'skipped' | 'failed'> {
  try {
    if ((await hasDone(p, sid, 'pin')) || (await hasDone(p, sid, 'pin:gaveup'))) return 'skipped'
    if ((await stateOf(p, target)).pinned === true) {
      await alreadyDone(p, sid, 'pin')
      return 'skipped'
    }
  } catch {
    return 'failed'
  }
  return once(p, sid, 'pin', async () => void (await must(p, APP.pin, { session_id: target, pinned: true })), L('The Chief: session pinned.', 'The Chief: oturum sabitlendi.'))
}

/**
 * Remote Control on, asking the app only when it is not on already. One try: if the app's auto mode gives no verdict
 * (or refuses) the session is given up on at once, the owner hears at most one line a day for all such failures, and
 * the raw error goes to the log, never into a chat.
 */
export async function remoteOn(p: Ports, sid: string, target: string): Promise<'done' | 'skipped' | 'failed'> {
  try {
    if ((await hasDone(p, sid, 'rc')) || (await hasDone(p, sid, 'rc:gaveup'))) return 'skipped'
    const st = await stateOf(p, target)
    if (st.remote === 'on' || st.remote === 'connecting') {
      await alreadyDone(p, sid, 'rc')
      return 'skipped'
    }
    if (st.remote === 'unavailable') {
      await p.set(actKey(sid, 'rc:gaveup'), await p.now())
      await logAction(p, sid, 'rc', false, 'unavailable for this session')
      return 'skipped'
    }
    const r = await p.app(APP.remote, { session_id: target, enabled: true })
    if (r.ok) {
      await p.set(actKey(sid, 'rc'), await p.now())
      await logAction(p, sid, 'rc', true)
      await p.say(L('The Chief: Remote Control turned on.', 'The Chief: Remote Control açıldı.')).catch(() => undefined)
      return 'done'
    }
    await logAction(p, sid, 'rc', false, message(r.text))
    await giveUp(p, sid, 'rc')
    return 'failed'
  } catch {
    return 'failed'
  }
}

/** The title the app shows for a session, or '' when it does not say. */
export async function titleOfSession(p: Ports, target: string): Promise<string> {
  const r = await p.app(APP.get, { session_id: target }).catch(() => ({ ok: false, text: '' }))
  return r.ok ? (/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(r.text)?.[1] ?? '').replace(/\\"/g, '"') : ''
}

const SMALL = new Set(['ve', 'ile', 'için', 'bir', 'de', 'da', 'mi', 'mı', 'and', 'with', 'for', 'the', 'of', 'to', 'a'])
const trUpper = (s: string) => s.toLocaleUpperCase('tr')
/** All-caps text lowercased: a Turkish İ becomes i, and a plain I too (HELLO becomes Hello). */
const trLower = (s: string) => s.replace(/İ/g, 'i').toLowerCase()

/** A tidy Turkish title: Title Case, 2 to 5 words, no "Chief ·", no quotes, no all-caps words (digits keep their case). */
export function cleanTitle(raw: string): string {
  const text = raw
    .replace(/^\s*chief\s*[·:\-–—]\s*/i, '')
    .replace(/["“”„`«»]/g, '')
    .replace(/(^|\s)['‘’]+|['‘’]+(?=\s|$)/g, '$1')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[.!?:;,]+$/g, '')
  const words = text.split(/\s+/).filter(Boolean).slice(0, 5)
  // a title never ends on a connective ("… Hızlandır ve"): the cut at five words, or the first-words fallback, left one there
  while (words.length > 2 && SMALL.has(trLower(words[words.length - 1]!))) words.pop()
  const cased = words.map((w, i) => {
    if (/\d/.test(w) && w === trUpper(w)) return w
    const letters = w.replace(/[^\p{L}]/gu, '')
    const body = letters.length > 3 && w === trUpper(w) ? trLower(w) : w
    if (i > 0 && SMALL.has(trLower(body))) return trLower(body)
    return trUpper(body.charAt(0)) + body.slice(1)
  })
  return cased.join(' ').trim()
}

/** The words of the goal or first request that name the work: the rules fallback when no model answers. */
export function titleFromText(text: string): string {
  const first = text.replace(/^\/\w+\s+/, '').split(/[\n.!?]/)[0] ?? ''
  const words = first.replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').split(/\s+/).filter(w => w.length > 1)
  return cleanTitle(words.slice(0, 4).join(' '))
}

/**
 * Sets the session's title once, from `title` (already made from the goal or first request). A title the owner
 * changed by hand is left alone for good; a handoff session keeps the old one (the caller passes it).
 */
export async function renameSession(p: Ports, sid: string, target: string, title: string, exact = false): Promise<'done' | 'skipped' | 'failed'> {
  // `exact`: a handoff session takes the old title as it is
  const clean = exact ? title.trim() : cleanTitle(title)
  if (!clean || (!exact && clean.split(/\s+/).length < 2)) return 'skipped'
  const s = await readSess(p, sid)
  if (s.userRenamed) return 'skipped'
  if (s.title) {
    const now = await titleOfSession(p, target)
    if (now && now !== s.title) {
      await patchSess(p, sid, () => ({ userRenamed: true }))
      await logAction(p, sid, 'rename', false, `owner renamed it to "${now}"; left alone`)
      return 'skipped'
    }
    if (s.title === clean) return 'skipped'
    // one rename only; a handoff session or the leader's fixed title (exact) may follow
    if (!exact) return 'skipped'
  } else if (!exact && clean === (await titleOfSession(p, target))) {
    await patchSess(p, sid, () => ({ title: clean }))
    return 'skipped'
  }
  const r = await attempt(p, async () => void (await must(p, APP.title, { session_id: target, title: clean })))
  if (!r.ok) {
    await logAction(p, sid, 'rename', false, r.error)
    await giveUp(p, sid, 'rename', s.title || clean)
    return 'failed'
  }
  await patchSess(p, sid, () => ({ title: clean }))
  await logAction(p, sid, 'rename', true, clean)
  await p.say(L(`The Chief: session renamed to "${clean}".`, `The Chief: oturum adı "${clean}" yapıldı.`)).catch(() => undefined)
  return 'done'
}

/** Names the session once, from a title made on demand; a title that cannot be made leaves it for the next try. */
export async function nameOnce(p: Ports, sid: string, target: string, make: () => Promise<string>): Promise<'done' | 'skipped' | 'failed'> {
  try {
    if (await hasDone(p, sid, 'named')) return 'skipped'
    const title = await make()
    if (!title) return 'skipped'
    const r = await renameSession(p, sid, target, title)
    // a refused rename is given up on, not tried at every turn's end
    await p.set(actKey(sid, 'named'), await p.now())
    return r
  } catch {
    return 'failed'
  }
}

/**
 * Names the session. The Leader of Chiefs always has LEADER_TITLE (also when a goal named it first), never a title made
 * from a goal; any other session is named once by `make`.
 */
export async function nameSession(p: Ports, sid: string, target: string, isLeader: boolean, make: () => Promise<string>): Promise<'done' | 'skipped' | 'failed'> {
  if (!isLeader) return nameOnce(p, sid, target, make)
  try {
    const r = await renameSession(p, sid, target, L(LEADER_TITLE_EN, LEADER_TITLE), true)
    await p.set(actKey(sid, 'named'), await p.now())
    return r
  } catch {
    return 'failed'
  }
}

export type ArchiveGuard = {
  /** A tool call, a subagent, a worker or a background job of that session is running. */
  busy: boolean
  /** The last time the owner typed into it (0 = never). */
  ownerTypedAt: number
  /** The session's title, for the one daily line when the app will not archive it. */
  title?: string
  /**
   * The old half of a handoff: it is archived only when the handoff proved itself (the new session took the work).
   * Omitted by a release, which is the leader's own order.
   */
  handoff?: { newSid: string; verified: boolean }
}

export type ArchiveResult = 'archived' | 'skipped' | 'busy' | 'typed' | 'unverified' | 'failed'

/**
 * Whether an old handoff session may be archived: the handoff must have PROVED itself (the new session started its
 * first turn, which `handoffOkAt` records). A failed or half-done handoff leaves the old chat exactly as it is: it is
 * still the only one doing the job (a wt-shrink chief was archived after a handoff that never happened).
 */
export function handoffArchiveOk(s: { handedOffTo?: string; handoffOkAt?: number }, newSid: string): boolean {
  return !!newSid && s.handedOffTo === newSid && (s.handoffOkAt ?? 0) > 0
}

/**
 * Unpins, then archives a finished or handed-off session. Never while it runs something, never within 30 minutes
 * of the owner typing into it ('busy' and 'typed' mean: try again later). Idempotent. The app's answer is final: a
 * refusal (e.g. the auto mode classifier gave no verdict) gives the session up, with no timer trying again.
 */
export async function archiveSession(p: Ports, sid: string, target: string, g: ArchiveGuard, why: string): Promise<ArchiveResult> {
  try {
    if ((await hasDone(p, sid, 'archive')) || (await hasDone(p, sid, 'archive:gaveup'))) return 'skipped'
    if (g.busy) return 'busy'
    if (g.ownerTypedAt > 0 && (await p.now()) - g.ownerTypedAt < TYPED_QUIET_MS) return 'typed'
    // a handoff archives the old chat only after the new one proved it took over; nothing is called otherwise
    if (g.handoff && !g.handoff.verified) {
      await logAction(p, sid, 'archive', false, `handoff to ${g.handoff.newSid || '(none)'} not verified; the old session stays`)
      return 'unverified'
    }
    const st = await stateOf(p, target)
    if (st.archived === true) {
      await alreadyDone(p, sid, 'archive')
      return 'skipped'
    }
    if (st.pinned !== false && !(await hasDone(p, sid, 'unpin'))) {
      // one try per session: marked before the call, so a refused or thrown unpin is never retried on a later archive attempt
      await p.set(actKey(sid, 'unpin'), await p.now())
      const unpin = await p.app(APP.pin, { session_id: target, pinned: false }).catch((e: unknown) => ({ ok: false as const, text: e }))
      if (!unpin.ok) await logAction(p, sid, 'unpin', false, message(unpin.text))
    }
    const r = await once(p, sid, 'archive', async () => void (await must(p, APP.archive, { session_id: target, reason: `The Chief: ${why}` })), L(`The Chief: ${why}; unpinned and archived.`, `The Chief: ${why}; sabitleme kalktı, oturum arşivlendi.`), g.title)
    return r === 'done' ? 'archived' : r === 'skipped' ? 'skipped' : 'failed'
  } catch {
    return 'failed'
  }
}

// ---------- when to hand off ----------

export type TriggerInput = {
  now: number
  compacts: number
  afterCompacts: number
  startedAt: number
  afterHours: number
  context: number
  handoffAt: number
  handedOffTo: string
  /** The identity (app id) is known, the chat is a normal interactive one, and it is not a leader. */
  eligible: boolean
  /** A turn, a tool call, a subagent, a worker or a background job is running. */
  busy: boolean
  /** The owner interrupted the writing turn once: no automatic handoff for this session again. */
  autoOff?: boolean
  /** The leader or the owner turned handoff off for this chief (its config: `handoff: false`); absent means on. */
  handoffOn?: boolean
}

export type HandoffVerdict = { go: false; why: string } | { go: true; reason: 'compacts' | 'age' }

/** The reason this session should hand off now, or why it should not. */
export function handoffVerdict(i: TriggerInput): HandoffVerdict {
  if (!i.eligible) return { go: false, why: 'not eligible' }
  if (i.handoffOn === false) return { go: false, why: 'handoff is off for this chief' }
  if (i.handedOffTo) return { go: false, why: 'already handed off' }
  if (i.autoOff) return { go: false, why: 'the owner stopped it' }
  if (i.handoffAt && i.now - i.handoffAt < HANDOFF_DEBOUNCE_MS) return { go: false, why: 'handed off (or tried) under 30 min ago' }
  const byCompacts = i.afterCompacts > 0 && i.compacts >= i.afterCompacts
  const byAge = i.afterHours > 0 && i.now - i.startedAt > i.afterHours * 3600_000 && i.context > LONG_CONTEXT
  if (!byCompacts && !byAge) return { go: false, why: 'no trigger' }
  if (i.busy) return { go: false, why: 'busy' }
  return { go: true, reason: byCompacts ? 'compacts' : 'age' }
}

// ---------- the idle chief's own compact ----------

/**
 * An idle chief compacts itself this long after its last turn: while its prompt cache is still warm, so the summary is
 * written at the cache-read price and the next message does not write the whole history again.
 */
export const IDLE_COMPACT_MS = 50 * 60_000
/** The chat's prompt cache lives an hour; a compact after that reads the whole history again (the cold guard's job). */
export const CACHE_LIFE_MS = 62 * 60_000

export type IdleCompactInput = {
  now: number
  /** When its last turn ended (0 = no turn seen yet). */
  lastTurnEnd: number
  /** A turn, a tool call, a worker, a subagent or a detached run is running: never touched. */
  busy: boolean
  /** The chief's own switch (`compact: false` in its config turns it off). */
  on: boolean
  /** The idle spell already compacted (the end of its last turn), so one spell is one compact. */
  doneFor?: number
  /** The window, for tests. */
  after?: number
  before?: number
}

/**
 * Whether an idle chief is due its own compact now: 50 minutes after its last turn, never while anything runs, once
 * per idle spell, and never once the prompt cache has died (the cold guard handles that one). Pure, so it is tested.
 */
export function idleCompactDue(v: IdleCompactInput): boolean {
  if (!v.on || v.busy || v.lastTurnEnd <= 0) return false
  if (v.doneFor === v.lastTurnEnd) return false
  const idle = v.now - v.lastTurnEnd
  return idle >= (v.after ?? IDLE_COMPACT_MS) && idle < (v.before ?? CACHE_LIFE_MS)
}

// ---------- the handoff itself ----------

const pad = (n: number) => String(n).padStart(2, '0')

/** `<cwd>/.chief/handoff-2026-10-14-1530.md`, with the cwd's own separators. */
export function handoffPath(cwd: string, at: number): string {
  const d = new Date(at)
  const sep = /^[A-Za-z]:[\\/]/.test(cwd) && cwd.includes('\\') ? '\\' : '/'
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${cwd.replace(/[\\/]+$/, '')}${sep}.chief${sep}handoff-${stamp}.md`
}

/** The turn that writes the handoff file. */
export function handoffAsk(path: string, goal: string): string {
  return [
    `This session is long, so a fresh session takes over. Write a DETAILED handoff file at ${path} (create the .chief folder if needed) with the Write tool, then answer with one line: the path. Do nothing else.`,
    'It must be good enough that the next session needs no transcript. Target 3-8k tokens. Sections, in this order:',
    "1. The owner's standing instructions and rules, VERBATIM (CLAUDE.md-style rules, every 'always/never/do not' they gave, the language and tone they want).",
    `2. The goal${goal ? ` (currently: ${goal})` : ''}, in the owner's words.`,
    '3. Decisions made and why.',
    '4. Exact file paths, branches, commit hashes and line ranges touched or in play.',
    '5. The commands that build or verify the work, with their last result.',
    '6. Running background jobs and agents, each with its id and the exact way to check it (so nothing is lost).',
    '7. Open TODOs and the very next step.',
    '8. Unresolved errors, verbatim.',
    '9. Ids, URLs and names in play (sessions, tickets, services, people).',
    'Be concrete; no summaries of what is already done and verified.',
  ].join('\n')
}

export type Job = { id: string; name: string; check: string }

/** The first message of the new session: the file, the goal and the jobs to look at first. */
export function firstMessage(path: string, goal: string, jobs: readonly Job[], record = ''): string {
  return [
    L(`Handoff from the previous session: ${path}. Read the file and carry on where it left off.`, `Önceki oturumdan devir: ${path}. Dosyayı oku ve kaldığı yerden devam et.`),
    goal ? L(`Goal: ${goal}`, `Hedef: ${goal}`) : '',
    jobs.length
      ? L(`Running jobs (check these first, so their results are not lost): ${jobs.map(j => `${j.name} [${j.id}] → ${j.check}`).join('; ')}.`, `Çalışan işler (önce bunları kontrol et, sonuçları kaybolmasın): ${jobs.map(j => `${j.name} [${j.id}] → ${j.check}`).join('; ')}.`)
      : L("Check the 'running jobs' part of the file first, so their results are not lost.", "Dosyadaki 'çalışan işler' bölümünü ilk iş olarak kontrol et; sonuçları kaybolmasın."),
    // nothing is lost by a handoff: what the file leaves out is still in the old chat's record, looked up only when needed
    record ? L(`If you need a detail the file does not have, do not guess: the full record of the previous session is ${record}.jsonl under ~/.claude/projects. Do not read all of it; search it for what you need (grep).`, `Dosyada olmayan bir ayrıntı gerekirse tahmin etme: önceki oturumun tam kaydı ~/.claude/projects altındaki ${record}.jsonl dosyasında. Tamamını okuma; aradığın sözü o dosyada ara (grep).`) : '',
    L('Do not ask the user; carry on without waiting.', 'Kullanıcıya sorma, beklemeden devam et.'),
  ].filter(Boolean).join('\n')
}

/** What the new session needs to be the old one's successor. */
export type Inbound = {
  message: string
  /** Set as /goal after the first turn when the old session had a goal. */
  goal: string
  model: string
  effort: string
  permission: string
  dir: string
  title: string
  pinned: boolean
  remote: boolean
  fromSid: string
  /** The old session was this leader's chief: the new one becomes it. */
  chief: { leaderSid: string; leaderTitle: string; config: Record<string, unknown> } | null
}

export type FlowPorts = Ports & {
  /** Sends the turn that writes the file, ONCE; true when the file exists afterwards, 'aborted' when the owner interrupted the turn. */
  write: (path: string, ask: string) => Promise<boolean | 'aborted'>
  /** Keeps a copy of the file in the plugin store. */
  keep: (path: string) => Promise<void>
  /** Opens the new session with the first message waiting for it; throws with the reason. `again` is the id of a first try. */
  open: (inbound: Inbound, again: string | null) => Promise<string>
  /** The new session has started its first turn. */
  started: (newSid: string) => Promise<boolean>
  /**
   * The new session is really still there (it took the handoff and wrote its card after): the proof the old session
   * waits for before it is archived. Omitted, `started` is the proof.
   */
  verify?: (newSid: string) => Promise<boolean>
  /** Tells the leader a chief moved: "<chief> devredildi → <new sid>"; the old session stops being a chief. */
  moved: (title: string, newSid: string) => Promise<void>
  /** The guard for archiving the old session right now. */
  guard: () => Promise<ArchiveGuard>
}

export type FlowInput = {
  sid: string
  /** The engine's id of this chat: the name of its full record under ~/.claude/projects. */
  record?: string
  target: string
  cwd: string
  goal: string
  title: string
  jobs: readonly Job[]
  inbound: Omit<Inbound, 'message'>
}

/** What finishing a handoff needs to know about the old session. */
export type Finish = {
  sid: string
  target: string
  title: string
  isChief: boolean
  /** The handoff's proof (the new session started, and is still there). False: the old session is kept, no archive. */
  verified?: boolean
}

export type FlowResult = { ok: true; newSid: string; archive: ArchiveResult } | { ok: false; error: string }

async function waitStarted(f: FlowPorts, newSid: string): Promise<boolean> {
  for (let waited = 0; waited <= START_WAIT_MS; waited += START_STEP_MS) {
    if (await f.started(newSid).catch(() => false)) return true
    await f.sleep(START_STEP_MS)
  }
  return false
}

/**
 * A handoff that did not happen. The trigger starts over (no compacts, a new start time), so another one needs the
 * full 2 compacts / 8 hours again and nothing loops. `stop`: the owner interrupted it, so never automatically again.
 */
async function resetTrigger(f: Ports, sid: string, stop = false) {
  const now = await f.now()
  await patchSess(f, sid, () => ({ flow: null, compacts: 0, startedAt: now, ...(stop ? { autoOff: true } : {}) }))
}

async function failed(f: FlowPorts, sid: string, error: string, stop = false): Promise<FlowResult> {
  await resetTrigger(f, sid, stop)
  await logAction(f, sid, 'handoff', false, error)
  const line = stop ? L('The Chief: handoff stopped; automatic handoff is off for this session.', 'The Chief: devir durduruldu; bu oturum için otomatik devir kapalı.') : L(`The Chief: the handoff did not happen (${error}); carrying on in this session.`, `The Chief: devir olmadı (${error}); bu oturumda devam ediyorum.`)
  await f.say(line).catch(() => undefined)
  return { ok: false, error }
}

/**
 * One continuous action: file, new session, first message, wait for its first turn, then unpin and archive the old
 * one. Any failure leaves the old session working and untouched, and tells the owner one line.
 */
export async function runHandoff(f: FlowPorts, c: FlowInput): Promise<FlowResult> {
  try {
    const t0 = await f.now()
    const path = handoffPath(c.cwd, t0)
    await patchSess(f, c.sid, () => ({ handoffAt: t0, flow: { stage: 'writing', path, newSid: '', at: t0 } }))
    // the writing turn is sent once and never repeated: an interrupted or failed one ends the try
    let wrote: boolean | 'aborted' = false
    let why = L('file not written', 'dosya yazılmadı')
    try {
      wrote = await f.write(path, handoffAsk(path, c.goal))
    } catch (e) {
      why = message(e)
    }
    if (wrote === 'aborted') return await failed(f, c.sid, L('handoff turn stopped', 'devir turu durduruldu'), true)
    if (wrote !== true) return await failed(f, c.sid, L(`handoff file: ${why}`, `devir dosyası: ${why}`))
    await f.keep(path).catch(() => undefined)

    const inbound: Inbound = { ...c.inbound, message: firstMessage(path, c.goal, c.jobs, c.record) }
    await patchSess(f, c.sid, () => ({ flow: { stage: 'opening', path, newSid: '', at: t0 } }))
    const opened = await attempt(f, () => f.open(inbound, null))
    if (!opened.ok) return await failed(f, c.sid, L(`could not open the new session: ${opened.error}`, `yeni oturum açılamadı: ${opened.error}`))
    let newSid = opened.value
    await patchSess(f, c.sid, () => ({ flow: { stage: 'waiting', path, newSid, at: t0 } }))

    let up = await waitStarted(f, newSid)
    if (!up) {
      const again = await attempt(f, () => f.open(inbound, newSid))
      if (again.ok) newSid = again.value
      up = again.ok && (await waitStarted(f, newSid))
    }
    if (!up) return await failed(f, c.sid, L('the new session did not start its first turn', 'yeni oturum ilk turunu başlatmadı'))
    // started is not enough: the new chat must still be there (it took the handoff and wrote its card after that)
    if (f.verify && !(await f.verify(newSid).catch(() => false))) return await failed(f, c.sid, L('could not verify the new session', 'yeni oturum doğrulanamadı'))
    return await finishHandoff(f, { sid: c.sid, target: c.target, title: c.title, isChief: !!c.inbound.chief, verified: true }, newSid)
  } catch (e) {
    return await failed(f, c.sid, message(e))
  }
}

/** The new session is running: mark the old one handed off, tell the owner, then unpin and archive it. */
export async function finishHandoff(f: FlowPorts, c: Finish, newSid: string): Promise<FlowResult> {
  // no proof, no handoff: the old chat is not marked handed off and is never archived for a handoff that did not happen
  if (c.verified === false || !newSid) {
    await resetTrigger(f, c.sid)
    await logAction(f, c.sid, 'handoff', false, 'not verified; the old session is kept')
    return { ok: false, error: L('could not verify the new session', 'yeni oturum doğrulanamadı') }
  }
  const at = await f.now()
  await patchSess(f, c.sid, () => ({ handedOffTo: newSid, handoffOkAt: at, flow: null }))
  await f.set(actKey(c.sid, 'handoff'), at)
  await logAction(f, c.sid, 'handoff', true, newSid)
  await f.say(L(`The session got long; moved to a new session with a detailed handoff: ${c.title}`, `Oturum uzadı, ayrıntılı devirle yeni oturuma geçildi: ${c.title}`)).catch(() => undefined)
  if (c.isChief) await f.moved(c.title, newSid).catch(() => undefined)
  const archive = await archiveSession(f, c.sid, c.target, { ...(await f.guard()), handoff: { newSid, verified: true } }, L('handoff done, the new session is running', 'devir tamam, yeni oturum çalışıyor'))
  return { ok: true, newSid, archive }
}

/**
 * A reload (an undo, an app restart) in the middle of a handoff: if the new session had been opened, wait for
 * its first turn and finish; anything earlier is dropped and the trigger starts over, so it cannot loop.
 */
export async function resumeHandoff(f: FlowPorts, c: Finish): Promise<'finished' | 'dropped' | 'none'> {
  const s = await readSess(f, c.sid)
  if (!s.flow || s.handedOffTo) return 'none'
  const { stage, newSid } = s.flow
  if (stage === 'waiting' && newSid && (await waitStarted(f, newSid)) && (!f.verify || (await f.verify(newSid).catch(() => false)))) {
    await finishHandoff(f, { ...c, verified: true }, newSid)
    return 'finished'
  }
  await resetTrigger(f, c.sid)
  await logAction(f, c.sid, 'handoff', false, `dropped after a reload at "${stage}"`)
  await f.say(L('The Chief: the handoff stopped half way (the session reopened); carrying on in this session.', 'The Chief: devir yarıda kaldı (oturum yeniden açıldı); bu oturumda devam ediyorum.')).catch(() => undefined)
  return 'dropped'
}
