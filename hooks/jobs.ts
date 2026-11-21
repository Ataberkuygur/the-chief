import { L } from './lang'
/**
 * Jobs that outlive the chat that started them, and the merge train built on them.
 *
 * A job is a PowerShell script started outside the app (WMI on Windows), so an app restart or a chat that ends does
 * not kill it (train30 and train34 died half way when their leader's turn ended, 18.10). It writes its output and,
 * at the end, its exit code into its own folder under hq/jobs; any chat of its owner reads them later.
 *
 * The merge train takes the branches chiefs said were ready (HAZIR: lane/x <sha>), merges them one by one onto the
 * base in its own worktree, drops the ones that conflict, runs the gates (each a command whose exit must be 0, or
 * whose JSON array output must stay at or under a ceiling), pushes the base and writes one line to the train log.
 * Everything here is pure, so it is tested.
 */

/** One gate: a command run in the train worktree. `{OUT}` in it names a file the command may write. */
export type TrainGate = { name: string; cmd: string; max?: number; min?: number }
export type TrainConfig = { wt: string; base: string; log: string; gates: TrainGate[]; remote?: string; lock?: string; wait?: string }
export type TrainGateResult = { name: string; ok: boolean; value?: number | null }
export type TrainResult = { ok: boolean; merged: string[]; conflict: string[]; gates: TrainGateResult[]; failed?: string; sha?: string; at?: number }
/** A branch a chief said is ready, as it waits in the train queue. */
export type TrainItem = { branch: string; sha: string; from: string; title?: string; at: number }

/** Branch names that may go into a script: letters, digits and . _ / - only, never a leading dash. */
export const safeBranch = (b: string) => /^[A-Za-z0-9_][\w./-]*$/.test(b) && !b.includes('..')

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`

/** A config the train can run: a worktree, a base, a log path, gates with a name and a command. */
export function parseTrainConfig(raw: unknown): TrainConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string).trim() : '')
  const wt = str('wt')
  const base = str('base')
  const log = str('log')
  if (!wt || !base || !log || !safeBranch(base)) return null
  const gates = Array.isArray(c.gates)
    ? (c.gates as Record<string, unknown>[])
        .filter(g => g && typeof g.name === 'string' && typeof g.cmd === 'string' && g.cmd.trim())
        .map(g => ({ name: String(g.name), cmd: String(g.cmd), ...(typeof g.max === 'number' ? { max: g.max } : {}), ...(typeof g.min === 'number' ? { min: g.min } : {}) }))
    : []
  const remote = str('remote') || 'origin'
  if (!safeBranch(remote)) return null
  // the machine's own build lock (a directory made atomically, e.g. locks/tsc): the gates wait for it like any tsc
  const lock = str('lock')
  const wait = trainWaitFile({ lock, wait: str('wait') })
  return { wt, base, log, gates, remote, ...(lock ? { lock } : {}), ...(wait ? { wait } : {}) }
}

/** The queue file of one ready branch at one sha: the same claim always lands on the same file. */
export function trainQueueName(c: { branch: string; sha: string }): string {
  return `${c.branch.replace(/[^\w.-]+/g, '_')}@${(c.sha || 'head').slice(0, 12)}.json`
}

/** The queue as the train takes it: one entry per branch (the newest claim wins), only names safe for a script. */
export function trainBatch(items: readonly TrainItem[]): TrainItem[] {
  const byBranch = new Map<string, TrainItem>()
  for (const it of [...items].sort((a, b) => a.at - b.at)) if (safeBranch(it.branch)) byBranch.set(it.branch, it)
  return [...byBranch.values()]
}

/**
 * The file that says "the train has work: workers, leave the build lock to it" (workers' lock loops wait while it
 * exists). Explicit `wait` in the config, else `train-wait` next to the lock directory; none without a lock.
 */
export function trainWaitFile(c: { lock?: string; wait?: string }): string | undefined {
  if (c.wait) return c.wait
  return c.lock ? c.lock.replace(/[^\\/]+[\\/]*$/, 'train-wait') : undefined
}
/**
 * The train as one PowerShell script. Merges each branch onto <remote>/<base> in the worktree (a conflict is aborted
 * and the branch left out), runs the gates, pushes, appends one line to the log and writes the result JSON last;
 * a step that fails writes the result with `failed` and stops, nothing pushed. Gate i runs gateFiles[i] (see gateCmd).
 */
export function trainScript(cfg: TrainConfig, branches: readonly string[], resultPath: string, gateFiles: readonly string[]): string {
  const remote = cfg.remote ?? 'origin'
  const list = branches.filter(safeBranch).map(psq).join(', ')
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    '$res = [ordered]@{ ok = $false; merged = @(); conflict = @(); gates = @(); failed = $null; sha = $null }',
    '$held = $null',
    `function Finish { if ($held) { Remove-Item -LiteralPath $held -Force -ErrorAction SilentlyContinue };${cfg.wait ? ` Remove-Item -LiteralPath ${psq(cfg.wait)} -Force -ErrorAction SilentlyContinue;` : ''} $res.at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); $res | ConvertTo-Json -Depth 5 -Compress | Set-Content -Encoding UTF8 -LiteralPath ${psq(resultPath)}; exit 0 }`,
    `Set-Location -LiteralPath ${psq(cfg.wt)}`,
    'if (-not $?) { $res.failed = "worktree"; Finish }',
    'git merge --abort 2>&1 | Out-Null',
    'git reset -q --hard 2>&1 | Out-Null',
    `git fetch -q ${psq(remote)} 2>&1 | Out-Null`,
    'if ($LASTEXITCODE -ne 0) { $res.failed = "git fetch"; Finish }',
    `git checkout -q --detach ${psq(`${remote}/${cfg.base}`)} 2>&1 | Out-Null`,
    `if ($LASTEXITCODE -ne 0) { $res.failed = ${psq(`checkout ${remote}/${cfg.base}`)}; Finish }`,
    `foreach ($b in @(${list})) {`,
    `  git merge --no-ff --no-edit -m "train: $b" "${remote}/$b" 2>&1 | Out-Null`,
    '  if ($LASTEXITCODE -ne 0) { git merge --abort 2>&1 | Out-Null; git reset -q --hard 2>&1 | Out-Null; $res.conflict += $b } else { $res.merged += $b }',
    '}',
    'if ($res.merged.Count -eq 0) { $res.failed = "nothing merged"; Finish }',
    '$out = Join-Path $env:TEMP ("chief-train-" + [guid]::NewGuid().ToString("N") + ".json")',
  ]
  if (cfg.lock)
    lines.push(
      // the build lock is a directory: made once it is free (up to an hour), removed when the train ends
      '$tries = 0',
      `while (-not $held) { if (-not (Test-Path -LiteralPath ${psq(cfg.lock)})) { try { New-Item -ItemType Directory -Path ${psq(cfg.lock)} -ErrorAction Stop | Out-Null; $held = ${psq(cfg.lock)} } catch { } }; if (-not $held) { $tries++; if ($tries -gt 240) { $res.failed = "lock"; Finish }; Start-Sleep 15 } }`,
    )
  cfg.gates.forEach((g, i) => {
    // each gate's command sits in its own .cmd file (no quoting through PowerShell); {OUT} is %CHIEF_OUT% there
    lines.push(
      'Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue',
      '$env:CHIEF_OUT = $out',
      `cmd /c ${psq(gateFiles[i] ?? '')} 2>&1 | Out-Null`,
      '$code = $LASTEXITCODE',
    )
    if (g.max !== undefined) {
      lines.push(
        // a counting gate fails on a non-zero exit, a missing / empty / unparsable output or a count under min (default 1):
        // a command that never ran (wrong binary, wrong scope) must not read as "0 violations".
        // Windows PowerShell hands a JSON array on as one object: held in a variable first, then counted
        '$n = $null; try { if ($code -eq 0 -and (Test-Path -LiteralPath $out)) { $raw = Get-Content -Raw -LiteralPath $out; if ($raw -and $raw.Trim().Length -gt 1) { $j = $raw | ConvertFrom-Json; if ($j -is [array] -or $raw.Trim().StartsWith("[")) { $n = @($j).Count } } } } catch { }',
        `$res.gates += [ordered]@{ name = ${psq(g.name)}; ok = ($null -ne $n -and $n -ge ${g.min ?? 1} -and $n -le ${g.max}); value = $n; exit = $code }`,
      )
    } else lines.push(`$res.gates += [ordered]@{ name = ${psq(g.name)}; ok = ($code -eq 0); value = $code }`)
    lines.push(`if (-not $res.gates[-1].ok) { $res.failed = ${psq(`gate ${g.name}`)}; Finish }`)
  })
  lines.push(
    `git push -q ${psq(remote)} ${psq(`HEAD:refs/heads/${cfg.base}`)} 2>&1 | Out-Null`,
    'if ($LASTEXITCODE -ne 0) { $res.failed = "push"; Finish }',
    '$res.sha = (git rev-parse --short HEAD).Trim()',
    '$res.ok = $true',
    '$gl = ($res.gates | ForEach-Object { $_.name + " " + $_.value }) -join ", "',
    '$line = (Get-Date -Format "yyyy-MM-dd HH:mm") + " chief-train: " + ($res.merged -join " ") + " -> " + $res.sha + " gates ok (" + $gl + ")"',
    'if ($res.conflict.Count) { $line += " | conflict: " + ($res.conflict -join " ") }',
    `Add-Content -Encoding UTF8 -LiteralPath ${psq(cfg.log)} -Value $line`,
    'Finish',
  )
  return lines.join('\r\n')
}

/** One line for the leader: the summary of a train that went, or what stopped it. */
export function trainSummary(r: TrainResult): string {
  const gates = r.gates.map(g => `${g.name} ${g.value ?? '?'}`).join(', ')
  const conflict = r.conflict.length ? L(`; conflict: ${r.conflict.join(' ')}`, `; çakışma: ${r.conflict.join(' ')}`) : ''
  if (r.ok) return `Train: ${r.merged.join(' ')} → ${r.sha}${gates ? ` (${gates})` : ''}${conflict}`
  return L(`Train stopped (${r.failed ?? 'unknown'}): ${r.merged.join(' ') || 'nothing merged'}${gates ? ` (${gates})` : ''}${conflict}; no push`, `Train durdu (${r.failed ?? 'bilinmiyor'}): ${r.merged.join(' ') || 'hiçbiri birleşmedi'}${gates ? ` (${gates})` : ''}${conflict}; push yok`)
}

/** A gate's .cmd file: its command, {OUT} as the file the train reads its JSON count from. */
export const gateCmd = (g: TrainGate) => ['@echo off', g.cmd.split('{OUT}').join('"%CHIEF_OUT%"')].join('\r\n')

/** A job's own PowerShell script: its .cmd in its folder, output to out.log, the exit code to exit.txt last. */
export function jobScript(cmdFile: string, cwd: string, out: string, exit: string): string {
  return [
    `Set-Location -LiteralPath ${psq(cwd)}`,
    `cmd /c ${psq(cmdFile)} *>> ${psq(out)}`,
    `Set-Content -Encoding ASCII -LiteralPath ${psq(exit)} -Value $LASTEXITCODE`,
  ].join('\r\n')
}

const shq = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
/** The same job on macOS and Linux: a shell script that runs the command in its folder, appends its output and writes its exit code. */
export function jobScriptSh(command: string, cwd: string, out: string, exit: string): string {
  return ['#!/bin/sh', `cd ${shq(cwd)} || { echo 97 > ${shq(exit)}; exit 97; }`, `( ${command}\n) >> ${shq(out)} 2>&1`, `echo $? > ${shq(exit)}`, ''].join('\n')
}
/** Starts that script detached (it outlives the chat and the app) and prints its pid. */
export const launchShArgv = (script: string): string[] => ['sh', '-c', `nohup sh ${shq(script)} >/dev/null 2>&1 & echo $!`]
