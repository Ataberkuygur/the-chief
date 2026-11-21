/**
 * One gate for heavy commands (tsc, vitest, dependency-cruiser) on this machine. ffmpeg is not gated: it holds
 * 100-300 MB, and suspending it froze Lumiere exports for minutes (24.10: mix, QC and engine stalls).
 *
 * The heavy.lock only covers Claude sessions' Bash tool; agent workers ran 3 tsc + 2 dependency-cruiser at once
 * (~12 GB, 17.10), and chiefs' own batch scripts (nohup node run-batches.mjs, npx vitest from a shell whose parent is
 * gone) ran 27 vitest at once and froze the machine (18.10). So the gate looks at processes, whoever started them: a
 * heavy command that does not fit in the RAM-based slots is suspended and resumed, oldest first, when one frees. To the
 * caller that is a command waiting on a lock. Everything here is pure, so it is tested.
 */

/** One process, as the gate sees it. */
export type GateProc = { pid: number; ppid: number; name: string; cmd: string; created: number; mb: number }
/** A heavy command the gate holds: its root process id, that process's start time (pid reuse guard), and since when. */
export type GateWait = { pid: number; created: number; since: number }

/** tsc, vitest and dependency-cruiser by their command lines (node_modules/typescript/bin/tsc, npx tsc, vitest forks …). */
const HEAVY_CMD_RE = /typescript[\\/]bin[\\/]tsc\b|(^|[\s"'\\/])tsc(\.cmd|\.js)?(\s|"|$)|vitest|dependency-cruise|depcruise/i
/** Long-lived helpers that are not a build: an editor's tsserver, a watch mode. */
const NOT_HEAVY_RE = /tsserver|typingsInstaller|--watch\b/i
/** Agent processes: a heavy command under one of these was started by an agent and may be held. */
const AGENT_RE = /^(claude|opencode|qodercli|codex|devin|cursor-agent|gemini|agy)(\.exe)?$/i
const AGENT_CMD_RE = /claude-code|@anthropic-ai|opencode|qodercli|codex|cursor-agent/i
/** A person's own terminal or editor: a heavy command under one of these (and no agent in between) is theirs. */
const PERSON_RE = /^(explorer|WindowsTerminal|OpenConsole|wt|Code|Cursor|powershell_ise|idea64|devenv)(\.exe)?$/i
/** True when the person started it (their PowerShell froze when the gate held their own tsc, 20.11.2026). Orphans stay gated. */
export function personOwned(byId: Map<number, GateProc>, p: GateProc): boolean {
  for (const a of ancestors(byId, p)) {
    if (AGENT_RE.test(a.name) || AGENT_CMD_RE.test(a.cmd)) return false
    if (PERSON_RE.test(a.name)) return true
  }
  return false
}
export const isHeavy = (p: Pick<GateProc, 'name' | 'cmd'>) =>
  /^(node|bun)(\.exe)?$/i.test(p.name) && HEAVY_CMD_RE.test(p.cmd) && !NOT_HEAVY_RE.test(p.cmd)

/** The ancestors of a process, nearest first (stops at a loop or a missing parent). */
function ancestors(byId: Map<number, GateProc>, p: GateProc): GateProc[] {
  const out: GateProc[] = []
  const seen = new Set<number>([p.pid])
  let cur = byId.get(p.ppid)
  // a parent that started after its child is a reused id, not the real parent
  let child = p
  while (cur && !seen.has(cur.pid) && !(cur.created > 0 && child.created > 0 && cur.created > child.created)) {
    out.push(cur)
    seen.add(cur.pid)
    child = cur
    cur = byId.get(cur.ppid)
  }
  return out
}

/** The root process that holds the build lock taken at lockAt: the oldest tsc / dependency-cruise started at or after it. */
function lockHolder(roots: readonly GateProc[], lockAt: number | undefined): number | null {
  if (!lockAt) return null
  const c = roots.filter(r => /tsc|dependency-cruise|depcruise/i.test(r.cmd) && !/vitest/i.test(r.cmd) && r.created >= lockAt - 5000)
  return c.sort((a, b) => a.created - b.created)[0]?.pid ?? null
}

/** A process and everything under it, root first. */
function treeOf(byParent: Map<number, GateProc[]>, root: GateProc): number[] {
  const out = [root.pid]
  const seen = new Set(out)
  for (let i = 0; i < out.length; i++) {
    for (const k of byParent.get(out[i]!) ?? []) {
      if (seen.has(k.pid)) continue
      seen.add(k.pid)
      out.push(k.pid)
    }
  }
  return out
}

export type GatePlan = {
  /** Process ids to suspend (whole trees). */
  suspend: number[]
  /** Process ids to resume (whole trees). */
  resume: number[]
  /** The held heavy commands after this step. */
  next: GateWait[]
  /** Heavy commands running after this step, and the slots the RAM allows. */
  running: number
  slots: number
}

/**
 * One gate step. Slots = (free RAM + RAM the running heavy commands hold − reserve) / slotMb, at least 1, at most
 * maxSlots. Too many running: the newest ones are held. Room: the oldest held ones go on. A command held
 * longer than maxWaitMs goes on anyway, so a hold never becomes a hang.
 */
export function gatePlan(procs: readonly GateProc[], held: readonly GateWait[], o: { freeMb: number; reserveMb: number; slotMb: number; maxSlots: number; now: number; maxWaitMs: number; lockAt?: number }): GatePlan {
  const byId = new Map(procs.map(p => [p.pid, p]))
  const byParent = new Map<number, GateProc[]>()
  for (const p of procs) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p])
  const roots = procs.filter(p => isHeavy(p) && !ancestors(byId, p).some(isHeavy) && !personOwned(byId, p))
  const info = new Map(roots.map(r => {
    const tree = treeOf(byParent, r)
    return [r.pid, { root: r, tree, mb: tree.reduce((s, id) => s + (byId.get(id)?.mb ?? 0), 0) }] as const
  }))
  // a held entry counts only while the same process (same start time) is still there
  const stillHeld = held.filter(h => info.has(h.pid) && info.get(h.pid)!.root.created === h.created)
  const heldIds = new Set(stillHeld.map(h => h.pid))
  const running = roots.filter(r => !heldIds.has(r.pid))
  const usedMb = running.reduce((s, r) => s + info.get(r.pid)!.mb, 0)
  const slots = Math.max(1, Math.min(o.maxSlots, Math.floor((o.freeMb + usedMb - o.reserveMb) / o.slotMb)))
  const suspend: number[] = []
  const resume: number[] = []
  let next = [...stillHeld].sort((a, b) => a.since - b.since || a.created - b.created)
  let count = running.length
  // the lock holder never waits: the lock is what the held ones and the train are waiting for
  const holder = lockHolder(roots, o.lockAt)
  const hi = next.findIndex(x => x.pid === holder)
  if (hi >= 0) {
    const [h] = next.splice(hi, 1)
    resume.push(...info.get(h!.pid)!.tree)
    count++
  }
  // held too long: goes on whatever the slots say
  for (const h of next.filter(x => o.now - x.since > o.maxWaitMs)) {
    resume.push(...info.get(h.pid)!.tree)
    count++
  }
  next = next.filter(x => o.now - x.since <= o.maxWaitMs)
  if (count > slots) {
    const newest = running.filter(r => r.pid !== holder).sort((a, b) => b.created - a.created)
    for (const r of newest) {
      if (count <= slots) break
      suspend.push(...info.get(r.pid)!.tree)
      next.push({ pid: r.pid, created: r.created, since: o.now })
      count--
    }
  } else {
    while (count < slots && next.length) {
      const h = next.shift()!
      resume.push(...info.get(h.pid)!.tree)
      count++
    }
  }
  return { suspend, resume, next, running: count, slots }
}

/**
 * The last resort, what tools/ram-guard.ps1 did by hand: under critMb of free RAM a held build still holds its memory,
 * so one heavy tree a step is ended: the newest vitest first, else the newest tsc/dependency-cruiser while another
 * one is left (the oldest, the furthest along, goes on).
 */
export function criticalKill(procs: readonly GateProc[], freeMb: number, critMb: number): number[] {
  if (freeMb >= critMb) return []
  const byId = new Map(procs.map(p => [p.pid, p]))
  const byParent = new Map<number, GateProc[]>()
  for (const p of procs) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p])
  const roots = procs.filter(p => isHeavy(p) && !ancestors(byId, p).some(isHeavy) && !personOwned(byId, p)).sort((a, b) => b.created - a.created)
  const pick = roots.find(r => /vitest/i.test(r.cmd)) ?? (roots.length > 1 ? roots[0] : undefined)
  return pick ? treeOf(byParent, pick) : []
}

/**
 * Suspends or resumes processes by id (ntdll NtSuspendProcess / NtResumeProcess). Resume runs three times: a suspend
 * count above one (two gates at once for a moment) must not leave a build frozen.
 */
export function suspendPs(pids: readonly number[], suspend: boolean): string {
  const ids = pids.filter(p => Number.isInteger(p) && p > 0).join(',')
  return [
    "Add-Type -Namespace TheChief -Name Nt -MemberDefinition '[DllImport(\"ntdll.dll\")] public static extern int NtSuspendProcess(IntPtr h); [DllImport(\"ntdll.dll\")] public static extern int NtResumeProcess(IntPtr h); [DllImport(\"kernel32.dll\")] public static extern IntPtr OpenProcess(int a, bool i, int p); [DllImport(\"kernel32.dll\")] public static extern bool CloseHandle(IntPtr h);'",
    `foreach ($id in @(${ids})) { $h = [TheChief.Nt]::OpenProcess(0x0800, $false, $id); if ($h -ne [IntPtr]::Zero) { ${suspend ? '[void][TheChief.Nt]::NtSuspendProcess($h)' : '1..3 | ForEach-Object { [void][TheChief.Nt]::NtResumeProcess($h) }'}; [void][TheChief.Nt]::CloseHandle($h) } }`,
  ].join('\n')
}

/** True while the logon task (scripts/ram-gate.ps1) beats: it ends the critical tree then, not the chats. */
export function bootGateLive(beat: { at?: number } | null, now: number, freshMs = 60000): boolean {
  const at = Number(beat?.at ?? 0)
  return at > 0 && now - at < freshMs
}
