/**
 * Consultants and CLI logins.
 *
 * A consultant is another model, reached through its own CLI, that the chief asks for a second opinion: when the
 * owner says so, before a decision that is hard to undo, on a bug that survived two fixes, or for a heavy analysis.
 * It runs read-only (it advises, it never edits), sees none of the chat, and its answer comes back in the same turn.
 *
 * A login is the CLI's own sign-in, opened in a real terminal window from a button: the plugin never sees a
 * password or a token, it only starts the command and later reads the CLI's own "am I signed in" answer.
 *
 * Everything here is pure (argv builders, parsers, verdicts), so it is tested; the plugin runs the commands.
 */

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Consultant = { cli: string; model: string; effort: string }

/** The CLIs a consultant can be asked through, with the binary each needs. */
export const CONSULT_BIN: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  devin: 'devin',
  cursor: 'cursor-agent',
  qoder: 'qodercli',
  gemini: 'gemini',
  antigravity: 'agy',
  openrouter: 'opencode',
  'opencode-zen': 'opencode',
  'opencode-go': 'opencode',
  'opencode-ollama': 'opencode',
}

/** A different model family first (an independent view), then the strongest Claude. */
export const CONSULTANTS_DEFAULT = 'codex/gpt-6-luna:high, devin/gemini-4-argon, claude/claude-opus-5-5:high'
/** A consultant thinks before it answers: ten minutes, then the next one is asked. */
export const CONSULT_TIMEOUT_MS = 10 * 60_000
/** How much of an answer goes back into the chat. */
export const CONSULT_ANSWER_MAX = 12_000
/** At most this many consultants on the list, and so in a panel (panel: true asks the whole list). */
export const CONSULT_PANEL_MAX = 6

/** One list as written, no defaults: `cli/model[:effort]` entries, unknown CLIs and repeats dropped. */
function parseList(v: string): Consultant[] {
  const seen = new Set<string>()
  return v
    .split(/[,\n]/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => {
      const i = x.indexOf('/')
      if (i <= 0) return null
      const head = x.slice(0, i).trim().toLowerCase()
      const cli = head === 'opencode' ? 'opencode-go' : head === 'agy' ? 'antigravity' : head
      let model = x.slice(i + 1).trim()
      let effort = ''
      const colon = model.lastIndexOf(':')
      if (colon > 0 && (EFFORTS as readonly string[]).includes(model.slice(colon + 1).trim().toLowerCase())) {
        effort = model.slice(colon + 1).trim().toLowerCase()
        model = model.slice(0, colon).trim()
      }
      // a model id is letters, digits and . _ - / : @ only: on Windows it rides a cmd line, where & | > would be commands
      return /^[\w.\-/:@]+$/.test(model) && CONSULT_BIN[cli] ? { cli, model, effort } : null
    })
    .filter((c): c is Consultant => {
      if (!c) return false
      const key = `${c.cli}/${c.model}`.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** `codex/gpt-6-luna:high, devin/gemini-4-argon`: cli, model and an optional effort after the last colon. Empty or all-wrong = the defaults; off = none. */
export function parseConsultants(raw: string | undefined): Consultant[] {
  const v = (raw ?? '').trim()
  if (/^(off|none|kapalı|yok)$/i.test(v)) return []
  const list = parseList(v)
  return list.length ? list : parseList(CONSULTANTS_DEFAULT)
}

export const consultantName = (c: Consultant) => `${c.cli}/${c.model}${c.effort ? `:${c.effort}` : ''}`

/** Which consultants a call means: a number (1 = first), a CLI, words of a model, or none (the first; with panel the first few). */
export function pickConsultants(list: readonly Consultant[], ref: string | undefined, panel = false): Consultant[] {
  const r = (ref ?? '').trim().toLowerCase()
  if (!r) return list.slice(0, panel ? CONSULT_PANEL_MAX : 1)
  if (r === 'all' || r === 'hepsi') return list.slice(0, CONSULT_PANEL_MAX)
  const n = Number(r)
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return [list[n - 1]!]
  const exact = list.filter(c => consultantName(c).toLowerCase() === r || `${c.cli}/${c.model}`.toLowerCase() === r)
  if (exact.length) return exact.slice(0, 1)
  const loose = list.filter(c => c.cli === r || c.model.toLowerCase().includes(r))
  if (loose.length) return loose.slice(0, 1)
  // a consultant named in full that is not in the saved list is still asked: the owner (or the chief) chose it
  return r.includes('/') ? parseList(ref ?? '').slice(0, 1) : []
}

const prefixed = (prefix: string, m: string) => (m.startsWith(`${prefix}/`) ? m : `${prefix}/${m}`)
const OPENCODE_PREFIX: Record<string, string> = { openrouter: 'openrouter', 'opencode-zen': 'opencode', 'opencode-go': 'opencode-go', 'opencode-ollama': 'ollama' }

/**
 * The command that asks one consultant, read-only: plan mode, a read-only sandbox or the CLI's default (asking)
 * permissions, which a headless run answers "no" to. `outFile` is where Codex writes its last message.
 * null for a CLI that cannot be asked.
 */
export function consultArgv(c: Consultant, prompt: string, outFile: string, isWin: boolean): string[] | null {
  const shim = (argv: string[]) => (isWin ? ['cmd', '/c', ...argv] : argv)
  const e = c.effort
  switch (c.cli) {
    case 'claude':
      return ['claude', '-p', prompt, '--model', c.model, ...(e ? ['--effort', e] : []), '--permission-mode', 'plan', '--output-format', 'text']
    case 'codex':
      return ['codex', 'exec', '-m', c.model, ...(e ? ['-c', `model_reasoning_effort="${e === 'max' ? 'xhigh' : e}"`] : []), '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-o', outFile, prompt]
    case 'devin':
      // auto approves read-only tools only; a folder Devin was never opened in by hand is still answered in
      return ['devin', '-p', prompt, '--model', c.model, '--permission-mode', 'auto', '--respect-workspace-trust', 'false']
    case 'cursor':
      return ['cursor-agent', '-p', prompt, '--model', c.model, '--output-format', 'text']
    case 'qoder':
      return ['qodercli', '-p', prompt, '-m', c.model, ...(e ? ['--reasoning-effort', e] : []), '--permission-mode', 'default']
    case 'gemini':
      return shim(['gemini', '-m', c.model, '-o', 'text', prompt])
    case 'antigravity':
      // no --dangerously-skip-permissions: a tool that needs approval is not run, since nobody answers
      return shim(['agy', '-p', prompt, '--model', c.model, '--output-format', 'text'])
    default: {
      const prefix = OPENCODE_PREFIX[c.cli]
      return prefix ? shim(['opencode', 'run', '--agent', 'plan', '-m', prefixed(prefix, c.model), prompt]) : null
    }
  }
}

/** What the consultant is told: it sees nothing of the chat, so the question carries everything. */
export function consultPrompt(question: string, files: readonly string[] = [], asker = ''): string {
  return [
    'You are a consultant: another AI agent, in the middle of real work, is asking you for a second opinion.',
    'You see nothing of its conversation; everything you get is below. You may read files to check a claim, but do not edit anything and do not run commands that change anything.',
    'Answer in the language of the question. Be direct and concrete, and disagree where the asker looks wrong. Give:',
    '1. Your recommendation, in one or two sentences.',
    '2. The reasons, most important first.',
    '3. The risks, and what would change your mind.',
    'No preamble, no summary of the question, at most about 400 words unless the question needs more.',
    asker ? `\nAsked by: ${asker}` : '',
    `\nQuestion:\n${question.trim()}`,
    files.length ? `\nFiles worth reading:\n${files.map(f => `- ${f}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** A CLI's printed answer as plain text: colour codes and spinner leftovers out, cut to what a chat can carry. */
export function cleanAnswer(raw: string, max = CONSULT_ANSWER_MAX): string {
  const text = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters cut]` : text
}

/** Why a consultant gave no answer, in a few words, from what its CLI printed. */
export function consultFailure(exitCode: number, stdout: string, stderr: string): string {
  const all = `${stderr}\n${stdout}`
  if (/command not found|not recognized as|ENOENT|No such file or directory/i.test(all)) return 'CLI not installed'
  if (/not logged in|login required|please (log|sign) in|unauthorized|401|invalid api key|authentication/i.test(all)) return 'not signed in'
  if (/rate limit|usage limit|quota|429|limit exceeded/i.test(all)) return 'at its limit'
  if (/model.{0,40}(not found|does not exist|not supported|unknown)|unknown model|invalid model/i.test(all)) return 'model not available'
  if (/timed? ?out/i.test(all)) return 'timed out'
  const last = cleanAnswer(all).split('\n').filter(Boolean).pop() ?? ''
  return last ? `exit ${exitCode}: ${last.slice(0, 160)}` : `exit ${exitCode}, no output`
}

// ---------- logins ----------

export type Platform = 'windows' | 'mac' | 'linux'
/** Windows by a drive-letter cwd, the Mac by its home folder; anything else is Linux. */
export const platformOf = (cwd: string, home: string): Platform => (/^[A-Za-z]:[\\/]/.test(cwd) || /^[A-Za-z]:[\\/]/.test(home) ? 'windows' : home.startsWith('/Users/') || cwd.startsWith('/Users/') ? 'mac' : 'linux')

/** Each CLI's own sign-in and "am I signed in" commands. Gemini signs in on its first interactive run. */
export const LOGIN: Record<string, { login: string; status?: string[]; note?: string }> = {
  claude: { login: 'claude auth login', status: ['claude', 'auth', 'status'] },
  codex: { login: 'codex login', status: ['codex', 'login', 'status'] },
  devin: { login: 'devin auth login', status: ['devin', 'auth', 'status'] },
  cursor: { login: 'cursor-agent login', status: ['cursor-agent', 'status'] },
  qoder: { login: 'qodercli login', status: ['qodercli', 'status'] },
  gemini: { login: 'gemini', note: 'Gemini asks you to sign in when it first opens; close it afterwards.' },
  antigravity: { login: 'agy', note: 'Antigravity asks you to sign in when it first opens; close it afterwards.' },
  openrouter: { login: 'opencode auth login', status: ['opencode', 'auth', 'list'], note: 'Pick OpenRouter in the list.' },
  'opencode-zen': { login: 'opencode auth login', status: ['opencode', 'auth', 'list'], note: 'Pick OpenCode Zen in the list.' },
  'opencode-go': { login: 'opencode auth login', status: ['opencode', 'auth', 'list'], note: 'Pick OpenCode Go in the list.' },
}

/** The provider line `opencode auth list` prints for each of our OpenCode providers. */
const OPENCODE_LINE: Record<string, RegExp> = { openrouter: /openrouter/i, 'opencode-zen': /opencode(?! go)\s+(api|oauth)|opencode zen/i, 'opencode-go': /opencode go/i }

/** Signed in, signed out, or the CLI did not say: read from its own status output, never from a file of its secrets. */
export function loginVerdict(cli: string, exitCode: number, out: string): 'in' | 'out' | 'unknown' {
  const text = cleanAnswer(out, 4000)
  if (/command not found|not recognized as|ENOENT/i.test(text)) return 'unknown'
  if (cli === 'claude') return /"loggedIn"\s*:\s*true/.test(text) ? 'in' : /"loggedIn"\s*:\s*false/.test(text) ? 'out' : 'unknown'
  if (OPENCODE_LINE[cli]) return text.split('\n').some(l => OPENCODE_LINE[cli]!.test(l)) ? 'in' : /credentials/i.test(text) ? 'out' : 'unknown'
  if (cli === 'qoder') return /^\s*(username|email)\s*:\s*\S/im.test(text) ? 'in' : exitCode !== 0 || /not logged in|login/i.test(text) ? 'out' : 'unknown'
  if (/not (logged|signed) in|logged out|no credentials/i.test(text)) return 'out'
  if (/(logged|signed) in/i.test(text)) return 'in'
  return exitCode === 0 ? 'unknown' : 'out'
}

const MAC_TERMINAL = 'f="${TMPDIR:-/tmp}/the-chief-$$.command"; printf "%s\\n" "#!/bin/sh" "$1" > "$f" && chmod +x "$f" && open -a Terminal "$f"'

/**
 * Opens a real terminal window running one command (a login is interactive: it prints a link or waits for a code).
 * `command` is one of the fixed LOGIN strings, never text someone typed.
 */
export function terminalArgv(command: string, platform: Platform): string[] {
  if (platform === 'windows') return ['cmd', '/c', 'start', 'The Chief', 'cmd', '/k', command]
  // the Mac: a .command file opened with Terminal. AppleScript ("tell Terminal to do script") waits on an Automation
  // permission prompt the first time, and hangs when nobody is there to answer it; this asks for nothing.
  if (platform === 'mac') return ['sh', '-c', MAC_TERMINAL, 'the-chief', command]
  return ['x-terminal-emulator', '-e', 'sh', '-c', `${command}; exec sh`]
}

/** Opens a link or an app deep link with the system's own opener. */
export function openArgv(url: string, platform: Platform): string[] {
  return platform === 'windows' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : platform === 'mac' ? ['open', url] : ['xdg-open', url]
}

/** A new terminal with a fresh `claude` on a prompt, in a folder: a Windows Terminal tab, a Terminal.app window, or the system terminal. `flags` go before the prompt. */
export function newClaudeArgv(prompt: string, dir: string, platform: Platform, flags: readonly string[] = []): string[] {
  // Windows Terminal reads a bare ; as "next command"
  if (platform === 'windows') return ['wt', '-w', '0', 'nt', '-d', dir || '.', 'claude', ...flags, prompt.replace(/;/g, '\\;')]
  const sh = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
  const line = `cd ${sh(dir || '.')} && claude ${[...flags, prompt].map(sh).join(' ')}`
  return platform === 'mac' ? terminalArgv(line, 'mac') : ['x-terminal-emulator', '-e', 'sh', '-c', line]
}
