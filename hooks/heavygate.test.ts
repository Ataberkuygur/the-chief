import { expect, test } from 'claude-code/testing'
import { gatePlan, isAsr, isHeavy } from './heavygate'
import type { GateProc } from './heavygate'

const ASR_CMD = 'C:\\x\\local-env/asr-venv/Scripts/python.exe C:\\x\\core\\src\\analyze\\py\\asr_worker.py clip.wav'
const agent: GateProc = { pid: 1, ppid: 0, name: 'claude.exe', cmd: 'claude', created: 1, mb: 300 }
const asrProc = (pid: number, created: number): GateProc => ({ pid, ppid: 1, name: 'python.exe', cmd: ASR_CMD, created, mb: 2500 })

test('isAsr catches speech-recognition python, never the long-lived python servers or the Node builds', () => {
  expect(isAsr({ name: 'python.exe', cmd: ASR_CMD })).toBe(true)
  expect(isAsr({ name: 'python.exe', cmd: 'python -m faster_whisper_cli a.wav' })).toBe(true)
  expect(isAsr({ name: 'python.exe', cmd: 'C:\\x\\asr-venv\\Scripts\\python.exe C:\\x\\embed_worker.py serve --model m' })).toBe(false)
  expect(isAsr({ name: 'python.exe', cmd: 'C:\\Ataberk\\MyWiki\\server\\.venv\\Scripts\\python.exe C:\\Ataberk\\MyWiki\\server\\server.py' })).toBe(false)
  expect(isAsr({ name: 'node.exe', cmd: ASR_CMD })).toBe(false)
  expect(isHeavy({ name: 'python.exe', cmd: ASR_CMD })).toBe(false)
})

test('four ASR runs on a low machine: the newest wait, and they go on when RAM comes back', () => {
  const procs = [agent, asrProc(10, 100), asrProc(11, 200), asrProc(12, 300), asrProc(13, 400)]
  const o = { reserveMb: 4096, slotMb: 3000, maxSlots: 3, now: 1000, maxWaitMs: 1200000, heavy: isAsr }
  // 1.8 GB free, 10 GB held by the four: (1800 + 10000 - 4096) / 3000 = 2 slots
  const low = gatePlan(procs, [], { ...o, freeMb: 1800 })
  expect(low.slots).toBe(2)
  expect(low.suspend.sort()).toEqual([12, 13])
  expect(low.next.map(w => w.pid).sort()).toEqual([12, 13])
  // plenty of RAM: three at a time at most (maxSlots), the newest one still waits
  const plenty = gatePlan(procs, [], { ...o, freeMb: 20000 })
  expect(plenty.slots).toBe(3)
  expect(plenty.suspend).toEqual([13])
  // RAM back and the others finished: the held one is resumed
  const later = gatePlan([agent, asrProc(13, 400)], low.next, { ...o, freeMb: 16000, now: 2000 })
  expect(later.resume).toEqual([13])
  expect(later.next).toEqual([])
})

test('a held ASR run goes on after maxWaitMs whatever the slots say, and a person’s own run is never held', () => {
  const held = [{ pid: 13, created: 400, since: 0 }]
  const procs = [agent, asrProc(10, 100), asrProc(11, 200), asrProc(12, 300), asrProc(13, 400)]
  const o = { reserveMb: 4096, slotMb: 3000, maxSlots: 3, maxWaitMs: 1200000, heavy: isAsr, freeMb: 1000 }
  expect(gatePlan(procs, held, { ...o, now: 1300000 }).resume).toContain(13)
  const mine: GateProc[] = [{ pid: 2, ppid: 0, name: 'WindowsTerminal.exe', cmd: 'wt', created: 1, mb: 90 }, { pid: 20, ppid: 2, name: 'python.exe', cmd: ASR_CMD, created: 50, mb: 2500 }, { pid: 21, ppid: 2, name: 'python.exe', cmd: ASR_CMD, created: 60, mb: 2500 }]
  expect(gatePlan(mine, [], { ...o, now: 5 }).suspend).toEqual([])
})
