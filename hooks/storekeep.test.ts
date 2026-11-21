import { expect, test } from 'claude-code/testing'
import { BULKY, kvName, prunePlan, sidOf, storeSet } from './storekeep'

const A = '11111111-2222-3333-4444-555555555555'
const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const C = '99999999-8888-7777-6666-555555555555'
const DAY = 86400000

function memStore(init: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(init))
  let writes = 0
  return {
    writes: () => writes,
    store: {
      get: async (k: string) => m.get(k),
      set: async (k: string, v: unknown) => { writes++; if (v === undefined) m.delete(k); else m.set(k, JSON.parse(JSON.stringify(v))) },
      delete: async (k: string) => { m.delete(k) },
      keys: async () => [...m.keys()],
    },
  }
}

test('storeSet: skips an unchanged value and writes a changed one', async () => {
    const $ = memStore({ k: { a: 1, b: [2] } })
    await storeSet($, 'k', { a: 1, b: [2] })
    expect($.writes()).toBe(0)
    await storeSet($, 'k', { a: 2, b: [2] })
    expect($.writes()).toBe(1)
    await storeSet($, 'new', 0)
    expect($.writes()).toBe(2)
    await storeSet($, 'missing', undefined)
    expect($.writes()).toBe(2)
    await storeSet($, 'new', undefined)
    expect($.writes()).toBe(3)
})

test('prunePlan: drops every key of a session not seen for the age limit, keeps live and unknown ones', () => {
    const now = 100 * DAY
    const e = new Map<string, unknown>([
      [`lastTurnEnd:${A}`, now - 30 * DAY], [`role:${A}`, { role: 'solo' }], [`act:${A}:rc`, now - 40 * DAY],
      [`sess:${B}`, { startedAt: now - 30 * DAY, ownerTypedAt: now - DAY }], [`role:${B}`, {}],
      [`chiefConfig:${C}`, { goal: 'x' }],
      ['reports', []], ['walm:abc', 1],
    ])
    expect(prunePlan(e, now, 14 * DAY).sort()).toEqual([`act:${A}:rc`, `lastTurnEnd:${A}`, `role:${A}`].sort())
    expect(sidOf(`act:${A}:rc`)).toBe(A)
    expect(sidOf('walm:abc')).toBeNull()
})

test('logs, reports, handoff texts and model lists go to their own hq file; small state stays in the store', () => {
  for (const k of [`leaderLog:${A}`, `handoffFile:${A}`, `handoffIn:${A}`, 'housekeeping:log', 'reports', 'modelCache']) expect(BULKY.test(k)).toBe(true)
  for (const k of [`role:${A}`, `chiefConfig:${A}`, 'mainGoal', 'reportsSeen', 'modelCacheAt', `act:${A}:rc`]) expect(BULKY.test(k)).toBe(false)
  expect(kvName(`leaderLog:${A}`)).toBe(`kv-leaderLog_${A}.json`)
  expect(kvName('housekeeping:log')).toBe('kv-housekeeping_log.json')
})
