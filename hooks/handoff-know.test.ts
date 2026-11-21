import { expect, test } from 'claude-code/testing'
import { firstMessage, knowAsk, knowPath } from './handoff'

test('handoff: the new session gets the handoff file and the NE-BILIYORUZ file', () => {
  const at = new Date(2026, 10, 21, 15, 30).getTime()
  const know = knowPath('C:\\work', at)
  expect(know).toBe('C:\\work\\.chief\\NE-BILIYORUZ-2026-11-21-1530.md')
  const msg = firstMessage('C:\\work\\.chief\\handoff-2026-11-21-1530.md', 'g', [], '', know)
  expect(msg.includes('handoff-2026-11-21-1530.md')).toBe(true)
  expect(msg.includes(know)).toBe(true)
  expect(firstMessage('h.md', 'g', []).includes('NE-BILIYORUZ')).toBe(false)
  expect(knowAsk(know, 'g', true).includes('fresh session takes over')).toBe(true)
})
