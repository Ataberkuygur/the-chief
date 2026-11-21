/**
 * Pure pieces of three safeguards, kept apart so they are tested without the engine:
 * the one-word test of each CLI (a broken sign-in shows before a job lands on it), the check a chief's DONE passes
 * before it counts, and the simple mode that reads the fine-tuning options as their defaults.
 */
import { cleanAnswer, consultArgv, consultFailure } from './consult'

// ---------- the one-word test ----------

export const PING_PROMPT = 'Reply with the single word: ok'

/** The model a one-word test runs on: a small one by its name, else the first of the list. */
export function pingModel(models: readonly string[]): string {
  return models.find(m => /haiku|flash|lite|mini|nano|free|auto/i.test(m)) ?? models[0] ?? ''
}

/**
 * The one-word test's command: read-only, no tools. null for a CLI that is not tested (a local model would be loaded
 * into memory to say one word; a custom endpoint has no CLI of its own).
 */
export function pingArgv(cli: string, model: string, outFile: string, isWin: boolean): string[] | null {
  if (!model || cli === 'opencode-ollama' || cli === 'custom') return null
  // no tools, no MCP servers, no session file: one word for a fraction of a cent
  if (cli === 'claude') return ['claude', '-p', 'ok', '--model', model, '--system-prompt', PING_PROMPT, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text']
  return consultArgv({ cli, model, effort: '' }, PING_PROMPT, outFile, isWin)
}

export type PingVerdict = 'ok' | 'key' | 'limit' | 'missing' | 'failed'

/** What a one-word test showed: it answered, its key or credit is refused, it is at its limit, it is not installed, or it failed some other way. */
export function pingVerdict(exitCode: number, stdout: string, stderr: string, authRe: RegExp, rateRe: RegExp): { verdict: PingVerdict; why: string } {
  const all = `${stderr}\n${stdout}`
  const last = cleanAnswer(all, 4000).split('\n').filter(Boolean).pop()?.slice(0, 160) ?? ''
  if (/command not found|not recognized as|ENOENT|No such file or directory/i.test(all)) return { verdict: 'missing', why: 'CLI not installed' }
  const isAuth = authRe.test(all) || /not (logged|signed) in|login required|please (log|sign) in/i.test(all)
  if (exitCode === 0 && cleanAnswer(stdout) && !isAuth) return { verdict: 'ok', why: '' }
  if (isAuth) return { verdict: 'key', why: last || 'sign-in or key refused' }
  if (rateRe.test(all)) return { verdict: 'limit', why: last || 'at its limit' }
  return { verdict: 'failed', why: consultFailure(exitCode, stdout, stderr) }
}

// ---------- the check a DONE passes ----------

/**
 * The files a finished turn names: paths in backticks, in markdown links and written out in full. Only what is
 * plainly a path counts (a folder in it, and either a full path or a file extension), so a branch name, a slash
 * command or a version number is never checked as a file.
 */
export function claimedPaths(text: string, max = 12): string[] {
  const out: string[] = []
  const hasExt = (s: string) => /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(s)
  const add = (raw: string, bare = false) => {
    const s = raw.trim().replace(/[.,;:)\]]+$/, '').replace(/:\d+(:\d+)?$/, '')
    if (!s || !/[\\/]/.test(s) || /[*<>|{}$=]|…|\.\.\.|^-|:\/\//.test(s)) return
    const rooted = /^(~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/[^/\s]+\/)/.test(s)
    if (!rooted && (/\s/.test(s) || s.startsWith('/') || !hasExt(s))) return
    // written outside backticks a path ends at the first space: only one that still ends in a file name is whole
    if (bare && !hasExt(s)) return
    if (!out.includes(s) && out.length < max) out.push(s)
  }
  for (const m of text.matchAll(/`([^`\n]{2,260})`/g)) add(m[1]!)
  for (const m of text.matchAll(/\]\(([^)\s]{2,260})\)/g)) add(m[1]!)
  for (const m of text.replace(/`[^`\n]*`/g, ' ').matchAll(/(?<![\w/.~:-])((?:~|[A-Za-z]:)?[\\/][^\s`'"()<>]{3,260})/g)) add(m[1]!, true)
  return out
}

/** A claimed path as a full one: ~ is the home folder, a relative one sits in the chat's folder. */
export function fullPath(p: string, cwd: string, home: string): string {
  if (/^~[\\/]/.test(p)) return `${home}${p.slice(1)}`
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(p)) return p
  return `${cwd.replace(/[\\/]+$/, '')}/${p.replace(/^\.[\\/]/, '')}`
}

/** What the named files turned out to be; a "path" whose first folder does not exist (a route, a slash command) is not counted as a file. */
export async function checkFiles(
  paths: readonly string[],
  cwd: string,
  home: string,
  fs: { exists: (p: string) => Promise<boolean>; stat: (p: string) => Promise<{ kind: string; size: number } | null> },
): Promise<{ checked: number; missing: string[]; empty: string[] }> {
  const roots = new Map<string, boolean>()
  const out = { checked: 0, missing: [] as string[], empty: [] as string[] }
  for (const p of paths) {
    const full = fullPath(p, cwd, home)
    const root = rootOf(full)
    if (!roots.has(root)) roots.set(root, await fs.exists(root).catch(() => false))
    if (!roots.get(root)) continue
    out.checked++
    const st = await fs.stat(full).catch(() => null)
    if (!st) out.missing.push(p)
    else if (st.kind === 'file' && st.size === 0) out.empty.push(p)
  }
  return out
}

/** The first folder of a full path ("/Users" of "/Users/x/y"): a "path" whose first folder does not exist is a route or a command, not a file. */
export const rootOf = (full: string): string => /^[A-Za-z]:[\\/]/.test(full) ? full.slice(0, 3) : `/${full.split('/')[1] ?? ''}`

// ---------- simple mode ----------

/**
 * The fine-tuning options and their defaults (the manifest's own; a test holds the two together). With simple_mode
 * on they are read as these, whatever is saved: keys, models, tiers, permissions and money options are never touched.
 */
export const ADVANCED_DEFAULTS: Readonly<Record<string, string>> = {
  context_guard: '300k',
  cold_guard: '80k',
  read_guard: '64k',
  handoff_after_compacts: 'off',
  handoff_after_hours: 'off',
  wake_guard: 'on',
  heavy_gate: 'on',
  stale_locks: '',
  max_parallel_total: '',
  worker_models: 'off',
  worker_routes: 'auto',
  auto_release_done: 'auto',
}

/** An option as The Chief reads it: a fine-tuning one is its default while simple mode is on. */
export const simpleOpt = (field: string, saved: string, simple: boolean): string => (simple && field in ADVANCED_DEFAULTS ? ADVANCED_DEFAULTS[field]! : saved)
