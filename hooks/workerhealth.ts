import { L } from './lang'
/**
 * Worker health: the state of a running CLI worker, and whether it is a real alarm.
 *
 * Pure, so every CLI (claude, codex, qoder, opencode-zen, opencode-go, ollama/custom …) and both plugin
 * stores (inline and synced) go through exactly the same rules: register.tsx only reads the log, the
 * process list and the CPU times and hands them in here.
 *
 * The rule the old watchdog broke: a stop is declared ONLY with evidence —
 *   • the process is gone,
 *   • the run exited non-zero,
 *   • or the log has not grown for QUIET_MS AND the process shows no CPU activity.
 * Thinking, a long tool call, a small log or a fresh run are NOT alarms. A log never written is 0-BYTE
 * only when the process is alive and provably used no CPU; a process that is alive with CPU is working.
 * Restarts and the one-notification-per-alarm rule live in register.tsx (the alarm key below is what it
 * persists).
 */

/** Quiet time after which a worker is looked at. On its own it is never an alarm. */
export const QUIET_MS = 10 * 60000
/** Grace after the process leaves: a run that has just ended is not yet a stop. */
export const GONE_GRACE_MS = 2 * 60000
/** CPU (ms) its process tree must have used since the previous look to count as working. */
export const CPU_ACTIVE_MS = 150

export type WorkerHealthInput = {
  /** Bytes in the run's log (0 = never written). */
  logBytes: number
  /** When the log last grew; 0 = never. */
  lastWriteAt: number
  startedAt: number
  now: number
  /** The command running under it (a build, a test, a lock wait): busy, not stuck. */
  busy?: { label: string; lockWait: boolean } | null
  /** A child that is hung (OpenCode's snapshot `git add`). */
  hung?: string | null
  /** A heavy command of its tree is held by the RAM gate. */
  gateHeld?: boolean
  /** The machine's build lock / train queue is held. */
  lockHeld?: boolean
  /** The process was found in the machine's list on this look; undefined = not looked / could not tell. */
  alive?: boolean
  /** A recorded process id that is no longer on the machine (proven gone). */
  gone?: boolean
  /** CPU its tree used since the previous look: true = it used some, false = none, undefined = not measured. */
  cpuActive?: boolean
  /** The run's exit code when it has ended; null/undefined while it runs. */
  exitCode?: number | null
  /** The record's own status when it is not running: done, failed or stopped. */
  status?: string
}

export type AlarmReason = 'gone' | 'exit' | 'hung' | 'zero-byte' | 'stalled'

export type WorkerHealth = {
  state: string
  note: string
  /** True only for a stop/hang with evidence; a busy or waiting worker is never one. */
  alarm: boolean
  /** Why it alarms (the dedupe key's reason); '' when it does not. */
  reason: AlarmReason | ''
}

/** "45 sn", "12 dk", "3 sa": a short elapsed time for the state's note. */
const elapsed = (ms: number): string => {
  const m = Math.round(Math.max(0, ms) / 60000)
  if (m < 1) return L(`${Math.max(0, Math.round(ms / 1000))} s`, `${Math.max(0, Math.round(ms / 1000))} sn`)
  if (m < 60) return L(`${m} min`, `${m} dk`)
  return L(`${Math.round(m / 60)} h`, `${Math.round(m / 60)} sa`)
}

/**
 * One worker's health. The order matters: an ended run, a proven death, a hang, a wait and a busy
 * command all win over "no new log"; only what is left can be a stall.
 */
const STATE_EN: Record<string, string> = { KOPTU: 'GONE', ASILI: 'HUNG', 'RAM BEKLİYOR': 'WAITING FOR RAM', 'KİLİT BEKLİYOR': 'WAITING FOR LOCK', 'KOMUT ÇALIŞIYOR': 'COMMAND RUNNING', çalışıyor: 'working', TAKILMIŞ: 'STALLED', durduruldu: 'stopped' }
/** A state as the person reads it; the state itself stays the same word, code compares it. */
export const stateLabel = (s: string) => L(STATE_EN[s] ?? s.replace(/^bitti, çıkış/, 'done, exit').replace(/^başarısız, çıkış/, 'failed, exit'), s)
export function workerHealth(v: WorkerHealthInput): WorkerHealth {
  const quiet = v.now - (v.lastWriteAt || v.startedAt)
  // an ended run: its ending is told once by the run itself, never as a stall
  if (v.status && v.status !== 'running') {
    if (v.status === 'done') return { state: `bitti, çıkış ${v.exitCode ?? 0}`, note: '', alarm: false, reason: '' }
    if (v.status === 'stopped') return { state: 'durduruldu', note: '', alarm: false, reason: '' }
    return { state: `başarısız, çıkış ${v.exitCode ?? 'n/a'}`, note: '', alarm: false, reason: '' }
  }
  // 1. a process that is gone is a real stop (after the grace: a run that just ended still writes its log)
  if ((v.gone || v.alive === false) && quiet > GONE_GRACE_MS) return { state: 'KOPTU', note: L('no process, log stopped', 'süreç yok, log durdu'), alarm: true, reason: 'gone' }
  // 2. a non-zero exit is a real stop too
  if (v.exitCode != null && v.exitCode !== 0) return { state: 'KOPTU', note: L(`exit ${v.exitCode}`, `çıkış ${v.exitCode}`), alarm: true, reason: 'exit' }
  // 3. a hung child (OpenCode's snapshot git) is evidence of a hang, not of a quiet log
  if (v.hung && quiet > GONE_GRACE_MS) return { state: 'ASILI', note: L(`${v.hung} stuck`, `${v.hung} takılı`), alarm: true, reason: 'hung' }
  // 4. waiting is work: the RAM gate's hold, the build lock / train queue, a build or test under it
  if (quiet > QUIET_MS && v.gateHeld) return { state: 'RAM BEKLİYOR', note: L('heavy command held in the RAM queue', 'ağır komut RAM sırasında bekletiliyor'), alarm: false, reason: '' }
  if (quiet > QUIET_MS && v.busy && v.lockHeld && /^(sleep|timeout|bash|sh|cmd|powershell|pwsh|node)$/i.test(v.busy.label)) return { state: 'KİLİT BEKLİYOR', note: L('waiting for the tsc lock / train turn', 'tsc kilidi / train sırası bekleniyor'), alarm: false, reason: '' }
  if (quiet > QUIET_MS && v.busy) {
    return v.busy.lockWait
      ? { state: 'KİLİT BEKLİYOR', note: L(`${v.busy.label} waiting for a lock`, `${v.busy.label} kilit bekliyor`), alarm: false, reason: '' }
      : { state: 'KOMUT ÇALIŞIYOR', note: L(`${v.busy.label} running, no log for ${elapsed(quiet)}`, `${v.busy.label} çalışıyor, ${elapsed(quiet)} log yok`), alarm: false, reason: '' }
  }
  // 5. a quiet log with CPU in its tree is thinking or inside a long tool call: never an alarm
  if (quiet > QUIET_MS && v.cpuActive === true) return { state: 'çalışıyor', note: L('quiet, using CPU', 'sessiz, CPU kullanıyor'), alarm: false, reason: '' }
  // 6. a log never written: only a process that is alive and provably idle is 0-BYTE (a claude run writes
  //    its log at the end, an OpenCode run says nothing for minutes: neither is an alarm without evidence)
  if (v.logBytes === 0) {
    if (quiet > QUIET_MS && v.alive === true && v.cpuActive === false) return { state: '0-BYTE', note: L('log never written', 'log hiç yazılmadı'), alarm: true, reason: 'zero-byte' }
    return { state: 'çalışıyor', note: '', alarm: false, reason: '' }
  }
  // 7. a log that stopped growing: only with no CPU activity behind it
  if (quiet > QUIET_MS && v.cpuActive === false) return { state: 'TAKILMIŞ', note: L(`no new log for ${elapsed(quiet)}, no command running under it`, `${elapsed(quiet)} yeni log yok, altında çalışan komut yok`), alarm: true, reason: 'stalled' }
  return { state: 'çalışıyor', note: '', alarm: false, reason: '' }
}

/** The old name, kept for callers that only draw the state and the note. */
export function runningState(v: WorkerHealthInput): { state: string; note: string } {
  const h = workerHealth(v)
  return { state: h.state, note: h.note }
}

/**
 * The persisted dedupe key of one alarm: the worker, its run and the reason. A new run of the same
 * worker is a new key, so a restarted worker that stalls again is told again; the same run's same
 * reason never is. Stored in the plugin store (both inline and synced go through it).
 */
export const alarmKey = (id: string, runs: number, reason: string) => `walm:${id}:${runs}:${reason}`

/** Whether an alarm key is still unseen: told once, never repeated. */
export const alarmDue = (toldAt: unknown) => toldAt === null || toldAt === undefined

/**
 * "2:05.31" / "1:02:05" / "2-03:04:05" (ps TIME) as milliseconds of CPU; -1 when it is not that shape.
 */
export function parseCpuTime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s.trim())
  if (!m) return -1
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  const mins = Number(m[3] ?? 0)
  const secs = Number(m[4] ?? 0)
  return Math.round((((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000)
}

/** The brief file of a worker: the same `.squad/prompts/<name>.md` for every CLI (claude and zen alike). */
export const promptFile = (dir: string | undefined, cwd: string | undefined, name: string, runs: number) =>
  `${dir || cwd || '.'}/.squad/prompts/${name}${runs > 1 ? `.run${runs}` : ''}.md`

/** A report as it is kept on the worker record: one line, 2000 characters, whatever CLI wrote it. */
export const resultReport = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 2000)

export type WorkerRowShape = {
  name: string
  model: string
  pid: number
  startedAt: number
  logBytes: number
  logAt: number
  files: number
  state: string
  note: string
  /** Whether this row is a real alarm, and why (the same for every CLI). */
  alarm: boolean
  reason: string
}

/**
 * One row of the worker table (list_agents, list_chiefs, agent_output): the same shape and the same
 * fields for a claude worker and for a zen/qoder/go worker — pid, log, files touched, status.
 */
export function workerRow(v: {
  name: string
  cli: string
  model: string
  pid: number
  startedAt: number
  logBytes: number
  logAt: number
  files: number
  health: WorkerHealth
}): WorkerRowShape {
  return {
    name: v.name,
    model: `${v.cli}/${v.model}`,
    pid: v.pid || 0,
    startedAt: v.startedAt,
    logBytes: v.logBytes || 0,
    logAt: v.logAt || 0,
    files: v.files || 0,
    state: v.health.state,
    note: v.health.note,
    alarm: v.health.alarm,
    reason: v.health.reason,
  }
}
