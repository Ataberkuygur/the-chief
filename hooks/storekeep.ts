/**
 * Store upkeep (21.11). The engine rewrites the whole shared store file on every `$.store.set`, and every open chat
 * reads it back. Timers in every chat set values that did not change, so a 2.6 MB file was rewritten about every
 * 400 ms with identical bytes and each idle chat burnt 35-119% of a core. Keys of chats gone for weeks were never
 * removed (5600 keys), and the store refuses writes past 4 MiB.
 *
 * `storeSet` writes only a changed value; `prunePlan` lists the keys of sessions not seen for `maxAgeMs`.
 */
type StoreLike = { store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>; keys(): Promise<string[]> } }

/** `$.store.set` that skips a write when the stored value is already the same JSON. */
export async function storeSet($: StoreLike, key: string, value: unknown): Promise<void> {
  const cur = await $.store.get(key)
  // removing a key that is not there is no change either
  if (value === undefined ? cur === undefined : cur !== undefined && JSON.stringify(cur) === JSON.stringify(value)) return
  return $.store.set(key, value)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The session id a key belongs to (`prefix:<uuid>` or `prefix:<uuid>:more`), else null. Pure. */
export function sidOf(key: string): string | null {
  const id = key.split(':')[1]
  return id !== undefined && UUID.test(id) ? id.toLowerCase() : null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Keys of sessions whose newest sign of life (lastTurnEnd, act, sess.startedAt / ownerTypedAt) is older than
 * `maxAgeMs`. A session with no timestamp at all is kept: nothing says it is gone. Pure.
 */
export function prunePlan(entries: ReadonlyMap<string, unknown>, now: number, maxAgeMs: number): string[] {
  const seen = new Map<string, number>()
  const note = (sid: string, at: number): void => { if (at > (seen.get(sid) ?? 0)) seen.set(sid, at) }
  for (const [key, value] of entries) {
    const sid = sidOf(key)
    if (sid === null) continue
    if (key.startsWith('lastTurnEnd:') || key.startsWith('act:')) note(sid, num(value))
    else if (key.startsWith('sess:') && value !== null && typeof value === 'object') {
      const s = value as Record<string, unknown>
      note(sid, Math.max(num(s.startedAt), num(s.ownerTypedAt), num(s.handoffAt)))
    }
    if (!seen.has(sid)) seen.set(sid, 0)
  }
  const gone = new Set([...seen].filter(([, at]) => at > 0 && now - at > maxAgeMs).map(([sid]) => sid))
  return [...entries.keys()].filter(key => { const sid = sidOf(key); return sid !== null && gone.has(sid) })
}

/** Removes the keys `prunePlan` names; returns how many went. */
export async function pruneStore($: StoreLike, now: number, maxAgeMs: number): Promise<number> {
  const entries = new Map<string, unknown>()
  for (const key of await $.store.keys()) entries.set(key, await $.store.get(key))
  const drop = prunePlan(entries, now, maxAgeMs)
  for (const key of drop) await $.store.delete(key)
  return drop.length
}
