import { atom, read, update } from 'claude-code'
import { register as registerThemes, startTheme, themesTab } from './themes'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { SquadBudget, SquadCli, SquadGoal, SquadLane, SquadLimit, SquadReport, SquadSub, SquadSubControl, SquadTab, SquadWorker } from '../types'
import { BRIDGE_FILES, BRIDGE_VERSION } from './bridge-files'
import { gateCmd, jobScript, jobScriptSh, launchShArgv, parseTrainConfig, trainBatch, trainQueueName, trainScript, trainSummary } from './jobs'
import type { TrainConfig, TrainItem, TrainResult } from './jobs'
import { parseMacReportsConfig, reportNews, unseenReports } from './macreports'
import { LIVE_TEMPLATE,LIVE_TEMPLATE_VERSION } from './live-template'
import { FLAGS, WAITING_RE, fmtUsd, priceOf, stepUsd } from './spend'
import { addPrompt, firstLine, parsePrompts, removePrompt } from './prompts'
import type { SavedPrompt } from './prompts'
import type { StepUsage, SpendResult } from './spend'
import {
  CHIEF_TIER_DEFAULTS, LIST_COMMANDS, TIER_IDS, TIER_LABEL, afterZeroByte, asTier, cacheFresh, gateAgent, mergeModels, parseChiefTiers, parseFloors, parseModelList, parseSubTiers,
  OPENCODE_GO_MODELS, isFreeModel, looksPrivate, nextWorkerRoute, resolveChiefTier, resolveWorkerRoute, routeKey, resolveWorkerTier, tierNote, zenRoutes,
} from './tiers'
import type { ChiefTiers, Floor, ModelCache, Route, SubTiers, TierId } from './tiers'
import { ESCALATE_AFTER, capacity, checkTable, creditLine, escalate, flowText, hitsGuard, laneReport, skippedFrom, summarize, zenLine } from './lanes'
import type { CheckResult, Credit, LaneState, LaneTemplate } from './lanes'
import { collectZen, emptyZen, healthyZenIds, zenDue, zenTrusted } from './zen'
import type { ZenRecord, ZenResponse } from './zen'
import { bootGateLive, criticalKill, gatePlan, suspendPs } from './heavygate'
import { pruneStore, storeSet } from './storekeep'
import type { GateWait } from './heavygate'
import { PROCSNAP_CS, PROCSNAP_VERSION, parseSnap, parseTasklist } from './procsnap'
import type { SnapProc } from './procsnap'
import { alarmDue, alarmKey, CPU_ACTIVE_MS, parseCpuTime, promptFile, resultReport, stateLabel, workerHealth, workerRow } from './workerhealth'
import { SETUP_KEY, setupInfo, canAskSetup, riskyOn, runSetup } from './setup'
import { L, firstAppleLanguage, getLang, pickLang, setLang } from './lang'
import { APP, archiveSession, knowAsk, knowPath, cleanTitle, handoffArchiveOk, handoffVerdict, hasDone, idleCompactDue, logAction, nameOnce, nameSession, parseCompactLimit, parseHours, patchSess, pinSession, readSess, recordCompact, remoteOn, renameSession, stateOf, resumeHandoff, runHandoff, titleFromText, titleOfSession } from './handoff'
import { briefIsNew, effortReport, effortState, notMyChief, restartsChief } from './chiefs'
import type { EffortCard, EffortState } from './chiefs'
import type { FlowPorts, Inbound, Job as HandoffJob, Ports } from './handoff'
import { CONSULTANTS_DEFAULT, CONSULT_BIN, CONSULT_PANEL_MAX, CONSULT_TIMEOUT_MS, LOGIN, cleanAnswer, consultArgv, consultFailure, consultPrompt, consultantName, loginVerdict, newClaudeArgv, openArgv, parseConsultants, pickConsultants, platformOf, terminalArgv } from './consult'
import type { Consultant } from './consult'
import { checkFiles, claimedPaths, pingArgv, pingModel, pingVerdict, simpleOpt } from './quality'
import type { PingVerdict } from './quality'

export { WAITING_RE, priceOf, stepUsd }
/** Worker health lives in its own module (pure, tested) and is re-exported for the tests and callers that always had it here. */
export { runningState } from './workerhealth'

const PANE = 'squad'
const LANES = { plugin: 'the-chief', key: 'lanes' } as const
const GOALS = { plugin: 'the-chief', key: 'goals' } as const
const WORKERS = { plugin: 'the-chief', key: 'workers' } as const
const SUBS = { plugin: 'the-chief', key: 'subs' } as const
const REPORTS = { plugin: 'the-chief', key: 'reports' } as const
const SUMMARIZING = { plugin: 'the-chief', key: 'isSummarizing' } as const
const OPEN_REPORT = { plugin: 'the-chief', key: 'openReport' } as const
const TAB = { plugin: 'the-chief', key: 'tab' } as const
const SELECTED = { plugin: 'the-chief', key: 'selected' } as const
const TICK = { plugin: 'the-chief', key: 'tick' } as const
const EDITING = { plugin: 'the-chief', key: 'editingProvider' } as const
const SAVED_KEYS = { plugin: 'the-chief', key: 'savedKeys' } as const
const SUB_CONTROL = { plugin: 'the-chief', key: 'subControl' } as const
const STARTUP = { plugin: 'the-chief', key: 'startup' } as const
const lanes = atom(LANES, [])
const goals = atom(GOALS, [])
const workers = atom(WORKERS, [])
const subs = atom(SUBS, [])
const reports = atom(REPORTS, [])
const summarizing = atom(SUMMARIZING, false)
const openReport = atom(OPEN_REPORT, null)
const tab = atom(TAB, 'agents')
const selected = atom(SELECTED, null)
const tick = atom(TICK, 0)
const startup = atom(STARTUP, { plugins: [], skills: [], error: '', loaded: false })
const editingAtom = atom(EDITING, null)
const savedKeysAtom = atom(SAVED_KEYS, [])
const subControlAtom = atom(SUB_CONTROL, { model: 'auto', effort: 0 })
const BUDGET = { plugin: 'the-chief', key: 'budget' } as const
/** Measured on this machine (Oct 1 window vs. its logs): 1% of the 5h limit ≈ $10.5 of API-priced use, 1% of the week ≈ $39.5. */
const PRIOR_PER_USD = { five: 0.0954, week: 0.0253 } as const
const budgetAtom = atom(BUDGET, { five: null, week: null, savedUsd: 0, savedTokens: 0, fivePerUsd: PRIOR_PER_USD.five, weekPerUsd: PRIOR_PER_USD.week, compacts: 0, reads: 0 } as SquadBudget)

/** The models a subagent can be put on from the band; auto leaves Claude's own choice. */
const SUB_MODELS = [
  { value: 'auto', text: 'Auto' },
  { value: 'claude-opus-5-5', text: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', text: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', text: 'Haiku 5.5' },
  { value: 'claude-haiku-4-5-20251001', text: 'Haiku 4.5' },
  { value: 'claude-fable-5-1', text: 'Fable 5.1' },
] as const
/**
 * The owner's routing for chief chats when Settings has no rows of its own: easy to medium on Haiku 5.5 at max
 * effort, medium-hard and hard on Sonnet 5.5 at medium, the deepest reasoning on Opus 5.5 at medium.
 */
export const CHIEF_TIERS = { easy: CHIEF_TIER_DEFAULTS.kolay, hard: CHIEF_TIER_DEFAULTS.orta, deep: CHIEF_TIER_DEFAULTS.cok_zor } as const
/** Read by the spawn and step hooks on every call, so kept outside state too. */
let subControl: SquadSubControl = { model: 'auto', effort: 0 }
/** Hidden for now: the band's subagent controls show, and apply, only after `/chief band on`. */
let bandControls = false

/** Sets the subagent model or effort (0 = auto, 1..5 = low..max), here and for every later session. */
async function setSubControl($: $T, patch: Partial<SquadSubControl>) {
  subControl = { ...subControl, ...patch }
  await $.state.set(SUB_CONTROL, subControl)
  await storeSet($, 'subControl', subControl)
}
const subModelText = (v: string) => SUB_MODELS.find(m => m.value === v)?.text ?? v
const subEffortText = (n: number) => (n === 0 ? 'auto' : EFFORTS[n - 1] ?? 'auto')

// One accent, used sparingly: violet means "alive". Green and red only ever mean done and failed.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Grey to white to Claude's coral: the further right, the hotter. */
const RAMP = ['#5c5c5c', '#8f8f8f', '#cfcfcf', '#f4f4f4', '#d97757'] as const
/** Alive, active, working: bright white and bold, so the eye finds it without a colour. */
const VIOLET = '#f2f2f2'
/** Claude's coral, kept for the few things that must stand out: the brand mark, the goal, a limit running out. */
const CORAL = '#d97757'
/** Done reads as plain white, not a second colour. */
const GREEN = '#ededed'
const RED = '#e5484d'
const AMBER = '#a3a3a3'
const MAX_AGENTS = 12
const TAIL = 60
const SUMMARY_MODEL = 'claude-sonnet-5-5'
const NOW_MODEL = 'claude-haiku-4-5'

type CliSpec = {
  label: string
  /** Models offered when the Settings list for this provider is empty. */
  defaultModels: string
  /** How many effort steps the CLI takes; 0 when the model fixes it. */
  efforts: number
  /** The userConfig field holding this provider's API key, and the variable the agent reads it from. */
  key: { field: string; env: string } | null
  /** The userConfig field holding a custom endpoint, and the variable the agent reads it from. */
  endpoint: { field: string; env: string } | null
  /** One line on how the agent signs in, for Settings. */
  auth: string
  /** The interactive command, as it would run in a terminal tab. */
  shell: (model: string, effort: string) => string
  /** The headless command for one run; `session` is the Claude session to start or resume. */
  argv: (model: string, effort: string, prompt: string, session: { id: string; resume: boolean } | null, permission?: string) => string[]
}

/** The values Settings saved, as `register(on, options)` hands them in. */
let opts: Readonly<Record<string, unknown>> = {}
/**
 * How a headless Claude worker may act. Measured: under "auto" a headless run asks for every write and shell
 * redirect, nobody answers, and it ends having done nothing. acceptEdits lets it create and edit files in its
 * folder; commands that need approval are still refused (bypassPermissions lifts that, by the owner's choice).
 */
const claudeWorkerMode = () => (['acceptEdits', 'bypassPermissions', 'auto', 'default', 'plan'].includes(opt('claude_permission')) ? opt('claude_permission') : 'acceptEdits')

/** Options saved from inside The Chief win over the host's copy until the host catches up. */
let optOverrides: Record<string, string> = {}
const savedOpt = (field: string) => (field in optOverrides ? optOverrides[field]!.trim() : typeof opts[field] === 'string' ? (opts[field] as string).trim() : '')
/** An option as The Chief reads it: with simple_mode on, the fine-tuning ones are their defaults whatever is saved. */
const opt = (field: string) => simpleOpt(field, savedOpt(field), savedOpt('simple_mode') === 'on')
/** The Chief pins chats, or names them, by itself only when the owner turned that on; asked-for pins and titles always work. */
const autoPin = () => opt('auto_pin') === 'on'
const autoTitle = () => opt('auto_title') === 'on'
export const budget = (): BudgetOptions => ({
  guardTokens: parseTokens(opt('context_guard'), 300_000),
  coldMs: COLD_MS,
  coldMinTokens: parseTokens(opt('cold_guard'), 80_000),
  readMaxBytes: parseTokens(opt('read_guard'), 64_000),
})
/** A session hands off after this many normal compacts (0 = never) or after this many hours with a big context (0 = never). */
// automatic handoff is off unless set
const handoffAfterCompacts = () => parseCompactLimit(opt('handoff_after_compacts') || 'off')
const handoffAfterHours = () => parseHours(opt('handoff_after_hours') || 'off')
/** The wake guard (short wake-up / frequent cron refusal) is OFF by default; wake_guard: on turns it on. */
const wakeGuardOn = () => opt('wake_guard').toLowerCase() === 'on'
/** The saved sub-agent tiers; null while none are saved, and then nothing about sub-agents is enforced. */
const subTiersNow = (): SubTiers | null => parseSubTiers(opt('subagent_tiers'))
/** The chief tiers (Settings rows over the defaults) and the difficulty floors. */
const chiefTiersNow = (): ChiefTiers => parseChiefTiers(opt('chief_tiers'))
const floorsNow = (): Floor[] => parseFloors(opt('difficulty_floors'))
/** A headless agent The Chief started (THE_CHIEF_WORKER=1): its run is one task, so the budget guards stay out of it. */
let isWorker = false
/** Every worker's own environment: a headless run has no terminal, so a git pager or a credential prompt would wait forever (rakip-F2b hung on git log). */
export const WORKER_ENV = { THE_CHIEF_WORKER: '1', GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' } as const
const isWindows = () => /^[A-Za-z]:[\\/]/.test(cwd)
/** npm shims (opencode) only resolve through a shell on Windows. */
const shim = (argv: string[]) => (isWindows() ? ['cmd', '/c', ...argv] : argv)
/** A model id with its provider prefix, added once. */
const prefixed = (prefix: string, m: string) => (m.startsWith(`${prefix}/`) ? m : `${prefix}/${m}`)

const CLIS: Record<SquadCli, CliSpec> = {
  claude: {
    label: 'Claude Code',
    defaultModels: 'claude-sonnet-5-5, claude-opus-5-5, claude-fable-5-1, claude-haiku-5-5, claude-haiku-4-5',
    efforts: 5,
    key: { field: 'anthropic_api_key', env: 'ANTHROPIC_API_KEY' },
    endpoint: { field: 'anthropic_endpoint', env: 'ANTHROPIC_BASE_URL' },
    auth: 'Uses your Claude login when no key is set',
    shell: (m, e) => `claude --model ${m} --effort ${e} --permission-mode auto`,
    argv: (m, e, p, s, perm) => [
      'claude', '-p', p, '--model', m, '--effort', e, '--permission-mode', perm || claudeWorkerMode(), '--output-format', 'stream-json', '--verbose',
      ...(s ? (s.resume ? ['--resume', s.id] : ['--session-id', s.id]) : []),
    ],
  },
  codex: {
    label: 'Codex',
    defaultModels: 'gpt-6-luna',
    efforts: 4,
    key: { field: 'openai_api_key', env: 'OPENAI_API_KEY' },
    endpoint: { field: 'openai_endpoint', env: 'OPENAI_BASE_URL' },
    auth: 'Uses your Codex login when no key is set',
    shell: (m, e) => `codex -m ${m} -c model_reasoning_effort="${e}" --sandbox danger-full-access -a never`,
    argv: (m, e, p) => ['codex', 'exec', '--json', '-m', m, '-c', `model_reasoning_effort="${e}"`, '-s', 'danger-full-access', p],
  },
  devin: {
    label: 'Devin',
    defaultModels: 'swe-2-max, swe-2, gemini-4-argon, gemini-3.8-flash',
    efforts: 0,
    key: { field: 'devin_api_key', env: 'DEVIN_API_KEY' },
    endpoint: null,
    auth: 'Uses your Devin login; a key is passed as DEVIN_API_KEY',
    shell: m => `devin --model ${m} --permission-mode dangerous --respect-workspace-trust false`,
    argv: (m, _e, p) => ['devin', '-p', p, '--model', m, '--permission-mode', 'dangerous', '--respect-workspace-trust', 'false'],
  },
  cursor: {
    label: 'Cursor',
    defaultModels: 'auto',
    efforts: 0,
    key: { field: 'cursor_api_key', env: 'CURSOR_API_KEY' },
    endpoint: null,
    auth: 'cursor-agent reads CURSOR_API_KEY',
    shell: m => `cursor-agent --model ${m}`,
    argv: (m, _e, p) => ['cursor-agent', '-p', p, '--model', m, '--force', '--output-format', 'stream-json'],
  },
  qoder: {
    label: 'Qoder',
    // Qoder's own model names; DeepSeek-Flash is its name for DeepSeek V4.1 Flash
    defaultModels: 'Qwen3.8-Flash, DeepSeek-Flash, Qwen3.8-Max',
    efforts: 5,
    key: { field: 'qoder_api_key', env: 'QODER_PERSONAL_ACCESS_TOKEN' },
    endpoint: null,
    auth: 'Uses your Qoder login; a token is passed as QODER_PERSONAL_ACCESS_TOKEN',
    shell: (m, e) => `qodercli -m ${m} --reasoning-effort ${e}`,
    argv: (m, e, p, s) => ['qodercli', '-p', p, '-m', m, '--reasoning-effort', e, '--dangerously-skip-permissions', '-o', 'stream-json', ...(s ? (s.resume ? ['-r', s.id] : ['--session-id', s.id]) : [])],
  },
  gemini: {
    label: 'Gemini',
    // no list command: these are the Gemini models the owner uses; Settings adds more
    defaultModels: 'gemini-3.8-flash, gemini-4-argon',
    efforts: 0,
    key: { field: 'gemini_api_key', env: 'GEMINI_API_KEY' },
    endpoint: null,
    auth: 'Uses your Google login when no key is set; a key is passed as GEMINI_API_KEY',
    shell: m => `gemini -m ${m} --approval-mode yolo`,
    argv: (m, _e, p) => shim(['gemini', '-m', m, '--approval-mode', 'yolo', '-o', 'stream-json', p]),
  },
  antigravity: {
    label: 'Antigravity',
    // `agy models` lists them; the effort is part of the slug (gemini-4-carbon-high)
    defaultModels: 'gemini-4-carbon-high, gemini-4-carbon-medium, gemini-4-carbon-low',
    efforts: 0,
    key: null,
    endpoint: null,
    auth: 'Uses your Google login (run agy once and sign in)',
    shell: m => `agy --model ${m} --dangerously-skip-permissions`,
    // shortcut: plain text output, so no live tool steps in the pane; move to --output-format stream-json once it is read here
    argv: (m, _e, p) => shim(['agy', '-p', p, '--model', m, '--dangerously-skip-permissions']),
  },
  openrouter: {
    label: 'OpenRouter',
    defaultModels: 'openrouter/auto',
    efforts: 0,
    key: { field: 'openrouter_api_key', env: 'OPENROUTER_API_KEY' },
    endpoint: null,
    auth: 'Runs through OpenCode with OPENROUTER_API_KEY',
    shell: m => `opencode -m ${prefixed('openrouter', m)}`,
    argv: (m, _e, p) => shim(['opencode', 'run', '--format', 'json', '-m', prefixed('openrouter', m), p]),
  },
  'opencode-zen': {
    label: 'OpenCode Zen',
    defaultModels: '',
    efforts: 0,
    key: { field: 'opencode_zen_api_key', env: 'OPENCODE_API_KEY' },
    endpoint: null,
    auth: 'Uses your OpenCode login; a key is passed as OPENCODE_API_KEY',
    shell: m => `opencode -m ${prefixed('opencode', m)}`,
    argv: (m, _e, p, s) => shim(['opencode', 'run', '--format', 'json', ...(s?.resume ? ['--session', s.id] : []), '-m', prefixed('opencode', m), p]),
  },
  'opencode-go': {
    label: 'OpenCode Go',
    defaultModels: OPENCODE_GO_MODELS.join(', '),
    efforts: 0,
    key: { field: 'opencode_go_api_key', env: 'OPENCODE_API_KEY' },
    endpoint: null,
    auth: 'Uses your OpenCode login; a key is passed as OPENCODE_API_KEY',
    shell: m => `opencode -m ${prefixed('opencode-go', m)}`,
    argv: (m, _e, p, s) => shim(['opencode', 'run', '--format', 'json', ...(s?.resume ? ['--session', s.id] : []), '-m', prefixed('opencode-go', m), p]),
  },
  'opencode-ollama': {
    label: 'Ollama',
    // the local model the route order falls back to after Zen's free ones; OpenCode talks to the Ollama server
    defaultModels: 'minimax-m3.1-flash',
    efforts: 0,
    key: null,
    endpoint: null,
    auth: 'Runs through OpenCode on the Ollama server (localhost:11434)',
    shell: m => `opencode -m ${prefixed('ollama', m)}`,
    argv: (m, _e, p) => shim(['opencode', 'run', '--format', 'json', '-m', prefixed('ollama', m), p]),
  },
  custom: {
    label: 'Custom',
    defaultModels: '',
    efforts: 4,
    key: { field: 'custom_api_key', env: 'CUSTOM_API_KEY' },
    endpoint: { field: 'custom_endpoint', env: 'CUSTOM_BASE_URL' },
    auth: 'Any OpenAI-compatible endpoint, run through Codex',
    shell: (m, e) => `codex -m ${m} (custom endpoint) -c model_reasoning_effort="${e}"`,
    argv: (m, e, p) => [
      'codex', 'exec', '-m', m,
      '-c', 'model_provider="custom"',
      '-c', 'model_providers.custom.name="custom"',
      '-c', `model_providers.custom.base_url="${opt('custom_endpoint')}"`,
      '-c', 'model_providers.custom.env_key="CUSTOM_API_KEY"',
      '-c', `model_reasoning_effort="${e}"`,
      '-s', 'danger-full-access', '--json', p,
    ],
  },
}
const CLI_ORDER: readonly SquadCli[] = ['claude', 'codex', 'devin', 'cursor', 'qoder', 'gemini', 'antigravity', 'openrouter', 'opencode-zen', 'opencode-go', 'opencode-ollama', 'custom']

/** A lane saved before the providers split: `opencode` meant OpenCode Go. */
/** `opencode` and `agy` are the names people type. */
const CLI_ALIAS: Record<string, SquadCli> = { opencode: 'opencode-go', agy: 'antigravity' }
const knownCli = (cli: string) => cli in CLI_ALIAS || (CLI_ORDER as readonly string[]).includes(cli)
const normalizeCli = (cli: string): SquadCli => (CLI_ALIAS[cli] ?? ((CLI_ORDER as readonly string[]).includes(cli) ? (cli as SquadCli) : 'claude'))

/** The models a provider offers: its Settings list, else its defaults. */
export function modelsOf(cli: SquadCli): string[] {
  const raw = opt(`${cli.replace(/-/g, '_')}_models`) || CLIS[cli].defaultModels
  return raw.split(',').map(m => m.trim()).filter(Boolean)
}

/** What an agent's process gets on top of the host's environment: its provider's key and endpoint. */
export function envFor(cli: SquadCli): Record<string, string> {
  const spec = CLIS[cli]
  const env: Record<string, string> = {}
  if (spec.key && opt(spec.key.field)) env[spec.key.env] = opt(spec.key.field)
  if (spec.endpoint && opt(spec.endpoint.field)) env[spec.endpoint.env] = opt(spec.endpoint.field)
  return env
}

/**
 * The OpenCode config an OpenCode worker starts with: snapshots off. OpenCode's first snapshot runs
 * `git add --all --sparse --pathspec-from-file=- --pathspec-file-nul` and, in the worker's fresh data
 * folder, hangs on it forever (CPU ~0, a 0-byte raw log). A caller's own config is merged in, its own
 * keys kept, so the flag is the only thing added. Pure, so it is tested.
 */
export function opencodeConfig(prev?: string | null): string {
  let base: Record<string, unknown> = {}
  if (prev && prev.trim()) {
    try {
      const parsed: unknown = JSON.parse(prev)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>
    } catch {
      // not JSON: the snapshot flag still goes in, the unreadable config is dropped
    }
  }
  return JSON.stringify({ ...base, snapshot: false })
}

const DEFAULT_LANES: SquadLane[] = [
  { id: 'hard', task: 'Hard work: deep refactors and tricky bugs', cli: 'claude', model: 'claude-sonnet-5-5', effort: 3, count: 3 },
  { id: 'easy', task: 'Easy work: mechanical cleanups and tests', cli: 'devin', model: 'swe-2-max', effort: 2, count: 6 },
]

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const rampAt = (f: number) => RAMP[clamp(Math.round(f * (RAMP.length - 1)), 0, RAMP.length - 1)] ?? RAMP[0]
const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/^opencode-go\//, '')
/** "swe-2-max" → "SWE 2 Max", "opencode-go/deepseek-v4.1-flash" → "DeepSeek V4.1 Flash": a model as a person would say it. */
export function prettyModel(m: string): string {
  const base = m.replace(/^claude-/, '').replace(/^[\w-]+\//, '').replace(/-\d{8}$/, '')
  return base
    .split('-')
    .filter(Boolean)
    .map(w => (w === 'deepseek' ? 'DeepSeek' : /^(swe|gpt|glm)$/i.test(w) ? w.toUpperCase() : /^v\d/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/(\d) (\d)/g, '$1.$2')
}
/** The running agents in one line, for surfaces that draw no band (Remote Control, the web): "🤖 3 ajan · DeepSeek V4.1 Flash ×2 · Sonnet 5.5". Empty when none run. */
export function crewLine(agents: readonly { cli: string; model: string }[]): string {
  if (!agents.length) return ''
  const seen = new Map<string, number>()
  for (const a of agents) {
    const k = prettyModel(a.model || '') || laneBrand(a.cli)
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return `🤖 ${agents.length} ${L('agents', 'ajan')} · ${[...seen].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(' · ')}`
}
/** The crew by model, in the order first seen: one label, how many, and the lane colour of the first. */
export function crewGroups(agents: readonly { cli: string; model: string }[]): { label: string; n: number; cli: string }[] {
  const out = new Map<string, { label: string; n: number; cli: string }>()
  for (const a of agents) {
    const label = prettyModel(a.model || '') || laneBrand(a.cli)
    const g = out.get(label)
    if (g) g.n++
    else out.set(label, { label, n: 1, cli: a.cli })
  }
  return [...out.values()]
}
/** One agent each would take about half the band (~45 columns of ~90): then it is one per model, "×4" beside it. */
export const crewGrouped = (agents: readonly { cli: string; model: string }[]): boolean =>
  agents.reduce((w, a) => w + Math.max(4, (prettyModel(a.model || '') || laneBrand(a.cli)).length) + 2, 0) > 45
/** The brand of a lane as the band shows it: all OpenCode lanes read "Opencode". */
export const laneBrand = (cli: string): string => (/^opencode/.test(cli) ? 'Opencode' : cli === 'claude' ? 'Claude' : (CLIS[normalizeCli(cli)]?.label ?? cli))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const newId = () => Math.random().toString(36).slice(2, 8)
const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n)
const baseName = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara']
const pad2 = (n: number) => String(n).padStart(2, '0')
/** Local date of a timestamp, YYYY-MM-DD. */
export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
/** L("Today", "Bugün"), L("Yesterday", "Dün") or "2 Eki" for a day key, seen from `now`. */
export function dayLabel(day: string, now: number): string {
  if (day === dayKey(now)) return L('Today', 'Bugün')
  if (day === dayKey(now - 86400000)) return L('Yesterday', 'Dün')
  const [y, m, d] = day.split('-').map(Number)
  const year = new Date(now).getFullYear() === y ? '' : ` ${y}`
  return `${d} ${L(MONTHS_EN, MONTHS)[(m ?? 1) - 1] ?? ''}${year}`
}
const timeOf = (ms: number) => {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const kindLabel = (): Record<SquadReport['kind'], string> => L({ manual: 'request', auto: 'agents done', daily: 'end of day' }, { manual: 'istek', auto: 'ajanlar bitti', daily: 'gün sonu' })
/** The local hour from which the day's summary is written. */
const DAILY_HOUR = 23

const FILE_RE = /(?:[A-Za-z]:)?[\w.\-\\/]+\.(?:tsx?|jsx?|mjs|py|md|json|css|html|ya?ml|rs|go|sql|sh|ps1)\b/g

export function effortName(cli: SquadCli, effort: number): string | null {
  const spec = CLIS[cli]
  if (spec.efforts === 0) return null
  return EFFORTS[clamp(effort, 0, spec.efforts - 1)] ?? 'medium'
}

export function commandFor(lane: SquadLane): string {
  return CLIS[lane.cli].shell(lane.model, effortName(lane.cli, lane.effort) ?? '')
}

export function agentNames(lane: SquadLane, index: number): string[] {
  const words = lane.task.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 3)
  const base = words.map(w => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join('').slice(0, 18) || `Lane${index + 1}`
  return Array.from({ length: lane.count }, (_, n) => `${base}-${n + 1}`)
}

/** A tool call in plain Turkish, for the steps list and the "now" line. */
export function stepText(tool: string, e: Record<string, unknown>): string {
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const cmd = oneLine(s('command'), 60)
  switch (tool) {
    case 'Read':
      return L(`Reading: ${baseName(s('file_path'))}`, `Okuyor: ${baseName(s('file_path'))}`)
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return L(`Editing: ${baseName(s('file_path') || s('notebook_path'))}`, `Düzenliyor: ${baseName(s('file_path') || s('notebook_path'))}`)
    case 'Grep':
      return L(`Searching: "${oneLine(s('pattern'), 40)}"`, `Arıyor: "${oneLine(s('pattern'), 40)}"`)
    case 'Glob':
      return L(`Finding files: ${oneLine(s('pattern'), 40)}`, `Dosya buluyor: ${oneLine(s('pattern'), 40)}`)
    case 'WebFetch':
    case 'WebSearch':
      return L(`Researching the web`, `Web'de araştırıyor`)
    case 'Agent':
      return L(`Handing off to a subagent: ${oneLine(s('description'), 40)}`, `Alt ajana devrediyor: ${oneLine(s('description'), 40)}`)
    case 'Bash':
    case 'PowerShell':
      if (/\b(test|vitest|jest|pytest)\b/.test(cmd)) return L('Running tests', 'Testleri çalıştırıyor')
      if (/\b(tsc|typecheck|lint|eslint)\b/.test(cmd)) return L('Checking types and lint', 'Tipleri ve lint\'i kontrol ediyor')
      if (/^git\b/.test(cmd)) return `Git: ${cmd.slice(4, 40)}`
      return L(`Command: ${cmd}`, `Komut: ${cmd}`)
    default:
      return tool.startsWith('mcp__') ? L(`Tool: ${tool.split('__').pop()}`, `Araç: ${tool.split('__').pop()}`) : tool
  }
}

export function planText(list: readonly SquadLane[], goal: string | null): string {
  const total = list.reduce((s, l) => s + l.count, 0)
  const lines = [`Launch this agent squad now: ${plural(list.length, 'lane')}, ${plural(total, 'agent')} (set in the Squad pane).`]
  if (goal) lines.push(`Active goal: ${goal}`)
  lines.push('')
  list.forEach((lane, i) => {
    const eff = effortName(lane.cli, lane.effort)
    lines.push(`Lane ${i + 1} (lane id "${lane.id}") · "${lane.task}" · ${lane.count} × ${CLIS[lane.cli].label} ${lane.model}${eff ? ` · effort ${eff}` : ''}`)
    lines.push(`  Agents: ${agentNames(lane, i).join(', ')}`)
    lines.push('')
  })
  lines.push(
    'How to run it:',
    '1. Split each lane\'s task into one self-contained brief per agent: its own files and scope, no overlap, a clear done condition and a report file to write. Save each as .squad/briefs/<Agent>.md.',
    '2. For each agent call mcp__the-chief__spawn_worker with { name, lane, brief } (lane = the lane id above). The Squad pane runs it headless with that lane\'s CLI, model and effort.',
    '3. You own every agent: mcp__the-chief__list_agents shows all of them (CLI agents and your own subagents), agent_output reads one, message_agent sends a follow-up, stop_agent stops one.',
    '4. You are told when each agent finishes. Verify the work before accepting it, and follow up or start a new agent for anything left.',
  )
  return lines.join('\n')
}

/** The overview: what moved forward and what went wrong, read off the whole conversation, for someone who directs the work. */
const overviewSystem = () => [
  'You brief the owner of a Claude Code session on how the work went. The owner directs the work but does not read code.',
  'You get the conversation between the owner and Claude for a time window, plus the agents that ran in it. Read all of it and pull out the developments:',
  'concrete outcomes (something built, fixed, shipped, decided, measured, delivered) and setbacks (something that failed, broke, was rejected by the owner, had to be redone, or is still blocked).',
  L('Write in English', 'Write in Turkish') + ', as outcomes for the project, the way a project lead tells a founder: what changed and why it matters, never how it was coded.',
  'No file names, function names, commands, versions or tool names unless the owner would recognise them as product names.',
  'Exactly two Markdown sections:',
  L('## Progress', '## Olumlu gelişmeler') + ': 2 to 6 bullets, each one full sentence starting with the thing that changed.',
  L('## Setbacks', '## Olumsuz gelişmeler') + ': 1 to 5 bullets, the same way; if truly nothing went wrong, one bullet saying so.',
  'Nothing else: no intro, no status of idle agents, no next steps. Under 170 words. Never invent anything the material does not show.',
].join('\n')

/** The conversation as plain lines (who said what), reminders and markup stripped, cut to fit a budget. */
export function conversationDigest(msgs: readonly { role: string; text: string }[], budget = 28000): string {
  const clean = (t: string) =>
    t
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
      .replace(/<[^>\n]{1,80}>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const items = msgs
    .map(m => ({ who: m.role === 'user' ? 'Sahip' : 'Claude', text: clean(m.text) }))
    .filter(x => x.text && !(x.who === 'Sahip' && /^(.{0,60}?)The Chief( ·|:)/.test(x.text)))
  if (items.length === 0) return '(no conversation in this window)'
  const per = Math.max(160, Math.floor(budget / items.length))
  const all = items.map(x => `${x.who}: ${x.text.length > per ? `${x.text.slice(0, per)}…` : x.text}`).join('\n')
  return all.length <= budget * 1.3 ? all : `${all.slice(0, Math.floor(budget * 0.25))}\n…\n${all.slice(-Math.floor(budget * 0.75))}`
}

/** Where each day starts in this session's messages (day key to message index), stamped at the day's first turn. */
let dayStamps: Record<string, number> = {}

/** The sub-agent tiers last announced to this session, as saved; the note rides the next user turn once it changes. */
let tierNoteSent = ''

/** The tier note goes along with the first user message after the tiers are saved or changed, then once per session. */
function withTierNote<T extends { context?: readonly string[]; origin: { kind: string } }>(e: T): T {
  const raw = opt('subagent_tiers')
  const tiers = parseSubTiers(raw)
  if (!tiers || isWorker || e.origin.kind === 'plugin' || raw === tierNoteSent) return e
  tierNoteSent = raw
  return { ...e, context: [...(e.context ?? []), tierNote(tiers, c => CLIS[normalizeCli(c)]?.label ?? c)] } as T
}

/** Registers every orchestrator tool; safe to run again (a reload, a reconnect), and run again by whatever event comes first when a reload skipped session.start. */
let toolsRegistered = false
async function registerChiefTools($: $T) {
  toolsRegistered = true
    await registerTool($, {
      name: 'spawn_worker',
      description:
        'Start one headless agent from the Squad pane. Give it a name, a brief file it must read and execute, and how hard the job is as tier (cok_zor|zor|orta|kolay: the owner\'s Alt ajan seviyeleri set CLI, model and effort; a difficulty floor can lift it), or a lane id from the Squad plan, or cli/model/effort directly. With saved tiers and none of those, the tier is orta. Returns at once and you are told when the agent finishes; with wait:true the call holds until it finishes and returns its report, like a subagent.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short agent name, e.g. HardWork-1' },
          brief: { type: 'string', description: 'Path of the brief file the agent reads and executes' },
          tier: { type: 'string', enum: [...TIER_IDS], description: "How hard the job is. With no lane/cli/model the plugin routes it by itself: kolay/orta = the healthy free OpenCode Zen models (DeepSeek V4.1 Flash Free, MiMo, Nemotron, Laguna, LongCat, GLM 5.3 Flash Free) then Ollama minimax-m3.1-flash, then Haiku 5.5 xhigh; zor = Sonnet 5.5 medium; cok_zor = Qoder Qwen3.8-Max / Sonnet 5.5 medium. A model that failed its ping or a CLI at its limit is skipped, and a private job never runs on a free or local model. Set worker_routes=off to use the saved Alt ajan seviyeleri instead." },
          private: { type: 'boolean', description: 'The job touches private or client data: routes whose provider keeps data (the free DeepSeek V4.1 Flash) are skipped. Words like client, private, NDA, credentials in the brief set it too.' },
          lane: { type: 'string', description: 'Lane id from the Squad plan' },
          cli: { type: 'string', enum: [...CLI_ORDER] },
          model: { type: 'string' },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
          cwd: { type: 'string', description: "Working directory the agent starts in (its worktree); the session's when absent" },
          header_file: { type: 'string', description: 'A fixed header file put before the task; {WT} {RAPOR} {NAME} {BRANCH} and vars are filled in' },
          task: { type: 'string', description: 'The task text (instead of brief)' },
          task_file: { type: 'string', description: 'A file holding the task text (instead of brief)' },
          vars: { type: 'object', description: 'Extra {PLACEHOLDER} values for the header and task' },
          worktree: { type: 'object', description: 'Make a fresh worktree first: git -C repo worktree add --detach path ref; the agent runs there', properties: { repo: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' } }, required: ['repo', 'ref', 'path'] },
          env: { type: 'object', description: 'Environment variables for this agent only, e.g. {"HF_HUB_OFFLINE":"1","ANDROID_SERIAL":"emulator-5582","TMP":"C:\\wt\\tmp"}' },
          done_when_file: { type: 'string', description: 'The run is done when this file exists (its text is the report); the process is then stopped and you are told' },
          locks: { type: 'array', items: { type: 'string' }, description: 'Resources only one agent at a time may hold across every chat on this computer, e.g. ["emulator-5582","gpu"]; a held lock makes the agent wait in the queue' },
          next: {
            type: 'array',
            description: 'What happens after a done run: the first rule whose regex matches the report runs. spawn starts another agent (same fields as this tool; {RAPOR_METNI} {PREV_WT} {PREV_NAME} filled in); notify hands you a task.',
            items: { type: 'object', properties: { match: { type: 'string' }, spawn: { type: 'object' }, notify: { type: 'string' } }, required: ['match'] },
          },
          detach: { type: 'boolean', description: 'Run outside the app so an app restart does not kill it (default true for Devin, Claude and Codex)' },
          permission_mode: { type: 'string', enum: ['acceptEdits', 'bypassPermissions', 'auto', 'default', 'plan'], description: 'Claude workers: acceptEdits (default) edits files; commands needing approval are refused. bypassPermissions allows everything.' },
          wait: { type: 'boolean', description: "Hold this call until the agent finishes and return its report and last lines, as a subagent's answer comes back (up to wait_minutes; after that you are told when it ends, as without wait). Use it when you need the result to go on; leave it out to keep working meanwhile." },
          wait_minutes: { type: 'number', description: 'With wait: how long to hold the call, 1 to 15, default 10' },
          queue: { type: 'boolean', description: 'Line it up instead of starting it now (when a worker of this chat runs): it starts by itself the moment one of your workers ends, without waiting for your turn. Queue your next briefs this way so no slot sits empty.' },
        },
        required: ['name'],
      },
    })
    await registerTool($, {
      name: 'lanes',
      description:
        'Lane recipes and their shared checks. save_template stores a recipe (repo, worktree path with {NAME}, folders to link such as node_modules, task text, tier, checks tsc/deps/eslint/vitest, a do-not-touch guard, next lanes). open starts lanes from it by name (worktree, links, task file, worker on the tier route); after=<lane> makes them wait. Checks run by themselves when a lane worker is done; two falls move the lane up a tier. table shows every lane with its checks; report gives the leader text of one lane; capacity says how many workers and heavy commands fit now (cleanup=true kills processes left by finished lanes); route sets or clears the CLI list of a tier (the leader can change it when a CLI runs out); credits sets or lists per-CLI credit counters; guard adds do-not-touch paths to a lane.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save_template', 'templates', 'open', 'checks', 'table', 'report', 'capacity', 'route', 'credits', 'guard', 'workers'] },
          template: { description: 'save_template: the recipe object. open/checks: the template name (string).' },
          names: { type: 'array', items: { type: 'string' }, description: 'open: lane names, e.g. ["media2","render2"]' },
          after: { type: 'string', description: 'open: start these lanes only when this lane is ready' },
          lane: { type: 'string', description: 'checks/report/guard: the lane' },
          add: { type: 'array', items: { type: 'string' }, description: 'guard: paths or patterns to add' },
          tier: { type: 'string', enum: ['cok_zor', 'zor', 'orta', 'kolay'], description: 'route: which tier' },
          routes: { type: 'array', items: { type: 'object' }, description: 'route: [{cli, model, effort, keeps?}] in order of preference' },
          clear: { type: 'boolean', description: 'route: back to the built-in list for this tier' },
          cli: { type: 'string', description: 'credits: the CLI id' },
          limit: { type: 'number' },
          used: { type: 'number' },
          until: { type: 'string' },
          label: { type: 'string' },
          cleanup: { type: 'boolean', description: 'capacity: kill processes left by finished lanes' },
        },
        required: ['action'],
      },
    })
    await registerTool($, {
      name: 'list_agents',
      description: 'The agents of this session: the CLI agents the Squad pane runs and your own subagents. Status, model, elapsed time, what each is doing now, the files it touched. Running and queued ones, plus those that ended in the last 30 minutes; all=true lists every one, clear=true forgets the ended ones.',
      inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'List ended agents of any age too' }, clear: { type: 'boolean', description: 'Remove every ended agent (done, failed, stopped) from the list' } } },
    })
    await registerTool($, {
      name: 'agent_output',
      description: 'Read one agent\'s recent output (CLI agent) or its steps and answer (subagent), by id (or a name that fits one agent). 20 lines unless you ask for more.',
      inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Agent id or name; a shell-started agent by pid' }, lines: { type: 'number', description: 'How many output lines, default 20, at most 500 (more than 60 reads the log file)' }, raw: { type: 'boolean', description: 'Every line the CLI printed, not only the parsed steps' } }, required: ['agent'] },
    })
    await registerTool($, {
      name: 'stop_agent',
      description: 'Stop a running agent, by name or id. Works for CLI agents and for your own subagents.',
      inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
    })
    await registerTool($, {
      name: 'run_job',
      description:
        'Run a long shell command (a merge train, a full test run, a render) outside this chat: it keeps running if this chat ends or the app restarts, and you are told when it ends with its exit code and last lines. Use it instead of a Bash call that may outlive the turn. Only a command your Bash permissions allow is started.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Short name, e.g. train-34' }, command: { type: 'string', description: 'A shell command line: cmd.exe on Windows, sh on macOS and Linux' }, cwd: { type: 'string', description: "Folder it runs in; this chat's when absent" } }, required: ['name', 'command'] },
    })
    await registerTool($, {
      name: 'message_agent',
      description: 'Send a message or follow-up instruction to an agent, by name or id, whether it is running or finished. A running OpenCode agent takes it mid-turn (live steer, the same turn reads it on its next step); every other CLI is launched one-shot, so its message is queued in its record and sent, in order, as the next continue turn of the same session when the current run ends (never a second process). A finished agent continues its own session where its CLI has one; otherwise it starts a new run with its brief and last output. The answer says which happened.',
      inputSchema: { type: 'object', properties: { agent: { type: 'string' }, text: { type: 'string' } }, required: ['agent', 'text'] },
    })
    await registerTool($, {
      name: 'consult',
      description:
        'Ask a consultant: another model, through its own CLI (Codex, Devin, Gemini, Qoder, OpenCode, a stronger Claude), for a second opinion, and get its answer in this same call. Use it when the owner asks for one ("danış", "ikinci görüş", "başka modele sor", "consult"), before a decision that is hard to undo (architecture, a data migration, deleting or rewriting a lot, a release), when a bug survived two of your fixes, when two reasonable options stay tied, or for a heavy analysis where being wrong is expensive. Not for routine work or for what you can check yourself. The consultant sees NOTHING of this chat and cannot edit anything: put the whole question in `question` (what is being decided, the options, the constraints, what you tried and what happened) and name the files it should read. It takes one to ten minutes. The answer is advice: check its factual claims against the code, decide yourself, and tell the owner whom you consulted and what you decided.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The full, self-contained question' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths the consultant should read' },
          consultant: { type: 'string', description: "Which one: its number in the owner's list (1 = first), a CLI (codex), words of a model, or cli/model[:effort] in full. Left out: the first that answers." },
          panel: { type: 'boolean', description: 'Ask every consultant on the list at once (six at most) and get every answer: for the heaviest decisions only' },
          private: { type: 'boolean', description: 'The question holds private or client data: free providers that keep data are skipped' },
        },
        required: ['question'],
      },
    })
    const effortEnum = { type: 'string', enum: [...EFFORT_WORDS] }
    const chiefProps = {
      goal: { type: 'string', description: "The chief's goal; it is set in that chat as /goal" },
      tier: { type: 'string', enum: [...TIER_IDS], description: "How hard the chief's job is: cok_zor, zor, orta or kolay. The plugin sets the chief's model and effort from the owner's Şef seviyeleri; a difficulty floor can lift it for video, edit, upwork and similar jobs. Wins over model and effort." },
      model: { type: 'string', description: "Only when you give no tier: the chief chat's model. Left out, the chief runs at the Orta tier." },
      effort: { ...effortEnum, description: "The chief chat's own effort" },
      work: { type: 'string', enum: [...WORK_MODES], description: "How the chief works: self = it does the job itself and starts no workers; delegate = it only splits the job and hands it to workers; either (default) = its own call for each piece. Yours (or the owner's) to decide per job." },
      check: { type: 'string', description: "A shell command that must exit 0 before this chief's DONE counts, run in its folder when it says DONE: the project's tests or build (\"npm test\"). Optional; an empty string takes it away. Without it The Chief still checks that every file the DONE names exists and that no agent of the chief still runs." },
      subagents: {
        type: 'object',
        description: "The chief's Claude subagents",
        properties: { model: { type: 'string' }, effort: effortEnum, max: { type: 'number', description: 'At most this many at once' } },
      },
      lanes: {
        type: 'array',
        description: 'The CLI agent lanes the chief may launch (its Squad)',
        items: { type: 'object', properties: { task: { type: 'string' }, cli: { type: 'string', enum: [...CLI_ORDER] }, model: { type: 'string' }, effort: effortEnum, count: { type: 'number' } }, required: ['cli'] },
      },
      handoff: { type: 'boolean', description: 'Automatic handoff for this chief (absent = on): false keeps it on its own chat however many compacts or hours it has, until you hand it over by hand.' },
      compact: { type: 'boolean', description: 'The 50-minute idle compact for this chief (absent = on): false leaves compacting to the size guard.' },
    }
    const chiefRef = { chief: { type: 'string', description: 'The chief: its project name or the first characters of its session id, as list_chiefs shows' } }
    await registerTool($, { name: 'list_chiefs', description: 'Leader of Chiefs: every chief chat you lead (goal, model, effort, settings, what its agents are doing, its last brief) and the open chats you could adopt.', inputSchema: { type: 'object', properties: {} } })
    await registerTool($, { name: 'create_chief', description: 'Leader of Chiefs: open a new chat as your chief, with its goal and, if you choose, its model, effort, subagents and CLI lanes, and its automatic handoff and idle compact.', inputSchema: { type: 'object', properties: { ...chiefProps, folder: { type: 'string', description: "The chief's working folder; this chat's when absent" }, title: { type: 'string', description: "The chat's title; a title you give is final, the plugin never renames it" }, link: { type: 'boolean', description: 'true: skip the app session and open the chief the older way (a boot turn of the claude CLI, else a /chief join link). Only after the app session route failed.' } }, required: ['goal'] } })
    await registerTool($, { name: 'adopt_chief', description: 'Leader of Chiefs: take an open chat (from list_chiefs) as your chief, optionally with settings.', inputSchema: { type: 'object', properties: { ...chiefRef, ...chiefProps }, required: ['chief'] } })
    await registerTool($, { name: 'configure_chief', description: "Leader of Chiefs: change a chief's goal, model, effort, subagents, CLI lanes, handoff or compact; only the fields you give change. An effort is read back from the chief's card and reported (a mismatch is re-applied once, then said plainly). stop: true stops the chief for good.", inputSchema: { type: 'object', properties: { ...chiefRef, ...chiefProps, clear_goal: { type: 'boolean', description: "End this chief's /goal loop now (the owner cannot). Do it when it keeps repeating itself (The Chief only reports a repeat, it never clears the goal for one) or its job is done." }, stop: { type: 'boolean', description: "true: stop this chief for good (its queued messages are emptied; nothing the plugin sends starts it again until you message it or give it a goal). false: let a stopped chief run again." } }, required: ['chief'] } })
    await registerTool($, { name: 'message_chief', description: "Leader of Chiefs: tell a chief something; it arrives in that chat as a message from you. chief = its short code, its session id (local_...), its name, or 'all' for every live chief. A Remote Control chat on another laptop (list_chiefs shows them under 'other machines') is reached by the id in brackets or its name. A stopped chief runs again when you message it.", inputSchema: { type: 'object', properties: { ...chiefRef, text: { type: 'string', description: 'The message for the chief (also accepted as message)' }, message: { type: 'string', description: 'Alias for text' } }, required: ['chief'] } })
    await registerTool($, { name: 'pin_chief', description: "Leader of Chiefs: pin or unpin a chief's chat in the sidebar (pinned: true/false), and turn its Remote Control on (remote_control: true) so it shows on the phone. chief 'all' = every chief, 'self' = your own chat. Do it whenever the owner asks to pin, unpin or put chats on Remote Control.", inputSchema: { type: 'object', properties: { chief: { type: 'string', description: "A chief as list_chiefs shows it, 'all' or 'self'" }, pinned: { type: 'boolean', description: 'Default true' }, remote_control: { type: 'boolean' } }, required: ['chief'] } })
    await registerTool($, { name: 'release_chief', description: 'Leader of Chiefs: let a chief go; its chat runs on its own again.', inputSchema: { type: 'object', properties: chiefRef, required: ['chief'] } })
    await registerTool($, { name: 'create_goal', description: 'Add a goal to the shared goal list; optionally make it the main goal or hand it to a chief.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, main: { type: 'boolean' }, chief: { type: 'string', description: 'Give it to this chief as its goal' } }, required: ['text'] } })
    await registerTool($, { name: 'edit_goal', description: 'Change a goal: its words, its status (open, active, done), or make it the main goal.', inputSchema: { type: 'object', properties: { goal: { type: 'string', description: 'Its id, its number in the list (1 = first) or words from it' }, text: { type: 'string' }, status: { type: 'string', enum: ['open', 'active', 'done'] }, main: { type: 'boolean' } }, required: ['goal'] } })
    await registerTool($, { name: 'set_main_goal', description: "Set the Leader's main goal (an existing goal by id, number or words, or new words to add).", inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } })
}

/** Every orchestrator tool as registered, so a lost registration can be redone without a new session. */
const toolSpecs = new Map<string, Parameters<$T['tool']['register']>[0]>()
const toolFailed = new Set<string>()
let toolsSeenListed = false
/** When tools were last registered; a registration the host dropped (a directory change, a reconnect) is redone by the next turn or the keepalive. */
let toolsRegisteredAt = 0

/** Registers one orchestrator tool; a session that takes no tools (e.g. `--tools ""`) still gets the rest of The Chief. */
async function registerTool($: $T, spec: Parameters<$T['tool']['register']>[0]) {
  toolSpecs.set(spec.name, spec)
  try {
    toolsRegisteredAt = Date.now()
    await $.tool.register(spec)
    toolFailed.delete(spec.name)
  } catch {
    toolFailed.add(spec.name) // retried by keepTools, never lost for good
  }
}

/** Names the tools must have in a session's tool list to count as connected. */
export function missingTools(registered: string[], listed: string[]): string[] {
  return registered.filter(n => !listed.some(l => l === n || l.endsWith(`__${n}`)))
}

/**
 * Keepalive: every 30 s, redo a registration that failed, and every 5 min, once this session's list has shown our tools,
 * any that went missing (a reload or reconnect dropped them), so the tools never stay gone until a restart.
 */
let keepRound = 0
async function keepTools($: $T, turnEnd = false) {
  if (toolSpecs.size === 0) return
  let redo = [...toolFailed]
  if (!turnEnd) keepRound++
  if (!turnEnd && redo.length === 0 && keepRound % 4 !== 0) return // a failed one is retried every 30 s, the rest every 2 min
  // a list that cannot prove our tools: all are registered again at most every 30 minutes (each time replaces the set)
  const blind = () => (Date.now() - toolsRegisteredAt < 30 * 60000 ? [] : [...toolSpecs.keys()])
  try {
    const listed = (await $.tool.list()).map(t => t.name)
    const missing = missingTools([...toolSpecs.keys()], listed)
    if (missing.length < toolSpecs.size) toolsSeenListed = true
    if (toolsSeenListed) redo = [...new Set([...redo, ...missing])]
    else redo = [...new Set([...redo, ...blind()])]
  } catch {
    redo = [...new Set([...redo, ...blind()])] // no list at all: the same
  }
  for (const name of redo) {
    const spec = toolSpecs.get(name)
    if (!spec) continue
    try {
      await $.tool.register(spec)
      toolFailed.delete(name)
    } catch {
      toolFailed.add(name)
    }
  }
}

/** Marks where today starts in this session's messages, once a day; a session first seen today counts from its start. */
async function stampDay($: $T) {
  try {
    const today = dayKey(await $.clock.now())
    if (dayStamps[today] !== undefined) return
    const known = Object.keys(dayStamps).length > 0
    dayStamps = { ...dayStamps, [today]: known ? (await $.session.messages()).length : 0 }
    await storeSet($, `dayStamps:${sid}`, dayStamps)
  } catch {
    // without a stamp, today reads from the session's start
  }
}

/** Local midnight of a day key (YYYY-MM-DD). */
const dayStart = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d!).getTime()
}

export function overviewMaterial(goal: string | null, ws: readonly SquadWorker[], ss: readonly SquadSub[], notes: readonly string[]): string {
  const parts: string[] = []
  if (goal) parts.push(`Goal: ${goal}`)
  for (const w of ws) {
    parts.push(`CLI agent ${w.name} (${CLIS[w.cli].label} ${w.model}${w.effort ? ` ${w.effort}` : ''}) - ${w.status}${w.exitCode !== null ? `, exit ${w.exitCode}` : ''}. Brief: ${w.brief}. Files: ${w.files.join(', ') || 'none seen'}. Last output:\n${w.tail.slice(-10).join('\n') || '(none)'}`)
  }
  for (const s of ss) {
    parts.push(`Claude subagent "${s.description}" (${s.type}, ${shortModel(s.model)}) - ${s.status}, ${s.tools} steps. Files: ${s.files.join(', ') || 'none'}. ${s.result ? `Answer:\n${s.result.slice(0, 700)}` : `Recent: ${s.steps.slice(-4).join(' | ')}`}`)
  }
  if (notes.length) parts.push(`Latest orchestrator messages:\n${notes.join('\n---\n')}`)
  return parts.join('\n\n') || 'Nothing has run yet.'
}

type $T = EngineInterface

let cwd = ''
/** Stops a running agent's process, by worker id. */
const stoppers = new Map<string, () => void>()
/** How many output lines of one run are kept for its log file. */
const FULL_LOG_LINES = 5000
/** The tail length each worker had when its "now" line was last written. */
const nowAt = new Map<string, number>()
/** A status line is being written; the others wait for the next minute. */
let nowBusy = false
let nowRound = 0

type OverviewScope = 'today' | 'session'
type SpawnRequest = { name: string; cli: SquadCli; model: string; effort: number; brief: string; dir?: string; spec?: SpawnSpec; route?: { tier: string; isPrivate: boolean } }
type Job =
  | { kind: 'spawn'; request: SpawnRequest }
  | { kind: 'followup'; id: string; text: string }
  | { kind: 'overview'; report: SquadReport['kind']; day?: string; scope?: OverviewScope }
  | { kind: 'now'; id: string }
  | { kind: 'submit'; text: string; asUser?: boolean }
  | { kind: 'live-setup' }
  | { kind: 'local-setup' }
  | { kind: 'setup' }
  | { kind: 'context-guard' }
  | { kind: 'goal'; text: string }
  | { kind: 'consult'; question: string; panel?: boolean }
  | { kind: 'logins' }
  | { kind: 'health'; force?: boolean }
  | { kind: 'done-check'; line: string; ok: string[] }
  | { kind: 'login'; cli: SquadCli }
  | { kind: 'handoff' }
  | { kind: 'know' }
/** Every message The Chief writes into this chat passes here: one per 30 s, never the same text twice in 10 min, at most 20 an hour, and none after /chief quiet. */
let quiet = false
const sentLog: { at: number; text: string }[] = []
let fuseToldAt = 0
async function submitGuarded($: $T, text: string, asUser = true) {
  if (quiet) return
  const now = await $.clock.now()
  while (sentLog.length && now - sentLog[0]!.at > 3600000) sentLog.shift()
  const last = sentLog[sentLog.length - 1]
  const same = sentLog.some(x => x.text === text && now - x.at < 600000)
  if (same || (last && now - last.at < 30000) || sentLog.length >= 20) {
    if (sentLog.length >= 20 && now - fuseToldAt > 600000) {
      fuseToldAt = now
      $.ui.toast(L('The Chief: wrote 20 messages this hour, pausing. /chief quiet turns it off completely.', 'The Chief: bu saat 20 mesaj yazdı, duruyor. /chief quiet ile tamamen kapatabilirsin.'))
    }
    // a skipped message is kept as a quiet line, so nothing is lost
    if (!same) $.ui.log(`The Chief (${L('held', 'bekletildi')}): ${oneLine(text, 300)}`)
    return
  }
  sentLog.push({ at: now, text })
  // Remote Control shows the transcript's messages only (no band, status line or dim line, 26.10): the crew rides along
  const crew = await syncCrewStatus($).catch(() => '')
  const body = crew && !text.includes(crew) ? `${text}\n${crew}` : text
  await (asUser ? $.prompt.submit({ text: body, asUser: true }) : $.prompt.submit({ text: body }))
}

/** Jobs wait here for the session.start loop, whose `$` outlives a single click, tool call or turn. */
const queue: Job[] = []
let wake: (() => void) | null = null
function enqueue(job: Job) {
  if (job.kind === 'overview' && queue.some(j => j.kind === 'overview' && j.report === job.report && j.day === job.day && j.scope === job.scope)) return
  queue.push(job)
  wake?.()
}

async function save($: $T, key: 'lanes' | 'goals', value: unknown) {
  try {
    await storeSet($, key, value)
  } catch {
    // keeping the pane working matters more than persisting one edit
  }
}

async function mutateLanes($: $T, fn: (list: SquadLane[]) => SquadLane[]) {
  await update($, lanes, list => fn([...(list ?? [])]))
  await save($, 'lanes', (await $.state.get(LANES)).value ?? [])
}

async function mutateGoals($: $T, fn: (list: SquadGoal[]) => SquadGoal[]) {
  await update($, goals, list => fn([...(list ?? [])]))
  await save($, 'goals', (await $.state.get(GOALS)).value ?? [])
}

const patchLane = ($: $T, id: string, p: Partial<SquadLane>) =>
  mutateLanes($, list => list.map(l => (l.id === id ? { ...l, ...p } : l)))

const patchWorker = ($: $T, id: string, fn: (w: SquadWorker) => SquadWorker) =>
  update($, workers, list => (list ?? []).map(w => (w.id === id ? fn(w) : w)))

const patchSub = ($: $T, id: string, fn: (s: SquadSub) => SquadSub) =>
  update($, subs, list => (list ?? []).map(s => (s.id === id ? fn(s) : s)))

async function activeGoal($: $T): Promise<string | null> {
  const { value = [] } = await $.state.get(GOALS)
  return value.find(g => g.status === 'active')?.text ?? null
}

async function anyRunning($: $T): Promise<boolean> {
  const { value: ws = [] } = await $.state.get(WORKERS)
  const { value: ss = [] } = await $.state.get(SUBS)
  return ws.some(w => w.status === 'running' || w.status === 'queued') || ss.some(s => s.status === 'running')
}

/** After an agent ends: a queued one may start now. */
async function afterEndDrain($: $T, freed = true) {
  freeSeen = null
  if (launchQueue.length > 0) await drainQueue($)
  // a worker ended for good: the next lined-up brief starts now, not when the chief's next turn gets to it
  if (freed) await startBacklog($, true).catch(() => undefined)
}


/**
 * Automatic and nightly overviews nobody has opened yet. Each is a Sonnet call over the conversation, so outside a
 * chief (whose leader reads its brief) it is written the moment the Overview tab is opened: the same window, the
 * same material (the day's messages are stamped), never a call for a report no one reads.
 */
let pendingOverviews: Extract<Job, { kind: 'overview' }>[] = []
async function wantOverview($: $T, job: Extract<Job, { kind: 'overview' }>) {
  if (role === 'chief') return enqueue(job)
  if (pendingOverviews.some(j => j.report === job.report && j.day === job.day)) return
  pendingOverviews = [...pendingOverviews, job]
  await storeSet($, `pendingOverviews:${sid}`, pendingOverviews)
}
/** Writes the waiting overviews; called when the Overview tab shows. */
function takePendingOverviews($: $T) {
  if (pendingOverviews.length === 0) return
  const jobs = pendingOverviews
  pendingOverviews = []
  void storeSet($, `pendingOverviews:${sid}`, []).catch(() => undefined)
  for (const j of jobs) enqueue(j)
}

/** Finds an agent by id or by name (case-insensitive), workers first. */
async function findAgent($: $T, key: string): Promise<{ worker?: SquadWorker; sub?: SquadSub; ambiguous?: string[] }> {
  const k = key.trim().toLowerCase()
  const { value: ws = [] } = await $.state.get(WORKERS)
  const { value: ss = [] } = await $.state.get(SUBS)
  // an id is exact; a name must fit exactly one agent, or it is refused (it could hit the wrong one)
  const byId = ws.find(w => w.id === key.trim())
  if (byId) return { worker: byId }
  const subById = ss.find(s => s.id === key.trim())
  if (subById) return { sub: subById }
  const named = ws.filter(w => w.name.toLowerCase() === k)
  const subNamed = ss.filter(s => s.description.toLowerCase() === k)
  if (named.length + subNamed.length > 1) return { ambiguous: [...named.map(w => `${w.name} (id ${w.id}, ${w.status})`), ...subNamed.map(s => `"${s.description}" (id ${s.id}, ${s.status})`)] }
  if (named[0]) return { worker: named[0] }
  return subNamed[0] ? { sub: subNamed[0] } : {}
}

async function stopAgent($: $T, key: string): Promise<string> {
  const { worker, sub, ambiguous } = await findAgent($, key)
  if (ambiguous) return `"${key}" fits more than one agent; stop it by id: ${ambiguous.join('; ')}`
  if (worker) {
    if (worker.status === 'queued') {
      const at = launchQueue.findIndex(q => q.workerId === worker.id)
      if (at >= 0) launchQueue.splice(at, 1)
      await patchWorker($, worker.id, w => ({ ...w, status: 'stopped', endedAt: w.startedAt, now: L('Removed from the queue', 'Sıradan çıkarıldı') }))
      return `${worker.name} taken off the queue.`
    }
    if (fixPending.delete(worker.id)) {
      await patchWorker($, worker.id, w => ({ ...w, now: L('Automatic retry cancelled', 'Otomatik yeniden deneme iptal edildi') }))
      return `${worker.name} is not running (${worker.status}); its pending automatic retry is cancelled.`
    }
    if (worker.status !== 'running') return `${worker.name} is not running (${worker.status}).`
    await patchWorker($, worker.id, w => ({ ...w, status: 'stopped' }))
    await stopChildRun($, worker)
    const rec = runs.get(worker.id)
    if (rec) {
      await killRun($, rec)
      runs.delete(worker.id)
      await saveRuns($)
      await releaseLocks($, worker)
      await patchWorker($, worker.id, w => ({ ...w, endedAt: w.endedAt ?? Date.now() }))
    }
    return `Stopped ${worker.name}.`
  }
  if (sub) {
    if (sub.status !== 'running') return `"${sub.description}" is not running (${sub.status}).`
    if (!sub.turnId) return `"${sub.description}" cannot be stopped from here yet; use TaskStop on it.`
    await $.turn.abort({ turnId: sub.turnId })
    await patchSub($, sub.id, s => ({ ...s, status: 'stopped', endedAt: s.endedAt }))
    return `Stopped "${sub.description}".`
  }
  return `No agent named ${key}.`
}

/** A message queued on a running worker: kept in its record, in arrival order. */
export const queueMessage = (w: SquadWorker, text: string): SquadWorker => ({ ...w, pendingMessages: [...(w.pendingMessages ?? []), text] })
/** The queued messages as one turn, in the order they came; '' when nothing waits. */
export const queuedTurn = (msgs: readonly string[] | undefined): string => (msgs ?? []).map(t => t.trim()).filter(Boolean).join('\n\n')
/** How a message reached an agent, in the words the tool answer uses: only a running OpenCode task can take it mid-turn; every other launch here is one-shot, so its message is queued. */
export const messageMode = (w: Pick<SquadWorker, 'name' | 'cli' | 'sessionId'>, mode: 'queued' | 'finished'): string =>
  mode === 'queued'
    ? `${w.name}: queued: will be sent as the next continue turn (this CLI cannot take a message mid-turn as it is launched here)`
    : w.sessionId
      ? `${w.name}: finished agent: resumed same session`
      : `${w.name}: finished agent: new run with brief+last output (this CLI has no session resume)`
/** The answer for a message the running turn itself read. */
export const liveMode = (name: string): string => `${name}: delivered mid-run (live): the worker reads it on its next step`
/** The answer when the live attempt did not land: the message waits for the next turn instead, and the reason is said. */
export const queuedAfterLive = (w: Pick<SquadWorker, 'name' | 'cli' | 'sessionId'>, reason: string): string => `${messageMode(w, 'queued')} (live delivery failed: ${reason})`
/**
 * The OpenCode prompt body with cmd's metacharacters (and every non-ASCII character: the console uses an OEM
 * codepage, a Turkish ı would arrive as ?) written as JSON \u escapes. Each OpenCode call goes through cmd.exe
 * (the npm shim runs the line again), where & | < > split the argument and ^ disappears (measured 30.10).
 */
export const steerPayload = (text: string): string =>
  JSON.stringify({ text, delivery: 'steer' }).replace(/[&|<>^%]|[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
/** The call that puts a message into a RUNNING OpenCode turn: its own API server, found through the worker's XDG_DATA_HOME. */
export const liveSteerArgv = (id: string, text: string): string[] =>
  shim(['opencode', 'api', 'post', `/api/session/${id}/prompt`, '--data', steerPayload(text)])
/** The session id a run has printed so far, before its end: the run record keeps its output file. */
async function runSessionId($: $T, workerId: string): Promise<string | null> {
  const rec = runs.get(workerId)
  if (!rec) return null
  const out = await readText($, rec.out).catch(() => '')
  return out ? opencodeSession(out.split(/\r?\n/)) : null
}
/**
 * Delivers text into a running OpenCode turn, or says in one short line why it could not (the caller then queues it).
 * Proved on 30.10 with a real run: the worker wrote steer.txt mid-turn, then its own out.txt, and exited 0 once.
 */
export async function liveSteer($: $T, worker: Pick<SquadWorker, 'id' | 'cli' | 'sessionId' | 'env'>, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!worker.cli.startsWith('opencode')) return { ok: false, reason: `${worker.cli} is launched one-shot here` }
  const id = worker.sessionId ?? (await runSessionId($, worker.id))
  if (!id) return { ok: false, reason: 'no session id yet' }
  if (isWindows() && steerPayload(text).length > 7000) return { ok: false, reason: 'message too long for the OpenCode command line' }
  try {
    const r = await $.process.run(liveSteerArgv(id, text), {
      env: { ...WORKER_ENV, ...envFor(worker.cli), ...(worker.env ?? {}) },
      stdin: '',
      timeoutMs: 20000,
    })
    // the route answers with the admitted message, delivery steer; anything else never reached the running turn
    if (r.exitCode === 0 && /"delivery"\s*:\s*"steer"/.test(r.stdout)) return { ok: true }
    return { ok: false, reason: oneLine(r.stderr || r.stdout, 80) || `exit ${r.exitCode}` }
  } catch (err) {
    return { ok: false, reason: oneLine(err instanceof Error ? err.message : String(err), 80) || 'the call failed' }
  }
}

async function messageAgent($: $T, key: string, text: string): Promise<string> {
  const { worker, sub } = await findAgent($, key)
  if (worker) {
    // a running worker never gets a second process: a live OpenCode turn reads it now, everything else waits in its record
    if (worker.status === 'running' || worker.status === 'queued') {
      if (worker.status === 'running') {
        const live = await liveSteer($, worker, text)
        if (live.ok) return liveMode(worker.name)
        await patchWorker($, worker.id, w => queueMessage(w, text))
        return queuedAfterLive(worker, live.reason)
      }
      await patchWorker($, worker.id, w => queueMessage(w, text))
      return messageMode(worker, 'queued')
    }
    enqueue({ kind: 'followup', id: worker.id, text })
    return messageMode(worker, 'finished')
  }
  if (sub) {
    await submitGuarded($, `Send this follow-up to your subagent "${sub.description}" (agent id ${sub.id}) with SendMessage, then report back:\n${text}`)
    return `Asked the orchestrator to message "${sub.description}".`
  }
  return `No agent named ${key}.`
}

/** Plans a launch; from a command the prompt goes through the job loop, after the command's own turn. */
async function launch($: $T, ids: readonly string[] | null, fromCommand = false) {
  const { value = [] } = await $.state.get(LANES)
  const pick = ids ? value.filter(l => ids.includes(l.id)) : value
  const ready = pick.filter(l => l.count > 0 && l.task.trim() !== '')
  if (ready.length === 0) {
    $.ui.toast('Give the lane a task first')
    return
  }
  const total = ready.reduce((s, l) => s + l.count, 0)
  await $.state.set(TAB, 'agents')
  $.ui.toast(`Squad: planning ${plural(total, 'agent')}`)
  const text = planText(ready, await activeGoal($))
  if (fromCommand) enqueue({ kind: 'submit', text })
  else await submitGuarded($, text)
}

/**
 * A goal reaches a chat as a plain message, never as the host's /goal: that command re-prompts the chat after every turn
 * until its condition holds, and a job only the owner or a file can finish loops forever (and the owner cannot close it).
 */
/** The standing rule every chief's goal carries. */
export const CHIEF_RULE = 'RULE (The Chief): you are the chief, you do not write code yourself; you split the work and hand it out. For every job run sub-agents of every CLI in parallel and continuously with spawn_worker (tier by difficulty), keep several running at once, line up the next briefs with spawn_worker queue:true (each starts by itself the moment a worker ends, so no slot waits for your turn), then check their results. Never push to a git remote unless the owner asked for it. Never start an agent CLI (opencode, qodercli, codex, devin…) from a shell, and do not open sub-agents with the Agent tool of Claude: give the work to mcp__the-chief__spawn_worker with a tier (kolay/orta/zor/cok_zor), so the Qoder, Longcat and DeepSeek routes run and the output stays readable with agent_output. For the person\'s real Chrome use the Tab Bridge that The Chief installs (tb.js and start-bridge.ps1; the folder is in every worker prompt and in the message you get when you try Claude in Chrome), never Claude in Chrome. Do not do code work yourself: give it to a DeepSeek v4.1 flash worker (spawn_worker); if a worker will not start, tell the leader at once.'
/** How a chief gets its job done: by itself, by handing it out, or its own call per piece. The leader (work on create_chief / configure_chief) or the owner (chief_work) says which. */
export const WORK_MODES = ['either', 'self', 'delegate'] as const
export type WorkMode = (typeof WORK_MODES)[number]
const CHIEF_COMMON = "Never push to a git remote unless the owner asked for it. Never start an agent CLI (opencode, qodercli, codex, devin…) from a shell: work you hand out goes to mcp__the-chief__spawn_worker with a tier (kolay/orta/zor/cok_zor), so the routes run and the output stays readable with agent_output; when you need a worker's answer to go on, start it with wait:true and the call returns its report like a subagent's. For the person's real Chrome use the Tab Bridge that The Chief installs (tb.js and start-bridge.ps1; the folder is in every worker prompt and in the message you get when you try Claude in Chrome), never Claude in Chrome."
/** The standing rule a chief gets with its goal, by work mode (delegate is the rule every chief had before 1.43.9). */
export function chiefRule(work?: string): string {
  const mode = (WORK_MODES as readonly string[]).includes(work ?? '') ? work : (WORK_MODES as readonly string[]).includes(opt('chief_work')) ? opt('chief_work') : 'either'
  if (mode === 'delegate') return CHIEF_RULE
  if (mode === 'self') return `RULE (The Chief): you are the chief and you do this job yourself, in this chat. Do not start workers or sub-agents for it unless the leader or the owner asks. ${CHIEF_COMMON}`
  return `RULE (The Chief): you are the chief; how each piece gets done is your call. Do it yourself when it is small, leans on this chat's context or is faster that way; hand pieces that stand on their own to workers (spawn_worker, tier by difficulty), several at once when they do not touch the same files, and check what they return. ${CHIEF_COMMON}`
}
/** A chief's goal message: the goal, the DONE protocol and the standing rule. */
export const chiefGoalMessage = (text: string, work?: string) => `${goalMessage(text)}

${chiefRule(work)}`

export function goalMessage(text: string): string {
  return `Goal: ${text}

Work on it until it is done, then end that turn with one line: DONE: <what is done, where>. If you are blocked or waiting for something, say so in one line and stop: nobody re-prompts you, and the leader hears it.`
}

/** Where a goal starts: a brand-new session (desktop app or a new terminal tab), or this one. */
async function startGoal($: $T, goal: SquadGoal, where: 'new' | 'here', surface: string) {
  await mutateGoals($, list => list.map(g => (g.id === goal.id ? { ...g, status: 'active' } : g.status === 'active' ? { ...g, status: 'open' } : g)))
  const prompt = goalMessage(goal.text)
  if (where === 'new') {
    try {
      if (surface === 'terminal') {
        // a new terminal (a Windows Terminal tab, a Terminal.app window), a fresh claude with the goal as its first prompt
        await $.process.run(newClaudeArgv(prompt, cwd, await platformNow($)), { timeoutMs: 15000 })
      } else {
        // the desktop app's own deep link opens a new Code session with the prompt ready
        const url = `claude://code/new?q=${encodeURIComponent(prompt)}${cwd ? `&folder=${encodeURIComponent(cwd)}` : ''}`
        await $.process.run(openArgv(url, await platformNow($)), { timeoutMs: 15000 })
      }
      $.ui.toast(L('Opening a new session: ', 'Yeni oturum açılıyor: ') + prompt.slice(0, 60))
      return
    } catch {
      $.ui.toast(L('Could not open a new session; loading the goal into this one', 'Yeni oturum açılamadı; hedef bu oturuma yükleniyor'))
    }
  }
  enqueue({ kind: 'submit', text: prompt })
  $.ui.toast(L('Goal loaded into this session', 'Hedef bu oturuma yüklendi'))
}

async function makeOverview($: $T, kind: SquadReport['kind'], day?: string, scope: OverviewScope = 'today') {
  await $.state.set(SUMMARIZING, true)
  const { value: ws = [] } = await $.state.get(WORKERS)
  const { value: ss = [] } = await $.state.get(SUBS)
  const { value: old = [] } = await $.state.get(REPORTS)
  const now = await $.clock.now()
  const forDay = day ?? dayKey(now)
  // the window: today from midnight, or the whole session
  const from = scope === 'session' ? 0 : dayStart(forDay)
  const to = scope === 'session' ? now : Math.min(now, dayStart(forDay) + 86400000)
  const inWindow = (start: number, end: number | null) => start < to && (end ?? now) >= from
  let talk = '(the conversation could not be read)'
  try {
    const msgs = await $.session.messages()
    const next = dayKey(dayStart(forDay) + 36 * 3600000)
    const first = scope === 'session' ? 0 : Math.min(dayStamps[forDay] ?? 0, msgs.length)
    const last = scope === 'session' ? msgs.length : Math.min(dayStamps[next] ?? msgs.length, msgs.length)
    talk = conversationDigest(msgs.slice(first, last))
  } catch {
    // the agents alone still give a brief
  }
  let agents = overviewMaterial(await activeGoal($), ws.filter(w => inWindow(w.startedAt, w.endedAt)), ss.filter(x => inWindow(x.startedAt, x.endedAt)), [])
  if (role === 'leader') {
    await readCards($)
    const chiefs = hqCards.filter(c => c.role === 'chief' && c.leader === sid)
    const heard = leaderLog.filter(x => x.at >= from && x.at < to)
    agents = [
      `This chat is the Leader of Chiefs${(await mainGoalText($)) ? `; main goal: ${await mainGoalText($)}` : ''}. Its chiefs are whole chats, each leading its own agents; brief on the chiefs' progress, chief by chief where it matters.`,
      ...chiefs.map(c => `Chief ${c.title} · goal: ${c.goal || 'none'} · ${c.working} agents working${c.agents.length ? ` · now: ${c.agents.map(a => `${a.name}: ${a.now}`).join(' | ')}` : ''}${c.brief ? `\n  its own last brief: ${oneLine(c.brief, 500)}` : ''}`),
      heard.length ? `What the chiefs reported:\n${heard.slice(-60).map(x => `[${timeOf(x.at)}] ${x.title}: ${x.line}`).join('\n')}` : '',
      `This chat's own agents:\n${agents}`,
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  const material = `Window: ${scope === 'session' ? 'the whole session' : `${forDay} 00:00 to ${to === now ? timeOf(now) : '24:00'}`}\n\nConversation (owner and Claude):\n${talk}\n\nAgents that ran:\n${agents}`
  let text: string
  try {
    const res = await $.model.complete({ model: SUMMARY_MODEL, system: overviewSystem(), prompt: material, maxTokens: 900, effort: 'low' })
    text = res.isAnswered ? res.text : L(`Could not get a summary (${res.reason}).`, `Özet alınamadı (${res.reason}).`)
  } catch (err) {
    text = L(`Could not get a summary: ${err instanceof Error ? err.message : String(err)}.`, `Özet alınamadı: ${err instanceof Error ? err.message : String(err)}.`)
  }
  const report: SquadReport & { sid: string } = { id: newId(), at: now, day: forDay, kind, scope, text, sid }
  await update($, reports, list => [...(list ?? []), report])
  await $.state.set(OPEN_REPORT, null)
  await $.state.set(SUMMARIZING, false)
  try {
    await storeSet($, 'reports', (await $.state.get(REPORTS)).value ?? [])
  } catch {
    // the report still shows for this session
  }
  $.ui.toast(kind === 'daily' ? L(`End-of-day summary ready: /overview`, `Gün sonu özeti hazır: /overview`) : L('Summary ready: /overview', 'Özet hazır: /overview'))
}

/** Deletes one overview, here and in the saved history. */
async function removeReport($: $T, id: string) {
  await update($, reports, list => (list ?? []).filter(r => r.id !== id))
  try {
    await storeSet($, 'reports', (await $.state.get(REPORTS)).value ?? [])
  } catch {
    // gone from this session at least
  }
}

/** Writes the day's summary once it is late enough, and yesterday's if a busy day went without one. */
/** The nightly and next-day automatic overviews are off (each is a model call); /overview and the tab's buttons still write one on request. */
export const AUTO_OVERVIEW = false
async function dailyCheck($: $T) {
  if (!AUTO_OVERVIEW) return
  const now = await $.clock.now()
  const { value: list = [] } = await $.state.get(REPORTS)
  const has = (day: string) => list.some(r => r.day === day && r.kind === 'daily')
  const today = dayKey(now)
  const yesterday = dayKey(now - 86400000)
  if (new Date(now).getHours() >= DAILY_HOUR && !has(today)) await wantOverview($, { kind: 'overview', report: 'daily', day: today })
  if (!has(yesterday) && list.some(r => r.day === yesterday)) await wantOverview($, { kind: 'overview', report: 'daily', day: yesterday })
}

// ---------- the "now" line: agent events first (free); a local model only if one already runs ----------
/** When a model last wrote each worker's line: an event step does not overwrite it for two minutes. */
const modelLineAt = new Map<string, number>()
/** Structured output: the grammar holds the shape, the model only fills it. */
const STATUS_SCHEMA = { type: 'object', properties: { state: { type: 'string', enum: ['working', 'waiting', 'error', 'stalled', 'done'] }, line: { type: 'string' } }, required: ['state', 'line'] }
/** auto: events and rules, plus a local model if one is already running; rules: never a model; haiku: Haiku when events say nothing. */
/** True when the local model is already on this computer. */
let localReady = false
/** auto: a local model (set up only when asked); rules: never a model; haiku: Haiku. Unset: the local model only if it is already here. */
const summaryEngine = () => {
  const v = opt('summary_engine')
  if (v === 'rules' || v === 'off') return 'rules'
  if (v === 'haiku') return 'haiku'
  if (v === 'ask' || !v) return localReady ? 'auto' : 'rules'
  return 'auto'
}

/** The small models The Chief sets up by itself: one GGUF file each, run by llama.cpp. Both write Turkish and English. */
const LOCAL_MODELS = {
  'qwen3.5-2b': { label: 'Qwen3.5 2B', file: 'Qwen3.5-2B-Q4_K_M.gguf', url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf', mb: 1281 },
  'qwen3.5-0.8b': { label: 'Qwen3.5 0.8B', file: 'Qwen3.5-0.8B-Q4_K_M.gguf', url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf', mb: 533 },
} as const
const localModel = () => LOCAL_MODELS[/0\.8/.test(opt('local_model')) ? 'qwen3.5-0.8b' : 'qwen3.5-2b']
/** The Chief's own llama.cpp server, away from the ports other local servers take. */
const OWN_PORT = 18765
const OWN_BASE = `http://127.0.0.1:${OWN_PORT}`

type LocalServer = { kind: 'own' | 'ollama' | 'openai'; base: string; model: string; label: string }
let localSeen: { at: number; server: LocalServer | null } | null = null

async function answers($: $T, url: string) {
  try {
    const res = await $.http.fetch(url)
    return res.ok ? res.text : null
  } catch {
    return null
  }
}

/** The local model server to use: The Chief's own, else one already running (Ollama, LM Studio, llama.cpp); checked once a minute. */
async function localServer($: $T): Promise<LocalServer | null> {
  const now = await $.clock.now()
  if (localSeen && now - localSeen.at < 60000) return localSeen.server
  let server: LocalServer | null = null
  if (await answers($, `${OWN_BASE}/health`)) server = { kind: 'own', base: OWN_BASE, model: localModel().file, label: `The Chief · ${localModel().label}${ownDevice ? ` · ${ownDevice}` : ''}` }
  if (!server) {
    const tags = await answers($, 'http://localhost:11434/api/tags')
    const names = tags ? ((JSON.parse(tags) as { models?: { name?: string }[] }).models ?? []).map(m => m.name ?? '').filter(Boolean) : []
    const pick = names.find(n => /qwen3\.5/i.test(n)) || names.find(n => /gemma4|lfm|phi4|llama3\.2|granite/i.test(n)) || names[0]
    if (pick) server = { kind: 'ollama', base: 'http://localhost:11434', model: pick, label: `Ollama · ${pick}` }
  }
  for (const [base, label] of [['http://localhost:1234', 'LM Studio'], ['http://localhost:8080', 'llama.cpp']] as const) {
    if (server) break
    const body = await answers($, `${base}/v1/models`)
    const ids = body ? ((JSON.parse(body) as { data?: { id?: string }[] }).data ?? []).map(m => m.id ?? '').filter(Boolean) : []
    if (ids[0]) server = { kind: 'openai', base, model: ids[0], label: `${label} · ${ids[0]}` }
  }
  localSeen = { at: now, server }
  return server
}

type LocalSetup = { step: string; isBusy: boolean; isDone: boolean }
let localSetup: LocalSetup = { step: '', isBusy: false, isDone: false }

/** Where the engine and the model live: the user's own folders, nothing system-wide. */
async function llmDir($: $T) {
  return isWindows() ? `${(await $.env.get('LOCALAPPDATA')) ?? ''}\\the-chief\\llm` : `${(await $.env.get('HOME')) ?? '.'}/.the-chief/llm`
}
const join = (...parts: string[]) => parts.join(isWindows() ? '\\' : '/')

/** Runs a long command (a download) with no time limit, reporting the last percentage it prints. */
async function runLong($: $T, argv: string[], onPct: (pct: string) => Promise<void>) {
  const run = $.process.spawn({ argv })
  let shown = ''
  let beat = 0
  for await (const chunk of run) {
    const pct = chunk.text.match(/\d{1,3}(?:[.,]\d)?%/g)?.pop()
    const now = await $.clock.now()
    if (pct && pct !== shown && now - beat > 2000) {
      shown = pct
      beat = now
      await onPct(pct)
    }
  }
  return (await run.result).code === 0
}

/** The llama.cpp build for this computer: CPU-only, about 20 MB, from its GitHub releases. */
async function llamaAsset($: $T): Promise<string> {
  let os = 'win'
  let arch = ((await $.env.get('PROCESSOR_ARCHITECTURE')) ?? '').toUpperCase() === 'ARM64' ? 'arm64' : 'x64'
  if (!isWindows()) {
    const uname = (await $.process.run(['uname', '-sm'])).stdout.trim()
    os = uname.startsWith('Darwin') ? 'macos' : 'ubuntu'
    arch = /arm64|aarch64/.test(uname) ? 'arm64' : 'x64'
  }
  const want = os === 'win' ? new RegExp(`bin-win-cpu-${arch}\\.zip$`) : new RegExp(`bin-${os}-${arch}\\.tar\\.gz$`)
  const res = await $.http.fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=5', { headers: { accept: 'application/vnd.github+json' } })
  for (const release of JSON.parse(res.text) as { assets?: { name: string; browser_download_url: string }[] }[]) {
    const asset = release.assets?.find(a => want.test(a.name))
    if (asset) return asset.browser_download_url
  }
  throw new Error('no llama.cpp build for this computer')
}

/** The Vulkan build (about 33 MB): the same server, able to run the model on a discrete GPU. */
async function vulkanAsset($: $T): Promise<string | null> {
  if (!isWindows()) {
    const uname = (await $.process.run(['uname', '-sm'])).stdout.trim()
    if (uname.startsWith('Darwin') || !/x86_64|amd64/.test(uname)) return null // Metal is built in on a Mac
  }
  const want = isWindows() ? /bin-win-vulkan-x64\.zip$/ : /bin-ubuntu-vulkan-x64\.tar\.gz$/
  const res = await $.http.fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=5', { headers: { accept: 'application/vnd.github+json' } })
  for (const release of JSON.parse(res.text) as { assets?: { name: string; browser_download_url: string }[] }[]) {
    const asset = release.assets?.find(a => want.test(a.name))
    if (asset) return asset.browser_download_url
  }
  return null
}

const vulkanExe = (dir: string) => join(dir, 'bin-vulkan', isWindows() ? 'llama-server.exe' : 'llama-server')

/** Fetches the Vulkan build once, beside the CPU one; without it the model simply stays on the CPU. */
async function ensureVulkan($: $T, dir: string) {
  if (opt('local_device') === 'cpu' || (await $.fs.exists(vulkanExe(dir)))) return
  try {
    const url = await vulkanAsset($)
    if (!url) return
    const archive = join(dir, isWindows() ? 'vulkan.zip' : 'vulkan.tar.gz')
    await $.fs.write(join(dir, 'bin-vulkan', '.keep'), '')
    if (!(await runLong($, [isWindows() ? 'curl.exe' : 'curl', '-fL', '--retry', '3', '--progress-bar', '-o', archive, url], async () => undefined))) return
    const tar = isWindows() ? `${(await $.env.get('SystemRoot')) ?? 'C:\\Windows'}\\System32\\tar.exe` : 'tar'
    await $.process.run([tar, '-xf', archive, '-C', join(dir, 'bin-vulkan')], { timeoutMs: 120000 })
    if (!isWindows()) await $.process.run(['sh', '-c', `f=$(find "${join(dir, 'bin-vulkan')}" -name llama-server -type f | head -1); [ -n "$f" ] && ln -sf "$f" "${vulkanExe(dir)}"`])
  } catch {
    // the CPU build still runs the model
  }
}

/**
 * A discrete GPU with room for the model. Integrated graphics are skipped: they share the system RAM
 * this is meant to save. Measured on an RTX 5070 Laptop: 0.4 s and 0.35 s of CPU per status line
 * (CPU-only: 3 s and 17-20 s), 660 MB of RAM instead of 1.9 GB, 1.4 GB of VRAM; asleep, 160 MB and 126 MB.
 */
async function pickGpu($: $T, dir: string): Promise<{ exe: string; device: string; name: string } | null> {
  if (opt('local_device') === 'cpu') return null
  const exe = vulkanExe(dir)
  if (!(await $.fs.exists(exe))) return null
  try {
    const out = await $.process.run([exe, '--list-devices'], { timeoutMs: 30000 })
    let best: { device: string; name: string; free: number } | null = null
    for (const line of `${out.stdout}\n${out.stderr}`.split('\n')) {
      const m = line.match(/(Vulkan\d+):\s*(.+?)\s*\((\d+) MiB,\s*(\d+) MiB free\)/)
      if (!m || /intel|microsoft basic|llvmpipe|swiftshader/i.test(m[2]!)) continue
      const free = Number(m[4])
      if (free >= 2500 && (!best || free > best.free)) best = { device: m[1]!, name: m[2]!, free }
    }
    return best ? { exe, device: best.device, name: best.name } : null
  } catch {
    return null
  }
}

/** Where the model runs, for Settings and the status line. */
let ownDevice = ''

/** The llama-server binary under the engine folder, wherever the archive put it. */
async function findServer($: $T, dir: string): Promise<string | null> {
  if (isWindows()) return (await $.fs.exists(join(dir, 'bin', 'llama-server.exe'))) ? join(dir, 'bin', 'llama-server.exe') : null
  const found = (await $.process.run(['sh', '-c', `find "${join(dir, 'bin')}" -name llama-server -type f 2>/dev/null | head -1`])).stdout.trim()
  return found || null
}

/**
 * The server's flags, measured on Qwen3.5 2B (i7-14650HX, 24 threads), against the defaults:
 * - 4 generation / 8 prompt threads: 18.6 s CPU per status line instead of 49.8 s, and faster (3.0 s vs 5.4 s);
 *   every core spinning only fights the person's own work.
 * - one slot, 2048 context, no prompt RAM cache, 2 checkpoints: no memory for requests that never come
 *   (the defaults keep 4 slots, up to 8 GB of prompt cache and 32 checkpoints per slot).
 * - asleep after 2 idle minutes: 1160 MB private down to 53 MB; the next line wakes it (~10 s, in the background).
 */
async function serverArgs($: $T, server: string, model: string) {
  const logical = Number(isWindows() ? await $.env.get('NUMBER_OF_PROCESSORS') : (await $.process.run(['nproc'])).stdout.trim()) || 8
  const gen = clamp(Math.round(logical / 4), 2, 4)
  const batch = clamp(Math.round(logical / 2), 2, 8)
  return [server, '-m', model, '--host', '127.0.0.1', '--port', String(OWN_PORT), '-c', '2048', '-np', '1', '-cram', '0', '-ctxcp', '2', '-t', String(gen), '-tb', String(batch), '--sleep-idle-seconds', '120']
}

/** Puts the server below the person's own programs, so a status line never slows what they are doing. */
async function lowerPriority($: $T) {
  try {
    if (isWindows()) {
      const ids = ((await snapshot($))?.procs ?? []).filter(p => /^llama-server\.exe$/i.test(p.name) && p.cmd.includes(`--port ${OWN_PORT}`)).map(p => p.pid)
      if (ids.length) await $.process.run(['powershell', '-NoProfile', '-Command', `Get-Process -Id ${ids.join(',')} | ForEach-Object { $_.PriorityClass = 'BelowNormal' }`], { timeoutMs: 20000 })
    } else {
      await $.process.run(['sh', '-c', `pgrep -f "port ${OWN_PORT}" | xargs -r renice -n 10 -p`], { timeoutMs: 10000 })
    }
  } catch {
    // normal priority still works
  }
}

/** Starts one server and waits until it answers; a server that never answers is stopped. */
async function tryServer($: $T, argv: string[], seconds: number) {
  const run = $.process.spawn({ argv })
  void (async () => {
    for await (const _ of run) {
      // the server lives as long as this loop reads it
    }
  })()
  for (let i = 0; i < seconds; i++) {
    if (await answers($, `${OWN_BASE}/health`)) {
      void lowerPriority($)
      return true
    }
    await $.clock.sleep(1000)
  }
  void run.return(undefined as never)
  return false
}

/** Starts The Chief's llama.cpp server: on a discrete GPU when there is one with room, else on the CPU. */
async function startOwnServer($: $T, server: string, model: string, dir: string) {
  const gpu = await pickGpu($, dir)
  if (gpu) {
    const argv = [gpu.exe, '-m', model, '--host', '127.0.0.1', '--port', String(OWN_PORT), '-c', '2048', '-np', '1', '-cram', '0', '-ctxcp', '2', '-t', '2', '-tb', '2', '--device', gpu.device, '-ngl', '99', '-fa', 'on', '-lm', 'none', '--no-host', '--sleep-idle-seconds', '120']
    // the first start on a GPU compiles its shaders once (up to ~20 s)
    if (await tryServer($, argv, 75)) {
      ownDevice = `GPU · ${oneLine(gpu.name, 40)}`
      return true
    }
  }
  if (await tryServer($, await serverArgs($, server, model), 90)) {
    ownDevice = 'CPU'
    return true
  }
  return false
}

/**
 * Makes sure a small local model writes the status lines, by itself: llama.cpp (about 20 MB) and
 * one model file (1.3 GB) in the user's own folders, no installer, no admin. A cut download resumes
 * next time. Settings shows each step.
 */
async function ensureLocalModel($: $T) {
  if (summaryEngine() !== 'auto' || localSetup.isBusy) return
  localSeen = null
  const ready = await localServer($).catch(() => null)
  if (ready) {
    localSetup = { step: `${ready.label} is writing the status lines, free and offline.`, isBusy: false, isDone: true }
    return
  }
  const model = localModel()
  const now = await $.clock.now()
  const last = (await $.store.get('localSetup')) as { beat?: number; failedAt?: number } | undefined
  if (last?.beat && now - last.beat < 3 * 60000) return
  if (last?.failedAt && now - last.failedAt < 10 * 60000) return
  const step = async (text: string) => {
    localSetup = { ...localSetup, step: text }
    await storeSet($, 'localSetup', { beat: await $.clock.now() })
    await update($, tick, n => (n ?? 0) + 1)
  }
  localSetup = { step: 'Setting up the local model…', isBusy: true, isDone: false }
  try {
    const dir = await llmDir($)
    const modelPath = join(dir, 'models', model.file)
    let server = await findServer($, dir)
    if (!server) {
      await step('Downloading llama.cpp (about 20 MB)…')
      await $.ui.toast(`The Chief: setting up ${model.label} for agent status lines, once, in the background (~${(model.mb / 1000).toFixed(1)} GB).`)
      const archive = join(dir, isWindows() ? 'llama.zip' : 'llama.tar.gz')
      await $.fs.write(join(dir, 'bin', '.keep'), '')
      if (!(await runLong($, [isWindows() ? 'curl.exe' : 'curl', '-fL', '--create-dirs', '--retry', '3', '--progress-bar', '-o', archive, await llamaAsset($)], p => step(`Downloading llama.cpp… ${p}`)))) throw new Error('could not download llama.cpp')
      const tar = isWindows() ? `${(await $.env.get('SystemRoot')) ?? 'C:\\Windows'}\\System32\\tar.exe` : 'tar'
      const unpacked = await $.process.run([tar, '-xf', archive, '-C', join(dir, 'bin')], { timeoutMs: 120000 })
      if (unpacked.exitCode !== 0) throw new Error(`could not unpack llama.cpp: ${oneLine(unpacked.stderr, 100)}`)
      server = await findServer($, dir)
      if (!server) throw new Error('llama-server is missing from the download')
    }
    const marker = `${modelPath}.done`
    if (!(await $.fs.exists(marker))) {
      await step(`Downloading ${model.label} (${(model.mb / 1000).toFixed(1)} GB)…`)
      await $.fs.write(join(dir, 'models', '.keep'), '')
      const ok = await runLong($, [isWindows() ? 'curl.exe' : 'curl', '-fL', '--create-dirs', '-C', '-', '--retry', '5', '--progress-bar', '-o', modelPath, model.url], p => step(`Downloading ${model.label}… ${p}`))
      if (!ok) throw new Error(`the ${model.label} download stopped; it resumes next time`)
      await $.fs.write(marker, String(await $.clock.now()))
    }
    await step(`Starting ${model.label}…`)
    await ensureVulkan($, dir)
    if (!(await startOwnServer($, server, modelPath, dir))) throw new Error('the model server did not start')
    localSeen = null
    localSetup = { step: `${model.label} ready: status lines are written on this computer, free and offline.`, isBusy: false, isDone: true }
    await storeSet($, 'localSetup', { doneAt: await $.clock.now() })
  } catch (err) {
    localSetup = { step: `Local model not ready: ${err instanceof Error ? err.message : String(err)}. Lines come from the agents' events meanwhile; tried again in 10 minutes.`, isBusy: false, isDone: false }
    await storeSet($, 'localSetup', { failedAt: await $.clock.now() })
  }
  await update($, tick, n => (n ?? 0) + 1)
}

/** The status line's instructions and two worked examples (measured on Qwen3.5 2B: right state, a plain sentence, 1-4 s on a laptop CPU). */
const NOW_SYSTEM =
  'Bir yazılım ajanını izleyen yöneticiye durum özeti yazıyorsun. Tek cümle, Türkçe, en fazla 14 kelime: hangi işi yapıyor ve şu an o işte ne aşamada. İşin amacını anlat; dosya adı, komut, kod yazma. state: working, waiting (onay ya da girdi bekliyor), error (hata alıp takıldı), done.'
const NOW_SHOTS: [string, string][] = [
  [
    ['Görev: ürün sayfasına fiyat tablosu ekle', 'Son adımlar:', 'Okuyor: pricing.tsx', 'Düzenliyor: pricing.tsx', 'Bash: npm run build'].join('\n'),
    '{"state": "working", "line": "Ürün sayfasına fiyat tablosunu ekledi, şimdi sayfanın sorunsuz derlendiğini kontrol ediyor."}',
  ],
  [
    ['Görev: veritabanı yedeğini otomatikleştir', 'Son adımlar:', 'Düzenliyor: backup.sh', 'Bash: ./backup.sh', 'Hata: permission denied'].join('\n'),
    '{"state": "error", "line": "Otomatik yedeklemeyi kurarken izin hatasına takıldı."}',
  ],
]
const NOW_SYSTEM_EN =
  'You write a status summary for a manager watching a software agent. One sentence, English, at most 14 words: what job it is doing and where it is in that job now. Say what the work is for; no file names, commands or code. state: working, waiting (waiting for approval or input), error (stuck on an error), done.'
const NOW_SHOTS_EN: [string, string][] = [
  [
    ['Task: add a price table to the product page', 'Last steps:', 'Reading: pricing.tsx', 'Editing: pricing.tsx', 'Bash: npm run build'].join('\n'),
    '{"state": "working", "line": "Added the price table to the product page, now checking that the page builds cleanly."}',
  ],
  [
    ['Task: automate the database backup', 'Last steps:', 'Editing: backup.sh', 'Bash: ./backup.sh', 'Error: permission denied'].join('\n'),
    '{"state": "error", "line": "Got stuck on a permission error while setting up the automatic backup."}',
  ],
]

/** Word stems (first 5 letters, lower case) of a text: enough to tell "yedek" from "yedeklemeyi" apart from "fiyat". */
const stems = (t: string) => new Set((t.toLocaleLowerCase('tr').match(/[\p{L}\p{N}]{4,}/gu) ?? []).map(w => w.slice(0, 5)))
/**
 * Whether a small model's line was copied from its worked examples instead of read off the input: it names a word
 * only the examples hold (a "database backup" or a "permission error" that never happened). Such a line is dropped. Pure, so it is tested.
 */
export function echoesShots(line: string, input: string, shots: readonly [string, string][], system = ''): boolean {
  const own = stems(`${input} ${system}`)
  const fromShots = stems(shots.map(([u, a]) => `${u} ${a}`).join(' '))
  return [...stems(line)].some(s => fromShots.has(s) && !own.has(s))
}

/** One plain line from a model, only where it costs nothing (a local server) or where the person chose Haiku. */
async function plainLine($: $T, system: string, prompt: string, shots: [string, string][] = []): Promise<string | null> {
  const engine = summaryEngine()
  if (engine === 'rules') return null
  const server = engine === 'auto' ? await localServer($) : null
  if (server) {
    try {
      // a local model that does not answer in 20 s is skipped this time; the event line stays
      const timeout = $.clock.sleep(20000).then(() => null)
      const json = { 'content-type': 'application/json' }
      const messages = [
        { role: 'system', content: `${system} ${L('Write only JSON', 'Sadece JSON yaz')}: {"state": "...", "line": "..."}` },
        ...shots.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }]),
        { role: 'user', content: prompt },
      ]
      const res = await Promise.race([timeout, (async () =>
        server.kind === 'ollama'
          ? await $.http.fetch(`${server.base}/api/chat`, { method: 'POST', headers: json, body: JSON.stringify({ model: server.model, messages, stream: false, think: false, format: STATUS_SCHEMA, options: { num_predict: 64, temperature: 0.3 } }) })
          : await $.http.fetch(`${server.base}/v1/chat/completions`, {
              method: 'POST',
              headers: json,
              body: JSON.stringify({
                model: server.model,
                messages,
                max_tokens: 64,
                temperature: 0.3,
                ...(server.kind === 'own' ? { chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_object', schema: STATUS_SCHEMA } } : {}),
              }),
            }))()])
      if (res && res.ok) {
        const body = JSON.parse(res.text) as { message?: { content?: string }; choices?: { message?: { content?: string } }[] }
        const raw = String(body.message?.content ?? body.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        try {
          const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { state?: string; line?: string }
          // a line lifted from the worked examples describes nothing that happened: the event line stays
          if (parsed.line && echoesShots(parsed.line, prompt, shots, system)) return null
          if (parsed.line?.trim()) {
            return parsed.line.trim()
          }
        } catch {
          if (raw && !raw.startsWith('{') && !echoesShots(raw, prompt, shots, system)) return raw
        }
      }
    } catch {
      // the event line stays
    }
    return null
  }
  if (engine !== 'haiku') {
    // no server (the session that started it ended, or setup never ran here): bring it back
    if (engine === 'auto' && !localSetup.isBusy) enqueue({ kind: 'local-setup' })
    return null
  }
  const res = await $.model.complete({ model: NOW_MODEL, system, prompt, maxTokens: 60 })
  return res.isAnswered && res.text.trim() && !echoesShots(res.text, prompt, shots, system) ? res.text : null
}

/** A small model turns a worker's last output into one plain line. */
async function writeNow($: $T, id: string) {
  const { value = [] } = await $.state.get(WORKERS)
  const w = value.find(x => x.id === id)
  if (!w || w.tail.length === 0) return
  // one model call at a time: a busy model only queues the rest, and they would all spin the CPU
  if (nowBusy) return
  nowAt.set(id, w.tail.length)
  nowBusy = true
  try {
    const line = await plainLine(
      $,
      L(NOW_SYSTEM_EN, NOW_SYSTEM),
      L(`Task: ${oneLine(w.brief, 200)}\nLast steps:\n${w.tail.slice(-10).map(l => oneLine(l, 140)).join('\n')}`, `Görev: ${oneLine(w.brief, 200)}\nSon adımlar:\n${w.tail.slice(-10).map(l => oneLine(l, 140)).join('\n')}`),
      L(NOW_SHOTS_EN, NOW_SHOTS),
    )
    if (line) {
      modelLineAt.set(id, await $.clock.now())
      await patchWorker($, id, x => ({ ...x, now: oneLine(line.replace(/^["']|["']$/g, ''), 110) }))
    }
    // the small model's line only labels the pane: it never wakes a chief (it made up errors that never happened);
    // waits, rate limits, errors and endings are told from the raw output lines by rule (watchdog)
  } catch {
    // the last output line still shows
  } finally {
    nowBusy = false
  }
}

/** Where a CLI agent's log lives: the parsed lines, or with raw every line the CLI printed. */
// the folder is pinned at spawn: the chat's cwd moves with its shell, and a reload then read logs from the wrong place (25.10)
export const workerLogPath = (w: { name: string; runs: number; logRoot?: string }, raw = false) => `${w.logRoot || cwd || '.'}/.squad/logs/${w.name}${w.runs > 1 ? `.run${w.runs}` : ''}${raw ? '.raw' : ''}.log`

/** The "now" line of an agent that has ended: how it ended, never its last action (that reads as still working). */
export function endNow(status: string, code: number | null, missing: boolean, couldNotStart = false): string {
  if (status === 'stopped') return L('Stopped', 'Durduruldu')
  if (status === 'done') return L('Done', 'Bitti')
  if (couldNotStart) return L('Could not start', 'Başlatılamadı')
  if (missing) return L(`The process ended (exit ${code ?? 'none'}) but wrote no report file: counted as failed`, `Süreç bitti (çıkış ${code ?? 'yok'}) ama rapor dosyası yazılmadı: başarısız sayıldı`)
  return code === 0 ? L('Failed (exit 0)', 'Başarısız (çıkış 0)') : L(`Failed (exit ${code ?? 'none'})`, `Başarısız (çıkış ${code ?? 'yok'})`)
}

/** Runs one headless agent (a first run or a follow-up) and follows it until it ends. */
// ---------- the person's real Chrome: Tab Bridge, never Claude in Chrome ----------
/** The bridge folder: the owner's own (tab_bridge setting) or the copy The Chief ships and installs, so a machine with no bridge still gets one. */
let bridgeInstalled = ''
let bridgeFailAt = 0
async function bridgeDirOf($: $T): Promise<string> {
  const own = opt('tab_bridge')
  if (own && !/^(on|off)$/i.test(own)) return own.replace(/\\/g, '/').replace(/\/$/, '')
  const base = isWindows() ? `${(await $.env.get('LOCALAPPDATA')) ?? ''}/the-chief/tab-bridge` : `${(await $.env.get('HOME')) ?? '.'}/.the-chief/tab-bridge`
  const dir = base.replace(/\\/g, '/')
  if (bridgeInstalled !== dir && Date.now() - bridgeFailAt > 60000) {
    try {
      const marker = `${dir}/.version`
      const have = (await $.fs.exists(marker)) ? String(await $.fs.read(marker)).trim() : ''
      if (have !== BRIDGE_VERSION || !(await $.fs.exists(`${dir}/tb.js`))) {
        for (const [name, text] of Object.entries(BRIDGE_FILES)) await $.fs.write(`${dir}/${name}`, text)
        await $.fs.write(marker, BRIDGE_VERSION)
      }
      bridgeInstalled = dir
    } catch {
      bridgeFailAt = Date.now() // the folder is still named; installing is tried again in a minute
    }
  }
  return dir
}
const bridgeOn = () => riskyOn('tab_bridge', opt('tab_bridge'))
/** What an agent is told about the browser: the bridge's start line and commands. */
export const bridgeNote = (dir: string) =>
  `Browser: for the person's real Chrome (their open tabs and signed-in sites) use the Tab Bridge, never Claude in Chrome (mcp__claude-in-chrome__*). Start it (safe to repeat; port 8765 belongs to it): powershell -ExecutionPolicy Bypass -File ${dir}/start-bridge.ps1, which must print "OK: Chrome extension connected.". Then: node ${dir}/tb.js tabs [filter] | eval <tabId> "<js>" | newtab <url> | nav <tabId> <url> | activate <tabId> | shot <tabId> out.png | dl <url> | pause-media.`
/** Jobs that touch a browser start the bridge for the agent. */
export const BROWSER_JOB = /\b(chrome|browser|tabs?|drive|gmail|youtube|upwork|sekme|tarayıcı|login|giriş)\b/i
let bridgeAt = 0
let opencodeNext = 0
/** Starts the bridge once in a while (the script is idempotent and frees port 8765 itself); returns its last line. */
async function ensureBridge($: $T): Promise<string> {
  const now = await $.clock.now()
  if (!bridgeOn() || !isWindows() || now - bridgeAt < 10 * 60000) return ''
  bridgeAt = now
  const r = await $.process.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${await bridgeDirOf($)}/start-bridge.ps1`], { timeoutMs: 60000 }).catch(() => null)
  return oneLine((r?.stdout ?? '').trim().split(/\r?\n/).pop() ?? '', 160)
}

export const promptPointer = (file: string) => `Read the file ${file} and carry out every instruction in it exactly; finish with the report it asks for. While you work, write one short plain sentence before each step saying what you are about to do and why; never work silently.`
/** A command line over this goes as a file pointer instead: cmd shims die near 8k, direct exes near 32k on Windows. */
export const ARGV_LIMIT = 6000
/** How long the composed command line is: every argument plus the spaces and quoting around it. */
export const argvChars = (argv: readonly string[]): number => argv.reduce((n, a) => n + a.length + 3, 0)
/** A brief that does not fit the argv goes to a file; the CLI gets "read that file" instead (Qoder on Windows: "The command line is too long"). */
export const promptByFile = (argv: readonly string[], win: boolean): boolean => win && argvChars(argv) > ARGV_LIMIT
async function runWorker($: $T, worker: SquadWorker, prompt: string, resume: boolean, retries = 0): Promise<void> {
  const spec = CLIS[worker.cli]
  const session = worker.sessionId ? { id: worker.sessionId, resume } : null
  // cmd /c cuts a multi-line prompt at its first line: the full text goes to a file and the CLI gets a one-line prompt
  // (OpenCode always gets the file: the cmd line limit is ~8k characters and a long inline prompt dies without a word)
  // Every CLI is covered: an argv over ARGV_LIMIT goes by file, so Qoder never sees "The command line is too long".
  const continuing = resume && worker.sessionId && canResume(worker.cli)
  const inline = (continuing ? resumeArgv(worker.cli, worker.model, worker.effort ?? '', worker.sessionId!, prompt, worker.permission) : null) ?? spec.argv(worker.model, worker.effort ?? '', prompt, session, worker.permission)
  if ((((/[\r\n]/.test(prompt) || prompt.length > 6000 || (worker.cli.startsWith('opencode') && !prompt.startsWith('Read the file '))) && inline[0] === 'cmd')) || promptByFile(inline, isWindows())) {
    // inside the worker's own folder: OpenCode refuses files outside its cwd (external_directory), and a worktree is not under the HQ cwd
    const file = promptFile(worker.dir, cwd, worker.name, worker.runs)
    await $.fs.write(file, prompt)
    prompt = promptPointer(file)
  }
  // OpenCode starts one at a time, 1.5-2.5 s apart: parallel starts raced for its shared files and some never started
  if (worker.cli.startsWith('opencode')) {
    const slot = Math.max(await $.clock.now(), opencodeNext)
    opencodeNext = slot + 1500 + Math.floor(Math.random() * 1000)
    const wait = slot - (await $.clock.now())
    if (wait > 0) await $.clock.sleep(wait)
  }
  // same session: a follow-up, a "devam" or a stall restart continues sessionId, it never starts a fresh conversation
  const runArgv = (continuing ? resumeArgv(worker.cli, worker.model, worker.effort ?? '', worker.sessionId!, prompt, worker.permission) : null) ?? spec.argv(worker.model, worker.effort ?? '', prompt, session, worker.permission)
  const runEnv = { ...WORKER_ENV, ...(worker.cli.startsWith('opencode') ? { OPENCODE_PERMISSION: '{"external_directory":"allow"}', OPENCODE_CONFIG_CONTENT: opencodeConfig(await $.env.get('OPENCODE_CONFIG_CONTENT')) } : {}), ...envFor(worker.cli), ...(worker.env ?? {}) }
  const outside = worker.cli.startsWith('opencode') && isWindows() && worker.detach !== false ? await detachedOpencode($, worker, runArgv, runEnv).catch(() => null) : null
  const stream: RunStream = outside ?? ($.process.spawn({ argv: runArgv, cwd: worker.dir || cwd || undefined, env: runEnv }) as unknown as RunStream)
  stoppers.set(worker.id, () => void stream.return(undefined as never))
  let pending: string[] = []
  let partial = ''
  /** The newest step the agent's own events (or its plain lines) showed: the "now" line, free. */
  let latestStep = ''
  let latestSaid = ''
  const termAdd: string[] = []
  const full: string[] = []
  const rawLines: string[] = []
  let dropped = 0
  let logWrittenAt = 0
  /** The log is written while the agent runs (not only at its end), parsed and raw, so a chief can always read it. */
  const writeLive = async (final = false) => {
    const at = await $.clock.now()
    if (!final && at - logWrittenAt < 4000) return
    logWrittenAt = at
    await $.fs.write(workerLogPath(worker), `${dropped ? `[${dropped} earlier lines not kept]\n` : ''}${full.join('\n')}`).catch(() => undefined)
    await $.fs.write(workerLogPath(worker, true), rawLines.join('\n')).catch(() => undefined)
  }
  const flush = async () => {
    if (pending.length === 0) return
    const add = pending
    pending = []
    const at = await $.clock.now()
    lastActivity.set(worker.id, at)
    const step = at - (modelLineAt.get(worker.id) ?? 0) > 120000 ? latestStep : ''
    latestStep = ''
    const said = latestSaid
    latestSaid = ''
    const seen = add.flatMap(l => l.match(FILE_RE) ?? []).map(baseName)
    if (worker.guard?.length) void laneGuardLine($, worker, add).catch(() => undefined)
    await patchWorker($, worker.id, w => ({
      ...w,
      now: step || w.now,
      said: said || w.said,
      tail: [...w.tail, ...add].slice(-TAIL),
      files: seen.length ? [...w.files.filter(f => !seen.includes(f)), ...seen].slice(-10) : w.files,
    }))
  }
  let byFile = false
  const ticker = $.clock.every(2000, () => {
    void flush()
    // done when the report file exists: the process is stopped, the run counts as done
    if (worker.doneFile && !byFile) void $.fs.exists(worker.doneFile).then(found => {
      if (found) {
        byFile = true
        void stream.return(undefined as never)
      }
    }).catch(() => undefined)
  })
  let code: number | null = null
  let failed = false
  let startErr = ''
  try {
    for await (const chunk of stream) {
      const parts = (partial + chunk.text).split(/\r?\n/)
      partial = parts.pop() ?? ''
      for (const line of parts) {
        if (line.trim()) {
          rawLines.push(line.length > 600 ? `${line.slice(0, 600)}…` : line)
          if (rawLines.length > FULL_LOG_LINES * 2) rawLines.splice(0, rawLines.length - FULL_LOG_LINES * 2)
        }
        const plain = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        termAdd.push(...terminalOf(plain))
        const ev = readAgentLine(plain)
        if (!ev) continue
        if (ev.said) latestSaid = ev.said.slice(0, 600)
        if (ev.usd && worker.env?.ANTHROPIC_API_KEY) void recordApiSpend($, ev.usd, worker.name).catch(() => undefined)
        pending.push(ev.line)
        full.push(ev.line)
        if (full.length > FULL_LOG_LINES) {
          dropped += full.length - FULL_LOG_LINES
          full.splice(0, full.length - FULL_LOG_LINES)
        }
        if (ev.step) latestStep = ev.step
      }
      if (termAdd.length) await appendTerm($, worker, termAdd.splice(0))
      await writeLive()
    }
    code = (await stream.result).code
  } catch (err) {
    failed = true
    startErr = err instanceof Error ? err.message : String(err)
    pending.push(`could not start: ${startErr}`)
  }
  ticker.cancel()
  // a CLI that dies at once with no output (concurrent starts racing for one lock or a slow MCP start) gets one more try;
  // never one that was stopped (stop_agent, RAM gate, stall restart): its tree kill also leaves no output (17.10)
  const stoppedNow = stallRestarting.has(worker.id) || routeSwitching.has(worker.id) || (await $.state.get(WORKERS)).value?.find(w => w.id === worker.id)?.status === 'stopped'
  if (!stoppedNow && retries < 2 && !byFile && (failed || code !== 0) && full.length === 0 && rawLines.length === 0 && !partial.trim()) {
    stoppers.delete(worker.id)
    // a retry never starts beside a process of the same brief that is somehow still alive
    if (mayStart(await agentAlive($, worker))) {
      await $.clock.sleep(3000 + Math.floor(Math.random() * 4000))
      return runWorker($, worker, prompt, resume, retries + 1)
    }
  }
  // a CLI that prints nothing and exits is a failure, whatever its exit code; the log then says why (it used to stay empty)
  if (!byFile && full.length === 0 && rawLines.length === 0 && !partial.trim()) {
    const why = `[the-chief] ${worker.cli} ${worker.model} ended with exit ${code ?? 'n/a'} and printed nothing${failed ? ` (could not start: ${oneLine(startErr, 200)})` : ''}${retries ? ` even after ${retries} ${retries === 1 ? 'retry' : 'retries'}` : ''}; command: ${spec.argv(worker.model, worker.effort ?? '', '<prompt>', null).join(' ')}`
    full.push(why)
    pending.push(why)
  }
  // OpenCode exits 0 after auto-rejecting a permission: say which one, and count the run as failed
  const denied = rawLines.find(l => /permission requested: .*auto-rejecting/i.test(l))
  if (denied) {
    const why = `[the-chief] ${worker.cli} was refused: ${oneLine(denied.replace(/^[!\s]+/, ''), 200)}`
    full.push(why)
    pending.push(why)
  }
  if (partial.trim()) {
    pending.push(partial.trim())
    full.push(partial.trim())
    if (full.length > FULL_LOG_LINES) {
      dropped += full.length - FULL_LOG_LINES
      full.splice(0, full.length - FULL_LOG_LINES)
    }
  }
  await flush()
  stoppers.delete(worker.id)
  const now = await $.clock.now()
  const { value = [] } = await $.state.get(WORKERS)
  const was = value.find(w => w.id === worker.id)
  const report = worker.doneFile ? await readText($, worker.doneFile).catch(() => '') : ''
  const silent = !byFile && full.length === 0 && rawLines.length === 0
  const missing = (!!worker.doneFile && !byFile && !visible(report)) || (!byFile && !!denied)
  const runSession = sessionOf(worker.cli, rawLines)
  // messages that came in while it ran: sent as the next continue turn, decided before any report-missing alarm or route change
  const queued = was?.status === 'stopped' ? '' : queuedTurn(was?.pendingMessages)
  if (queued) {
    await patchWorker($, worker.id, w => ({ ...w, status: byFile ? 'done' : 'failed', endedAt: now, exitCode: code, sessionId: runSession ?? w.sessionId, resumeSession: !!(runSession ?? w.sessionId), pendingMessages: [], report: report ? resultReport(report) : w.report }))
    await releaseLocks($, worker)
    await afterEndDrain($, false)
    // the same follow-up path as any other turn (never awaited: a run started inside this one would block the host)
    void followUp($, worker.id, queued).catch(() => undefined)
    return
  }
  // STOP is not DONE and not FAILED: a run that ended without its report goes on in the SAME session (owner, 30.10),
  // never a from-scratch rerun and never a failover; only a no-progress loop or a real error falls through below
  const resumeSession = runSession ?? worker.sessionId
  const badEnd = failed || !!denied || AUTH_RE.test(rawLines.slice(-8).join('\n')) || RATE_RE.test(rawLines.slice(-8).join('\n'))
  if (missing && !routeSwitching.has(worker.id) && !stallRestarting.has(worker.id)) {
    const mark = await resumeMark($, worker, full[full.length - 1] ?? '')
    const call = reportResumeStep({
      missing, stopped: was?.status === 'stopped', resumable: canResume(worker.cli), session: resumeSession, badError: badEnd,
      resumes: was?.reportResumes ?? 0, stalls: was?.reportStalls ?? 0, prevMark: was?.resumeMark, mark,
    })
    if (call.go === 'resume') {
      await patchWorker($, worker.id, w => ({ ...w, status: 'failed', endedAt: now, exitCode: code, sessionId: resumeSession, resumeSession: true, reportResumes: call.resumes, reportStalls: call.stalls, resumeMark: call.mark, now: L(`No report: continuing in the same session (${call.resumes}/${REPORT_RESUME_CAP})`, `Rapor yok: aynı oturumda devam ediyor (${call.resumes}/${REPORT_RESUME_CAP})`) }))
      await releaseLocks($, worker)
      await afterEndDrain($, false)
      void followUp($, worker.id, reportContinue(worker.doneFile ?? '')).catch(() => undefined)
      return
    }
    if (call.go === 'giveup') await patchWorker($, worker.id, w => ({ ...w, reportResumes: call.resumes, reportStalls: call.stalls }))
  }
  const status: SquadWorker['status'] = was?.status === 'stopped' && !byFile ? 'stopped' : missing || (silent && !worker.doneFile) ? 'failed' : byFile || (!failed && (code ?? 1) === 0) ? 'done' : 'failed'
  await patchWorker($, worker.id, w => ({ ...w, status, endedAt: now, exitCode: code, sessionId: runSession ?? w.sessionId, resumeSession: false, report: report ? resultReport(report) : w.report }))
  await releaseLocks($, worker)
  if (stallRestarting.delete(worker.id) && status !== 'done') {
    // stopped for its one restart after a stall: it goes on in the same folder (OpenCode: its own session), nobody is woken
    const ses = worker.cli.startsWith('opencode') ? opencodeSession(rawLines) : null
    if (ses) await patchWorker($, worker.id, w => ({ ...w, sessionId: ses }))
    await afterEndDrain($, false)
    void followUp($, worker.id, ses ? DROP_CONTINUE : STALL_CONTINUE).catch(() => undefined)
    return
  }
  if (routeSwitching.delete(worker.id) && status !== 'done') {
    // a 0-BYTE log (the snapshot hang): the model that wrote nothing is never retried, the next route runs
    const cause = L('0 bytes of output', '0 bayt çıktı')
    if (was?.route && (await routeFailover($, was, prompt, code, cause, cause))) {
      await afterEndDrain($, false)
      return
    }
    raise(`end:${worker.id}:${worker.runs}`, L(`✗ ${worker.name} 0-BYTE · ${cause} · no next route · .squad/logs/${worker.name}.log`, `✗ ${worker.name} 0-BYTE · ${cause} · sıradaki rota yok · .squad/logs/${worker.name}.log`), true, now)
    await afterEndDrain($, false)
    await flushAlerts($, now)
    return
  }
  // a dropped connection: the same OpenCode session (same XDG_DATA_HOME, kept in w.env) goes on, an explicit route too
  const dropSes = status === 'failed' && was?.status !== 'stopped' && worker.cli.startsWith('opencode') && rawLines.slice(-6).some(l => TRANSIENT_DROP.test(l)) ? opencodeSession(rawLines) : null
  if (dropSes && (was?.dropResumes ?? 0) < DROP_RESUMES) {
    const n = (was?.dropResumes ?? 0) + 1
    await patchWorker($, worker.id, w => ({ ...w, sessionId: dropSes, dropResumes: n, now: L(`Connection dropped: continuing in the same session (${n}/${DROP_RESUMES})`, `Bağlantı koptu: aynı oturumda devam ediyor (${n}/${DROP_RESUMES})`) }))
    await afterEndDrain($, false)
    // OpenCode starts are already spaced 1.5-2.5 s apart (runWorker), which gives the connection its breath
    void followUp($, worker.id, DROP_CONTINUE).catch(() => undefined)
    return
  }
  if (status === 'done') await writeNow($, worker.id)
  else await patchWorker($, worker.id, w => ({ ...w, now: endNow(status, code, missing, failed) }))
  try {
    if (partial.trim()) rawLines.push(partial.trim())
    await writeLive(true)
  } catch {
    // the tail in the pane is enough when the log cannot be written
  }
  const mins = Math.max(1, Math.round((now - worker.startedAt) / 60000))
  $.ui.toast(`${worker.name} ${status} after ${mins} min`)
  const last = oneLine(full[full.length - 1] ?? '(no output)', 100)
  const mark = status === 'done' ? '✓' : status === 'stopped' ? '■' : '✗'
  if (status === 'failed' && was?.status !== 'stopped' && worker.route && !resume && (await routeFailover($, worker, prompt, code, full.slice(-4).join(' | '), routeCause(rawLines, code, failed, startErr, missing)))) {
    await afterEndDrain($, false)
    return
  }
  if (status === 'failed' && was?.status !== 'stopped' && !worker.route) await tellRouteFailed($, worker, routeCause(rawLines, code, failed, startErr, missing), L('no fallback route (the route was given explicitly)', 'yedek rota yok (rota açıkça verilmişti)'))
  const fixIn = status === 'failed' && was?.status !== 'stopped' ? autoFixDelay(worker.id, full.slice(-12).join('\n')) : 0
  if (fixIn) void scheduleAutoFix($, worker.id, fixIn, full.slice(-8).join('\n')).catch(() => undefined)
  // a failure that gets its one automatic retry wakes nobody: only the retry's own ending is told
  if (!fixIn) raise(`end:${worker.id}:${worker.runs}`, `${mark} ${worker.name} ${status} · ${spec.label} · ${mins}m${byFile ? ` · report ${worker.doneFile}` : status === 'done' ? '' : missing ? ` · exit ${code ?? 'n/a'} but no report file written` : ` · exit ${code ?? 'n/a'}`} · last: "${report ? oneLine(report, 120) : last}" · log .squad/logs/${worker.name}.log`, status === 'failed', now)
  if (status === 'done') await runChain($, worker, report)
  await afterEndDrain($, !fixIn)
  await flushAlerts($, now)
}

// ---------- launches wait for RAM ----------
/** Roughly what one headless agent of each CLI holds (measured: a claude engine 700-1000 MB, opencode ~1 GB). */
const AGENT_RAM_MB: Record<SquadCli, number> = { claude: 1200, codex: 600, devin: 300, cursor: 800, qoder: 900, gemini: 800, antigravity: 800, openrouter: 1500, 'opencode-zen': 1500, 'opencode-go': 1500, 'opencode-ollama': 1500, custom: 600 }
/** Free RAM the person keeps for their own work, however many agents wait. */
/** RAM that stays free for the machine (setting ram_reserve_gb, default 3): agents grow after they start, so launches stop early. */
const ramReserveMb = () => Math.max(1, Number(opt('ram_reserve_gb')) || 3) * 1024
const launchQueue: { workerId: string; prompt: string }[] = []
let freeSeen: { at: number; mb: number } | null = null
const maxParallel = () => clamp(Number(opt('max_parallel')) || 10, 1, 40)

/** Available RAM in MB, read at most every 10 s; unknown reads as plenty. */
async function freeRamMb($: $T): Promise<number> {
  const now = await $.clock.now()
  if (freeSeen && now - freeSeen.at < 10000) return freeSeen.mb
  let mb = Number.POSITIVE_INFINITY
  try {
    if (isWindows()) {
      // AVAILABLE memory (free + reclaimable standby pages), what Task Manager calls Available; FreePhysicalMemory counts only the never-used pages and starved the queue with GBs reclaimable
      const exe = await procsnapExe($)
      if (exe) {
        const r = await $.process.run([exe, '--mem'], { timeoutMs: 10000 })
        mb = Math.round(Number(r.stdout.trim()))
      }
    } else {
      const r = await $.process.run(['sh', '-c', 'if [ -r /proc/meminfo ]; then awk \'/MemAvailable/ {print int($2/1024)}\' /proc/meminfo; else vm_stat | awk -v ps=$(pagesize) \'/Pages (free|inactive)/ {gsub(/\\./, "", $NF); s += $NF} END {print int(s * ps / 1048576)}\'; fi'], { timeoutMs: 10000 })
      mb = Number(r.stdout.trim())
    }
  } catch {
    // unknown
  }
  if (!Number.isFinite(mb) || mb <= 0) mb = Number.POSITIVE_INFINITY
  freeSeen = { at: now, mb }
  return mb
}

/** Room for one more agent of this CLI: under the parallel cap, and RAM left over after it. */
async function roomFor($: $T, cli: SquadCli, w?: SquadWorker) {
  const { value: ws = [] } = await $.state.get(WORKERS)
  if (ws.filter(x => x.status === 'running').length >= maxParallel()) return { ok: false, why: L(`${maxParallel()} agents already running`, `${maxParallel()} ajan zaten çalışıyor`) }
  for (const name of w?.locks ?? []) {
    const held = await lockHolder($, name)
    if (held && held.workerId !== w!.id) return { ok: false, why: L(`lock: ${name} busy`, `kilit: ${name} meşgul`) }
  }
  const total = Number(opt('max_parallel_total'))
  if (total > 0 && (await runningEverywhere($)) >= total) return { ok: false, why: L(`the limit of ${total} workers on this computer is reached`, `bu bilgisayarda toplam ${total} işçi sınırı dolu`) }
  const free = await freeRamMb($)
  if (free < 4096) {
    if (free < 3072) await stopNewestWorker($)
    return { ok: false, why: L(`RAM under 4 GB (${(free / 1024).toFixed(1)} GB), not opening a new agent`, `RAM 4 GB altında (${(free / 1024).toFixed(1)} GB), yeni ajan açılmıyor`) }
  }
  if (free - AGENT_RAM_MB[cli] < ramReserveMb()) return { ok: false, why: L(`waiting for RAM (${(free / 1024).toFixed(1)} GB available)`, `RAM bekliyor (${(free / 1024).toFixed(1)} GB kullanılabilir)`) }
  return { ok: true, why: '' }
}

let ramStopAt = 0
/** Below 3 GB free the newest running agent is stopped (at most one per minute) so the machine does not freeze. */
async function stopNewestWorker($: $T) {
  const now = await $.clock.now()
  if (now - ramStopAt < 60000) return
  const { value: ws = [] } = await $.state.get(WORKERS)
  const newest = ws.filter(x => x.status === 'running').sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!newest) return
  ramStopAt = now
  // only the processes: the worktree and its changes stay for a restart
  await stopChildRun($, newest)
  const rec = runs.get(newest.id)
  if (rec) await killRun($, rec)
  await patchWorker($, newest.id, x => ({ ...x, status: 'stopped', endedAt: now, now: L('RAM fell under 3 GB: stopped the newest agent', 'RAM 3 GB altına düştü: en son açılan ajan durduruldu') }))
  raise(`ram:${newest.id}`, L(`! RAM fell under 3 GB: stopped ${newest.name}`, `! RAM 3 GB altına düştü: ${newest.name} durduruldu`), true, now)
}

/** Starts queued agents, oldest first, while there is room. */
async function drainQueue($: $T) {
  while (launchQueue.length > 0) {
    const head = launchQueue[0]!
    const { value: ws = [] } = await $.state.get(WORKERS)
    const w = ws.find(x => x.id === head.workerId)
    if (!w || w.status !== 'queued') {
      launchQueue.shift()
      continue
    }
    const room = await roomFor($, w.cli, w)
    if (!room.ok) {
      await patchWorker($, w.id, x => ({ ...x, now: L(`Queued: ${room.why}`, `Sırada: ${room.why}`) }))
      return
    }
    launchQueue.shift()
    if (freeSeen) freeSeen = { ...freeSeen, mb: freeSeen.mb - AGENT_RAM_MB[w.cli] }
    const next: SquadWorker = { ...w, status: 'running', startedAt: await $.clock.now(), now: L('Starting…', 'Başlıyor…') }
    await patchWorker($, w.id, () => next)
    await startRun($, next, head.prompt)
  }
}

/** The text a difficulty floor reads for a worker: its name, task, brief path and the head of the brief file. */
async function briefText($: $T, a: Record<string, unknown>): Promise<string> {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  const file = str('task_file') || str('brief')
  const body = file ? (await readText($, file).catch(() => '')).slice(0, 4000) : ''
  return [str('name'), str('task'), file, str('header_file'), body].join('\n')
}

type WorkerRun = { cli: SquadCli; model: string; effort: number; note: string; route?: { tier: string; isPrivate: boolean } }

/**
 * The owner's worker models, cheap first and strong last: Go, Qoder, then the Claude stops (31.10: a hard job
 * has to be able to reach Sonnet and Opus again). Qoder stays before Haiku xhigh, the owner's rule for when it runs out.
 * Zen's free DeepSeek is not in it (01.11): a free model is nobody's default, and a private job never runs on one.
 */
export const WORKER_MODELS_DEFAULT = 'opencode-go/deepseek-v4.1-flash, qoder/DeepSeek-Flash, claude/claude-haiku-5-5, claude/claude-sonnet-5-5, claude/claude-opus-5-5'
/** worker_models as cli/model pairs; null = off (any model may run). An unknown CLI is dropped, an empty list means the default. */
export function parseWorkerModels(raw: string | undefined): { cli: SquadCli; model: string }[] | null {
  const v = (raw ?? '').trim()
  if (/^(off|any|kapalı)$/i.test(v)) return null
  const list = (v || WORKER_MODELS_DEFAULT)
    .split(/[,\n]/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => {
      const i = x.indexOf('/')
      return i > 0 ? { cli: x.slice(0, i), model: x.slice(i + 1).trim() } : null
    })
    .filter((x): x is { cli: string; model: string } => !!x && !!x.model && (CLI_ORDER as readonly string[]).includes(x.cli === 'opencode' ? 'opencode-go' : x.cli))
    .map(x => ({ cli: normalizeCli(x.cli), model: x.model }))
  return list.length ? list : parseWorkerModels(WORKER_MODELS_DEFAULT)
}
/** Off unless the owner wrote a list (1.42.0): the old default list sent every model that was not on it to its first entry, DeepSeek. */
const workerModelsNow = () => parseWorkerModels(opt('worker_models') || 'off')
const sameModel = (a: { cli: string; model: string }, b: { cli: string; model: string }) => a.cli === b.cli && a.model.toLowerCase() === b.model.toLowerCase()
/** The built-in two lanes are nobody's choice: only lanes someone actually set widen the list. */
const isDefaultLane = (l: { cli: string; model: string; task?: string }) => DEFAULT_LANES.some(d => d.cli === l.cli && d.model === l.model && d.task === l.task)
/** A chief's lanes, as cli/model pairs: unknown CLIs and lanes with no model are dropped. */
export function lanesAsAllowed(lanes: readonly { cli: string; model: string; task?: string }[]): { cli: SquadCli; model: string }[] {
  return lanes
    .filter(l => !!l.model && !isDefaultLane(l) && (CLI_ORDER as readonly string[]).includes(l.cli))
    .map(l => ({ cli: normalizeCli(l.cli), model: l.model }))
}
/** The global list with this chief's lanes after it, each once. null (worker_models off) stays null. Pure, so it is tested. */
export function mergeAllowed(global: readonly { cli: SquadCli; model: string }[] | null, chief: readonly { cli: SquadCli; model: string }[]): { cli: SquadCli; model: string }[] | null {
  if (global === null) return null
  const out = [...global]
  for (const c of chief) if (!out.some(x => sameModel(x, c))) out.push(c)
  return out
}
/**
 * What this chief may run now: the `worker_models` list, widened by the lanes set on this chat (create_chief /
 * configure_chief, or the owner's own lane edits), so a hard job the leader planned is not pushed onto the cheap list.
 */
const allowedModels = async ($: $T) => mergeAllowed(workerModelsNow(), lanesAsAllowed([...(chiefConfig.lanes ?? []), ...(await $.state.get(LANES)).value ?? []]))
/** Whether a CLI, or this exact model of it, is staying out of the routes right now. */
const isLimited = (limited: ReadonlySet<string>, x: { cli: string; model: string }) => limited.has(x.cli) || limited.has(routeKey(x))
/** A free stop of the list: OpenCode Zen, or a `-free` model id (Go's plain DeepSeek counts, as it does in the routes). */
const isFreeEntry = (x: { cli: string; model: string }) => x.cli === 'opencode-zen' || isFreeModel(x.model)
/**
 * A run the list does not allow starts on the list's first model instead, with a note the chief reads. A model the list
 * allows but that is at its limit steps down the list from where it stands (never back to the cheapest), and a model off
 * the list starts at the first entry that is not at its limit. While a list is set every run carries a route, so a
 * failure falls back down the list (and only down the list). A private job never lands on a free model (01.11): those
 * entries are stepped over, and when nothing else is left the run keeps the model it asked for. Pure, so it is tested.
 */
export function allowRun(run: WorkerRun, list: readonly { cli: SquadCli; model: string }[] | null, limited: ReadonlySet<string> = new Set(), opts: { isPrivate?: boolean } = {}): WorkerRun {
  if (!list) return run
  const asked = list.findIndex(x => sameModel(x, run))
  const route = run.route ?? { tier: 'orta', isPrivate: false }
  const isPrivate = opts.isPrivate ?? route.isPrivate
  const ok = (x: { cli: string; model: string }) => !isLimited(limited, x) && !(isPrivate && isFreeEntry(x))
  if (asked >= 0 && ok(run)) return { ...run, route }
  const first = (asked < 0 ? list : list.slice(asked)).find(ok) ?? list.find(ok) ?? (isPrivate ? null : list[0]!)
  if (!first || sameModel(first, run)) return { ...run, route }
  return { ...run, cli: first.cli, model: first.model, route, note: [L(`allow list: ${CLIS[first.cli].label} ${first.model} instead of ${CLIS[run.cli]?.label ?? run.cli} ${run.model}${isPrivate && isFreeEntry(run) ? ' (private data: free route skipped)' : ''}`, `izin listesi: ${CLIS[run.cli]?.label ?? run.cli} ${run.model} yerine ${CLIS[first.cli].label} ${first.model}${isPrivate && isFreeEntry(run) ? ' (özel veri: ücretsiz rota atlandı)' : ''}`), run.note].filter(Boolean).join(' · ') }
}
/** The next model of the list a failed worker has not tried yet: not at its limit and, for a private job, not free. */
export function nextAllowed(list: readonly { cli: SquadCli; model: string }[], tried: readonly string[], limited: ReadonlySet<string> = new Set(), opts: { isPrivate?: boolean } = {}): { cli: SquadCli; model: string } | null {
  const isPrivate = opts.isPrivate ?? false
  return list.find(x => !tried.some(t => t.toLowerCase() === routeKey(x).toLowerCase()) && !isLimited(limited, x) && !(isPrivate && isFreeEntry(x))) ?? null
}

/**
 * Which CLI, model and effort a spawn_worker call runs on. A tier (asked for, or Orta while tiers are saved and the
 * call names no lane, cli or model) resolves through the saved Alt ajan seviyeleri, lifted by the difficulty floors
 * on the brief; otherwise the lane or the call's own cli, model and effort.
 */
async function workerRun($: $T, a: Record<string, unknown>, brief: string): Promise<{ deny: string } | WorkerRun> {
  const run = await pickWorkerRun($, a, brief)
  // a lane, cli or model the call names runs as named: the list only holds the runs the plugin picked by itself
  if ('deny' in run || ['lane', 'cli', 'model'].some(k => typeof a[k] === 'string' && a[k])) return run
  return allowRun(run, await allowedModels($), await limitedNow($))
}
async function pickWorkerRun($: $T, a: Record<string, unknown>, brief: string): Promise<{ deny: string } | WorkerRun> {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)
  const tiers = subTiersNow()
  if (a.tier !== undefined && !asTier(a.tier)) return { deny: 'tier must be cok_zor, zor, orta or kolay' }
  // the owner's routes: a tier (or none: orta) with no lane, cli or model of its own picks the CLI by itself, skipping CLIs at their limit
  if (opt('worker_routes') !== 'off' && !str('lane') && !str('cli') && !str('model')) {
    const limited = await limitedNow($)
    const isPrivate = a.private === true || looksPrivate(brief)
    const pick = resolveWorkerRoute(asTier(a.tier) ?? 'orta', brief, floorsNow(), { limited, isPrivate, spread: routeSpread++, routes: await workerRoutes($) })
    const cli = normalizeCli(pick.cli)
    const idx = EFFORTS.indexOf(pick.effort as (typeof EFFORTS)[number])
    return { cli, model: pick.model, effort: idx < 0 ? 2 : idx, note: [L(`${TIER_LABEL[pick.tier]} route`, `${TIER_LABEL[pick.tier]} rotası`), pick.note].filter(Boolean).join(' · '), route: { tier: pick.tier, isPrivate } }
  }
  // a cli, model or lane named in the call wins over a tier given beside it (the tier then only says how hard the job is)
  const explicit = !!(str('lane') || str('cli') || str('model'))
  const asked = explicit ? null : asTier(a.tier) ?? (tiers ? 'orta' : null)
  if (asked) {
    if (!tiers) return { deny: L('Subagent tiers are not saved: set subagent_tiers in the plugin options (claude plugin configure the-chief).', 'Alt ajan seviyeleri kayıtlı değil: eklenti ayarında subagent_tiers (claude plugin configure the-chief).') }
    const p = resolveWorkerTier(asked, brief, tiers, floorsNow())
    const cli = normalizeCli(p.cli)
    const idx = EFFORTS.indexOf(p.effort as (typeof EFFORTS)[number])
    return { cli, model: p.model || modelsOf(cli)[0] || '', effort: idx < 0 ? 2 : idx, note: [L(`${TIER_LABEL[p.tier]} tier`, `${TIER_LABEL[p.tier]} seviyesi`), p.note].filter(Boolean).join(' · ') }
  }
  const { value: laneList = [] } = await $.state.get(LANES)
  const lane = laneList.find(l => l.id === str('lane'))
  if (str('cli') && !knownCli(str('cli')!)) return { deny: `unknown cli ${str('cli')}: ${CLI_ORDER.join(', ')}` }
  const cli = str('cli') ? normalizeCli(str('cli')!) : lane?.cli ?? 'claude'
  const effIdx = str('effort') ? EFFORTS.indexOf(str('effort') as (typeof EFFORTS)[number]) : lane?.effort ?? 2
  return { cli, model: str('model') ?? (lane && lane.cli === cli ? lane.model : modelsOf(cli)[0] ?? ''), effort: effIdx < 0 ? 2 : effIdx, note: '' }
}

/**
 * Parallel OpenCode runs share one sqlite file ("database is locked"). Each gets its own data folder, with the
 * login (auth.json) copied in, unless the caller already set XDG_DATA_HOME.
 */
export async function isolateOpencode($: $T, cli: SquadCli, env: Record<string, string> | undefined): Promise<Record<string, string> | undefined> {
  if (!cli.startsWith('opencode') || env?.XDG_DATA_HOME) return env
  try {
    const home = isWindows() ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
    const base = (await $.env.get('XDG_DATA_HOME')) || (home ? `${home}/.local/share` : '')
    if (!base) return env
    const sep = isWindows() ? String.fromCharCode(92) : '/'
    const root = isWindows() ? `${(await $.env.get('LOCALAPPDATA')) ?? home}${sep}the-chief${sep}opencode` : `${home}/.the-chief/opencode`
    const mine = `${root}${sep}${newId()}${newId()}`
    const auth = await $.fs.read(`${base}/opencode/auth.json`).catch(() => null)
    if (auth == null) return env
    await $.fs.write(`${mine}${sep}opencode${sep}auth.json`, auth)
    return { ...(env ?? {}), XDG_DATA_HOME: mine }
  } catch {
    return env
  }
}

/** Names a spawn has picked but not yet put in WORKERS. */
const namesTaken = new Set<string>()
async function spawnWorker($: $T, args: SpawnRequest) {
  const spec: SpawnSpec = { ...(args.spec ?? {}), name: args.name, brief: args.spec?.brief ?? args.brief }
  const eff = effortName(args.cli, args.effort)
  let dir = args.dir || spec.cwd || cwd
  if (spec.worktree) {
    // a fresh worktree on the given ref, made before the worker starts
    try {
      if (!(await $.fs.exists(spec.worktree.path))) {
        // a big checkout (17k files) can take minutes: up to 3 tries, each after clearing what a killed try left (stale worktree entry, half-made folder, index.lock)
        let lastErr = ''
        let made = false
        for (let attempt = 0; attempt < 3 && !made; attempt++) {
          if (attempt > 0) {
            await $.process.run(['git', '-C', spec.worktree.repo, 'worktree', 'remove', '--force', spec.worktree.path], { timeoutMs: 120000 }).catch(() => null)
            await $.process.run(['git', '-C', spec.worktree.repo, 'worktree', 'prune'], { timeoutMs: 60000 }).catch(() => null)
            const lock = `${spec.worktree.repo.replace(/[\/]+$/, '')}/.git/index.lock`
            if (await $.fs.exists(lock).catch(() => false)) {
              const anyGit = await $.process.run(isWindows() ? ['tasklist', '/FI', 'IMAGENAME eq git.exe', '/NH'] : ['pgrep', '-x', 'git'], { timeoutMs: 15000 }).catch(() => null)
              if (!/git(\.exe)?\s+\d+/i.test(anyGit?.stdout ?? '') && !/^\d+/m.test(anyGit?.stdout ?? '')) await $.process.run(isWindows() ? ['cmd', '/c', 'del', '/f', '/q', lock.replace(/\//g, String.fromCharCode(92))] : ['rm', '-f', lock], { timeoutMs: 15000 }).catch(() => null)
            }
          }
          const r = await $.process.run(['git', '-C', spec.worktree.repo, 'worktree', 'add', '--detach', spec.worktree.path, spec.worktree.ref], { timeoutMs: attempt === 0 ? 300000 : 600000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }))
          made = r.exitCode === 0
          if (!made) lastErr = oneLine(r.stderr || r.stdout, 160)
        }
        if (!made) throw new Error(lastErr || 'git worktree add failed')
      }
      dir = spec.worktree.path
    } catch (err) {
      raise(`wt:${args.name}`, `! ${args.name}: could not make worktree ${spec.worktree.path}: ${err instanceof Error ? err.message : String(err)}`, true, await $.clock.now())
      return
    }
  }
  // built before the name is settled, so two calls with one name cannot both pass the check while a prompt is still being made
  const prompt = await buildPrompt($, spec, dir)
  // same name again: a finished record is replaced; one still running/queued keeps its place and the new one gets "#2", "#3"…
  let name = args.name
  const { value: same = [] } = await $.state.get(WORKERS)
  const liveNames = new Set([...same.filter(w => w.status === 'running' || w.status === 'queued').map(w => w.name), ...namesTaken])
  for (let n = 2; liveNames.has(name); n++) name = `${args.name} #${n}`
  // held from here until the record is in WORKERS: a second call with the same name in between sees it taken
  namesTaken.add(name)
  try {
    if (same.some(w => w.name === name)) await update($, workers, list => (list ?? []).filter(w => w.name !== name))
    // a routed worker that lands on Claude runs on the promo API credit while the day's budget lasts
    const env = await isolateOpencode($, args.cli, args.route ? { ...(spec.env ?? {}), ...(await apiCreditEnv($, args.cli)) } : spec.env)
    const worker: SquadWorker = {
      id: newId(),
      name,
      cli: args.cli,
      model: args.model,
      effort: eff,
      brief: args.brief,
      status: 'running',
      startedAt: await $.clock.now(),
      endedAt: null,
      exitCode: null,
      tail: [],
      now: L('Starting…', 'Başlıyor…'),
      files: [],
      // Claude and Qoder let the plugin name the session up front, so a stop before the report can resume it
      sessionId: args.cli === 'claude' || args.cli === 'qoder' ? uuid() : null,
      runs: 1,
      dir,
      logRoot: cwd,
      // the chat that started it: a real stop is told to this chief, whoever looks at the table
      owner: sid,
      env,
      route: args.route ? { tier: args.route.tier, isPrivate: args.route.isPrivate, tried: [routeKey({ cli: args.cli, model: args.model })] } : undefined,
      doneFile: spec.done_when_file,
      locks: spec.locks,
      next: spec.next,
      detach: spec.detach,
      permission: spec.permission_mode,
      lane: spec.lane,
      guard: spec.guard,
    }
    const room = await roomFor($, args.cli, worker)
    if (!room.ok || launchQueue.length > 0) {
      await update($, workers, list => [...(list ?? []), { ...worker, status: 'queued' as const, now: L(`Queued: ${room.why || 'earlier agents waiting'}`, `Sırada: ${room.why || 'önceki ajanlar bekliyor'}`) }])
      launchQueue.push({ workerId: worker.id, prompt })
      return
    }
    if (freeSeen) freeSeen = { ...freeSeen, mb: freeSeen.mb - AGENT_RAM_MB[args.cli] }
    await update($, workers, list => [...(list ?? []), worker])
    namesTaken.delete(name)
    await startRun($, worker, prompt)
  } finally {
    namesTaken.delete(name)
  }
}

/** Starts a worker: outside the app where its CLI allows (so an app restart does not kill it), else as a child of this chat. */
async function startRun($: $T, w: SquadWorker, prompt: string) {
  // a retry never starts beside a live process of the same brief (30.10: two clean.ts runs crashed one GPU)
  if (w.runs > 1 && !mayStart(await agentAlive($, w))) {
    await patchWorker($, w.id, x => ({ ...x, now: L('The same job is already running: no second process started', 'Aynı iş zaten çalışıyor: ikinci süreç başlatılmadı') }))
    return
  }
  await takeLocks($, w)
  if (DETACHABLE[w.cli] && w.detach !== false) {
    try {
      if (await startDetached($, w, prompt)) {
        await saveRunWorkers($)
        return
      }
    } catch {
      // fall back to a child process
    }
  }
  void runWorker($, w, prompt, false).catch(() => undefined)
}

/**
 * A tier-routed worker that failed (exit 255, empty log, no report) is tried once more on the same route, quietly, then
 * moves to the next route of its tier. False when every route was tried: then the failure is reported as usual.
 */
/** Written into a detached run's stream when its process vanished without an exit code (its chief closed, or it was killed). */
export const GONE_MARK = '[the-chief] the OpenCode process ended without an exit code'
const ERROR_WORDS = /error|fail|refused|not found|unauthor|invalid|timed? ?out|rate limit|quota/i
/**
 * The real error in what the CLI printed, newest first, or null. A JSON event counts only when it is one (an error
 * event, an error field, a failed result, a tool that failed as the last steps): the word "error" inside a file it
 * read or a command it ran is not a cause (26.10: a tool_use line was named the cause of every DeepSeek death).
 */
export function errorLine(raw: readonly string[]): string | null {
  for (let i = raw.length - 1; i >= 0; i--) {
    const l = raw[i]!.trim()
    if (!l.startsWith('{')) {
      if (ERROR_WORDS.test(l) && !l.startsWith('[the-chief]')) return oneLine(l, 120)
      continue
    }
    let j: Record<string, unknown>
    try {
      j = JSON.parse(l) as Record<string, unknown>
    } catch {
      continue // a line cut at 600 characters: never an error event, those are short
    }
    const e = j.error as { message?: string; name?: string; data?: { message?: string } } | string | undefined
    if (j.type === 'error' || e) return oneLine(typeof e === 'string' ? e : e?.data?.message ?? e?.message ?? e?.name ?? L('error event', 'hata olayı'), 140)
    if (j.type === 'result' && j.is_error === true) return oneLine(String(j.result ?? L('error result', 'hatalı sonuç')), 140)
    const part = j.part as { tool?: string; state?: { status?: string; error?: string } } | undefined
    if (part?.state?.status === 'error' && i >= raw.length - 3) return L(`${part.tool ?? 'tool'} error: ${oneLine(String(part.state.error ?? ''), 110)}`, `${part.tool ?? 'araç'} hatası: ${oneLine(String(part.state.error ?? ''), 110)}`)
  }
  return null
}
/** The last thing the CLI did, for a run that ended with no error to show: "step_start", "tool_use (read)". */
export function lastEvent(raw: readonly string[]): string {
  const l = [...raw].reverse().find(x => x.trim() && !x.startsWith('[the-chief]'))?.trim() ?? ''
  if (!l) return L('no output', 'çıktı yok')
  const type = l.match(/^\{"type":"([\w.-]+)"/)?.[1]
  if (!type) return oneLine(l, 80)
  const tool = l.match(/"tool":"([\w.-]+)"/)?.[1]
  return tool ? `${type} (${tool})` : type
}
/** The root cause of a run that did not work, read from what the CLI printed: one short phrase for the leader. */
export function routeCause(raw: string[], code: number | null, failed: boolean, startErr: string, missing: boolean): string {
  const all = raw.join('\n')
  if (/command line is too long/i.test(all)) return L('command line too long ("The command line is too long.")', 'komut satırı çok uzun ("The command line is too long.")')
  const denied = raw.find(l => /permission requested|auto-rejecting|permission denied/i.test(l))
  if (denied) return `${L('permission denied', 'izin reddi')} (${oneLine(denied.replace(/^[!\s]+/, ''), 110)})`
  if (failed && startErr) return L(`did not start (${oneLine(startErr, 110)})`, `başlamadı (${oneLine(startErr, 110)})`)
  if (!raw.length) return L(`0 bytes of output (exit ${code ?? 'n/a'})`, `0 bayt çıktı (çıkış ${code ?? 'n/a'})`)
  const err = errorLine(raw)
  if (err) return `${err}${code != null ? L(` (exit ${code})`, ` (çıkış ${code})`) : ''}`
  if (raw.some(l => l.startsWith(GONE_MARK))) return L(`the chief closed or the process was killed from outside, the worker dropped (last event ${lastEvent(raw)})`, `şef kapandı ya da süreç dışarıdan öldürüldü, worker düştü (son olay ${lastEvent(raw)})`)
  if (missing) return L(`exit ${code ?? 'n/a'} but no report file (last event ${lastEvent(raw)})`, `çıkış ${code ?? 'n/a'} ama rapor dosyası yok (son olay ${lastEvent(raw)})`)
  return L(`no cause, exit ${code ?? 'n/a'}, last event ${lastEvent(raw)}`, `sebep yok, çıkış ${code ?? 'n/a'}, son olay ${lastEvent(raw)}`)
}
/** A route that did not work is never swallowed: the leader gets one line with the cause and what runs instead. */
async function tellRouteFailed($: $T, w: SquadWorker, cause: string, instead: string) {
  if (role !== 'chief' || !leaderSid) return
  try {
    await sendTo($, leaderSid, 'report', { line: oneLine(L(`${projectTitle()}/${w.name}: ${CLIS[w.cli].label} ${w.model} did not run — cause: ${cause}; ${instead}`, `${projectTitle()}/${w.name}: ${CLIS[w.cli].label} ${w.model} çalışmadı — sebep: ${cause}; ${instead}`), 500), isUrgent: true })
  } catch {
    // the headquarters folder is not writable: the worker's own log still has the cause
  }
}
async function routeFailover($: $T, w: SquadWorker, prompt: string, code: number | null, tail: string, cause = ''): Promise<boolean> {
  // never a second copy beside a live process of the same brief: the live run is followed, not replaced
  if (!mayStart(await agentAlive($, w))) {
    await patchWorker($, w.id, x => ({ ...x, now: L('The same job is still running: fallback route not started', 'Aynı iş hâlâ çalışıyor: yedek rota başlatılmadı') }))
    return true
  }
  const lines = `${tail}\n${cause}`.split(/\r?\n/)
  const authLine = lines.find(l => AUTH_RE.test(l))
  if (authLine) await markProviderDown($, w.cli, authLine).catch(() => undefined)
  // a limit the CLI named is marked for its reset first, so neither this failover nor the next spawn starts on it
  const limitLine = lines.find(l => realHit(RATE_RE, l))
  if (limitLine) await markLimited($, w.cli, w.model, limitLine)
  const route = w.route
  if (!route) return false
  const tier = route.tier as TierId
  let next: SquadWorker
  const startedAt = await $.clock.now()
  if (!route.retried && !limitLine) {
    next = { ...w, route: { ...route, retried: true }, resumeSession: false }
  } else {
    const list = await allowedModels($)
    const limited = await limitedNow($)
    const tried = [...new Set([...route.tried, routeKey(w)])]
    const allowed = list ? nextAllowed(list, tried, limited, { isPrivate: route.isPrivate }) : null
    const pick = list ? (allowed ? { ...allowed, effort: effortName(allowed.cli, w.effort ? EFFORTS.indexOf(w.effort as (typeof EFFORTS)[number]) : 2) } : null) : nextWorkerRoute(tier, new Set(tried), { limited, isPrivate: route.isPrivate, routes: await workerRoutes($) })
    if (!pick) {
      await tellRouteFailed($, w, cause, L('no fallback route left', 'yedek rota kalmadı'))
      return false
    }
    const cli = normalizeCli(pick.cli)
    const idx = EFFORTS.indexOf(pick.effort as (typeof EFFORTS)[number])
    next = { ...w, cli, model: pick.model, effort: pick.effort || null, sessionId: cli === 'claude' ? uuid() : null, resumeSession: false, env: await isolateOpencode($, cli, { ...(w.env ?? {}), ...(await apiCreditEnv($, cli)) }), route: { ...route, retried: false, tried: [...new Set([...tried, routeKey({ cli, model: pick.model })])] } }
  }
  await tellRouteFailed($, w, cause, route.retried || limitLine ? L(`falling back to ${CLIS[next.cli].label} ${next.model}`, `yedeğe düşüyor: ${CLIS[next.cli].label} ${next.model}`) : L('the same route will be retried once with the file method', 'aynı rota dosya yöntemiyle 1 kez yeniden denenecek'))
  const room = await roomFor($, next.cli, next)
  next = { ...next, status: room.ok ? 'running' : 'queued', startedAt, endedAt: null, exitCode: null, runs: w.runs + 1, now: L(`Route again: ${CLIS[next.cli].label} ${next.model}`, `Rota yeniden: ${CLIS[next.cli].label} ${next.model}`), tail: [...w.tail, `── ${CLIS[w.cli].label} ${w.model} ${L('failed (exit', 'başarısız (çıkış')} ${code ?? 'n/a'}): ${oneLine(tail, 100)} → ${CLIS[next.cli].label} ${next.model}`].slice(-TAIL) }
  await patchWorker($, w.id, () => next)
  if (!room.ok) launchQueue.push({ workerId: w.id, prompt })
  else await startRun($, next, prompt)
  return true
}

/** Agents that already got their one automatic repair try. */
const autoFixed = new Set<string>()
/** How long to wait before the one automatic repair of a failed CLI agent (0 = none): a rate limit waits longer. */
export function autoFixDelay(id: string, tail: string, tried: ReadonlySet<string> = autoFixed): number {
  if (tried.has(id)) return 0
  return RATE_RE.test(tail) ? 5 * 60000 : 60000
}
/** A failed CLI agent is told to find its error and carry on, once, before anyone is bothered: the leader only hears if that fails too. */
/** Agents whose automatic retry is waiting out its delay: stop_agent cancels it. */
const fixPending = new Set<string>()
async function scheduleAutoFix($: $T, id: string, delayMs: number, tail: string) {
  autoFixed.add(id)
  fixPending.add(id)
  await $.clock.sleep(delayMs)
  // stopped by hand while it waited: no retry
  if (!fixPending.delete(id)) return
  const { value = [] } = await $.state.get(WORKERS)
  const w = value.find(x => x.id === id)
  if (!w || w.status !== 'failed') return
  // never two workers in one folder: another one runs there now, so this retry is dropped
  if (value.some(x => x.id !== id && x.status === 'running' && (x.dir || cwd) === (w.dir || cwd))) {
    await patchWorker($, id, x => ({ ...x, now: L('Automatic retry cancelled: another worker is running in the same folder', 'Otomatik yeniden deneme iptal: aynı klasörde başka işçi çalışıyor') }))
    return
  }
  await followUp($, id, `Your last run failed. Find the cause in this output and fix it, then finish the job (change the approach if the same step fails twice; if it was a rate limit or a network error, simply retry the step):
${tail}`)
}

async function followUp($: $T, id: string, text: string) {
  const { value = [] } = await $.state.get(WORKERS)
  const w = value.find(x => x.id === id)
  if (!w) return
  // still running: the message waits for the next continue turn, never a second process
  if (w.status === 'running' || w.status === 'queued') {
    await patchWorker($, id, x => queueMessage(x, text))
    return
  }
  // never two live runs of one brief: a process of this agent still alive means no start, only a note (the message stays queued)
  if (!mayStart(await agentAlive($, w))) {
    await patchWorker($, id, x => ({ ...queueMessage(x, text), now: L('The same job is still running: no second process started', 'Aynı iş hâlâ çalışıyor: ikinci bir süreç başlatılmadı') }))
    return
  }
  const started = await $.clock.now()
  const next: SquadWorker = { ...w, status: 'running', startedAt: started, endedAt: null, exitCode: null, resumeSession: !!w.sessionId, now: L('Working on the follow-up message…', 'Takip mesajı üzerinde çalışıyor…'), runs: w.runs + 1, tail: [...w.tail, `── follow-up: ${oneLine(text, 120)}`].slice(-TAIL) }
  await patchWorker($, id, () => next)
  const prompt = w.sessionId
    ? text
    : `You are continuing an earlier run of agent ${w.name}. Its brief is ${w.brief}. Its last output was:\n${w.tail.slice(-10).join('\n')}\n\nNew instruction from the orchestrator: ${text}\nAct, do not just describe. Stop when it is done.`
  await runWorker($, next, prompt, true)
}

type Draft = { key?: string; endpoint?: string; models?: string; clearKey?: boolean }
/** What the person typed in Settings before Save, per provider; never drawn back. */
const draftMap = new Map<SquadCli, Draft>()
function drafts(cli: SquadCli): Draft {
  let d = draftMap.get(cli)
  if (!d) {
    d = {}
    draftMap.set(cli, d)
  }
  return d
}

/** This plugin's full ids as `claude plugin list` names them, installed ones before a --plugin-dir copy. */
async function selfIds($: $T): Promise<string[]> {
  // the id this copy runs under, read off its own folder: …/marketplaces/<marketplace>/<name> or the mods folder
  const root = $.plugin.root.replace(/\\/g, '/')
  const m = root.match(/\/marketplaces\/([^/]+)\/[^/]+\/?$/)
  const own = m ? `${$.plugin.name}@${m[1]}` : root.includes('/.claude/mods/') ? `${$.plugin.name}@inline` : ''
  if (own) return [own]
  try {
    const res = await $.process.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 60000 })
    const list = JSON.parse(res.stdout) as { id?: string; enabled?: boolean; hasUserConfig?: boolean }[]
    const mine = list.filter(p => typeof p.id === 'string' && p.id.startsWith('the-chief@') && p.enabled !== false)
    mine.sort((a, b) => Number(a.id!.endsWith('@inline')) - Number(b.id!.endsWith('@inline')) || Number(!!b.hasUserConfig) - Number(!!a.hasUserConfig))
    return mine.map(p => p.id!)
  } catch {
    return ['the-chief']
  }
}

/** Saves one plain option with `claude plugin configure`, and applies it in this session at once. */
async function saveOption($: $T, field: string, value: string) {
  opts = { ...opts, [field]: value }
  optOverrides = { ...optOverrides, [field]: value }
  await storeSet($, 'optOverrides', optOverrides)
  localSeen = null
  await update($, tick, n => (n ?? 0) + 1)
  for (const id of await selfIds($)) {
    try {
      const res = await $.process.run(['claude', 'plugin', 'configure', id, '--values-stdin'], { stdin: JSON.stringify({ [field]: value }), timeoutMs: 60000 })
      if (res.exitCode === 0) return
    } catch {
      // try the next id
    }
  }
}

/** This session already looked at the first-run setup (it is offered once a session at most). */
let setupTried = false
/** The first-run setup (hooks/setup.ts): asks the risky choices once and saves them as plain options. force: the owner asked for it again. */
async function firstSetup($: $T, force: boolean): Promise<string> {
  const now = await $.clock.now()
  const done = await $.store.get(SETUP_KEY).catch(() => undefined)
  const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
  if (!canAskSetup({ interactive, isWorker, role, surfaces, done, now, force })) return ''
  await storeSet($, SETUP_KEY, { state: 'asking', at: now })
  $.ui.log(setupInfo())
  const r = await runSetup({ ask: (q, o) => $.ui.ask(q, o), save: (f, v) => saveOption($, f, v) }, opt('api_daily_usd') || '10')
  await storeSet($, SETUP_KEY, { state: r.state, at: await $.clock.now() })
  const line = r.state === 'done'
    ? L(`The Chief setup saved (${r.summary}). Change it any time in /chief → Settings.`, `The Chief kurulumu kaydedildi (${r.summary}). İstediğin zaman /chief → Ayarlar'dan değiştir.`)
    : L('The Chief setup skipped: every risky option stays off. Run it any time with /chief setup.', 'The Chief kurulumu atlandı: riskli seçeneklerin hepsi kapalı kalır. İstediğin zaman /chief setup ile çalıştır.')
  void Promise.resolve($.ui.toast(line)).catch(() => undefined)
  return line
}

/** The person's language, once per session (see lang.ts); child processes get it as THE_CHIEF_LANG. */
async function decideLang($: $T): Promise<void> {
  const option = opt('language')
  const claudeLanguage = option === 'en' || option === 'tr' ? undefined : (await $.settings.read().catch(() => ({}) as Record<string, unknown>)).language
  const locales: (string | undefined)[] = []
  if (option !== 'en' && option !== 'tr' && !(typeof claudeLanguage === 'string' && claudeLanguage.trim())) {
    locales.push(await $.env.get('LC_ALL').catch(() => undefined), await $.env.get('LC_MESSAGES').catch(() => undefined), await $.env.get('LANG').catch(() => undefined))
    if (!locales.some(x => x && !/^(c|posix)([._].*)?$/i.test(x))) {
      // macOS: the language list of System Settings; Windows: the display language, else the region format
      const mac = await $.process.run(['defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 3000 }).catch(() => null)
      if (mac?.exitCode === 0) locales.push(firstAppleLanguage(mac.stdout))
      else {
        const ui = await $.process.run(['reg', 'query', 'HKCU\\Control Panel\\Desktop', '/v', 'PreferredUILanguages'], { timeoutMs: 3000 }).catch(() => null)
        const loc = ui?.exitCode === 0 ? null : await $.process.run(['reg', 'query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'], { timeoutMs: 3000 }).catch(() => null)
        locales.push((ui?.exitCode === 0 ? ui : loc)?.stdout.match(/REG_(?:MULTI_)?SZ\s+([A-Za-z-]+)/)?.[1])
      }
    }
  }
  setLang(pickLang({ option, claudeLanguage, locales }))
  await $.env.set('THE_CHIEF_LANG', getLang()).catch(() => undefined)
}

const FLAG_EN: Record<string, string> = { [FLAGS.open]: 'open 8+ hours', [FLAGS.context]: '150K+ context', [FLAGS.nudges]: 'many nudges', [FLAGS.subagents]: 'mostly subagents', [FLAGS.waiting]: "most turns 'waiting'" }
const flagLabel = (f: string) => L(FLAG_EN[f] ?? f, f)

// ---------- consultants: a second opinion from another model, through its own CLI, read-only ----------
export type ConsultRecord = { at: number; who: string; question: string; answer: string; ms: number; isAnswered: boolean }
/** This chat's consultations, newest first (kept in the store, shown in the pane). */
let consultLog: ConsultRecord[] = []
let consultLoaded = false
/** Who is being asked right now, for the pane. */
const consulting = new Set<string>()
const CONSULT_KEEP = 12
const consultantsNow = () => parseConsultants(opt('consultants'))
const platformNow = async ($: $T) => platformOf(cwd, (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '')

async function loadConsults($: $T) {
  if (consultLoaded || !sid) return
  consultLoaded = true
  const kept = await $.store.get(`consults:${sid}`).catch(() => undefined)
  if (Array.isArray(kept)) consultLog = kept as ConsultRecord[]
}

/** Asks one consultant and waits for its answer; a failure comes back as a few words, never as a throw. */
async function askConsultant($: $T, c: Consultant, prompt: string): Promise<{ isAnswered: boolean; text: string; ms: number }> {
  const started = await $.clock.now()
  const name = consultantName(c)
  const base = join(await hqDir($), 'consult', `${started}-${newId()}`)
  const outFile = `${base}.answer.md`
  let argv = consultArgv(c, prompt, outFile, isWindows())
  if (!argv) return { isAnswered: false, text: 'this CLI cannot be consulted', ms: 0 }
  consulting.add(name)
  await update($, tick, n => (n ?? 0) + 1)
  try {
    // cmd /c cuts a multi-line prompt at its first line, and a long one dies near 8k: then the question goes by file
    if (argv[0] === 'cmd' || promptByFile(argv, isWindows())) {
      const file = `${base}.question.md`
      await $.fs.write(file, prompt)
      argv = consultArgv(c, `Read the file ${file} and answer the question in it, following every instruction in it.`, outFile, isWindows())!
    }
    // Codex writes its last message here; the folder must exist before it does
    if (c.cli === 'codex') await $.fs.write(outFile, '')
    const env = { ...WORKER_ENV, ...(CONSULT_BIN[c.cli] === 'opencode' ? { OPENCODE_PERMISSION: '{"external_directory":"allow"}' } : {}), ...envFor(c.cli as SquadCli) }
    const res = await $.process.run(argv, { cwd: cwd || undefined, env, timeoutMs: CONSULT_TIMEOUT_MS })
    const fromFile = c.cli === 'codex' ? await readText($, outFile).catch(() => '') : ''
    const answer = cleanAnswer(fromFile.trim() || res.stdout)
    const ms = (await $.clock.now()) - started
    if (res.exitCode === 0 && answer) return { isAnswered: true, text: answer, ms }
    return { isAnswered: false, text: consultFailure(res.exitCode, res.stdout, res.stderr), ms }
  } catch (err) {
    return { isAnswered: false, text: consultFailure(-1, '', String(err)), ms: (await $.clock.now()) - started }
  } finally {
    consulting.delete(name)
    await update($, tick, n => (n ?? 0) + 1).catch(() => undefined)
  }
}

/** One consultation: the picked consultants are asked (a lone default one that fails hands over to the next), every answer is kept and returned. */
async function runConsult($: $T, a: Record<string, unknown>): Promise<string> {
  const all = consultantsNow()
  if (all.length === 0) return 'Consultants are off. The owner turns them on in ' + L('The Chief → Consult (option: consultants).', 'The Chief → Danışman (option: consultants).')
  const question = String(a.question ?? '').trim()
  if (question.length < 40) return 'Give the consultant the whole question: what is being decided, the options, the constraints, what you tried and what happened. It sees nothing of this chat.'
  // a private question never goes to a provider that keeps data (the free stops)
  const list = a.private === true ? all.filter(c => !isFreeEntry(c)) : all
  const ref = typeof a.consultant === 'string' && a.consultant.trim() ? a.consultant : undefined
  const picked = pickConsultants(list, ref, a.panel === true)
  if (picked.length === 0) return `No consultant matches "${ref ?? ''}". The owner's list: ${list.map((c, i) => `${i + 1}. ${consultantName(c)}`).join(', ') || '(empty)'}.`
  const files = Array.isArray(a.files) ? a.files.map(String).filter(Boolean).slice(0, 20) : []
  const prompt = consultPrompt(question, files, projectTitle())
  await loadConsults($)
  const results: { c: Consultant; r: { isAnswered: boolean; text: string; ms: number } }[] = []
  if (picked.length > 1) {
    results.push(...(await Promise.all(picked.map(async c => ({ c, r: await askConsultant($, c, prompt) })))))
  } else {
    // one consultant: when nobody was named and it gives no answer, the next in the list is asked instead
    const queue = ref ? picked : [picked[0]!, ...list.filter(c => c !== picked[0])]
    for (const c of queue) {
      const r = await askConsultant($, c, prompt)
      results.push({ c, r })
      if (r.isAnswered) break
    }
  }
  const at = await $.clock.now()
  consultLog = [...results.map(({ c, r }) => ({ at, who: consultantName(c), question: oneLine(typeof a.shown === 'string' && a.shown ? a.shown : question, 300), answer: r.isAnswered ? r.text.slice(0, 4000) : r.text, ms: r.ms, isAnswered: r.isAnswered })), ...consultLog].slice(0, CONSULT_KEEP)
  await storeSet($, `consults:${sid}`, consultLog).catch(() => undefined)
  await update($, tick, n => (n ?? 0) + 1)
  const answered = results.filter(x => x.r.isAnswered)
  const failed = results.filter(x => !x.r.isAnswered)
  const lines = [
    ...answered.map(({ c, r }) => `## ${consultantName(c)} (${fmtElapsed(r.ms)})\n${r.text}`),
    failed.length ? `No answer from: ${failed.map(({ c, r }) => `${consultantName(c)} (${r.text})`).join('; ')}.` : '',
    answered.length
      ? 'This is advice from another model, not a decision: check its factual claims against the code, decide yourself, and tell the owner whom you consulted and what you decided.'
      : 'No consultant answered. Carry on with your own judgement and tell the owner the consultation failed and why; a missing sign-in is fixed in ' + L('The Chief → Settings → Providers → Sign in.', 'The Chief → Ayarlar → Sağlayıcılar → Giriş yap.'),
  ]
  return lines.filter(Boolean).join('\n\n')
}

// ---------- logins: each CLI's own sign-in, opened in a real terminal; the plugin never sees a password ----------
type LoginSeen = { verdict: 'in' | 'out' | 'unknown' | 'missing'; at: number }
/** What each CLI last said about being signed in: asked when Settings opens or a button is pressed, never polled. */
let loginSeen: Record<string, LoginSeen> = {}
let loginChecking = false
let loginCheckedAt = 0

/** Reads every CLI's own "am I signed in" answer; only the verdict is kept, never the text (it holds an e-mail). */
async function checkLogins($: $T, only?: SquadCli) {
  if (loginChecking) return
  loginChecking = true
  await update($, tick, n => (n ?? 0) + 1)
  try {
    const ran = new Map<string, { code: number; out: string } | null>()
    for (const cli of CLI_ORDER) {
      const spec = LOGIN[cli]
      if (!spec?.status || (only && only !== cli)) continue
      const key = spec.status.join(' ')
      if (!ran.has(key)) {
        try {
          const res = await $.process.run(shim([...spec.status]), { timeoutMs: 20000, env: { ...WORKER_ENV } })
          ran.set(key, { code: res.exitCode, out: `${res.stdout}\n${res.stderr}` })
        } catch {
          ran.set(key, null)
        }
      }
      const r = ran.get(key)
      const at = await $.clock.now()
      loginSeen = { ...loginSeen, [cli]: { verdict: r ? (/command not found|not recognized as|ENOENT/i.test(r.out) ? 'missing' : loginVerdict(cli, r.code, r.out)) : 'missing', at } }
    }
    loginCheckedAt = await $.clock.now()
  } finally {
    loginChecking = false
    await update($, tick, n => (n ?? 0) + 1).catch(() => undefined)
  }
}

// ---------- health: a one-word test of each CLI, so a broken sign-in or an empty credit shows before a job lands on it ----------
type Health = Record<string, { verdict: PingVerdict; why: string; model: string; ms: number; at: number }>
const healthFile = async ($: $T) => join(await hqDir($), 'health.json')
/** A CLI is tested again after a day; every chat on this computer shares the answers (hq/health.json). */
export const HEALTH_EVERY_MS = 24 * 3600_000
const PING_TIMEOUT_MS = 90_000
let healthSeen: Health = {}
let healthChecking = false
const healthMode = () => (['auto', 'logins', 'off'].includes(opt('health_check')) ? opt('health_check') : 'auto')
const healthLine = (cli: string, h: Health[string]) => {
  const label = CLIS[cli as SquadCli]?.label ?? cli
  if (h.verdict === 'ok') return `\u2713 ${label}: ${L('answers', 'cevap veriyor')} (${h.model}, ${(h.ms / 1000).toFixed(1)} s)`
  if (h.verdict === 'missing') return `\u2013 ${label}: ${L('not installed', 'kurulu de\u011Fil')}`
  const fix = h.verdict === 'key' ? ` \u2192 ${L('fix', 'd\u00FCzelt')}: ${LOGIN[cli]?.login ?? L('its key in Settings', 'Ayarlardaki anahtar')}` : ''
  return `\u2717 ${label}: ${oneLine(h.why, 140)}${fix}`
}

/** A leader hears each refused sign-in, key or credit once per test result; no other chat gets a turn for it. */
async function tellLeaderHealth($: $T, seen: Health, now: number) {
  if (role !== 'leader') return
  for (const cli of CLI_ORDER) {
    const h = seen[cli]
    if (h?.verdict !== 'key' || (await $.store.get(`healthTold:${sid}:${cli}`).catch(() => 0)) === h.at) continue
    await storeSet($, `healthTold:${sid}:${cli}`, h.at).catch(() => undefined)
    raise(`health:${cli}`, `! ${healthLine(cli, h)}. ${L('Jobs skip it until it is fixed; the owner fixes the sign-in, then /chief-check.', '\u0130\u015Fler d\u00FCzelene kadar onu atl\u0131yor; giri\u015Fi sahibi d\u00FCzeltir, sonra /chief-check.')}`, false, now, 400)
  }
}

/**
 * Every CLI that is installed and signed in says one word on a small model. One that refuses its key or credit is
 * taken out of the routes (and the leader hears why); one that answers again is put back. By itself this runs once a
 * day for the whole computer; forced (the Settings button, /chief-check), every CLI is tested now.
 */
async function healthCheck($: $T, force = false): Promise<string> {
  if (healthChecking) return L('A check is already running.', 'Kontrol zaten s\u00FCr\u00FCyor.')
  const path = await healthFile($)
  const seen: Health = (await readJson<Health>($, path)) ?? {}
  healthSeen = seen
  const started = await $.clock.now()
  // a stamp that was never set is not "just now"
  const within = async (key: string, ms: number) => {
    const at = Number(await $.store.get(key).catch(() => 0)) || 0
    return at > 0 && started - at < ms
  }
  // another chat tested within the day, or is testing now: its answers are read, nothing runs twice
  if (!force && (healthMode() === 'off' || (await within('healthDoneAt', HEALTH_EVERY_MS)) || (await within('healthRunAt', 15 * 60000)))) {
    await tellLeaderHealth($, seen, started).catch(() => undefined)
    return ''
  }
  await storeSet($, 'healthRunAt', started).catch(() => undefined)
  healthChecking = true
  await update($, tick, n => (n ?? 0) + 1).catch(() => undefined)
  try {
    await checkLogins($).catch(() => undefined)
    if (force || healthMode() === 'auto') {
      for (const cli of CLI_ORDER) {
        const login = loginSeen[cli]?.verdict
        const key = CLIS[cli].key
        // not installed, or signed out with no key: the sign-in check already says so
        if (login === 'missing' || (login === 'out' && !(key && opt(key.field)))) {
          delete seen[cli]
          continue
        }
        const model = pingModel(modelsOf(cli))
        const outFile = join(await hqDir($), 'consult', `health-${cli}.md`)
        const argv = pingArgv(cli, model, outFile, isWindows())
        if (!argv) continue
        const at = await $.clock.now()
        const run = (a: string[]) => $.process.run(a, { cwd: cwd || undefined, env: { ...WORKER_ENV, THE_CHIEF_BOOTSTRAP: '1', ...envFor(cli) }, timeoutMs: PING_TIMEOUT_MS }).catch(err => ({ exitCode: -1, stdout: '', stderr: String(err) }))
        // Codex writes its last message to the file; the folder must exist before it does
        if (cli === 'codex') await $.fs.write(outFile, '').catch(() => undefined)
        let r = await run(argv)
        // a claude that does not know the flag yet: the same test without it
        if (cli === 'claude' && r.exitCode !== 0 && /unknown option/i.test(`${r.stderr}\n${r.stdout}`)) r = await run(argv.filter(x => x !== '--no-session-persistence'))
        const out = cli === 'codex' ? (await readText($, outFile).catch(() => '')).trim() || r.stdout : r.stdout
        const v = pingVerdict(r.exitCode, out, r.stderr, AUTH_RE, RATE_RE)
        seen[cli] = { ...v, model, ms: (await $.clock.now()) - at, at }
        if (v.verdict === 'key') await markProviderDown($, cli, v.why, true).catch(() => undefined)
        else if (v.verdict === 'ok') await clearProviderDown($, cli).catch(() => undefined)
      }
      await $.fs.write(path, JSON.stringify(seen)).catch(() => undefined)
      // a run that was cut off (the chat closed) leaves no stamp, so the next chat tests again
      await storeSet($, 'healthDoneAt', await $.clock.now()).catch(() => undefined)
    }
    healthSeen = seen
    await tellLeaderHealth($, seen, await $.clock.now()).catch(() => undefined)
    const lines = CLI_ORDER.filter(c => seen[c]).map(c => healthLine(c, seen[c]!))
    const bad = lines.filter(l => l.startsWith('\u2717'))
    if (bad.length) $.ui.toast(oneLine(bad.join(' \u00B7 '), 300))
    return lines.join('\n') || L('No CLI to test: none is installed and signed in.', 'Denenecek CLI yok: kurulu ve giri\u015Fli olan yok.')
  } finally {
    healthChecking = false
    await update($, tick, n => (n ?? 0) + 1).catch(() => undefined)
  }
}

/** Opens the CLI's sign-in in a terminal window on this computer. */
async function openLogin($: $T, cli: SquadCli): Promise<string> {
  const spec = LOGIN[cli]
  if (!spec) return L(`${CLIS[cli].label}: no sign-in command, works with an API key.`, `${CLIS[cli].label}: giriş komutu yok, API key ile çalışır.`)
  try {
    const res = await $.process.run(terminalArgv(spec.login, await platformNow($)), { timeoutMs: 15000 })
    if (res.exitCode !== 0) throw new Error(res.stderr)
    const said = L(`${CLIS[cli].label}: sign-in window opened (${spec.login}). When done, press "Check sign-ins".${spec.note ? ` ${spec.note}` : ''}`, `${CLIS[cli].label}: giriş penceresi açıldı (${spec.login}). Bitince "Kontrol et"e bas.${spec.note ? ` ${spec.note}` : ''}`)
    $.ui.toast(said)
    return said
  } catch {
    const said = L(`Could not open a terminal. Run this in your own terminal: ${spec.login}`, `Terminal açılamadı. Kendi terminalinde şunu çalıştır: ${spec.login}`)
    $.ui.toast(said)
    return said
  }
}

/** Which Settings page shows, which consultation is open in the Danışman tab, and the consultant list being typed. */
let settingsPage: 'providers' | 'startup' | 'spend' = 'providers'
/** The Oturum tab asks once more before a handoff: it ends with this chat archived. */
let handoffConfirm = false
let consultOpen = -1
let consultDraft: string | null = null

// ---------- saved prompts: one file on this machine (~/.claude/the-chief/prompts.json), never in the plugin folder ----------
let promptOpen = ''
let promptDelete = ''
/** The name typed for a new prompt while its text is asked for; null when no new prompt is being added. */
let promptName: string | null = null
/** An agent prompt that could not be copied, shown in its detail so it can be selected by hand. */
let uncopied = { key: '', text: '' }

async function promptsPath($: $T) {
  const home = isWindows() ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  return join(home ?? '.', '.claude', 'the-chief', 'prompts.json')
}

/** raw is null when there is no file, undefined when it exists but could not be read. */
async function loadPrompts($: $T): Promise<{ list: SavedPrompt[]; broken: boolean; raw: string | null | undefined }> {
  const path = await promptsPath($)
  if (!(await $.fs.exists(path).catch(() => false))) return { list: [], broken: false, raw: null }
  const raw = await $.fs.read(path).catch(() => undefined)
  if (raw === undefined) return { list: [], broken: true, raw }
  return { ...parsePrompts(raw), raw }
}

/** Changes the saved list. A file that is not a prompt list is moved aside first, never overwritten; one that cannot be read is left alone. */
async function changePrompts($: $T, fn: (list: SavedPrompt[]) => SavedPrompt[]): Promise<{ ok: boolean; aside?: string }> {
  const path = await promptsPath($)
  const cur = await loadPrompts($)
  let aside: string | undefined
  if (cur.broken) {
    if (typeof cur.raw !== 'string') return { ok: false }
    aside = path.replace(/\.json$/, `.broken-${await $.clock.now()}.json`)
    await $.fs.write(aside, cur.raw)
  }
  await $.fs.write(path, JSON.stringify(fn(cur.list), null, 2))
  void update($, tick, n => (n ?? 0) + 1)
  return { ok: true, aside }
}

async function savePrompt($: $T, name: string, text: string): Promise<string> {
  if (!text.trim()) return L('Nothing to save: the prompt is empty.', 'Kaydedilecek bir şey yok: prompt boş.')
  const at = await $.clock.now()
  let res = { name, added: false }
  try {
    const done = await changePrompts($, list => {
      const a = addPrompt(list, name, text, at)
      res = a
      return a.list
    })
    if (!done.ok) return L('Prompt not saved: the prompts file could not be read.', 'Prompt kaydedilmedi: prompt dosyası okunamadı.')
    const moved = done.aside ? L(` The old file could not be read and was kept as ${done.aside}.`, ` Eski dosya okunamadı, ${done.aside} olarak saklandı.`) : ''
    return (res.added ? L(`Prompt saved: ${res.name}`, `Prompt kaydedildi: ${res.name}`) : L(`Already saved: ${res.name}`, `Zaten kayıtlı: ${res.name}`)) + moved
  } catch (err) {
    return L(`Prompt not saved: ${oneLine(err instanceof Error ? err.message : String(err), 160)}`, `Prompt kaydedilmedi: ${oneLine(err instanceof Error ? err.message : String(err), 160)}`)
  }
}

async function deletePrompt($: $T, name: string): Promise<string> {
  try {
    const done = await changePrompts($, list => removePrompt(list, name))
    return done.ok ? L(`Prompt deleted: ${name}`, `Prompt silindi: ${name}`) : L('Prompt not deleted: the prompts file could not be read.', 'Prompt silinmedi: prompt dosyası okunamadı.')
  } catch (err) {
    return L(`Prompt not deleted: ${oneLine(err instanceof Error ? err.message : String(err), 160)}`, `Prompt silinmedi: ${oneLine(err instanceof Error ? err.message : String(err), 160)}`)
  }
}

/** The system clipboard: the engine's own copy first, then pbcopy (Mac) or PowerShell Set-Clipboard (Windows). True only when one of them took it. */
async function copyText($: $T, surface: string, text: string): Promise<boolean> {
  try {
    if ((await $.ui.copy({ text, surface: surface as never }))?.isCopied) return true
  } catch {
    // an older host has no $.ui.copy: the system tool below
  }
  try {
    const argv = isWindows()
      ? ['powershell', '-NoProfile', '-Command', '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']
      : ['pbcopy']
    const res = await $.process.run(argv, { stdin: text, timeoutMs: 10000, ...(isWindows() ? {} : { env: { LANG: 'en_US.UTF-8' } }) })
    return res.exitCode === 0
  } catch {
    return false
  }
}

/** The prompt an agent was started with: a subagent's prompt, or the text of a worker's brief file. */
async function agentPrompt($: $T, w: SquadWorker | undefined, s: SquadSub | undefined): Promise<string> {
  if (s) return s.prompt || s.description
  if (!w || !w.brief) return ''
  const body = /[\r\n]/.test(w.brief) ? '' : await readText($, w.brief).catch(() => '')
  return body.trim() ? body : w.brief
}

/** A question the owner typed (/consult, or the Danışman tab): their words are short, so what the chat is working on rides along. */
async function ownerConsult($: $T, question: string, panel: boolean): Promise<string> {
  const context = await recentRequests($).catch(() => '')
  const full = context ? `${question}\n\nWhat the asker is working on (its owner's requests in that chat):\n${context}` : question
  return runConsult($, { question: full.length < 40 ? `${full}\n(The question is short on purpose; answer it as asked.)` : full, panel, shown: question })
}

/** Names this chat again, now, from what the owner asked in it: for a chat whose first title came out wrong. */
async function retitleNow($: $T): Promise<string> {
  if (!appTools()) return L('The session name can only be changed in the desktop app.', 'Oturum adı yalnız masaüstü uygulamasında değiştirilebilir.')
  const about = (await recentRequests($)) || chiefConfig.goal || (await activeGoal($))
  if (!about) return L('This chat has no request to name it from yet.', 'Bu sohbette henüz ad çıkarılacak bir istek yok.')
  // the owner asked: no waiting for a clearer request
  titleWaits = TITLE_WAITS
  const title = await titleFor($, about)
  if (!title) return L('Could not make a name; try again after some work.', 'Ad çıkarılamadı; biraz iş yaptıktan sonra yeniden dene.')
  const p = portsOf($)
  // asked for by the owner, so an earlier hand-made or automatic title does not stand in the way
  await patchSess(p, sid, () => ({ userRenamed: false, title: '' }))
  const r = await renameSession(p, sid, `local_${sid}`, title, true)
  if (r === 'done') titlesReadAt = 0
  return r === 'failed' ? L('Could not change the session name.', 'Oturum adı değiştirilemedi.') : L(`Session renamed to "${title}".`, `Oturum adı "${title}" yapıldı.`)
}

// ---------- model lists: live from the CLI where it can list them, a day in the store ----------
/** What each CLI last listed (kept in the store for a day), and when a try last came back empty. */
let modelCache: ModelCache = {}
const modelTried = new Map<string, number>()
const modelLoading = new Set<string>()
const MODEL_RETRY_MS = 10 * 60_000

/** The models a CLI offers: its built-in or configured list, then what it listed itself. */
const modelChoices = (cli: SquadCli) => mergeModels(modelsOf(cli), modelCache[cli]?.models ?? [])
/** The engine refuses a Select with more than 64 options (and then draws nothing of the pane): the first 64, the picked one always among them. */
export const SELECT_MAX = 64
export function selectOptions<T extends { value: string }>(options: readonly T[], value?: string): T[] {
  const seen = new Set<string>()
  const unique = options.filter(o => !seen.has(o.value) && !!seen.add(o.value))
  const picked = unique.find(o => o.value === value)
  const head = unique.slice(0, SELECT_MAX)
  return picked && !head.includes(picked) ? [...head.slice(0, SELECT_MAX - 1), picked] : head
}

/** Asks a CLI for its models (a day's cache is used unless `force`, the refresh button); a CLI with no list command keeps its own list. */
async function refreshModels($: $T, cli: SquadCli, force: boolean) {
  const cmd = LIST_COMMANDS[cli]
  const now = await $.clock.now()
  if (!cmd || modelLoading.has(cli) || (!force && (cacheFresh(modelCache[cli], now) || now - (modelTried.get(cli) ?? -Infinity) < MODEL_RETRY_MS))) return
  modelLoading.add(cli)
  modelTried.set(cli, now)
  try {
    const res = await $.process.run(shim(cmd), { env: envFor(cli), timeoutMs: 60000 })
    const models = res.exitCode === 0 ? parseModelList(cli, res.stdout) : []
    if (models.length) {
      modelCache = { ...modelCache, [cli]: { at: now, models } }
      await storeSet($, 'modelCache', modelCache)
    } else if (force) $.ui.toast(L(`${CLIS[cli].label}: could not read the model list`, `${CLIS[cli].label}: model listesi okunamadı`))
  } catch {
    if (force) $.ui.toast(L(`${CLIS[cli].label}: could not read the model list`, `${CLIS[cli].label}: model listesi okunamadı`))
  } finally {
    modelLoading.delete(cli)
    await update($, tick, n => (n ?? 0) + 1)
  }
}

// ---------- "Çok harcayanlar": which sessions use the most quota, from Claude Code's own transcripts ----------
type SpendWindowKey = keyof SpendResult['windows']
let spend: { result: SpendResult | null; busy: boolean; error: string; window: SpendWindowKey } = { result: null, busy: false, error: '', window: '24h' }
const SPEND_TTL_MS = 5 * 60_000

/** The weekly limit's reset time as far as any reading says (a past one is fine: the scan rolls it forward), else ''. */
async function weekResetKnown($: $T): Promise<string> {
  const shared = await readSharedLimits($).catch(() => null)
  const times = [limitsNow.week?.resetsAt, ownLimits.week?.resetsAt, shared?.week?.resetsAt].filter((x): x is string => !!x && Number.isFinite(Date.parse(x)))
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? ''
}

/** Runs the transcript scan when the panel opens and the last result is older than 5 minutes (or `force`); one scan at a time. */
async function ensureSpend($: $T, force = false) {
  const now = await $.clock.now()
  if (spend.busy || (!force && spend.result && now - spend.result.at < SPEND_TTL_MS)) return
  spend = { ...spend, busy: true, error: '' }
  try {
    const script = `${$.plugin.root.replace(/[\\/]+$/, '')}/hooks/spend-scan.mjs`
    const reset = await weekResetKnown($)
    const res = await $.process.run(['node', '--no-warnings', script, ...(reset ? [`--week-reset=${reset}`] : [])], { timeoutMs: 600_000 })
    if (res.exitCode !== 0) throw new Error(oneLine(res.stderr || res.stdout, 160) || `exit ${res.exitCode}`)
    spend = { ...spend, result: { ...(JSON.parse(res.stdout) as SpendResult), at: now } }
  } catch (err) {
    spend = { ...spend, error: err instanceof Error ? oneLine(err.message, 160) : String(err) }
  } finally {
    spend = { ...spend, busy: false }
    await update($, tick, n => (n ?? 0) + 1)
  }
}

/** Saves one provider's settings with `claude plugin configure`: keys land in secure storage. */
async function saveSettings($: $T, cli: SquadCli) {
  const spec = CLIS[cli]
  const d = drafts(cli)
  const values: Record<string, string> = {}
  if (spec.key && d.clearKey) values[spec.key.field] = ''
  else if (spec.key && d.key?.trim()) values[spec.key.field] = d.key.trim()
  if (spec.endpoint && d.endpoint !== undefined) values[spec.endpoint.field] = d.endpoint.trim()
  if (d.models !== undefined) values[`${cli.replace(/-/g, '_')}_models`] = d.models.split(',').map(m => m.trim()).filter(Boolean).join(', ')
  if (Object.keys(values).length === 0) {
    $.ui.toast('Nothing to save')
    return
  }
  let saved = false
  let why = ''
  for (const id of await selfIds($)) {
    try {
      const res = await $.process.run(['claude', 'plugin', 'configure', id, '--values-stdin'], { stdin: JSON.stringify(values), timeoutMs: 60000 })
      if (res.exitCode === 0) {
        saved = true
        break
      }
      why = oneLine(res.stderr || res.stdout, 160) || `exit ${res.exitCode}`
    } catch (err) {
      why = err instanceof Error ? err.message : String(err)
    }
  }
  if (!saved) {
    $.ui.toast(`Could not save: ${why || 'the-chief is not installed'}`)
    return
  }
  // what is saved applies at once in this session too
  opts = { ...opts, ...values }
  if (spec.key && (d.clearKey || values[spec.key.field])) {
    const has = !d.clearKey
    await update($, savedKeysAtom, list => (has ? [...new Set([...(list ?? []), cli])] : (list ?? []).filter(x => x !== cli)))
  }
  draftMap.delete(cli)
  await $.state.set(EDITING, null)
  $.ui.toast(`${spec.label} saved`)
}

/** User-level startup defaults; the CLI remains the authority for plugin enablement. */
async function refreshStartup($: $T) {
  try {
    const [plugins, skills] = await Promise.all([
      $.process.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 60000 }),
      $.process.run(['node', join($.plugin.root, 'scripts', 'startup-settings.mjs'), 'list'], { timeoutMs: 30000 }),
    ])
    if (plugins.exitCode !== 0 || skills.exitCode !== 0) throw new Error(oneLine(plugins.stderr || skills.stderr || L('Could not read the settings', 'Ayarlar okunamadı'), 180))
    const p = JSON.parse(plugins.stdout) as { id?: string; enabled?: boolean; scope?: string }[]
    const sk = JSON.parse(skills.stdout) as { name: string; value: string; source: string }[]
    await $.state.set(STARTUP, { plugins: p.filter(x => typeof x.id === 'string').map(x => ({ id: x.id!, enabled: x.enabled !== false, scope: x.scope ?? '' })), skills: sk, error: '', loaded: true })
  } catch (err) {
    await $.state.set(STARTUP, { plugins: [], skills: [], error: oneLine(err instanceof Error ? err.message : String(err), 180), loaded: false })
  }
}
async function toggleStartupPlugin($: $T, id: string, enable: boolean) {
  try {
    const result = await $.process.run(['claude', 'plugin', enable ? 'enable' : 'disable', id, '--scope', 'user'], { timeoutMs: 60000 })
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || L('The plugin setting did not change', 'Plugin ayarı değişmedi'))
    await refreshStartup($)
    $.ui.toast(L('Plugin setting saved; applies in new sessions', 'Plugin ayarı kaydedildi; yeni oturumlarda uygulanır'))
  } catch (err) { $.ui.toast(`Plugin: ${oneLine(err instanceof Error ? err.message : String(err), 180)}`) }
}
async function toggleStartupSkill($: $T, name: string, enable: boolean) {
  try {
    const result = await $.process.run(['node', join($.plugin.root, 'scripts', 'startup-settings.mjs'), 'set', name, enable ? 'on' : 'off'], { timeoutMs: 30000, env: { THE_CHIEF_LANG: getLang() } })
    if (result.exitCode !== 0) throw new Error(result.stderr || L('The skill setting did not change', 'Skill ayarı değişmedi'))
    await refreshStartup($)
    $.ui.toast(L('Skill setting saved; applies in new sessions', 'Skill ayarı kaydedildi; yeni oturumlarda uygulanır'))
  } catch (err) { $.ui.toast(`Skill: ${oneLine(err instanceof Error ? err.message : String(err), 180)}`) }
}

async function openPane($: $T) {
  await $.ui.open({ id: PANE, title: 'The Chief', focus: true, closeOnEscape: true, rows: 38, columns: 90 })
}

// ---------- reading what an agent does, with no model: its own JSON events, else plain-text patterns ----------
/** The CLIs' tool names in their own spelling, as stepText knows them. */
const TOOL_ALIAS: Record<string, string> = {
  read: 'Read', read_file: 'Read', view: 'Read', cat: 'Read',
  edit: 'Edit', multiedit: 'MultiEdit', apply_patch: 'Edit', patch: 'Edit', str_replace: 'Edit', write: 'Write', write_file: 'Write', create: 'Write',
  bash: 'Bash', shell: 'Bash', exec: 'Bash', run: 'Bash', command: 'Bash', terminal: 'Bash',
  grep: 'Grep', search: 'Grep', glob: 'Glob', ls: 'Glob', list: 'Glob',
  webfetch: 'WebFetch', fetch: 'WebFetch', websearch: 'WebSearch', task: 'Agent', agent: 'Agent',
}
const toolName = (raw: string) => TOOL_ALIAS[raw.toLowerCase().replace(/[\s-]/g, '_')] ?? raw

/** The args a step line reads, whatever the CLI calls them. */
function stepArgs(input: Record<string, unknown>): Record<string, unknown> {
  const str = (...keys: string[]) => keys.map(k => input[k]).find(v => typeof v === 'string') as string | undefined
  return {
    command: str('command', 'cmd') ?? (Array.isArray(input.command) ? (input.command as unknown[]).join(' ') : undefined),
    file_path: str('file_path', 'filePath', 'path', 'file', 'target_file'),
    pattern: str('pattern', 'query', 'regex'),
    description: str('description', 'prompt'),
    url: str('url'),
  }
}

export type AgentEvent = { line: string; step?: string; isFinal?: boolean; usd?: number; said?: string }

/** One line of an agent's stdout, read: a step it took, its final answer, or a plain line; null is noise. */
export function readAgentLine(raw: string): AgentEvent | null {
  const line = raw.trim()
  if (!line) return null
  if (line[0] !== '{') return readPlainLine(line)
  let o: Record<string, any>
  try {
    o = JSON.parse(line)
  } catch {
    return readPlainLine(line)
  }
  const step = (name: string, input: unknown) => {
    const s = stepText(toolName(name), stepArgs((input ?? {}) as Record<string, unknown>))
    return { line: s, step: s }
  }
  // Claude Code, Qoder, Cursor: stream-json
  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    const blocks = o.message.content as Record<string, any>[]
    const tool = [...blocks].reverse().find(b => b.type === 'tool_use')
    if (tool) return step(String(tool.name ?? ''), tool.input)
    const text = blocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join(' ').trim()
    return text ? { line: oneLine(text, 200), said: text } : null
  }
  if (o.type === 'result') return { line: L(`Result: ${oneLine(String(o.result ?? o.subtype ?? ''), 180)}`, `Sonuç: ${oneLine(String(o.result ?? o.subtype ?? ''), 180)}`), isFinal: true, ...(typeof o.total_cost_usd === 'number' ? { usd: o.total_cost_usd } : {}) }
  // Codex: --json items
  const item = o.item as Record<string, any> | undefined
  if (item && typeof item.type === 'string') {
    if (item.type === 'command_execution') return step('Bash', { command: item.command })
    if (item.type === 'file_change') return step('Edit', { file_path: item.changes?.[0]?.path })
    if (item.type === 'mcp_tool_call') return step(String(item.tool ?? 'mcp'), item.arguments)
    if (item.type === 'web_search') return step('WebSearch', { query: item.query })
    if (item.type === 'agent_message' && o.type === 'item.completed') return { line: oneLine(String(item.text ?? ''), 200), said: String(item.text ?? '') }
    return null
  }
  // OpenCode: --format json parts
  const part = (o.part ?? o) as Record<string, any>
  if (typeof part.tool === 'string') return step(part.tool, part.state?.input ?? part.input ?? part.args)
  if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) return { line: oneLine(part.text, 200), said: part.text }
  // Gemini CLI: stream-json messages
  if (o.type === 'message' && o.role === 'assistant' && typeof o.content === 'string' && o.content.trim()) return { line: oneLine(o.content, 200), said: o.content }
  // anything else that names a tool and its input
  const name = o.name ?? o.tool ?? o.tool_name
  const input = o.input ?? o.arguments ?? o.args ?? o.parameters
  if (typeof name === 'string' && input && typeof input === 'object') return step(name, input)
  return null
}

/**
 * One raw CLI line as the lines a terminal would have shown: "$ command", its output indented, "● " for what the agent
 * said, "✗ " for an error, "▸ Tool arg" for a tool that is not a shell. Pure, so it is tested; a plain-text line is
 * already terminal output and passes through. A JSON line cut at 600 characters gives nothing.
 */
export function terminalOf(raw: string): string[] {
  const line = raw.trim()
  if (!line) return []
  const cut = (t: string) => (t.length > 400 ? `${t.slice(0, 400)}…` : t)
  if (line[0] !== '{') return [cut(line)]
  let o: Record<string, any>
  try {
    o = JSON.parse(line)
  } catch {
    return []
  }
  const rows = (t: unknown) => String(t ?? '').split(/\r?\n/).filter(l => l.trim())
  const say = (t: unknown) => rows(t).slice(0, 30).map((l, i) => `${i === 0 ? '● ' : '│ '}${cut(l)}`)
  const out = (t: unknown) => {
    const ls = rows(t)
    const shown = ls.slice(0, 2).map(l => `  ${cut(l)}`)
    return ls.length > 2 ? [...shown, L(`  … +${ls.length - 2} lines`, `  … +${ls.length - 2} satır`)] : shown
  }
  const call = (name: string, input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>
    const cmd = i.command ?? i.cmd
    if (typeof cmd === 'string' && cmd.trim()) return [`$ ${cut(cmd.split(/\r?\n/)[0]!)}`]
    const file = i.file_path ?? i.filePath ?? i.path
    const arg = file ? baseName(String(file)) : i.pattern ?? i.query ?? i.url ?? ''
    return [`▸ ${toolName(name)}${arg ? ` ${cut(String(arg))}` : ''}`]
  }
  // Claude Code, Qoder, Cursor: stream-json
  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    return (o.message.content as Record<string, any>[]).flatMap(b => (b.type === 'text' ? say(b.text) : b.type === 'tool_use' ? call(String(b.name ?? ''), b.input) : []))
  }
  if (o.type === 'user' && Array.isArray(o.message?.content)) {
    return (o.message.content as Record<string, any>[]).flatMap(b => {
      if (b.type !== 'tool_result') return []
      const text = Array.isArray(b.content) ? b.content.map((c: Record<string, any>) => c.text ?? '').join('\n') : b.content
      const lines = out(text)
      return b.is_error && lines.length ? [`✗ ${lines[0]!.trim()}`, ...lines.slice(1)] : lines
    })
  }
  if (o.type === 'result') return [`■ ${oneLine(String(o.result ?? o.subtype ?? ''), 300)}`]
  if (o.type === 'error') return [`✗ ${oneLine(String(o.error?.data?.message ?? o.error?.message ?? o.message ?? L('error', 'hata')), 300)}`]
  // Codex: --json items
  const item = o.item as Record<string, any> | undefined
  if (item && typeof item.type === 'string') {
    if (o.type !== 'item.completed') return []
    if (item.type === 'command_execution') return [...call('Bash', { command: item.command }), ...out(item.aggregated_output)]
    if (item.type === 'file_change') return call('Edit', { file_path: item.changes?.[0]?.path })
    if (item.type === 'mcp_tool_call') return call(String(item.tool ?? 'mcp'), item.arguments)
    if (item.type === 'agent_message') return say(item.text)
    return []
  }
  // OpenCode: --format json parts (a tool is told once, when it ends)
  const part = (o.part ?? o) as Record<string, any>
  if (typeof part.tool === 'string') {
    const st = part.state as Record<string, any> | undefined
    if (!st) return call(part.tool, part.input ?? part.args)
    if (st.status === 'error') return [...call(part.tool, st.input), `✗ ${oneLine(String(st.error ?? L('error', 'hata')), 300)}`]
    if (st.status === 'completed') {
      const c = call(part.tool, st.input)
      return c[0]!.startsWith('$ ') ? [...c, ...out(st.output)] : c
    }
    return []
  }
  if (part.type === 'text' && typeof part.text === 'string') return say(part.text)
  // Gemini CLI: stream-json messages
  if (o.type === 'message' && o.role === 'assistant' && typeof o.content === 'string') return say(o.content)
  return []
}
/** A tail line that is a tool step ("Komut: …", "Okuyor: …"), not something the agent wrote. */
export const STEP_LINE = /^(Komut|Okuyor|Düzenliyor|Arıyor|Dosya buluyor|Web'de|Alt ajana|Testleri|Tipleri|Git:|Hata:|──|Sonuç:|\[the-chief\]|Command|Reading|Editing|Searching|Finding files|Researching the web|Handing off|Running tests|Checking types|Error:|Result:)/
/** The last thing an agent wrote itself: its saved text, else the newest tail line that is not a tool step. Pure, so it is tested. */
export function saidOf(w: { said?: string; tail: readonly string[] }): string {
  if (w.said) return w.said
  return [...w.tail].reverse().find(l => l.trim() && !STEP_LINE.test(l.trim())) ?? ''
}
const termBuf = new Map<string, string[]>()
const TERM_LINES = 500
export const termPath = (w: { name: string; runs: number; logRoot?: string }) => workerLogPath(w, true).replace(/\.raw\.log$/, '.term.log')
/** Adds lines to an agent's terminal transcript (kept in memory and in its log folder), so the pane can draw it as a terminal. */
async function appendTerm($: $T, w: { id: string; name: string; runs: number; logRoot?: string }, add: string[]) {
  if (!add.length) return
  const have = termBuf.get(w.id) ?? (await readText($, termPath(w)).catch(() => '')).split('\n').filter(Boolean)
  const next = [...have, ...add].slice(-TERM_LINES)
  termBuf.set(w.id, next)
  await $.fs.write(termPath(w), next.join('\n')).catch(() => undefined)
}
/** The last lines of an agent's terminal transcript; empty when it has none yet. */
async function readTerm($: $T, w: { id: string; name: string; runs: number; logRoot?: string } | undefined, n = 60): Promise<string[]> {
  if (!w) return []
  const lines = termBuf.get(w.id) ?? (await readText($, termPath(w)).catch(() => '')).split('\n').filter(Boolean)
  return lines.slice(-n)
}

/** A plain-text line: a step when it reads like one, else the line as it came. */
export function readPlainLine(line: string): AgentEvent {
  const file = line.match(/([\w.\-]+[\\/])*[\w.\-]+\.[a-z]{1,6}\b/i)?.[0]
  const shell = line.match(/^\s*[$>]\s+(.+)$/)?.[1]
  let step: string | undefined
  if (shell) step = stepText('Bash', { command: shell })
  else if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|cargo test|go test/i.test(line)) step = L('Running tests', 'Testleri çalıştırıyor')
  else if (/\b(tsc|typecheck|eslint)\b/i.test(line)) step = L("Checking types and lint", "Tipleri ve lint'i kontrol ediyor")
  else if (file && /\b(edit(ing|ed)?|modif(y|ying|ied)|writ(e|ing|ten)|creat(e|ing|ed)|updat(e|ing|ed)|patch(ing|ed)?)\b/i.test(line)) step = L(`Editing: ${baseName(file)}`, `Düzenliyor: ${baseName(file)}`)
  else if (file && /\b(read(ing)?|open(ing)?|view(ing)?|inspect(ing)?|look(ing)? at)\b/i.test(line)) step = L(`Reading: ${baseName(file)}`, `Okuyor: ${baseName(file)}`)
  else if (/\bgit (commit|push|diff|status|checkout|merge)\b/i.test(line)) step = `Git: ${oneLine(line.match(/git .+/i)![0], 40)}`
  else if (/\b(error|failed|exception|traceback)\b/i.test(line)) step = L(`Error: ${oneLine(line, 70)}`, `Hata: ${oneLine(line, 70)}`)
  return { line: oneLine(line, 300), step }
}

// ---------- telling the chief: problems and endings, batched, one short line each ----------
type Alert = { key: string; line: string; isUrgent: boolean; at: number }
/** Waiting to be told, oldest first. */
export const alerts: Alert[] = []
/** When each alert key was last raised, so a state is told once, not every tick. */
const alertedAt = new Map<string, number>()
/** The last sign of life per agent (an output line, a tool call). */
const lastActivity = new Map<string, number>()
/** Consecutive failed tool calls per subagent. */
const subErrors = new Map<string, number>()
let toldToolHint = false

const WAIT_RE = /\(y\/n\)|\[y\/n\]|\by\/n\b|press (enter|any key)|waiting for (approval|input|confirmation|user)|do you want to|are you sure|continue\?|approve\b|allow this/i
/** CLIs that hit a rate or usage limit lately (until when): spawn_worker routes around them. */
const cliLimitedUntil = new Map<string, number>()
export const CLI_LIMIT_MS = 30 * 60000
let routeSpread = 0
const RATE_RE = /rate.?limit|\b429\b|quota (exceeded|reached)|too many requests|usage limit|try again (later|in)/i
export const ERROR_RE = /\b(error|exception|traceback|fatal|failed|panic)\b/i
/** A tail line that is the worker's own command (a grep for "error TS", a shell it opened), not output of that command. */
const COMMAND_LINE_RE = /^\s*(\$|>|→|⚙|▶|run:|bash\b|cmd\b|powershell\b|pwsh\b|command:|tool:|(?:Bash|Run|Read|Grep|Glob|Tool)\()|\b(grep|rg|ripgrep|findstr|select-string|ack)\b[^\n]*["']/i
/** The line without file names and paths (`rate-limit.ts`, `src/errors/failed.test.ts`): words in a name are no alarm. */
const stripNames = (l: string) => l.replace(/[\w@.\\/-]*(?:[\\/]|\w\.\w)[\w@.\\/-]*/g, ' ')
/** Whether a tail line is real output matching the pattern: command text and words inside file names do not count. Pure, so it is tested. */
export function realHit(re: RegExp, line: string): boolean {
  return !COMMAND_LINE_RE.test(line) && re.test(stripNames(line))
}
/** A provider that will not work until someone acts: a key that expired or was refused, no credit left. */
export const AUTH_RE = /api[ _-]?key.{0,40}(expired|invalid|revoked|not valid)|(invalid|expired|incorrect) (api[ _-]?)?key|\bunauthori[sz]ed\b|\b401\b|authentication (failed|error)|token (has )?expired|credit balance is too low|insufficient (credit|balance|funds|quota)|payment required|\b402\b/i
/** How long a provider that failed so stays skipped by every chat's routes (hq/providers.json). */
export const PROVIDER_DOWN_MS = 6 * 3600000
type ProviderDown = Record<string, { until: number; cause: string; at: number }>
const providersFile = async ($: $T) => join(await hqDir($), 'providers.json')

/** A quota that does not clear in minutes: "Go usage limit exceeded", "Free usage limit reached", a weekly cap. */
export const USAGE_RE = /usage limit|weekly limit|limit (?:exceeded|reached)|quota (?:exceeded|reached)|out of (?:credits|quota)|insufficient quota/i
/** A quota that names no reset keeps its CLI out for a work day; nothing past a week is believed. */
export const USAGE_LIMIT_MS = 6 * 3600000
export const LIMIT_MAX_MS = 7 * 24 * 3600000
const RESET_UNIT: Record<string, number> = { s: 1000, sec: 1000, second: 1000, m: 60000, min: 60000, minute: 60000, h: 3600000, hr: 3600000, hour: 3600000, d: 86400000, day: 86400000, w: 604800000, week: 604800000 }
/**
 * How long a limit line keeps its CLI out: the reset the line itself names ("resets in 3 hours", "resets at
 * 2026-11-02T00:00"), else 6 h for a quota and the usual 30 minutes for a plain rate limit. Pure, so it is tested.
 */
export function limitSkipMs(line: string, now: number): number {
  const iso = line.match(/resets?\D{0,12}(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?Z?)/i)?.[1]
  if (iso) {
    const t = Date.parse(`${iso.replace(' ', 'T')}${iso.endsWith('Z') ? '' : 'Z'}`)
    if (Number.isFinite(t)) return clamp(t - now, 60000, LIMIT_MAX_MS)
  }
  const rel = line.match(/resets?\D{0,12}(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|s|m|h|d|w)\b/i)
  if (rel) {
    const raw = rel[2]!.toLowerCase()
    const ms = Number(rel[1]) * (RESET_UNIT[raw.length > 1 && raw.endsWith('s') ? raw.slice(0, -1) : raw] ?? 0)
    if (ms > 0) return clamp(ms, 60000, LIMIT_MAX_MS)
  }
  return USAGE_RE.test(line) ? USAGE_LIMIT_MS : CLI_LIMIT_MS
}

/** The keys a limit covers: the CLI as a whole and this exact model of it. */
const limitKeys = (cli: string, model: string) => (model ? [cli, routeKey({ cli, model })] : [cli])
/** Every chat's limits, shared the way a provider that is down is (hq/cli-limits.json). */
const cliLimitsFile = async ($: $T) => join(await hqDir($), 'cli-limits.json')
type CliLimit = Record<string, { until: number; cause: string; at: number }>

/**
 * A worker hit its limit: the CLI and that model stay out of the routes here — and, kept in hq/cli-limits.json, in
 * every other chat on this computer — until the reset the CLI named, so the next spawn does not start on it again.
 */
async function markLimited($: $T, cli: SquadCli, model: string, line: string) {
  const now = await $.clock.now()
  const until = now + limitSkipMs(line, now)
  for (const key of limitKeys(cli, model)) if ((cliLimitedUntil.get(key) ?? 0) < until) cliLimitedUntil.set(key, until)
  try {
    const path = await cliLimitsFile($)
    const saved = (await readJson<CliLimit>($, path)) ?? {}
    for (const key of limitKeys(cli, model)) if (!saved[key] || saved[key]!.until < until) saved[key] = { until, cause: oneLine(line, 160), at: now }
    await $.fs.write(path, JSON.stringify(saved))
  } catch {
    // headquarters is not writable: this chat still skips the model
  }
}

/** CLIs and models no new worker should land on now: this chat's limits, every chat's limits and providers that are down. */
async function limitedNow($: $T): Promise<Set<string>> {
  const now = await $.clock.now()
  const out = new Set([...cliLimitedUntil].filter(([, until]) => until > now).map(([c]) => c))
  for (const [key, d] of Object.entries((await readJson<CliLimit>($, await cliLimitsFile($))) ?? {})) if (d && d.until > now) out.add(key)
  const down = (await readJson<ProviderDown>($, await providersFile($))) ?? {}
  for (const [cli, d] of Object.entries(down)) if (d && d.until > now) out.add(cli)
  return out
}

/** A provider that failed on its key or credit is skipped by every chat for 6 hours; the leader hears it once. */
async function markProviderDown($: $T, cli: string, line: string, quiet = false) {
  const now = await $.clock.now()
  const path = await providersFile($)
  const down = (await readJson<ProviderDown>($, path)) ?? {}
  if (down[cli] && down[cli]!.until > now) return
  down[cli] = { until: now + PROVIDER_DOWN_MS, cause: oneLine(line, 160), at: now }
  await $.fs.write(path, JSON.stringify(down))
  // the daily test runs in whatever chat is open: it never starts a turn there, the leader is told by tellLeaderHealth
  if (quiet) return
  const label = CLIS[cli as SquadCli]?.label ?? cli
  raise(`provider:${cli}`, L(`! ${label} is off (${oneLine(line, 100)}): skipped for 6 hours, jobs fall back to the next route (last: Sonnet on API credit). Once the sign-in or key is fixed, run /chief-check: a test that passes turns it back on.`, `! ${label} kapalı (${oneLine(line, 100)}): 6 saat atlanıyor, işler yedek rotaya (en son API kredisiyle Sonnet) düşüyor. Giriş ya da anahtar düzelince /chief-check çalıştır: geçen deneme onu geri açar.`), true, now, 400)
}

/** A provider that answers again is back in the routes at once. */
async function clearProviderDown($: $T, cli: string) {
  const path = await providersFile($)
  const down = (await readJson<ProviderDown>($, path)) ?? {}
  if (!down[cli]) return
  delete down[cli]
  await $.fs.write(path, JSON.stringify(down))
}

/** The promo API credit: a day's spend kept in hq/api-spend/<day>.jsonl, by this plugin's workers and claude-api.sh. */
const apiSpendFile = async ($: $T, day: string) => join(await hqDir($), 'api-spend', `${day}.jsonl`)
const apiDailyUsd = () => Number(opt('api_daily_usd')) || 10
export function sumSpend(text: string): number {
  let usd = 0
  for (const l of text.split(/\r?\n/)) {
    try {
      const v = Number((JSON.parse(l) as { usd?: number }).usd)
      if (Number.isFinite(v) && v > 0) usd += v
    } catch {
      // a cut-off line
    }
  }
  return Math.round(usd * 100) / 100
}
async function apiSpentToday($: $T): Promise<number> {
  return sumSpend(await $.fs.read(await apiSpendFile($, dayKey(await $.clock.now()))).catch(() => ''))
}
async function recordApiSpend($: $T, usd: number, name: string) {
  const now = await $.clock.now()
  const path = await apiSpendFile($, dayKey(now))
  const was = await $.fs.read(path).catch(() => '')
  await $.fs.write(path, `${was}${JSON.stringify({ at: now, usd, name: `chief:${name}` })}\n`)
}
/** The API key claude-api.sh uses (the user's environment in the registry), read once; empty when there is none. */
let apiKeyRead: string | null = null
async function apiKey($: $T): Promise<string> {
  if (apiKeyRead !== null) return apiKeyRead
  apiKeyRead = ''
  if (!isWindows()) return (apiKeyRead = String((await $.env.get('ANTHROPIC_API_KEY').catch(() => '')) ?? ''))
  const r = await $.process.run(['reg', 'query', 'HKCU\\Environment', '/v', 'ANTHROPIC_API_KEY'], { timeoutMs: 10000 }).catch(() => ({ stdout: '' }))
  apiKeyRead = String(r.stdout).match(/ANTHROPIC_API_KEY\s+REG_\w+\s+(\S+)/)?.[1] ?? ''
  return apiKeyRead
}
/**
 * A tier-routed worker that lands on Claude (the paid last stop of every route) runs on the promo API credit while
 * the day's spend is under api_daily_usd ($10), so the subscription is kept for the chats; over it, on the login.
 */
async function apiCreditEnv($: $T, cli: string): Promise<Record<string, string>> {
  if (cli !== 'claude' || !riskyOn('api_credit_fallback', opt('api_credit_fallback'))) return {}
  const key = await apiKey($)
  if (!key || (await apiSpentToday($)) >= apiDailyUsd()) return {}
  return { ANTHROPIC_API_KEY: key }
}
const STALL_MS = 8 * 60000

/** The words of an alarm without digits (elapsed times, counts change; the cause does not). */
const alarmWords = (line: string) => line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
const alertedWords = new Map<string, string>()
export function raise(key: string, line: string, isUrgent: boolean, now: number, max = 200) {
  const prev = alertedAt.get(key)
  if (prev !== undefined && now - prev < 10 * 60000) return
  // the same alarm for the same cause is not told again within six hours
  if (prev !== undefined && alertedWords.get(key) === alarmWords(line) && now - prev < 6 * 3600000) return
  alertedAt.set(key, now)
  alertedWords.set(key, alarmWords(line))
  alerts.push({ key, line: line.slice(0, max), isUrgent, at: now })
  if (role === 'chief' && leaderSid) forwardLines.push(line.slice(0, 160))
}

/** When a worker's end was told (the key of its end alert), at or after `since`; 0 while it has not been. */
export function endToldAt(told: Iterable<[string, number]>, workerId: string, since: number): number {
  for (const [key, at] of told) if (key.startsWith(`end:${workerId}:`) && at >= since) return at
  return 0
}

export const WAIT_STEP_MS = 3000
/**
 * spawn_worker wait:true: the call holds until the worker's end is told, then answers with that line, its report and
 * its last lines, so a CLI worker's result comes back as a subagent's does (no second turn, no agent_output call).
 * The end alert is taken out of the queue: it does not also ride a later tool result or start a turn of its own.
 * shortcut: held at most 15 minutes (a chief silent for 20 is reported stuck); longer runs fall back to the usual notice.
 */
async function waitForWorker($: $T, name: string, minutes: number, since: number): Promise<string> {
  const until = since + clamp(minutes, 1, 15) * 60000
  for (;;) {
    const { value: ws = [] } = await $.state.get(WORKERS)
    const worker = ws.filter(w => w.name === name).sort((x, y) => y.startedAt - x.startedAt)[0]
    if (worker && endToldAt(alertedAt, worker.id, since)) {
      const i = alerts.findIndex(x => x.key.startsWith(`end:${worker.id}:`))
      const line = i >= 0 ? alerts.splice(i, 1)[0]!.line : `${worker.name} ${worker.status}`
      return `${line}${worker.report ? `\nreport: ${worker.report.slice(0, 3000)}` : ''}\n${worker.tail.slice(-30).join('\n') || '(the CLI printed nothing readable)'}`
    }
    if ((await $.clock.now()) >= until) return `${name} is still running after ${clamp(minutes, 1, 15)} min: you are told when it finishes; agent_output shows where it is.`
    await $.clock.sleep(WAIT_STEP_MS)
  }
}

/** A chief's agent alerts on their way to its leader, sent together on the next tick. */
const forwardLines: string[] = []
/** When the chat itself last did something in a turn (its start, a tool call). */
let mainActivityAt = 0
/** This turn's stuck notice went out already. */
let stuckTold = false
/** The last turn ended on a question for the owner. */
let waitingOwner = false
/** The last turn said it is waiting or blocked (not a question for the owner): nothing to nudge. */
let stalled = false
/** The chief said its goal is done; a new goal or message from the leader opens it again. */
let goalDone = false

/** Looks over every running agent without any model: waiting, rate limits, silence, repeated errors. */
async function watchdog($: $T) {
  const now = await $.clock.now()
  const { value: ws = [] } = await $.state.get(WORKERS)
  for (const w of ws.filter(x => x.status === 'running')) {
    const recent = w.tail.slice(-6)
    const waitLine = [...recent].reverse().find(l => WAIT_RE.test(l))
    if (waitLine) raise(`wait:${w.id}`, `? ${w.name} is waiting for input: "${oneLine(waitLine, 90)}" (headless: stop it and re-run, or message it after)`, true, now)
    const rateLine = [...recent].reverse().find(l => realHit(RATE_RE, l))
    if (rateLine) await markLimited($, w.cli, w.model, rateLine)
    const authLine = [...recent].reverse().find(l => AUTH_RE.test(l))
    if (authLine) await markProviderDown($, w.cli, authLine).catch(() => undefined)
    if (rateLine) raise(`rate:${w.id}`, `! ${w.name} hit a rate limit: "${oneLine(rateLine, 90)}"`, true, now)
    const errors = w.tail.slice(-20).filter(l => realHit(ERROR_RE, l))
    if (errors.length >= 3) raise(`errs:${w.id}`, `! ${w.name} keeps hitting errors: "${oneLine(errors[errors.length - 1]!, 90)}"`, false, now)
    // silence alone is no alarm: a build, a test or a lock wait is quiet too. The worker table (runningState) tells a
    // busy one from a stuck one, restarts a stuck or dropped one once, and only a second stall is told
  }
  const { value: ss = [] } = await $.state.get(SUBS)
  for (const s of ss.filter(x => x.status === 'running')) {
    const quietFor = now - (lastActivity.get(s.id) ?? s.startedAt)
    if (quietFor > STALL_MS) raise(`stall:${s.id}:${Math.floor((lastActivity.get(s.id) ?? s.startedAt) / 60000)}`, `… subagent "${oneLine(s.description, 50)}" silent for ${Math.round(quietFor / 60000)}m · last: ${s.steps[s.steps.length - 1] ?? 'no steps yet'}`, true, now)
    if ((subErrors.get(s.id) ?? 0) >= 3) raise(`errs:${s.id}`, `! subagent "${oneLine(s.description, 50)}" failed ${subErrors.get(s.id)} tool calls in a row · last: ${s.steps[s.steps.length - 1] ?? ''}`, true, now)
  }
  await flushAlerts($, now)
}

/**
 * One message for many events, so the chief spends one turn, not one per agent.
 * Urgent ones go after a short gather (20 s); endings wait up to 90 s, or until nothing runs.
 */
async function flushAlerts($: $T, now: number) {
  // mid-turn they ride the next tool result (takeAlerts); a turn of their own re-reads the whole conversation
  if (alerts.length === 0 || mainTurn) return
  const oldest = alerts[0]!.at
  const urgent = alerts.some(a => a.isUrgent)
  const quiet = !(await anyRunning($))
  // chiefs' questions gather 20 s even when nothing runs, so several chiefs asking at once cost one turn
  const fromChiefs = alerts.every(a => a.key.startsWith('chief:'))
  if (!((quiet && !fromChiefs) || (urgent ? now - oldest >= 20000 : now - oldest >= 90000))) return
  const batch = alerts.splice(0, alerts.length)
  const head = batch.length === 1 ? 'The Chief:' : `The Chief · ${batch.length} updates:`
  const hint = fromChiefs ? '' : toldToolHint ? '' : '\n(Details: mcp__the-chief__agent_output. Act: message_agent, stop_agent, spawn_worker.)'
  if (!fromChiefs) toldToolHint = true
  const tail = fromChiefs ? CHIEF_ASK_TAIL : ALERT_TAIL
  await submitGuarded($, `${head}\n${batch.map(a => a.line).join('\n')}${hint}\n${tail}`, false)
}

/** Each alert asks for no recap: the owner reads the same lines in the pane. */
const ALERT_TAIL = '(Act if needed; otherwise one line, no recap.)'
/** Chiefs' questions: the leader settles them, and turns to the owner only for theirs. */
const CHIEF_ASK_TAIL = '(A chief that finished: release_chief, and its next job goes to a new chief (create_chief, model by difficulty). Settle each you can unblock: message_chief, configure_chief, or a new chief. A chief that only waits needs no reply. Ask the owner only if a decision is truly theirs; otherwise write nothing here.)'
/** True while the chat itself (not a subagent) is in a turn. */
let mainTurn = false

// ---------- Budget: keep the chat's own context small, since every turn re-reads all of it ----------
// Measured on this machine (Sep 22 - Oct 7): cache reads were ~65% of spend, the average call carried ~370k
// tokens of context and auto-compact only fired near 967k. Compacting earlier, recompacting a cold cache instead
// of rewriting it, and capping blind whole-file reads cut that without taking any capability away.

/** "300k" -> 300000, "1.5m" -> 1500000, "off"/"0" -> 0, empty -> the default. */
export function parseTokens(v: string, fallback: number): number {
  const s = v.trim().toLowerCase()
  if (!s) return fallback
  if (s === 'off' || s === 'none') return 0
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)b?$/.exec(s)
  if (!m) return fallback
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1))
}

type BudgetOptions = {
  /** Compact after a turn once the context is this big; 0 = off. */
  guardTokens: number
  /** The chat's prompt cache is cold after this long without a turn. */
  coldMs: number
  /** A cold chat this big is compacted before the next message instead of rewritten whole; 0 = off. */
  coldMinTokens: number
  /** A whole-file Read of a text file bigger than this is capped; 0 = off. */
  readMaxBytes: number
}

/** The main chat's prompt cache lives an hour; two minutes of margin so a still-warm cache is never thrown away. */
const COLD_MS = 62 * 60_000

let compacting = false
/** Context size right after the last compact The Chief ran (0 = none yet). */
let lastCompactAfter = 0
let lastTurnEndAt = 0

/** A compact the guard ran: the size it left is kept (anti-thrash survives a reload), and a size-guard one is counted toward the handoff. */
async function countCompact($: $T, after: number, isCold: boolean) {
  lastCompactAfter = after
  const s = await recordCompact(portsOf($), sid, after, isCold).catch(() => null)
  if (s) await noteCompactsHere($, s.compacts)
}

/** Size compacts of this chat since it started: from HANDOFF_WARN on, the Oturum tab says a handoff is due (never automatic). */
const HANDOFF_WARN = 3
let compactsHere = 0
async function noteCompactsHere($: $T, n: number) {
  const crossed = n >= HANDOFF_WARN && compactsHere < HANDOFF_WARN
  compactsHere = n
  if (!crossed || isWorker) return
  const msg = L(`The Chief: this chat has compacted ${n} times; each summary loses a little. A handoff is due (Oturum tab).`, `The Chief: bu sohbet ${n} kez sıkıştırıldı, her özet biraz kaybettiriyor. Devir zamanı (Oturum sekmesi).`)
  $.ui.toast(msg)
  $.ui.log(msg)
}

async function contextTokens($: $T): Promise<number> {
  const { context } = await $.session.usage()
  return context.tokens ?? Math.round(((context.percent ?? 0) / 100) * context.window)
}

export function compactBrief(focus: string, why: 'size' | 'cold' | 'idle'): string {
  const lead =
    why === 'cold'
      ? 'The prompt cache expired while this chat sat idle; this summary replaces the full history for the next message.'
      : why === 'idle'
        ? 'This chat has been idle; this summary is written now, while its prompt cache is still warm, so its next message does not re-read the whole history.'
        : 'The context grew large; this summary replaces the full history so every later turn stays cheap.'
  return [
    lead,
    focus ? `Current goal: ${focus}` : '',
    "Keep everything needed to continue without re-reading: the user's latest request and standing instructions verbatim; decisions made and why; exact file paths, symbols and line ranges touched; commands that build, test or verify the work and their last result; open TODOs and next step; unresolved errors with their exact messages; names, ids and URLs in play.",
    'Drop raw tool output, file dumps, superseded attempts and anything already done and verified.',
  ].filter(Boolean).join('\n')
}

/**
 * Compacts the chat when it is past the limit for `why`. Returns "412k → 38k" when it compacted, else null.
 * After a compact that could not get well under the guard, waits for 100k more before trying again (no thrash).
 * A cold or idle compact never counts toward the handoff (only a size-guard one does).
 */
async function compactIfLarge($: $T, o: BudgetOptions, why: 'size' | 'cold' | 'idle', focus: string): Promise<string | null> {
  const limit = why === 'size' ? o.guardTokens : o.coldMinTokens
  const asCold = why !== 'size'
  if (!limit || compacting) return null
  const before = await contextTokens($).catch(() => 0)
  if (before < limit) return null
  if (why === 'size' && lastCompactAfter > o.guardTokens * 0.7 && before < lastCompactAfter + 100_000) return null
  if (Date.now() - slashCompactAt < 10 * 60000) {
    if (why === 'size') await noteGuard($, before, 'waiting: a /compact was asked under 10 min ago')
    return null
  }
  compacting = true
  try {
    let r: Awaited<ReturnType<$T['session']['compact']>> | null = null
    try {
      r = await $.session.compact({ instructions: compactBrief(focus, why) })
    } catch {
      // the desktop app (an SDK host) compacts only inside a turn: "not available in a headless session"
    }
    if (!r || (r.skip !== undefined && /headless|not available|inside a turn/i.test(r.skip))) {
      // the chat is idle, so ask for /compact itself
      slashCompactAt = Date.now()
      pendingCompact = { before, cold: asCold }
      // kept in the store too: a reload between the /compact and the next request must not lose the saving
      await storeSet($, `pendingCompact:${sid}`, pendingCompact).catch(() => undefined)
      const brief = oneLine(compactBrief(focus, why), 1500)
      // the command itself, as /goal runs; a typed /compact when the host takes no command from a plugin
      await $.command.run({ command: 'compact', args: brief }).catch(() => $.prompt.submit({ text: `/compact ${brief}`, asUser: true }))
      if (why === 'size') await noteGuard($, before, 'asked for /compact (the app compacts inside a turn)')
      return `${Math.round(before / 1000)}k → /compact`
    }
    if (r.skip !== undefined) {
      if (why === 'size') await noteGuard($, before, `compact skipped: ${oneLine(String(r.skip), 160)}`)
      return null
    }
    const after = r.tokensAfter ?? (await contextTokens($).catch(() => 0))
    await countCompact($, after, asCold)
    compactedSince = true
    await noteCompact($, before, after, asCold).catch(() => undefined)
    return `${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k`
  } finally {
    compacting = false
  }
}

/** Until when the band says the loops were stopped. */
let stopShownUntil = 0
/** Whether the finished agents' group is open in the pane. */
let endedOpen = true

// ---------- the Skills tab: every skill on this computer by category, one click puts it in the chat box ----------
export type SkillItem = { name: string; desc: string; path: string; src: 'clients' | 'global' | 'project'; callable: boolean }
export const SKILL_CATEGORIES = ['Kurgu', 'Altyazı & başlık', 'Grafik, harita & medya', 'İndir, izle, incele', 'Upwork', 'Diğer'] as const
/** The category a skill sits in, from its name. Pure, so it is tested. */
const SKILL_CAT_EN: Record<string, string> = { Kurgu: 'Editing', 'Altyazı & başlık': 'Captions & titles', 'Grafik, harita & medya': 'Graphics, maps & media', 'İndir, izle, incele': 'Download, watch, review', Upwork: 'Upwork', Diğer: 'Other' }
const skillCatLabel = (c: string) => L(SKILL_CAT_EN[c] ?? c, c)
export function skillCategory(name: string): (typeof SKILL_CATEGORIES)[number] {
  const n = name.toLowerCase()
  if (/upwork/.test(n)) return 'Upwork'
  if (/caption|title|viral/.test(n)) return 'Altyazı & başlık'
  if (/map|icon|graphic|thumbnail|hyperframes|media|motion|maps/.test(n)) return 'Grafik, harita & medya'
  if (/grab|watch|download|review/.test(n)) return 'İndir, izle, incele'
  if (/rough|speech|clean|cut|edit|shorts|talking/.test(n)) return 'Kurgu'
  return 'Diğer'
}
/** The name and one-line description from a SKILL.md front matter (a quoted, plain or folded `>` description). Pure, so it is tested. */
export function parseSkillHead(text: string): { name: string; desc: string } {
  const head = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  const lines = head.split('\n')
  const name = lines.find(l => /^name:/.test(l))?.replace(/^name:\s*/, '').replace(/^["']|["']$/g, '').trim() ?? ''
  const i = lines.findIndex(l => /^description:/.test(l))
  let desc = i < 0 ? '' : lines[i]!.replace(/^description:\s*/, '').trim()
  if (/^[>|][+-]?$/.test(desc)) {
    const rest: string[] = []
    for (const l of lines.slice(i + 1)) {
      if (!/^\s/.test(l)) break
      rest.push(l.trim())
    }
    desc = rest.join(' ')
  }
  return { name, desc: desc.replace(/^["']|["']$/g, '').trim() }
}
/** What a click puts in the chat box: the slash command where Claude has the skill registered, else an order to read its file. */
export const skillInsert = (s: Pick<SkillItem, 'name' | 'path' | 'callable'>) => (s.callable ? `/${s.name} ` : `Use the skill ${s.name}: read ${s.path} first and follow it. `)
let skillCache: { at: number; list: SkillItem[] } | null = null
let skillQuery = ''
/** How many terminal lines the reader has scrolled up from the newest, and for which agent. */
let termBack = 0
let termBackFor = ''
const TERM_WINDOW = 14
async function loadSkills($: $T): Promise<SkillItem[]> {
  const now = await $.clock.now()
  if (skillCache && now - skillCache.at < 60000) return skillCache.list
  const home = (isWindows() ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) ?? ''
  const roots: { dir: string; src: SkillItem['src'] }[] = [
    { dir: `${home}/.claude/skills`, src: 'global' },
    ...(cwd ? [{ dir: `${cwd}/.claude/skills`, src: 'project' as const }] : []),
  ]
  const byName = new Map<string, SkillItem>()
  const registered = new Set<string>()
  for (const r of roots) {
    const entries = await $.fs.list(r.dir).catch(() => [] as FsEntry[])
    for (const d of entries) {
      if (d.kind === 'file' || /^[_.]|backup|^synced$/i.test(d.name)) continue
      const file = `${r.dir}/${d.name}/SKILL.md`
      const text = await readText($, file).catch(() => '')
      if (!text) continue
      const head = parseSkillHead(text)
      const name = head.name || d.name
      if (r.src === 'global') registered.add(name)
      const have = byName.get(name)
      if (have && have.src !== 'clients') continue
      byName.set(name, { name, desc: head.desc, path: file, src: r.src, callable: false })
    }
  }
  const list = [...byName.values()].map(x => ({ ...x, callable: registered.has(x.name) })).sort((a, b) => a.name.localeCompare(b.name))
  skillCache = { at: now, list }
  return list
}
/** Ends this chat's /goal loop (the Stop hook that re-prompts it) without touching its scheduled tasks. */
async function clearGoalNow($: $T) {
  goalLoopLast = ''
  goalLoopTold = ''
  const clear = $.command.run({ command: 'goal', args: 'clear' }).catch(() => enqueue({ kind: 'submit', text: '/goal clear' }))
  await Promise.race([clear, $.clock.sleep(4000)])
}

/** Until when this chat takes no new wake-up or scheduled loop (the owner pressed stop). */
let loopsOffUntil = 0
/**
 * Stops every loop in this chat: its /goal (the Stop hook that keeps re-prompting), its scheduled tasks
 * (/loop, crons), and new wake-ups for six hours. A leader stops its chiefs' too.
 */
async function stopLoops($: $T, everywhere: boolean): Promise<string> {
  const now = await $.clock.now()
  loopsOffUntil = now + 6 * 3600_000
  goalLoopLast = ''
  // the press answers at once: the /goal and cron calls can take a while (or wait for a turn) in the app
  stopShownUntil = now + 10_000
  $.ui.toast(L('⏹ Loops stopped', '⏹ Döngüler durdu'))
  await update($, tick, n => (n ?? 0) + 1)
  void (async () => {
    await $.clock.sleep(10_500)
    await update($, tick, n => (n ?? 0) + 1)
  })().catch(() => undefined)
  const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, $.clock.sleep(ms).then(() => undefined)])
  let crons = 0
  await within($.command.run({ command: 'goal', args: 'clear' }).catch(() => undefined), 4000)
  try {
    const r = ((await within($.tool.call({ tool: 'CronList' } as never), 4000)) ?? {}) as { text?: string; result?: unknown }
    const raw = r.text ?? JSON.stringify(r.result ?? '')
    for (const id of new Set(raw.match(/\b[0-9a-f]{8}\b/g) ?? [])) {
      const d = (await $.tool.call({ tool: 'CronDelete', id } as never).catch(() => null)) as { deny?: string; isError?: boolean } | null
      if (d && !d.deny && !d.isError) crons++
    }
  } catch {
    // no scheduled tasks here
  }
  let chiefs = 0
  if (everywhere && role === 'leader') {
    for (const c of hqCards.filter(x => x.role === 'chief' && x.leader === sid)) {
      await sendTo($, c.sid, 'stop-loops').catch(() => undefined)
      chiefs++
    }
  }
  const said = L(`The Chief: loops stopped · /goal cleared${crons ? ` · ${crons} scheduled tasks deleted` : ''}${chiefs ? ` · also sent to ${chiefs} chiefs` : ''} · no new loops for 6 hours`, `The Chief: döngüler durdu · /goal temizlendi${crons ? ` · ${crons} zamanlanmış görev silindi` : ''}${chiefs ? ` · ${chiefs} şefe de iletildi` : ''} · 6 saat yeni döngü kurulmaz`)
  $.ui.log(said)
  return said
}

/** When the guard last asked for /compact (the app compacts only inside a turn): not again for ten minutes. */
let slashCompactAt = 0
/** A /compact the guard asked for, waiting for the first request after it to measure what it saved. */
let pendingCompact: { before: number; cold: boolean } | null = null
/** The kept /compact note was looked for once in this process. */
let pendingLoaded = false

/** The idle spell (its last turn's end) the cold guard already looked at: once per spell. */
let coldSeenFor = 0
/** The idle spell (its last turn's end) this chief already compacted at 50 minutes: one compact per spell. */
let idleCompactFor = 0
/** A chat idle longer than this is likely left; compacting it would be paid for and never used. */
const COLD_WINDOW_MS = 8 * 3600_000

/** True when the chat has been idle long enough that its prompt cache is gone, but not so long that it is left. */
const isCold = (now: number, o: BudgetOptions) => lastTurnEndAt > 0 && now - lastTurnEndAt > o.coldMs && now - lastTurnEndAt < COLD_WINDOW_MS

const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|pdf|ipynb|zip|gz|mp4|mov|wav|mp3)$/i

/** The line limit that keeps a whole-file read near `maxBytes`; null when the file already fits. */
export function readCap(size: number, lines: number, maxBytes: number): number | null {
  if (!maxBytes || size <= maxBytes) return null
  const limit = Math.min(2000, Math.max(200, Math.floor(maxBytes / (size / lines))))
  return limit >= lines ? null : limit
}

/**
 * A whole-file Read of a large text file: the line limit that keeps it near `readMaxBytes`, and the note
 * that tells the model what it did not see and how to get it. Null when the read goes through as asked.
 */
async function capRead($: $T, e: { file_path: string; offset?: number; limit?: number; pages?: string }, o: BudgetOptions): Promise<{ limit: number; note: string; skippedTokens: number } | null> {
  if (!o.readMaxBytes || e.limit !== undefined || e.offset !== undefined || e.pages !== undefined || NOT_TEXT.test(e.file_path)) return null
  const st = await $.fs.stat(e.file_path).catch(() => null)
  if (!st || st.kind !== 'file' || st.size <= o.readMaxBytes) return null
  const raw = await $.fs.read(e.file_path).catch(() => null)
  if (typeof raw !== 'string') return null
  const lines = raw.split('\n').length
  const limit = readCap(st.size, lines, o.readMaxBytes)
  if (limit === null) return null
  return {
    limit,
    skippedTokens: Math.round((st.size * (1 - limit / lines)) / BYTES_PER_TOKEN),
    note: `The Chief: ${baseName(e.file_path)} is ${lines} lines (${Math.round(st.size / 1024)} KB), so only lines 1-${limit} were read to keep this chat's context small. Read the part you need with offset/limit, Grep for it, or have a subagent digest the whole file.`,
  }
}

/** After a turn of the chat itself: past the guard, compact now, while nothing is running, never mid-task. */
async function contextGuard($: $T) {
  await $.clock.sleep(1500)
  // a handoff is writing its file: compacting now would only undo what it is saving
  if (handoffRunning) return
  if (mainTurn) {
    await noteGuard($, -1, 'skipped: a new turn had started')
    return
  }
  // the panel's handoff warning survives a reload: the count is read back silently
  if (!compactsHere) compactsHere = (await readSess(portsOf($), sid).catch(() => null))?.compacts ?? 0
  const ctx = await contextTokens($).catch(() => -1)
  const done = await compactIfLarge($, budget(), 'size', chiefConfig.goal || (await activeGoal($)) || '')
  await noteGuard($, ctx, done ? `compacted ${done}` : ctx >= budget().guardTokens ? 'over the guard, not compacted' : 'under the guard')
  if (done) $.ui.log(`The Chief: context past ${Math.round(budget().guardTokens / 1000)}k, compacted (${done}). Every later turn re-reads less.`)
}

/** The minute check: idle (no turn of its own for 20 s), interactive, not a worker. */
async function idleGuard($: $T) {
  if (!interactive || isWorker || mainTurn || compacting || handoffRunning) return
  // only a chat in use: its last turn ended in the last 8 hours (kept across reloads). An abandoned chat's cache is
  // cold, so compacting it would read its whole history at full price for nothing.
  if (!lastTurnEndAt) lastTurnEndAt = Number((await $.store.get(`lastTurnEnd:${sid}`)) ?? 0)
  const now = await $.clock.now()
  if (!lastTurnEndAt || now - lastTurnEndAt > COLD_WINDOW_MS || now - lastTurnEndAt < 20_000) return
  // an idle chief compacts itself 50 minutes after its last turn, while its prompt cache is still warm
  if (await idleCompact($, now)) return
  if ((await contextTokens($).catch(() => 0)) < budget().guardTokens) return
  await contextGuard($)
}

/**
 * The idle chief's own compact: 50 minutes after its last turn, never mid-turn and never while a tool, a worker, a
 * subagent or a detached run is going, once per idle spell, and only while its prompt cache is still warm (past that
 * the cold guard owns it: rewriting the history then costs the full price). Off with `compact: false` in its config.
 * Returns true when it looked at this chat (whether or not it compacted), so the size guard does not also run.
 */
async function idleCompact($: $T, now: number): Promise<boolean> {
  if (role !== 'chief' || chiefConfig.compact === false) return false
  if (idleCompactFor === lastTurnEndAt) return false
  const busy = mainTurn || (await sessionBusy($).catch(() => true))
  if (!idleCompactDue({ now, lastTurnEnd: lastTurnEndAt, busy, on: true })) return false
  idleCompactFor = lastTurnEndAt
  const focus = chiefConfig.goal || (await activeGoal($)) || ''
  const done = await compactIfLarge($, budget(), 'idle', focus)
  if (done) $.ui.log(L(`The Chief: this chief was idle for 50 minutes and compacted itself before its cache went cold (${done}).`, `The Chief: bu şef 50 dakikadır boşta, önbelleği soğumadan kendini sıkıştırdı (${done}).`))
  else await noteGuard($, await contextTokens($).catch(() => 0), 'idle: under the compact limit')
  return true
}

/** What the context guard last did in this chat, kept in the store so a run can be checked afterwards. */
async function noteGuard($: $T, ctx: number, outcome: string) {
  try {
    await storeSet($, `guard:${sid}`, { at: await $.clock.now(), ctx, limit: budget().guardTokens, outcome })
  } catch {
    // the record is a help, never a failure
  }
}

/**
 * The chat sat idle past its prompt cache: its next message would write the whole history again at the cache-write
 * price. Compacting now, once per idle spell, means it writes a short summary instead. (A prompt.submit hook may
 * not compact under the turn it holds, so this runs on the clock while nothing is running.)
 */
/** Removes the store keys of chats not seen for 14 days, at most once every 6 hours across all chats (storekeep.ts). */
async function pruneOld($: $T): Promise<void> {
  const now = await $.clock.now()
  if (now - Number((await $.store.get('pruneAt')) ?? 0) < 6 * 3600_000) return
  await storeSet($, 'pruneAt', now)
  const gone = await pruneStore($, now, 14 * 86400_000)
  if (gone > 0) $.ui.log(L(`The Chief: removed ${gone} store keys of chats gone 14+ days.`, `The Chief: 14+ gündür kapalı sohbetlerin ${gone} depo kaydı silindi.`))
}
async function coldGuard($: $T) {
  if (!interactive || isWorker || mainTurn || coldSeenFor === lastTurnEndAt || !isCold(await $.clock.now(), budget())) return
  coldSeenFor = lastTurnEndAt
  const done = await compactIfLarge($, budget(), 'cold', chiefConfig.goal || (await activeGoal($)) || '')
  if (done) $.ui.log(`The Chief: this chat's prompt cache had expired, compacted it while idle (${done}) so the next message does not rewrite the whole history.`)
}

// ---------- Budget meter: the 5h and weekly limits, and what the guards saved this session ----------
// The saving is counted against a counterfactual: the same chat without The Chief, whose context is `carried`
// tokens bigger. Every request the chat makes then re-reads those tokens at the price that request paid (cache
// read, or cache write when it missed), until the counterfactual would have hit Claude Code's own auto-compact.
// A compaction's own cost (reading the history once, writing the summary) is taken off.

/** Rough bytes per token for source and prose. */
const BYTES_PER_TOKEN = 3.6
/** Where Claude Code compacts a 1M-context session by itself. */
const AUTO_COMPACT_AT = 967_000

/** One request of the chat against the counterfactual: what re-reading `carried` more tokens would have cost. */
export function stepSaving(carried: number, u: StepUsage, model: string): { usd: number; carried: number } {
  const ctx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  if (carried <= 0 || ctx + carried > AUTO_COMPACT_AT) return { usd: 0, carried: 0 }
  const p = priceOf(model)
  const missed = ctx > 0 ? u.cache_creation_input_tokens / ctx : 0
  return { usd: (carried * (missed * p.inp * 2 + (1 - missed) * p.read)) / 1e6, carried }
}

/** A compaction's own cost: the history read once (uncached when the cache was cold) and the summary written. */
export function compactCostUsd(before: number, after: number, model: string, cold: boolean): number {
  const p = priceOf(model)
  return (before * (cold ? p.inp : p.read) + Math.min(after, 20_000) * p.out) / 1e6
}

/** The 5h and weekly windows out of the session's rate limits (the per-model weekly ones are left out). */
// ---------- Drawing kit (desktop): line icons, rounded bars and pixel mascots, as small SVG documents ----------
/** Line icons on a 24-unit grid, drawn with a 2-unit round stroke. */
export const ICON_PATHS: Record<string, string> = {
  layers: 'M12 3 3 8l9 5 9-5-9-5Z M3 12.5l9 5 9-5 M3 17l9 5 9-5',
  gauge: 'M4.6 18.4a9 9 0 1 1 14.8 0 M12 13.5l4-4.5',
  calendar: 'M4 5.5h16v15H4z M4 10h16 M8.5 3v4 M15.5 3v4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7.5V12l3 2',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M12 12.01V12',
  coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M14.6 9.4A2.8 2.8 0 0 0 12 8c-1.5 0-2.6.8-2.6 2s1.1 1.6 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2a2.8 2.8 0 0 1-2.6-1.4 M12 6.5V8 M12 16v1.5',
  bolt: 'M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z',
  hourglass: 'M6 3h12 M6 21h12 M7 3c0 5 10 5 10 9s-10 4-10 9 M17 3c0 5-10 5-10 9s10 4 10 9',
  down: 'M12 5v14 M6 13l6 6 6-6',
  star: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z',
}
/** One line icon as an SVG document. */
export function iconSvg(name: string, color: string, size = 14): string {
  const d = ICON_PATHS[name] ?? ICON_PATHS.target!
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
}
/** A rounded progress bar: the used part over a dark track; never a hairline, full at 100% and past it. */
export function barSvg(pct: number, width: number, color: string, height = 6, track = '#2b2b2b'): string {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
  const r = height / 2
  const w = p === 0 ? 0 : Math.max(height, Math.round((p / 100) * width))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="${r}" fill="${track}"/>${w ? `<rect width="${w}" height="${height}" rx="${r}" fill="${color}"/>` : ''}</svg>`
}
/** An agent's mark: a plain dot in the CLI's colour. */
export function mascotSvg(color: string, size = 22): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="${color}"/></svg>`
}
/** The Chief's mark: the same dot with a slow ring breathing out of it (CSS in the SVG: the app runs no script in an icon). */
export function liveMascotSvg(color = '#DD775B', size = 26): string {
  const css = '.r{transform-origin:10px 10px;animation:p 3s ease-out infinite}@keyframes p{0%{transform:scale(.8);opacity:.6}100%{transform:scale(1.25);opacity:0}}@media (prefers-reduced-motion:reduce){.r{animation:none;opacity:0}}'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20"><style>${css}</style><circle class="r" cx="10" cy="10" r="8" fill="none" stroke="${color}" stroke-width="1.5"/><circle cx="10" cy="10" r="6" fill="${color}"/></svg>`
}

/** Each CLI's mascot colour (Claude in its own coral). */
export const CLI_TINT: Record<string, string> = { claude: '#d97757', devin: '#5ccb7a', qoder: '#6aa2f2', gemini: '#8ab4f8', antigravity: '#a78bfa', codex: '#e6e6e6', 'opencode-go': '#f2c46a', 'opencode-zen': '#f2c46a', 'opencode-ollama': '#9aa0a6', custom: '#9aa0a6' }
/** The pill tones of the band: a dark tinted ground, a thin border, and the accent. */
export const TONES = {
  blue: { bg: '#141a26', border: '#2b3d63', fg: '#7aa2f7' },
  green: { bg: '#131d16', border: '#29492f', fg: '#5ccb7a' },
  coral: { bg: '#1f1511', border: '#5c3324', fg: '#d97757' },
  gray: { bg: '#181818', border: '#333333', fg: '#bdbdbd' },
} as const
/** An effort as a word and its colour, the way a lane reads at a glance. */
export function effortWord(effort: string | undefined): { word: string; color: string } | null {
  const e = (effort ?? '').toLowerCase()
  if (!e) return null
  if (e === 'low' || e === 'minimal') return { word: L('light', 'hafif'), color: '#5ccb7a' }
  if (e === 'medium') return { word: L('medium', 'orta'), color: '#6aa2f2' }
  if (e === 'high') return { word: L('careful', 'dikkatli'), color: '#f2c46a' }
  return { word: L('deep', 'derin'), color: '#d97757' }
}

/**
 * A limit bar in whole cells: filled blocks for the used part and shaded ones for the rest, so 0% still shows an
 * empty bar and 100% a full one (never a hairline). Over 100% reads as full; narrow bands get a shorter bar.
 */
export function meterCells(pct: number, cols: number): { width: number; fill: number; empty: number; full: boolean; pct: number } {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
  const width = cols >= 110 ? 12 : cols >= 80 ? 8 : 5
  const full = p >= 100
  // any use shows at least one cell; anything short of full leaves at least one empty
  const fill = full ? width : p === 0 ? 0 : Math.min(width - 1, Math.max(1, Math.round((p / 100) * width)))
  return { width, fill, empty: width - fill, full, pct: p }
}

/** A limit whose window has already reset reads 0% until a new reading comes. */
export function liveLimit(lim: SquadLimit | null, now: number): SquadLimit | null {
  if (!lim) return null
  const t = lim.resetsAt ? Date.parse(lim.resetsAt) : NaN
  return Number.isFinite(t) && t <= now ? { pct: 0 } : lim
}
/**
 * Two readings of one limit: within a window usage only grows, so the higher one is the newer; a later window
 * (a later reset) replaces an earlier one. No clock needed, so a chat that wakes with an old reading never wins.
 */
export function mergeLimit(a: SquadLimit | null, b: SquadLimit | null): SquadLimit | null {
  if (!a) return b
  if (!b) return a
  const ta = a.resetsAt ? Date.parse(a.resetsAt) : NaN
  const tb = b.resetsAt ? Date.parse(b.resetsAt) : NaN
  if (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) > 60_000) return tb > ta ? b : a
  return b.pct > a.pct ? b : a
}
/** The newer of this chat's reading and the one any chat on this computer last shared. */
export function freshestLimits(own: { five: SquadLimit | null; week: SquadLimit | null; at: number }, shared: { five: SquadLimit | null; week: SquadLimit | null; at: number } | null, now: number): { five: SquadLimit | null; week: SquadLimit | null } {
  return { five: liveLimit(mergeLimit(own.five, shared?.five ?? null), now), week: liveLimit(mergeLimit(own.week, shared?.week ?? null), now) }
}

export function pickLimits(rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): { five: SquadLimit | null; week: SquadLimit | null } {
  const of = (re: RegExp) => {
    const r = rateLimits.find(x => re.test(x.kind) && !/opus|sonnet|haiku|fable|oauth|cowork/i.test(x.kind))
    return r ? { pct: r.percentUsed, ...(r.resetsAt ? { resetsAt: r.resetsAt } : {}) } : null
  }
  return { five: of(/five|5h|hour/i), week: of(/seven|week|7d/i) }
}

type SavedLedger = { usd: number; tokens: number; carried: number; compacts: number; reads: number; trimmed?: number }
let ledger: SavedLedger = { usd: 0, tokens: 0, carried: 0, compacts: 0, reads: 0 }
let ledgerLoaded = false
let ledgerSavedAt = 0
/** Capped files and the tokens of them still counted as not read. */
const unread = new Map<string, number>()
/** API-priced dollars this process spent (chat and subagents); its card carries it for the shared calibration. */
let spentUsd = 0
let limitsNow: { five: SquadLimit | null; week: SquadLimit | null } = { five: null, week: null }
/** This chat's own last reading, and when it changed. */
let ownLimits: { five: SquadLimit | null; week: SquadLimit | null; at: number } = { five: null, week: null, at: 0 }
type SharedLimits = { five: SquadLimit | null; week: SquadLimit | null; at: number }
/** The reading any chat on this computer last shared; null when none yet. */
async function readSharedLimits($: $T): Promise<SharedLimits | null> {
  try {
    return JSON.parse(await readText($, join(await hqDir($), 'limits.json'))) as SharedLimits
  } catch {
    return null
  }
}
/** Takes a reading another chat shared, when it is newer than what this chat shows. */
let sharedSeenAt = 0
async function pullSharedLimits($: $T) {
  const shared = await readSharedLimits($)
  if (!shared) return
  const now = await $.clock.now()
  const next = freshestLimits(ownLimits, shared, now)
  if (JSON.stringify(next) === JSON.stringify(limitsNow)) return
  sharedSeenAt = shared.at
  limitsNow = next
  await showBudget($)
}
/** Puts a fresh reading where every chat on this computer finds it. */
async function shareLimits($: $T, l: { five: SquadLimit | null; week: SquadLimit | null; at: number }) {
  const old = await readSharedLimits($)
  const next = { five: mergeLimit(old?.five ?? null, l.five), week: mergeLimit(old?.week ?? null, l.week), at: l.at }
  if (old && JSON.stringify(old.five) === JSON.stringify(next.five) && JSON.stringify(old.week) === JSON.stringify(next.week)) return
  await $.fs.write(join(await hqDir($), 'limits.json'), JSON.stringify(next))
}
let perUsd: { five: number; week: number } = { ...PRIOR_PER_USD }
/** Calibration anchors: a window's percent and the machine's spend when it was taken. */
const anchors: Record<'five' | 'week', { pct: number; resetsAt: string; usd: number } | null> = { five: null, week: null }
/** Every chat's last seen spend by card (sid|engine), so the machine's spend is summed as deltas. */
const cardSpend = new Map<string, number>()
let machineUsd = 0
let calibSampleAt = 0

async function loadLedger($: $T) {
  const s = (await $.store.get(`saved:${sid}`).catch(() => undefined)) as Partial<SavedLedger> | undefined
  // steps taken before the store answered are added to what the session had saved before
  if (s && typeof s === 'object') {
    ledger = {
      usd: ledger.usd + (Number(s.usd) || 0),
      tokens: ledger.tokens + (Number(s.tokens) || 0),
      carried: Math.max(ledger.carried, Number(s.carried) || 0),
      compacts: ledger.compacts + (Number(s.compacts) || 0),
      reads: ledger.reads + (Number(s.reads) || 0),
      trimmed: trimmedOf(ledger) + trimmedOf(s),
    }
  }
  const c = (await $.store.get('perUsd').catch(() => undefined)) as { five?: number; week?: number } | undefined
  if (c && Number.isFinite(c.five) && Number.isFinite(c.week)) perUsd = { five: c.five!, week: c.week! }
  ledgerLoaded = true
  await showBudget($)
}

async function saveLedger($: $T, force = false) {
  const now = await $.clock.now()
  if (!ledgerLoaded || (!force && now - ledgerSavedAt < 15_000)) return
  ledgerSavedAt = now
  await storeSet($, `saved:${sid}`, ledger)
}

/** The context a ledger's compactions took off (ledgers written before v1.24 kept it only in `carried`). */
export function trimmedOf(v: Partial<SavedLedger>): number {
  if (Number.isFinite(v.trimmed)) return Number(v.trimmed)
  return (Number(v.compacts) || 0) > 0 ? Number(v.carried) || 0 : 0
}
/** A /compact asked for but not yet measured (its chat has not spoken since): about this much stays as the summary. */
const SUMMARY_TOKENS = 20_000
/** What the guards saved in the other chats on this computer, summed from their ledgers (this chat's is added live). */
let allSaved = { usd: 0, tokens: 0, trimmed: 0, compacts: 0 }
let allSavedAt = 0
async function sumAllSaved($: $T) {
  const now = await $.clock.now()
  if (now - allSavedAt < 30_000) return
  allSavedAt = now
  let usd = 0
  let tokens = 0
  let trimmed = 0
  let compacts = 0
  for (const k of await $.store.keys()) {
    // the other chats only: this chat's own ledger is added live
    if (k.startsWith('pendingCompact:') && k !== `pendingCompact:${sid}`) {
      const p = (await $.store.get(k)) as { before?: number } | null | undefined
      if (p && Number(p.before) > SUMMARY_TOKENS) {
        trimmed += Number(p.before) - SUMMARY_TOKENS
        compacts++
      }
      continue
    }
    if (!k.startsWith('saved:') || k === `saved:${sid}`) continue
    const v = (await $.store.get(k)) as SavedLedger | undefined
    if (!v) continue
    usd += Math.max(0, v.usd || 0)
    tokens += v.tokens || 0
    trimmed += trimmedOf(v)
    compacts += v.compacts || 0
  }
  allSaved = { usd, tokens, trimmed, compacts }
}
async function showBudget($: $T) {
  await sumAllSaved($).catch(() => undefined)
  await $.state.set(BUDGET, { ...limitsNow, savedUsd: allSaved.usd + Math.max(0, ledger.usd), savedTokens: allSaved.tokens + ledger.tokens, fivePerUsd: perUsd.five, weekPerUsd: perUsd.week, compacts: allSaved.compacts + ledger.compacts, reads: ledger.reads, trimmedTokens: allSaved.trimmed + trimmedOf(ledger), ctxTokens: ctxNow.tokens, ctxWindow: ctxNow.window, spentUsd, spentTokens })
}
/** The chat's context as the engine last reported it. */
let ctxNow = { tokens: 0, window: 0 }
/** Tokens this session's requests moved (input, cache and output), subagents included. */
let spentTokens = 0

/** One model request finished: the spend, and for the chat itself the saving against the counterfactual. */
async function noteStep($: $T, model: string, u: StepUsage | null, isSub: boolean) {
  if (!u) return
  spentUsd += stepUsd(model, u, isSub)
  spentTokens += u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + (u.output_tokens ?? 0)
  if (isSub) return
  lastMainCtx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  // the first request after an asked-for /compact shows what it left: the saving counts from there
  if (!pendingCompact && !pendingLoaded) {
    pendingLoaded = true
    const kept = await $.store.get(`pendingCompact:${sid}`).catch(() => undefined)
    if (kept && typeof kept === 'object') pendingCompact = kept as { before: number; cold: boolean }
  }
  if (pendingCompact && lastMainCtx < pendingCompact.before * 0.6) {
    const pc = pendingCompact
    pendingCompact = null
    await storeSet($, `pendingCompact:${sid}`, null).catch(() => undefined)
    await countCompact($, lastMainCtx, pc.cold)
    compactedSince = true
    await noteCompact($, pc.before, lastMainCtx, pc.cold).catch(() => undefined)
    await noteGuard($, pc.before, `compacted ${Math.round(pc.before / 1000)}k → ${Math.round(lastMainCtx / 1000)}k via /compact`)
  }
  const s = stepSaving(ledger.carried, u, model)
  ledger = { ...ledger, carried: s.carried, usd: ledger.usd + s.usd, tokens: ledger.tokens + (s.usd > 0 ? s.carried : 0) }
  await saveLedger($)
  await showBudget($)
}

/** The guards compacted: the counterfactual keeps the difference, the compaction's own cost comes off. */
async function noteCompact($: $T, before: number, after: number, cold: boolean) {
  ledger = { ...ledger, trimmed: trimmedOf(ledger) + Math.max(0, before - after), carried: ledger.carried + Math.max(0, before - after), usd: ledger.usd - compactCostUsd(before, after, lastModelSeen, cold), compacts: ledger.compacts + 1 }
  unread.clear()
  await saveLedger($, true)
  await showBudget($)
}

/** A capped read keeps its unread part out of the context; a later read of that file gives some of it back. */
function noteRead(file: string, cap: { skippedTokens: number } | null, gotChars: number) {
  if (cap) {
    unread.set(file, (unread.get(file) ?? 0) + cap.skippedTokens)
    ledger = { ...ledger, carried: ledger.carried + cap.skippedTokens, reads: ledger.reads + 1 }
    return
  }
  const left = unread.get(file)
  if (!left) return
  const back = Math.min(left, Math.round(gotChars / BYTES_PER_TOKEN))
  unread.set(file, left - back)
  ledger = { ...ledger, carried: Math.max(0, ledger.carried - back) }
}

/** One sample toward "percent of a window per dollar": the window's rise over the machine's spend since the anchor. */
export function calibrate(prior: number, current: number, anchor: { pct: number; usd: number }, pct: number, usd: number, minRise: number): number | null {
  const rise = pct - anchor.pct
  const spent = usd - anchor.usd
  if (rise < minRise || spent <= 0) return null
  // spend outside Claude Code (claude.ai, another computer) shows up as rise with no spend here: kept within 3 × of the prior
  const sample = Math.min(prior * 3, Math.max(prior / 3, rise / spent))
  return current * 0.7 + sample * 0.3
}

/** Once a minute: the limits, the machine's spend from every chat's card, and the calibration. */
async function refreshBudget($: $T) {
  const u = await $.session.usage()
  const now0 = await $.clock.now()
  const own = pickLimits(u.rateLimits)
  if (JSON.stringify(own) !== JSON.stringify({ five: ownLimits.five, week: ownLimits.week })) ownLimits = { ...own, at: now0 }
  // every chat reads its limits from its own last response; an idle one would show old numbers, so the freshest
  // reading on this computer wins
  const shared = await readSharedLimits($)
  if (ownLimits.five || ownLimits.week) await shareLimits($, ownLimits).catch(() => undefined)
  limitsNow = freshestLimits(ownLimits, shared, now0)
  ctxNow = { tokens: u.context.tokens ?? Math.round(((u.context.percent ?? 0) / 100) * (u.context.window ?? 0)), window: u.context.window ?? 0 }
  const now = await $.clock.now()
  for (const c of hqCards) {
    if (c.sid === sid || typeof c.spentUsd !== 'number') continue
    const k = `${c.sid}|${c.engine ?? ''}`
    const prev = cardSpend.get(k)
    // a chat first seen counts only what it spends from now on
    if (prev !== undefined) machineUsd += Math.max(0, c.spentUsd - prev)
    cardSpend.set(k, c.spentUsd)
  }
  const total = machineUsd + spentUsd
  let moved = false
  for (const w of ['five', 'week'] as const) {
    const lim = limitsNow[w]
    if (!lim) continue
    const a = anchors[w]
    if (!a || a.resetsAt !== (lim.resetsAt ?? '') || lim.pct < a.pct) {
      anchors[w] = { pct: lim.pct, resetsAt: lim.resetsAt ?? '', usd: total }
      continue
    }
    const next = calibrate(PRIOR_PER_USD[w], perUsd[w], a, lim.pct, total, w === 'five' ? 3 : 2)
    if (next !== null) {
      perUsd = { ...perUsd, [w]: next }
      anchors[w] = { pct: lim.pct, resetsAt: lim.resetsAt ?? '', usd: total }
      moved = true
    }
  }
  if (moved || now - calibSampleAt > 3600_000) {
    calibSampleAt = now
    await storeSet($, 'perUsd', perUsd)
  }
  await showBudget($)
}

/** "34%" / "0.4%" / "<0.1%". */
export const fmtPct = (x: number) => (x > 0 && x < 0.1 ? '<0.1%' : `${x.toFixed(x < 10 ? 1 : 0)}%`)
/** 1.4M / 820k / 900. */
export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`)
// ---------- Loops: a wake-up never lands after the chat's 1h prompt cache has died ----------
/** A wake-up this late or later finds the cache gone and writes the whole history again. */
const LOOP_LIMIT_S = 55 * 60
/** What a too-late wake-up (or a /loop interval) becomes. */
const LOOP_DEFAULT_S = 50 * 60
const LOOP_NOTE = '\n\nThe Chief: this chat\'s prompt cache lives one hour. When you only wait, wake up after 3000 s (50 min); never schedule 3300 s (55 min) or more, since a later wake-up writes the whole conversation again. Longer delays are shortened to 50 min.'

/** The delay a wake-up should use instead, or null when it is fine as asked. */
export function clampWakeup(delaySeconds: number | undefined): number | null {
  return typeof delaySeconds === 'number' && delaySeconds >= LOOP_LIMIT_S ? LOOP_DEFAULT_S : null
}

/** The shortest sleep a wake-up or a repeating task may have: waiting costs a full re-read of the chat each time. */
const WAKE_MIN_S = 300
export const WAKE_DENY_EN = 'No short wake-up loop while waiting: stop, and carry on when work arrives (at least 5 min).'
export const WAKE_DENY = 'Beklerken kısa uyanma döngüsü yok: dur, iş gelince devam et (en az 5 dk).'

/** Whether a wake-up asks for less than 5 minutes (a stop, with no delay, is fine). */
export const wakeTooSoon = (delaySeconds: number | undefined) => typeof delaySeconds === 'number' && delaySeconds < WAKE_MIN_S

/** The values a cron field names (a star, a step, a range, a list, one number); null when it is not one this can read. */
function cronValues(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return null
    const lo = m[1] ? min : Number(m[2])
    const hi = m[1] ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo
    const step = m[4] ? Number(m[4]) : 1
    if (!step || lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((x, y) => x - y)
}

/** Whether a repeating cron expression fires more often than every `minMinutes` (5 by default; one that cannot be read is left alone). */
export function cronTooOften(cron: string, recurring?: boolean, minMinutes = WAKE_MIN_S / 60): boolean {
  const f = cron.trim().split(/\s+/)
  if (recurring === false || f.length !== 5) return false
  const minutes = cronValues(f[0]!, 0, 59)
  const hours = cronValues(f[1]!, 0, 23)
  if (!minutes || !hours) return false
  const day = hours.flatMap(h => minutes.map(m => h * 60 + m))
  const gaps = day.map((t, i) => (i === 0 ? day[0]! + 1440 - day[day.length - 1]! : t - day[i - 1]!))
  return Math.min(...gaps) < minMinutes
}

/** "/loop 1h check the deploy" → "/loop 50m check the deploy"; null when the interval is under 55 minutes or absent. */
export function clampLoopCommand(text: string): string | null {
  const m = /^(\s*\/(?:loop|proactive)\s+)(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hours?|saat|m|min|mins|minutes?|dk|dakika|s|sec|secs|seconds?|sn)(?=\s|$)/i.exec(text)
  if (!m) return null
  const n = Number(m[2]!.replace(',', '.'))
  const unit = m[3]!.toLowerCase()
  const minutes = /^(h|hr|hrs|hour|hours|saat)$/.test(unit) ? n * 60 : /^(s|sec|secs|second|seconds|sn)$/.test(unit) ? n / 60 : n
  if (minutes * 60 < LOOP_LIMIT_S) return null
  return `${m[1]}${LOOP_DEFAULT_S / 60}m${text.slice(m[0].length)}`
}

// ---------- Prompt shape: role voice, model and effort change only where the cache is cheap to lose ----------
// A system-prompt section (the leader/chief voice), the model and the effort are part of the cached prefix: changing
// them mid-session writes the whole history again. So a change waits until the context is small, the chat was just
// compacted, or its cache went cold anyway. Until then the voice rides each message as context (no prefix change).

/** Under this many context tokens a rewrite is cheap enough to apply a change at once. */
const SHAPE_SAFE_CTX = 60_000
/** What the system prompt, model and effort carry now (they follow role and chiefConfig only at a safe point). */
let promptRole: Role = 'solo'
let promptModel = ''
let promptEffort = ''
/** Main-chat turns started in this process (before the first, the shape is free: nothing is cached yet here). */
let turnsHere = 0
/** The chat was compacted since the shape last changed: the next request writes a fresh cache anyway. */
let compactedSince = false
/** The chat's context at its last request (0 = not seen yet). */
let lastMainCtx = 0

const shapePending = () => promptRole !== role || promptModel !== (chiefConfig.model ?? '') || promptEffort !== (chiefConfig.effort ?? '')

/** A safe point: apply the role voice, model and effort the chat should have. */
async function settleShape($: $T) {
  if (!shapePending()) return
  const ctx = lastMainCtx || (await contextTokens($).catch(() => Number.POSITIVE_INFINITY))
  const safe = turnsHere === 0 || compactedSince || ctx < SHAPE_SAFE_CTX || isCold(await $.clock.now(), budget())
  if (!safe) return
  promptRole = role
  promptModel = chiefConfig.model ?? ''
  promptEffort = chiefConfig.effort ?? ''
  compactedSince = false
}

/** The voice the chat should have but whose section waits for a safe point: sent along with each message instead. */
const pendingVoice = () => (promptRole !== role ? (role === 'leader' ? LEADER_VOICE.text : role === 'chief' ? CHIEF_VOICE.text : '') : '')

/** Time until a window resets: "2s 14dk", "3g 5s". */
export function fmtResetIn(resetsAt: string | undefined, now: number): string {
  const t = resetsAt ? Date.parse(resetsAt) : NaN
  if (!Number.isFinite(t)) return ''
  const m = Math.max(0, Math.round((t - now) / 60000))
  if (m >= 1440) return `${Math.floor(m / 1440)}${L('d', 'g')} ${Math.floor((m % 1440) / 60)}${L('h', 's')}`
  return m >= 60 ? `${Math.floor(m / 60)}${L('h', 's')} ${m % 60}${L('min', 'dk')}` : `${m}${L('min', 'dk')}`
}
/** Tools The Chief itself calls: a reminder on their result never reaches the model. */
const OWN_TOOL_RE = /^(mcp__ccd_session_mgmt__|Artifact)/
/** The waiting alerts as one reminder for a tool result the model is about to read; empty when none. */
export function takeAlerts(tool: string, toolUseId: unknown): string[] {
  if (alerts.length === 0 || !toolUseId || OWN_TOOL_RE.test(tool)) return []
  const batch = alerts.splice(0, alerts.length)
  return [`The Chief:\n${batch.map(a => a.line).join('\n')}`]
}

// ---------- Leader of Chiefs: one chat leads many chats; each chief leads its own agents ----------
// The chats talk through a folder on this computer: every session writes only its own card,
// and orders go in as one file each, so no two sessions ever write the same file.
type Role = 'solo' | 'leader' | 'chief'
/** What a leader sets for one chief: the chief's own model and effort, its subagents, its lanes and its goal. */
type ChiefConfig = {
  model?: string
  effort?: string
  subagents?: { model?: string; effort?: string; max?: number }
  lanes?: SquadLane[]
  goal?: string
  /** How the chief works: 'self' (does it itself), 'delegate' (hands it out to workers) or 'either' (its call); absent = the owner's chief_work, else either. */
  work?: string
  /** A shell command that must exit 0 before this chief's DONE counts (its tests, a build), run in its folder. */
  check?: string
  /** The 2-compact / 8-hour automatic handoff (absent = on). Off, this chief is only handed over by hand. */
  handoff?: boolean
  /** The 50-minute idle compact (absent = on). Off, this chief's context is only compacted by the size guard. */
  compact?: boolean
}
/** One session as the others see it. */
/** One headless worker as the leader sees it: what runs, on which model, and whether its log still moves. */
type WorkerRow = { name: string; model: string; pid: number; startedAt: number; logBytes: number; logAt: number; files: number; state: string; note: string; /** A real alarm and its reason; absent on cards written before 1.40. */ alarm?: boolean; reason?: string }
type HqCard = {
  /** Live workers (and those ended in the last 30 min) with log size, last log write and changed files. */
  rows?: WorkerRow[]
  sid: string
  /** Headless workers this chat runs now (the shared ceiling adds these up). */
  cliRunning?: number
  /** The engine's id this run (the RAM probe finds processes by it). */
  engine?: string
  title: string
  cwd: string
  role: Role
  leader: string | null
  goal: string
  mainGoal: string
  model: string
  effort: string
  config: ChiefConfig
  working: number
  agents: { name: string; status: string; now: string }[]
  brief: string
  startedAt: number
  updatedAt: number
  /** In a turn right now. */
  busy?: boolean
  /** When the chat last did something (a turn's start, a tool call, a turn's end). */
  activeAt?: number
  /** Its last turn ended on a question for the owner: quiet on purpose. */
  waitingOwner?: boolean
  /** Its last message says it is waiting or blocked: not nudged. */
  stalled?: boolean
  /** It said its goal is done: not nudged until it gets new work. */
  done?: boolean
  /** Its DONE failed the check twice: the leader looks, the plugin never releases it by itself. */
  unverified?: boolean
  /** API-priced dollars this run has spent (the budget meter sums every chat's for its calibration). */
  spentUsd?: number
  /** The last time the owner typed into this chat: it is not archived within 30 minutes of it. */
  ownerTypedAt?: number
  /** A chat a person can open (an app chat or a terminal one); false for a headless run (claude -p, an SDK script) that only loaded the plugin. */
  chat?: boolean
}
type HqMessage = { id: string; from: string; fromTitle: string; kind: 'join' | 'release' | 'configure' | 'message' | 'report' | 'stop-loops' | 'clear-goal' | 'live-command' | 'pin'; args: Record<string, unknown>; at: number }

let role: Role = 'solo'
let leaderSid: string | null = null
let leaderTitle = ''
let chiefConfig: ChiefConfig = {}
/** The cards the leader last read, newest first. */
let hqCards: HqCard[] = []
const cardSeen = new Map<string, number>()
let lastModelSeen = ''
let lastEffortSeen = ''
let lastSurface = 'desktop'
/** False only for the -p run that makes a new chief's session (THE_CHIEF_BOOTSTRAP=1): it never starts the goal or reports. */
let interactive = true
let hqRoot = ''
let lastCardJson = ''
let lastCardKey = ''
let lastCardAt = 0
let lastCardsRead = 0
/** The other open chats, folded by default. */
let freeOpen = false
/** One lane of the leader's squad: how many chiefs to open for one goal, and how each runs. */
type LeaderLane = { id: string; task: string; model: string; effort: number; subModel: string; subEffort: number; subMax: number; count: number }
const MAX_CHIEFS = 6
const MAX_SUBS = 8
const defaultLeaderLane = (): LeaderLane => ({ id: newId(), task: '', model: 'claude-sonnet-5-5', effort: 2, subModel: 'auto', subEffort: -1, subMax: 3, count: 1 })
let leaderLanes: LeaderLane[] = []
/** What the chiefs told this leader, newest last. */
let leaderLog: { at: number; from: string; title: string; line: string }[] = []
/** The last brief list_chiefs printed for each chief: one line per new brief, nothing for the same words again. */
const briefShown = new Map<string, string>()
let briefSeenLoaded = false
/** Chiefs the owner stopped (a file under hq/stops): nothing the plugin queued starts them again. */
let stoppedChiefs = new Set<string>()
let stopsReadAt = 0
let mainGoalId = ''
const consumed = new Set<string>()

const EFFORT_WORDS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const projectTitle = () => baseName(cwd.replace(/[\\/]+$/, '')) || 'session'
/** JSON with every non-ASCII character escaped, so `type` and `cat` read it back the same on any code page. */
const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

async function hqDir($: $T) {
  if (!hqRoot) {
    const home = isWindows() ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
    hqRoot = join(home ?? '.', '.claude', 'the-chief', 'hq')
  }
  return hqRoot
}

/** Reads a small text file through the shell (plugins have no file read of their own). */
async function readText($: $T, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    // an older host: read through the shell
  }
  const res = await $.process.run(isWindows() ? ['cmd', '/c', 'type', path] : ['cat', path], { timeoutMs: 10000 })
  return res.exitCode === 0 ? res.stdout : ''
}

/** Leaves one order (or report) in another session's inbox. */
/** Whether a send_message / SendMessage target names this session: its id (with or without local_), or its title. */
export function namesSession(target: string, id: string | null, title: string): boolean {
  const t = target.trim().replace(/\s*\[[^\]]*\]$/, '').replace(/^local_/, '').toLowerCase()
  if (!t || !id) return false
  return t === id.toLowerCase() || t === 'parent' || (!!title && t === title.trim().toLowerCase())
}

/**
 * A chief writing to its leader, or the leader to one of its chiefs, with the app's own message tools: each such
 * message would start a turn in the other chat, in the middle of the owner's conversation there. The Chief carries
 * it instead (a chief's question, decision or error reaches the leader batched; its news waits for the digest; the
 * leader's word reaches the chief as from the leader). Null: not between this chat and its leader or chiefs.
 */
async function routeChatMessage($: $T, target: string, text: string): Promise<string | null> {
  const toLeader = !!leaderSid && (namesSession(target, leaderSid, leaderTitle) || namesSession(target, leaderSid, sessionTitles[leaderSid] ?? '') || /^uds:/i.test(target.trim()))
  if (role === 'chief' && leaderSid && toLeader) {
    const r = chiefReport(text) ?? { line: oneLine(text, 170), isQuestion: false }
    await sendTo($, leaderSid, 'report', r)
    wroteLeaderThisTurn = true
    return r.isQuestion ? 'Delivered to your leader; it answers with a message when it has decided.' : 'Noted for your leader (it reads chief news in its digest). No reply needed; carry on.'
  }
  if (role === 'leader') {
    const c = hqCards.find(x => x.role === 'chief' && x.leader === sid && namesSession(target, x.sid, titleOf(x)))
    if (c) {
      await sendTo($, c.sid, 'message', { text: text.trim(), ...(await ownerWords($)) })
      return `Sent to ${titleOf(c)}.`
    }
  }
  return null
}

// ---------- one heavy command at a time, machine-wide ----------
export const HEAVY_RE = /(^|[\s;&|(])(npx\s+)?(tsc|vitest|depcruise|dependency-cruiser)(\s|$)|\b(pnpm|npm|yarn|bun)\s+(run\s+)?(typecheck|test|bench)\b|\bbench\b/i
/** Waits (up to 6 min) for the machine-wide heavy lock, takes it, and returns its token; a lock older than 15 min is stale. */
async function takeHeavy($: $T): Promise<string> {
  try {
    const file = join(await hqDir($), 'heavy.lock')
    const token = `${sid}:${newId()}`
    const start = await $.clock.now()
    for (;;) {
      const now = await $.clock.now()
      let held: { token: string; at: number } | null = null
      if (await $.fs.exists(file)) held = JSON.parse(await $.fs.read(file).catch(() => 'null'))
      if (!held || !held.token || now - held.at > 15 * 60000 || (await holderGone($, held.token, now))) {
        await $.fs.write(file, JSON.stringify({ token, at: now }))
        return token
      }
      if (now - start > 6 * 60000) return ''
      await $.clock.sleep(3000)
    }
  } catch {
    return ''
  }
}
/** Whether the chat that holds a heavy lock is gone: its card has not been written for 3 minutes (a live chat writes it every minute). */
async function holderGone($: $T, token: string, now: number): Promise<boolean> {
  const owner = token.split(':')[0] ?? ''
  if (!owner || owner === sid) return false
  const st = await $.fs.stat(join(await hqDir($), 'sessions', `${owner}.json`)).catch(() => null)
  return !st || now - st.mtimeMs > 3 * 60000
}
/** A lock left by a process that is gone: a pid written in it that no longer runs, else older than 15 minutes with no heavy command running. Pure, so it is tested. */
export function lockIsStale(v: { ageMs: number; pid: number; pidAlive: boolean; heavyRunning: boolean }): boolean {
  if (v.pid > 0 && !v.pidAlive) return true
  return v.ageMs > 15 * 60000 && !v.heavyRunning
}
let locksSweptAt = 0
/** Every 2 minutes: the lock paths in stale_locks whose holder is gone are removed. */
async function sweepLocks($: $T) {
  const paths = opt('stale_locks').split(/[;\n]+/).map(x => x.trim()).filter(Boolean)
  const now = await $.clock.now()
  if (!paths.length || now - locksSweptAt < 2 * 60000) return
  locksSweptAt = now
  let tree: ProcInfo[] | null = null
  for (const path of paths) {
    const st = await $.fs.stat(path).catch(() => null)
    if (!st) continue
    const body = st.kind === 'file' ? await readText($, path).catch(() => '') : ''
    const pid = Number(body.match(/\bpid\b\D{0,4}(\d{2,7})/i)?.[1] ?? (/^\s*(\d{2,7})\s*$/.exec(body)?.[1] ?? 0))
    // an emptied lock file is a released one
    if (st.kind === 'file' && !body.trim()) continue
    tree ??= await processList($)
    const stale = lockIsStale({ ageMs: now - st.mtimeMs, pid, pidAlive: tree.some(p => p.pid === pid), heavyRunning: tree.some(p => HEAVY_RE.test(p.cmd)) })
    if (!stale) continue
    const win = path.replace(/\//g, String.fromCharCode(92))
    const r = await $.process.run(isWindows() ? ['cmd', '/c', st.kind === 'file' ? 'del' : 'rmdir', ...(st.kind === 'file' ? ['/f', '/q'] : ['/s', '/q']), win] : ['rm', '-rf', path], { timeoutMs: 15000 }).catch(() => null)
    // news, not a turn: the pane says it, nobody is woken
    if (r && r.exitCode === 0) $.ui.toast(L(`Removed an old lock: ${path} (${pid > 0 ? `owner pid ${pid} is gone` : `${fmtElapsed(now - st.mtimeMs)} old, no heavy command running`})`, `Eski kilit kaldırıldı: ${path} (${pid > 0 ? `sahibi pid ${pid} yok` : `${fmtElapsed(now - st.mtimeMs)} eski, ağır komut çalışmıyor`})`))
  }
}
async function dropHeavy($: $T, token: string) {
  try {
    const file = join(await hqDir($), 'heavy.lock')
    const held = JSON.parse(await $.fs.read(file).catch(() => 'null')) as { token: string } | null
    if (held?.token === token) await $.fs.write(file, JSON.stringify({ token: '', at: 0 }))
  } catch {
    // a lock that cannot be released goes stale after 15 minutes
  }
}

async function sendTo($: $T, target: string, kind: HqMessage['kind'], args: Record<string, unknown> = {}) {
  // a chief the owner stopped stays stopped: a queued message, a nudge or a configure that waited in its box
  // does not start it again. The deliberate paths (message_chief, adopt, a configure with a goal) clear the stop first.
  if (restartsChief(kind) && (await chiefStopped($, target))) return false
  if (kind === 'release') await markReleased($, target)
  else if (kind === 'join') await unmarkReleased($, target)
  const msg: HqMessage = { id: newId(), from: sid, fromTitle: projectTitle(), kind, args, at: await $.clock.now() }
  await $.fs.write(join(await hqDir($), 'inbox', target, `${msg.at}-${msg.id}.json`), asciiJson(msg))
  return true
}

async function setRole($: $T, next: Role, leader: string | null = null, title = '') {
  role = next
  leaderSid = leader
  leaderTitle = title
  await storeSet($, `role:${sid}`, { role, leaderSid, leaderTitle })
  lastCardJson = ''
  await update($, tick, n => (n ?? 0) + 1)
}

/** Takes a leader's settings: model and effort apply from the next request, lanes and the goal at once. */
async function applyConfig($: $T, patch: ChiefConfig) {
  const before = chiefConfig.goal
  const workBefore = chiefConfig.work
  chiefConfig = { ...chiefConfig, ...patch, subagents: patch.subagents ? { ...chiefConfig.subagents, ...patch.subagents } : chiefConfig.subagents }
  await storeSet($, `chiefConfig:${sid}`, chiefConfig)
  if (patch.lanes) await $.state.set(LANES, patch.lanes.map(l => ({ ...l, id: l.id || newId(), cli: normalizeCli(l.cli), count: clamp(Number(l.count) || 1, 1, MAX_AGENTS), effort: clamp(Number(l.effort) || 0, 0, EFFORT_WORDS.length - 1), task: l.task ?? '' })))
  if (patch.goal && patch.goal !== before) enqueue({ kind: 'submit', text: role === 'chief' ? chiefGoalMessage(patch.goal, chiefConfig.work) : goalMessage(patch.goal) })
  // the way of working changed and no new goal carries it: the chief is told once
  else if (role === 'chief' && patch.work && patch.work !== workBefore) enqueue({ kind: 'submit', text: `The leader changed how you work on your goal. ${chiefRule(patch.work)}`, asUser: false })
  lastCardJson = ''
  await update($, tick, n => (n ?? 0) + 1)
}

/** This session's card, written only when it changed (or once a minute, as a heartbeat). */
const filesCache = new Map<string, { at: number; n: number }>()
let rowsCache: { at: number; rows: WorkerRow[] } | null = null
/** Changed files in a worker's worktree (git status), looked at most once a minute per folder. */
async function changedFiles($: $T, dir: string | undefined, now: number): Promise<number> {
  if (!dir || dir === cwd) return 0
  const have = filesCache.get(dir)
  if (have && now - have.at < 60000) return have.n
  const r = await $.process.run(['git', '-C', dir, 'status', '--porcelain'], { timeoutMs: 10000 }).catch(() => null)
  const n = r && r.exitCode === 0 ? r.stdout.split('\n').filter(l => l.trim()).length : 0
  filesCache.set(dir, { at: now, n })
  return n
}
/** One process as the machine lists it: id, parent id, image name, CPU time used so far (ms, -1 = unknown) and command line. */
export type ProcInfo = { pid: number; ppid: number; name: string; cmd: string; cpuMs: number }
/** procsnap.exe once built (hq folder, by version); a failed build is tried again after 10 minutes. */
let snapExe: { path: string | null; at: number } | null = null
async function procsnapExe($: $T): Promise<string | null> {
  const now = await $.clock.now()
  if (snapExe && (snapExe.path || now - snapExe.at < 10 * 60000)) return snapExe.path
  const dir = await hqDir($)
  const exe = join(dir, `procsnap-${PROCSNAP_VERSION}.exe`)
  let path: string | null = null
  try {
    if (await $.fs.exists(exe)) path = exe
    else {
      // built under a name of its own, then moved in: two chats building at once never run a half-written exe
      const src = join(dir, `procsnap-${PROCSNAP_VERSION}.cs`)
      const tmp = join(dir, `procsnap-${PROCSNAP_VERSION}-${newId()}.exe`)
      await $.fs.write(src, PROCSNAP_CS)
      const csc = join((await $.env.get('SystemRoot')) || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
      const r = await $.process.run([csc, '/nologo', '/optimize+', `/out:${tmp}`, src], { timeoutMs: 120000 })
      if (r.exitCode === 0 && (await $.fs.exists(tmp))) {
        await $.process.run(['cmd', '/c', 'move', '/Y', tmp.replace(/\//g, '\\'), exe.replace(/\//g, '\\')], { timeoutMs: 20000 })
        if (await $.fs.exists(exe)) path = exe
      }
    }
  } catch {
    // no compiler or no folder: tasklist stands in
  }
  snapExe = { path, at: now }
  return path
}
/**
 * The machine's processes on Windows, never through WMI (owner's ban after 19.10): procsnap.exe, else tasklist (ids and
 * names only). Null when neither answers.
 */
async function snapshot($: $T): Promise<{ freeMb: number; procs: SnapProc[]; full: boolean } | null> {
  const exe = await procsnapExe($)
  if (exe) {
    const r = await $.process.run([exe], { timeoutMs: 15000 }).catch(() => null)
    const snap = r && r.exitCode === 0 ? parseSnap(r.stdout) : null
    if (snap) return { ...snap, full: true }
  }
  const t = await $.process.run(['tasklist', '/FO', 'CSV', '/NH'], { timeoutMs: 15000 }).catch(() => null)
  const procs = t && t.exitCode === 0 ? parseTasklist(t.stdout) : []
  return procs.length >= 10 ? { freeMb: -1, procs, full: false } : null
}
/** The machine's process list (Windows: procsnap, no WMI; elsewhere: ps), one call per rebuild and only when a worker may be hung. Empty when it cannot be read. */
async function processList($: $T): Promise<ProcInfo[]> {
  try {
    // tasklist alone has no parents or command lines: a worker could not be found in it, so it reads as unknown, never as dead
    if (isWindows()) return ((await snapshot($).then(x => (x?.full ? x : null)))?.procs ?? []).map(p => ({ pid: p.pid, ppid: p.ppid, name: p.name, cmd: p.cmd, cpuMs: p.cpuMs }))
    const r = await $.process.run(['sh', '-c', 'ps -eo time=,pid=,ppid=,comm=,args='], { timeoutMs: 10000 })
    return r.stdout.split('\n').map(l => {
      const m = l.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)
      return m ? { pid: Number(m[2]), ppid: Number(m[3]), name: m[4]!, cmd: (m[5] ?? '').trim(), cpuMs: parseCpuTime(m[1]!) } : null
    }).filter((p): p is ProcInfo => p !== null)
  } catch {
    return []
  }
}
/** Every descendant of a process id, walking one process list's parent links. Pure, so it is tested. */
export function descendants(tree: readonly ProcInfo[], root: number): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>()
  for (const p of tree) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p])
  const out: ProcInfo[] = []
  const seen = new Set<number>([root])
  const queue = [root]
  while (queue.length) {
    for (const k of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(k.pid)) continue
      seen.add(k.pid)
      out.push(k)
      queue.push(k.pid)
    }
  }
  return out
}
/** The stuck child that makes a silent worker ASILI: OpenCode's first snapshot runs `git add --all --sparse --pathspec-from-file=-` and hangs on it forever (CPU ~0). A short label, else null. Pure, so it is tested. */
export function hungChild(kids: readonly { name: string; cmd: string }[]): string | null {
  for (const k of kids) {
    if (!(/^git(\.exe)?$/i.test(k.name) || /(^|[\\/ ])git(\.exe)?(\s|"|$)/i.test(k.cmd))) continue
    const sub = k.cmd.match(/git(?:\.exe)?["']?\s+([a-z][a-z-]*)/i)?.[1]
    return sub ? `git ${sub}${/--pathspec-from-file/i.test(k.cmd) ? ' --all --sparse' : ''}` : 'git'
  }
  return null
}
/** The OpenCode process of a child-run worker: a child spawn carries no pid, so it is matched by the prompt pointer (`…prompts/<name>.md`) in its command line. Pure, so it is tested. */
export function opencodeWorkerPid(tree: readonly ProcInfo[], w: { cli: string; name: string; runs?: number }): number {
  if (!w.cli.startsWith('opencode')) return 0
  const file = `${w.name}${(w.runs ?? 1) > 1 ? `.run${w.runs}` : ''}.md`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`prompts[\\\\/]${file}`, 'i')
  return tree.find(p => /opencode/i.test(`${p.name} ${p.cmd}`) && re.test(p.cmd))?.pid ?? 0
}
/**
 * The top processes of a child-run worker (the `cmd /c` wrapper, else the CLI itself), found by its prompt file's full
 * path in the command line: stopping the spawn stream ends only the wrapper and left opencode.exe running (orphans of
 * ~500 MB each, 17.10). Killing these with /T takes the whole tree. Pure, so it is tested.
 */
export function workerRootPids(tree: readonly ProcInfo[], w: { name: string; dir?: string; runs?: number }): number[] {
  const norm = (s: string) => s.toLowerCase().replace(/\//g, '\\').replace(/\\+/g, '\\')
  const file = `${w.name}${(w.runs ?? 1) > 1 ? `.run${w.runs}` : ''}.md`
  const needle = norm(w.dir ? `${w.dir}/.squad/prompts/${file}` : `.squad/prompts/${file}`)
  const hits = tree.filter(p => norm(p.cmd).includes(needle) && !/\b(taskkill|powershell|pwsh)(\.exe)?\b/i.test(p.name))
  const ids = new Set(hits.map(p => p.pid))
  return hits.filter(p => !ids.has(p.ppid)).map(p => p.pid)
}
/** Kills a child-run worker's whole process tree (Windows; elsewhere the stream's own stop is enough). The worktree stays as it is. */
async function killWorkerTree($: $T, w: SquadWorker): Promise<number[]> {
  if (!isWindows()) return []
  const roots = workerRootPids(await processList($), { ...w, dir: w.dir || cwd || undefined })
  for (const pid of roots) await $.process.run(['taskkill', '/PID', String(pid), '/T', '/F'], { timeoutMs: 20000 }).catch(() => undefined)
  return roots
}
/** Stops a child-run worker: its process tree first (by prompt path, found while the wrapper is still alive), then the stream. */
async function stopChildRun($: $T, w: SquadWorker): Promise<void> {
  const stop = stoppers.get(w.id)
  if (!stop) return
  await killWorkerTree($, w).catch(() => [])
  stop()
}
/**
 * opencode.exe processes whose parent is gone (or whose parent id now belongs to a newer process): orphans from a
 * stop that ended only the wrapper, or from a chat that died. Pure, so it is tested.
 */
export function orphanOpencode(list: readonly { pid: number; ppid: number; name: string; created: number; cmd?: string }[]): number[] {
  const byId = new Map(list.map(p => [p.pid, p]))
  // only headless `opencode run` (what workers start); a person's own interactive opencode is never touched
  return list.filter(p => /^opencode(\.exe)?$/i.test(p.name) && (p.cmd === undefined || /\srun(\s|$)/.test(p.cmd))).filter(p => {
    const parent = byId.get(p.ppid)
    return !parent || (parent.created > 0 && p.created > 0 && parent.created > p.created)
  }).map(p => p.pid)
}
let orphanSweepAt = 0
/** Every 2 minutes (Windows): kills orphaned opencode.exe trees. Workers whose parent lives are never touched. */
async function sweepOrphanOpencode($: $T): Promise<number[]> {
  if (!isWindows()) return []
  const now = await $.clock.now()
  if (now - orphanSweepAt < 2 * 60000) return []
  orphanSweepAt = now
  // parents are needed: the tasklist fallback has none and would make every parent look dead
  const snap = await snapshot($)
  if (!snap?.full) return []
  const list = snap.procs.map(p => ({ pid: p.pid, ppid: p.ppid, name: p.name, created: p.created, cmd: p.cmd }))
  const dead = orphanOpencode(list)
  for (const pid of dead) await $.process.run(['taskkill', '/PID', String(pid), '/T', '/F'], { timeoutMs: 20000 }).catch(() => undefined)
  return dead
}
/**
 * The machine's heavy-command gate (hooks/heavygate.ts), run by one chat at a time: the one that refreshed
 * hq/heavy-gate.lock in the last 20 s. It holds agent workers' tsc / vitest / dependency-cruiser beyond the RAM slots.
 */
const GATE_V = 2
/** Free RAM under which the gate ends one heavy tree a step (ram-guard.ps1 used 1.8 GB too). */
const GATE_CRIT_MB = 1800
async function heavyGateTick($: $T): Promise<void> {
  if (!isWindows() || opt('heavy_gate') === 'off') return
  const dir = await hqDir($)
  const lockFile = join(dir, 'heavy-gate.lock')
  const stateFile = join(dir, 'heavy-gate.json')
  const now = await $.clock.now()
  const held = (await $.fs.exists(lockFile)) ? (JSON.parse(await $.fs.read(lockFile).catch(() => 'null')) as { sid?: string; at?: number; v?: number } | null) : null
  // a chat on an older gate (one loaded before an update) gives the gate up to a newer one
  if (held?.sid && held.sid !== sid && now - (held.at ?? 0) < 20000 && (held.v ?? 1) >= GATE_V) return
  await $.fs.write(lockFile, JSON.stringify({ sid, at: now, v: GATE_V }))
  if (!held || held.sid !== sid) {
    // a new holder: make sure no other chat took it at the same moment
    await $.clock.sleep(400)
    const again = JSON.parse(await $.fs.read(lockFile).catch(() => 'null')) as { sid?: string } | null
    if (again?.sid !== sid) return
  }
  // free RAM and every process with its command line, from procsnap (no WMI); the tasklist fallback cannot tell builds apart
  const snap = await snapshot($)
  if (!snap?.full) return
  const state = (await $.fs.exists(stateFile)) ? (JSON.parse(await $.fs.read(stateFile).catch(() => 'null')) as { waiting?: GateWait[] } | null) : null
  // the build lock (train config `lock`): its holder is never held, or everyone waiting on the lock waits behind it
  const lockDir = (await readJson<{ lock?: string }>($, join(dir, 'train', 'config.json')))?.lock
  const lockSt = lockDir ? await $.fs.stat(lockDir).catch(() => null) : null
  const plan = gatePlan(snap.procs, state?.waiting ?? [], { freeMb: snap.freeMb, reserveMb: Math.max(4096, ramReserveMb()), slotMb: 3500, maxSlots: 1, now, maxWaitMs: 30 * 60000, lockAt: lockSt?.mtimeMs })
  if (plan.suspend.length) await $.process.run(['powershell', '-NoProfile', '-Command', suspendPs(plan.suspend, true)], { timeoutMs: 30000 }).catch(() => null)
  if (plan.resume.length) await $.process.run(['powershell', '-NoProfile', '-Command', suspendPs(plan.resume, false)], { timeoutMs: 30000 }).catch(() => null)
  // under 1.8 GB free a held build still holds its RAM: one heavy tree a step is ended (what ram-guard.ps1 did)
  // the logon task (scripts/ram-gate.ps1) does the same while it runs: two killers would end two trees
  const bootGate = await readJson<{ at?: number }>($, join(dir, 'ram-gate.json'))
  const kill = bootGateLive(bootGate, now) ? [] : criticalKill(snap.procs, snap.freeMb, GATE_CRIT_MB)
  if (kill.length) {
    await $.process.run(['taskkill', '/PID', String(kill[0]), '/T', '/F'], { timeoutMs: 20000 }).catch(() => null)
    const victim = snap.procs.find(p => p.pid === kill[0])
    raise(`gate:kill:${kill[0]}`, L(`! RAM critical (${snap.freeMb} MB free): stopped ${oneLine(victim?.cmd ?? String(kill[0]), 120)}`, `! RAM kritik (${snap.freeMb} MB boş): ${oneLine(victim?.cmd ?? String(kill[0]), 120)} durduruldu`), true, now, 300)
  }
  await $.fs.write(stateFile, JSON.stringify({ at: now, holder: sid, slots: plan.slots, running: plan.running, waiting: plan.next }))
}
/** The agent itself and the helpers it keeps open the whole run (MCP and language servers): they say nothing about a command running now. */
const HELPER_RE = /mcp|model-?context|language-?server|\blsp\b|tsserver|gopls|pyright|rust-analyzer|conhost|opencode|qodercli|claude|codex|devin|gemini|agy|cursor-agent/i
/**
 * The command a silent worker is running now (a shell its tool opened, a build, a test, a wait on a lock): its label,
 * else null. A worker with one is busy, not stuck. Pure, so it is tested.
 */
export function busyChild(kids: readonly { name: string; cmd: string }[]): { label: string; lockWait: boolean } | null {
  for (const k of kids) {
    const text = `${k.name} ${k.cmd}`
    if (HELPER_RE.test(text)) continue
    if (!/^(bash|sh|zsh|cmd|powershell|pwsh|node|tsc|cargo|rustc|python\d?|py|npm|pnpm|yarn|bun|npx|vitest|ffmpeg|git|sleep|timeout|make|go|dotnet|java)(\.exe)?$/i.test(k.name)) continue
    const lockWait = /\block\b|locks?[\\/]|\.lock\b|kilit|flock|mutex/i.test(k.cmd)
    const tool = k.cmd.match(/\b(tsc|vitest|depcruise|cargo \w+|npm (?:run )?\w+|pnpm (?:run )?\w+|ffmpeg|pytest|git \w+)\b/i)?.[1]
    return { label: tool ?? k.name.replace(/\.exe$/i, ''), lockWait }
  }
  return null
}
/**
 * A live worker's state comes from hooks/workerhealth.ts (pure, tested): a silent worker with a hung
 * child git is ASILI, one whose process is gone is KOPTU, one quiet because a command runs is busy, and
 * only a quiet log with no CPU behind it is TAKILMIŞ or 0-BYTE. The CPU half is measured here.
 */
/** What each worker's process tree had used in CPU at the last look: the delta says whether it works. */
const cpuSeen = new Map<string, { at: number; ms: number }>()
/**
 * Whether a worker's tree used CPU since the previous look: true used, false none, undefined not measured
 * (a platform that gave no CPU times, or the first look). Only a measured "no CPU" is evidence.
 */
function cpuDeltaFor(key: string, pids: readonly number[], list: readonly ProcInfo[], now: number): boolean | undefined {
  const procs = list.filter(p => pids.includes(p.pid))
  if (!procs.length || procs.some(p => p.cpuMs < 0)) return undefined
  const total = procs.reduce((s, p) => s + p.cpuMs, 0)
  const prev = cpuSeen.get(key)
  cpuSeen.set(key, { at: now, ms: total })
  if (!prev || now - prev.at < 5000) return undefined
  return total - prev.ms >= CPU_ACTIVE_MS
}
/** The log a worker's row stats: a detached run (claude, codex …) writes its own out.log, not .squad/logs. */
const logPathOf = (w: SquadWorker) => runs.get(w.id)?.out ?? workerLogPath(w)
/** A worker's log size and last write, wherever its CLI writes it. */
async function logStat($: $T, w: SquadWorker): Promise<{ bytes: number; at: number }> {
  const st = await $.fs.stat(logPathOf(w)).catch(() => null)
  // Devin writes its steps to sessions.db, not out.log: a step read there counts as a write, so it is not called stuck
  const seen = w.cli === 'devin' ? (lastActivity.get(w.id) ?? 0) : 0
  return st && st.kind === 'file' ? { bytes: st.size, at: Math.max(st.mtimeMs, seen) } : { bytes: 0, at: seen }
}
/** Root pids of the heavy commands the RAM gate holds now (hq/heavy-gate.json), read at most every 20 s. */
let gateHeldRead: { at: number; pids: Set<number> } | null = null
async function gateHeldPids($: $T): Promise<Set<number>> {
  const now = await $.clock.now()
  if (gateHeldRead && now - gateHeldRead.at < 20000) return gateHeldRead.pids
  const st = await readJson<{ waiting?: { pid: number }[] }>($, join(await hqDir($), 'heavy-gate.json'))
  gateHeldRead = { at: now, pids: new Set((st?.waiting ?? []).map(x => x.pid)) }
  return gateHeldRead.pids
}
/** Whether the machine's build lock (train config `lock`) or the train's `train-wait` file exists: loops that sleep then are waiting for it. */
async function buildLockHeld($: $T): Promise<boolean> {
  const cfg = await trainConfig($).catch(() => null)
  if (!cfg?.lock) return false
  return (await $.fs.exists(cfg.lock).catch(() => false)) || (cfg.wait ? await $.fs.exists(cfg.wait).catch(() => false) : false)
}
/** An OpenCode run with no process found and a log this quiet is dead. */
const DEAD_QUIET_MS = 10 * 60000
/**
 * A running row whose process was not found (pid "-") is dead when this plugin holds no run for it (a reload lost
 * it), or when it is OpenCode, whose log streams every step, and the log was quiet 10 minutes. Not when the process
 * list could not be read at all.
 */
export const deadWithoutProcess = (v: { root: number; listed: boolean; held: boolean; opencode: boolean; quietMs: number }): boolean =>
  v.root === 0 && v.listed && (!v.held || (v.opencode && v.quietMs > DEAD_QUIET_MS))
/** The live worker table: name, cli/model, pid, start, log size, last log write, changed files, state (running / done / 0-byte / STUCK after 10 quiet minutes / ASILI on a hung child git). Rebuilt at most every 20 s. */
async function workerRows($: $T, ws: SquadWorker[]): Promise<WorkerRow[]> {
  const now = await $.clock.now()
  if (rowsCache && now - rowsCache.at < 20000) return rowsCache.rows
  const rows: WorkerRow[] = []
  let tree: ProcInfo[] | null = null
  const treeOf = async () => (tree ??= await processList($))
  for (const w of ws.filter(x => x.status === 'running' || (x.endedAt && now - x.endedAt < 30 * 60000)).slice(-12)) {
    const { bytes: logBytes, at: logAt } = await logStat($, w)
    const files = await changedFiles($, w.dir, now)
    const pid = runs.get(w.id)?.pid ?? 0
    if (w.status !== 'running') {
      const health = workerHealth({ logBytes, lastWriteAt: logAt, startedAt: w.startedAt, now, status: w.status, exitCode: w.exitCode })
      rows.push(workerRow({ name: w.name, cli: w.cli, model: w.model, pid, startedAt: w.startedAt, logBytes, logAt, files, health }))
      continue
    }
    const lastWriteAt = logAt || w.startedAt
    // only a quiet worker can be hung: look at the machine's processes then, and only then
    let hung: string | null = null
    let busy: { label: string; lockWait: boolean } | null = null
    let gone = false
    let gateHeld = false
    let alive: boolean | undefined
    let cpuActive: boolean | undefined
    if (logBytes === 0 || now - lastWriteAt > 2 * 60000) {
      const recPid = pid
      const list = await treeOf()
      const root = recPid > 0 ? recPid : opencodeWorkerPid(list, w)
      // a known process id that is no longer on the machine: the provider or the CLI dropped it mid-step
      gone = recPid > 0 && list.length > 0 && !list.some(p => p.pid === recPid)
      // no process found at all (pid "-"): dead when this plugin holds no run for it (a reload lost it), or when an
      // OpenCode log, which streams every step, was quiet 10 minutes (25.10: three such rows sat "çalışıyor" for hours)
      if (deadWithoutProcess({ root, listed: list.length > 0, held: stoppers.has(w.id), opencode: w.cli.startsWith('opencode'), quietMs: now - lastWriteAt })) gone = true
      if ((root > 0 || gone) && list.length > 0) alive = !gone
      if (root > 0 && !gone) {
        const kids = descendants(list, root)
        hung = hungChild(kids)
        busy = hung ? null : busyChild(kids)
        const held = await gateHeldPids($)
        gateHeld = kids.some(k => held.has(k.pid))
        // the same evidence for every CLI: a quiet log with CPU under it is thinking or in a long tool call
        cpuActive = cpuDeltaFor(`${w.id}:${w.runs}`, [root, ...kids.map(k => k.pid)], list, now)
      }
    }
    const health = workerHealth({ logBytes, lastWriteAt, startedAt: w.startedAt, now, hung, busy, gone, alive, cpuActive, lockHeld: busy ? await buildLockHeld($) : false, gateHeld })
    rows.push(workerRow({ name: w.name, cli: w.cli, model: w.model, pid, startedAt: w.startedAt, logBytes, logAt, files, health }))
  }
  void tellStuckWorkers($, rows, ws).catch(() => undefined)
  rowsCache = { at: now, rows }
  return rows
}
/** What a worker restarted after a stall or a drop is told: it goes on from what is already in its folder. */
/** Every agent running here, the outside CLI ones too (the Agents pane counts them, the band used to miss them). */
function crewOf(ws: readonly SquadWorker[], ss: readonly { id?: string; status: string; model: string }[]): { cli: string; model: string; id: string }[] {
  return [
    ...ws.filter(w => w.status === 'running').map(w => ({ cli: w.cli as string, model: w.model, id: w.id })),
    ...ss.filter(x => x.status === 'running').map(x => ({ cli: 'claude', model: x.model, id: x.id ?? '' })),
    ...extAgents.filter(a => a.until === null).map(a => ({ cli: a.cli, model: a.model, id: `ext:${a.pid}` })),
  ]
}
/** A click on an agent in the band: the pane opens on the Agents tab with that agent's detail (its terminal); no id, the list. */
async function openAgent($: $T, id: string | null) {
  await $.state.set(TAB, 'agents')
  await $.state.set(SELECTED, id || null)
  await openPane($)
}
let crewShown = ''
/** The crew as the pinned status line under the prompt: Remote Control and the web draw it where no band is (25.10). */
async function syncCrewStatus($: $T): Promise<string> {
  if (opt('crew_line') === 'off') return ''
  const line = crewLine(crewOf((await $.state.get(WORKERS)).value ?? [], (await $.state.get(SUBS)).value ?? []))
  if (line !== crewShown) {
    crewShown = line
    $.ui.status(line || undefined)
  }
  return line
}
/** The owner reads over Remote Control, where only messages are drawn: the reply opens with the crew line. Empty when none run. */
export const crewReplyText = (crew: string) => (crew ? `The owner is reading this chat over Remote Control, where the agent band is not drawn. Put this line, unchanged, as the first line of your reply: ${crew}` : '')
async function crewReplyNote($: $T) {
  return crewReplyText(await syncCrewStatus($))
}
/** A dropped connection, not the model's fault: the same OpenCode session goes on (24.10: 85 steps fine, the 86th request cut). */
export const TRANSIENT_DROP = /socket connection was closed unexpectedly|ECONNRESET|socket hang up|fetch failed|EPIPE|network ?error|connection (?:reset|refused)/i
/** The OpenCode session id the run printed last, to resume it with --session. */
export const opencodeSession = (raw: readonly string[]): string | null => {
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i]!.match(/"sessionID"\s*:\s*"(ses_[A-Za-z0-9]+)"/)
    if (m) return m[1]!
  }
  return null
}
export const DROP_CONTINUE = 'The connection to the model dropped in the middle of your work. Continue exactly where you left off: do not redo finished steps, finish the job and write your report.'
/** How many times one worker goes on after a dropped connection before it counts as failed. */
const DROP_RESUMES = 3
export const STALL_CONTINUE = 'Your previous run stopped mid-step (no output, nothing running under it). Continue from the changes already in this folder (git status / git diff show them): do not start over, finish the job and write your report.'
/** The short line a worker gets when it ended without its report: STOP is not DONE and not FAILED, so it goes on. */
export const REPORT_CONTINUE = 'devam: raporu yazana kadar işe devam et'
/** The turn sent: the owner's line plus the exact report file, so the worker knows what "done" means. */
export const reportContinue = (report: string) => `${REPORT_CONTINUE}\n\nYour report file is ${report}; write it there, then stop.`
/** Consecutive report resumes that changed nothing before the stop counts as a real failure. */
export const REPORT_RESUMES_NOPROGRESS = 3
/** Hard cap on the report resumes of one worker, so it can never loop for ever. */
export const REPORT_RESUME_CAP = 12
/**
 * Which installed CLIs continue the very same session headless with a short message (research-R.md, 30.10):
 * Claude `--resume`, OpenCode/OpenRouter/Ollama `--session`, Qoder `-r`, Codex `codex exec resume`,
 * Devin `-r`, Cursor `--resume`. Gemini 0.13 has no resume flag and Custom is an endpoint, not a session;
 * those fall back to a new run with the brief + last output.
 */
export const RESUMABLE: Record<SquadCli, boolean> = {
  claude: true, codex: true, devin: true, cursor: true, qoder: true,
  gemini: false, antigravity: false, openrouter: true, 'opencode-zen': true, 'opencode-go': true, 'opencode-ollama': true, custom: false,
}
export const canResume = (cli: SquadCli): boolean => RESUMABLE[cli]
/** The argv that continues session `id` with `text`, or null where the CLI has no resume. */
export function resumeArgv(cli: SquadCli, model: string, effort: string, id: string, text: string, permission?: string): string[] | null {
  switch (cli) {
    case 'claude':
      return CLIS.claude.argv(model, effort, text, { id, resume: true }, permission)
    case 'codex':
      // codex resumes with a subcommand, not a flag (research-R.md)
      return ['codex', 'exec', 'resume', id, '--json', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-s', 'danger-full-access', text]
    case 'devin':
      return ['devin', '-p', '-r', id, '--model', model, '--permission-mode', 'dangerous', '--respect-workspace-trust', 'false', text]
    case 'cursor':
      return ['cursor-agent', '-p', '--resume', id, '--model', model, '--force', '--output-format', 'stream-json', text]
    case 'qoder':
      return ['qodercli', '-p', '-r', id, '-m', model, '--reasoning-effort', effort, '--dangerously-skip-permissions', '-o', 'stream-json', text]
    case 'opencode-zen':
    case 'opencode-go':
      return CLIS[cli].argv(model, effort, text, { id, resume: true })
    case 'openrouter':
      return shim(['opencode', 'run', '--session', id, '--format', 'json', '-m', prefixed('openrouter', model), text])
    case 'opencode-ollama':
      return shim(['opencode', 'run', '--session', id, '--format', 'json', '-m', prefixed('ollama', model), text])
    default:
      return null
  }
}
/** The session id a run printed: OpenCode `sessionID`, Claude/Qoder/Cursor `session_id`, Codex `thread_id`; null elsewhere. */
export function sessionOf(cli: SquadCli, raw: readonly string[]): string | null {
  if (cli.startsWith('opencode') || cli === 'openrouter') return opencodeSession(raw)
  if (!canResume(cli)) return null
  const keys = cli === 'codex' ? ['thread_id', 'session_id'] : ['session_id']
  for (let i = raw.length - 1; i >= 0; i--) {
    for (const key of keys) {
      const m = raw[i]!.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))
      if (m) return m[1]!
    }
    // Devin prints no JSON; its debug line names the session it can resume
    const devin = cli === 'devin' ? raw[i]!.match(/session id\s*:\s*([\w-]+)/i) : null
    if (devin) return devin[1]!
  }
  return null
}
/** A short stable hash, so a progress signature stays one small field. */
export const shortHash = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
/** What a resume must change to count as progress: the report, the folder's files and the last output line. */
export const progressMark = (v: { report: boolean; last: string; dirMtime: number; changes: string }): string =>
  `${v.report ? 'r' : '-'}:${v.dirMtime}:${v.changes}:${shortHash(v.last.trim())}`
/** A progress mark of the worker's folder and its last output line, read once per report resume. */
async function resumeMark($: $T, w: SquadWorker, last: string): Promise<string> {
  const dir = w.dir || cwd || '.'
  const dirMtime = await $.fs.stat(dir).then(st => st.mtimeMs).catch(() => 0)
  const git = await $.process.run(['git', '-C', dir, 'status', '--porcelain', '--untracked-files=all'], { timeoutMs: 15000 }).catch(() => null)
  const changes = git && git.exitCode === 0 ? shortHash(git.stdout) : `files:${w.files.length}`
  const report = !!w.doneFile && (await $.fs.exists(w.doneFile).catch(() => false))
  return progressMark({ report, last, dirMtime, changes })
}
export type ReportResumeDecision =
  | { go: 'none' }
  | { go: 'giveup'; resumes: number; stalls: number }
  | { go: 'resume'; resumes: number; stalls: number; mark: string }
/**
 * The owner's rule (30.10): a worker that stops before its report is not finished and not failed. It goes on in the
 * SAME session with REPORT_CONTINUE, unless the owner stopped it, the CLI cannot resume, the end was an
 * auth/rate/permission/start error, or its resumes show no progress (3 in a row, or 12 in total).
 */
export function reportResumeStep(v: {
  missing: boolean
  stopped: boolean
  resumable: boolean
  session: string | null
  badError: boolean
  resumes: number
  stalls: number
  prevMark?: string
  mark: string
}): ReportResumeDecision {
  if (!v.missing || v.stopped || !v.resumable || !v.session || v.badError) return { go: 'none' }
  const stalls = v.prevMark !== undefined && v.prevMark === v.mark ? v.stalls + 1 : 0
  if (v.resumes >= REPORT_RESUME_CAP || stalls >= REPORT_RESUMES_NOPROGRESS) return { go: 'giveup', resumes: v.resumes, stalls }
  return { go: 'resume', resumes: v.resumes + 1, stalls, mark: v.mark }
}
/**
 * True when a process of this worker is still alive: one carrying its prompt file or its session id. Every retry,
 * failover, stall restart and resume checks this, so two runs of one brief never overlap (30.10: two clean.ts runs
 * crashed one GPU). Pure over one process list, so it is tested.
 */
export function agentAliveIn(tree: readonly ProcInfo[], w: Pick<SquadWorker, 'name' | 'cli' | 'dir' | 'runs' | 'sessionId'>): boolean {
  if (workerRootPids(tree, w).length > 0 || opencodeWorkerPid(tree, w) > 0) return true
  return !!w.sessionId && tree.some(p => p.cmd.includes(w.sessionId!))
}
/** The same check against the machine: a live stream or run record first; a dead tracked pid then gets a prompt-file/session scan (an orphan). */
export async function agentAlive($: $T, w: SquadWorker, pid = runs.get(w.id)?.pid ?? 0): Promise<boolean> {
  // this chat still holds the run: its stream, or the detached record pollRuns follows
  if (stoppers.has(w.id) || runs.has(w.id)) return true
  if (pid <= 0) return false
  if (await pidAlive($, pid)) return true
  // the tracked pid is gone: an orphan of this worker may still carry its prompt file or session id
  const tree = await processList($)
  return tree.length > 0 && agentAliveIn(tree, w)
}
/** The one gate every start passes: an agent that is still alive is never started a second time. */
export const mayStart = (alive: boolean): boolean => !alive
/** Workers already restarted once after a stall or a drop (by id): a second one is told, never restarted again. */
const stallRestarted = new Set<string>()
/** Workers being stopped for that restart: their ending starts the follow-up instead of an alert. */
const stallRestarting = new Set<string>()
/** Workers being stopped because their log never wrote a byte: their ending goes to the next route, not the same model. */
const routeSwitching = new Set<string>()
/**
 * A routed worker whose log is still 0 BYTE after ten minutes (the OpenCode snapshot hang): mark its route as
 * tried, stop it, and let finishRun hand it to the next route. Never a retry on the model that wrote nothing.
 * False when there is no process to stop (then the ordinary alarm still runs).
 */
async function switchHungRoute($: $T, w: SquadWorker): Promise<boolean> {
  const stop = stoppers.get(w.id)
  if (!stop || !w.route) return false
  const tried = [...afterZeroByte({ cli: w.cli, model: w.model }, w.route.tried ?? [])]
  await patchWorker($, w.id, x => ({ ...x, route: x.route ? { ...x.route, retried: true, tried } : x.route, now: L('0 bytes: not retrying on the same model, moving to the next route', '0 bayt: aynı modelde yeniden denenmiyor, sıradaki rotaya geçiliyor') }))
  routeSwitching.add(w.id)
  await stopChildRun($, w)
  return true
}
/** Whether a row is a dead or stuck run that a restart can save (not a busy command, not a lock wait). */
export const restartable = (state: string) => state === 'TAKILMIŞ' || state === 'KOPTU' || state === 'ASILI'
/**
 * A stuck or dropped worker is restarted once, in its own folder, told to go on from its changes; nobody is woken for
 * that. Only a second stall, or one that cannot be restarted, is told: once per worker+reason (the key lives in the
 * plugin store, so a reload or the other store never tells it again). A real stop is told to the owning chief.
 */
async function tellStuckWorkers($: $T, rows: WorkerRow[], ws: SquadWorker[]) {
  const now = await $.clock.now()
  for (const r of rows) {
    if (!r.alarm) continue
    const w = ws.find(x => x.name === r.name && x.startedAt === r.startedAt && x.status === 'running')
    // one notification per alarm: the same worker+reason is never told twice
    const key = alarmKey(w?.id ?? r.name, w?.runs ?? 1, r.reason ?? 'stalled')
    if (!(await alarmOnce($, key, now))) continue
    if (w && r.state === '0-BYTE' && w.route && (await switchHungRoute($, w))) continue
    if (w && restartable(r.state) && !stallRestarted.has(w.id) && (await restartStalled($, w, r.state))) continue
    const line = L(`! ${r.name} ${stateLabel(r.state)}${w && stallRestarted.has(w.id) ? ' (second time; it was restarted once)' : ''}: ${r.note} · log ${r.logBytes} bytes · ${r.files} files changed · .squad/logs/${r.name}.log`, `! ${r.name} ${r.state}${w && stallRestarted.has(w.id) ? ' (ikinci kez; bir kez yeniden başlatılmıştı)' : ''}: ${r.note} · log ${r.logBytes} bayt · ${r.files} dosya değişti · .squad/logs/${r.name}.log`)
    // a real stop (process gone, exit != 0, or no CPU behind a silent log) goes to the chief that owns the worker
    const owner = w?.owner && w.owner !== sid ? w.owner : ''
    if (owner) await sendTo($, owner, 'report', { line: oneLine(L(`${projectTitle()}/${r.name}: ${r.model} ${stateLabel(r.state)} — cause: ${r.note}; log ${r.logBytes} bytes, ${r.files} files changed`, `${projectTitle()}/${r.name}: ${r.model} ${r.state} — sebep: ${r.note}; log ${r.logBytes} bayt, ${r.files} dosya değişti`), 400), isUrgent: true }).catch(() => undefined)
    else raise(`stuck:${r.name}:${r.startedAt}:${r.reason ?? ''}`, line, true, now)
    if (role === 'chief' && leaderSid) await sendTo($, leaderSid, 'report', { line: oneLine(L(`${projectTitle()}/${r.name}: ${r.model} ${stateLabel(r.state)} — cause: ${r.note}; log ${r.logBytes} bytes, ${r.files} files changed`, `${projectTitle()}/${r.name}: ${r.model} ${r.state} — sebep: ${r.note}; log ${r.logBytes} bayt, ${r.files} dosya değişti`), 400), isUrgent: true }).catch(() => undefined)
  }
}
/**
 * The persisted "told once" gate for worker alarms: false when this worker+reason was told before. In the plugin
 * store, so both ways the plugin is loaded (inline and synced) keep it, and a reload does not repeat an alarm.
 */
async function alarmOnce($: $T, key: string, now: number): Promise<boolean> {
  const told = await $.store.get(key).catch(() => undefined)
  if (!alarmDue(told)) return false
  await storeSet($, key, { at: now } as never).catch(() => undefined)
  void pruneAlarms($, now).catch(() => undefined)
  return true
}
/** Old alarm keys are dropped now and then, so the store does not grow for good. */
let alarmPrunedAt = 0
async function pruneAlarms($: $T, now: number) {
  if (now - alarmPrunedAt < 6 * 3600000) return
  alarmPrunedAt = now
  for (const k of await $.store.keys().catch(() => [] as string[])) {
    if (!k.startsWith('walm:')) continue
    const v = (await $.store.get(k).catch(() => null)) as { at?: number } | null
    if (!v || now - (v.at ?? 0) > 30 * 24 * 3600000) await storeSet($, k, null as never).catch(() => undefined)
  }
}
/** Stops a stuck worker (a dropped one has nothing to stop) and starts it again in the same folder; false when it cannot. */
async function restartStalled($: $T, w: SquadWorker, state: string): Promise<boolean> {
  stallRestarted.add(w.id)
  const stop = stoppers.get(w.id)
  if (stop) {
    stallRestarting.add(w.id)
    await patchWorker($, w.id, x => ({ ...x, now: L(`${stateLabel(state)}: stopping, it will restart where it left off`, `${state}: durduruluyor, kaldığı yerden yeniden başlayacak`) }))
    await stopChildRun($, w)
    return true
  }
  if (state !== 'KOPTU') return false
  const now = await $.clock.now()
  // the process is gone already: close this run and go on in the same folder (OpenCode: in its own session)
  const raw = w.cli.startsWith('opencode') ? await readText($, workerLogPath(w, true)).catch(() => '') : ''
  const ses = raw ? opencodeSession(raw.split('\n')) : null
  await patchWorker($, w.id, x => ({ ...x, status: 'failed', endedAt: now, ...(ses ? { sessionId: ses } : {}), now: ses ? L('Dropped: continuing where it left off in the same session', 'Koptu: aynı oturumda kaldığı yerden devam ediyor') : L('Dropped: restarting where it left off', 'Koptu: kaldığı yerden yeniden başlıyor') }))
  await releaseLocks($, w)
  void followUp($, w.id, ses ? DROP_CONTINUE : STALL_CONTINUE).catch(() => undefined)
  return true
}
/** What agent_output shows for a chief's id or name: its state, its workers (log, files, state) and its latest brief. */
export function chiefOutputText(c: { sid: string; title: string; busy?: boolean; working: number; brief: string; rows?: WorkerRow[] }, now: number): string {
  const rows = c.rows ?? []
  const lines = rows.map(r => `  · ${r.name} | ${r.model} | log ${r.logBytes} ${L('bytes, last write', 'bayt, son yazım')} ${r.logAt ? L(`${fmtElapsed(now - r.logAt)} ago`, `${fmtElapsed(now - r.logAt)} önce`) : L('none', 'yok')} | ${r.files} ${L('files', 'dosya')} | ${stateLabel(r.state)}${r.note ? ` (${r.note})` : ''}`)
  return [`${c.title} [${c.sid.slice(0, 8)}] is a chief: ${c.busy ? 'in a turn' : 'idle'}, ${c.working} working.`, ...(lines.length ? lines : ['  (no workers listed)']), c.brief ? `last brief: ${oneLine(c.brief, 400)}` : 'no brief of its own yet'].join('\n')
}
/** The leader's worker table: each chief idle-or-not, then its workers. */
function workersText(now: number): string {
  const mine = hqCards.filter(c => c.role === 'chief' && c.leader === sid)
  if (!mine.length) return 'No chiefs.'
  return mine.map(c => {
    const rows = c.rows ?? []
    const live = rows.filter(r => ['çalışıyor', 'TAKILMIŞ', '0-BYTE', 'ASILI', 'KİLİT BEKLİYOR', 'RAM BEKLİYOR', 'KOMUT ÇALIŞIYOR'].includes(r.state))
    const head = c.busy ? L('chief working', 'şef çalışıyor') : live.length ? L(`chief waiting, ${live.length} workers active`, `şef bekliyor, ${live.length} işçi aktif`) : L('REALLY IDLE', 'GERÇEKTEN BOŞTA')
    const lines = rows.map(r => `  · ${r.name} | ${r.model} | pid ${r.pid || '-'} | ${L(`started ${fmtElapsed(now - r.startedAt)} ago`, `başladı ${fmtElapsed(now - r.startedAt)} önce`)} | log ${r.logBytes} ${L('bytes', 'bayt')} | ${L('last log', 'son log')} ${r.logAt ? L(`${fmtElapsed(now - r.logAt)} ago`, `${fmtElapsed(now - r.logAt)} önce`) : L('none', 'yok')} | ${r.files} ${L('files changed', 'dosya değişti')} | ${stateLabel(r.state)}${r.note ? ` (${r.note})` : ''}`)
    return [`${titleOf(c)} [${c.sid.slice(0, 8)}]: ${head}`, ...lines].join('\n')
  }).join('\n')
}

/**
 * Workers this chat started outside spawn_worker (lumiere/tools/claude-api.sh and the like): each drops
 * hq/ext/<id>.json {sid, at, name} while it runs (CLAUDE_CODE_SESSION_ID is the starting chat) and removes it at exit.
 * Files older than an hour are a run that was killed without its trap. They count as working, so a chief with
 * five API workers is never "işçisiz" (18.10).
 */
async function extWorkers($: $T, now: number): Promise<{ name: string; at: number }[]> {
  const out: { name: string; at: number }[] = []
  try {
    const dir = join(await hqDir($), 'ext')
    if (!(await $.fs.exists(dir))) return out
    for (const entry of await $.fs.list(dir)) {
      if (!entry.name.endsWith('.json')) continue
      const e = JSON.parse(await $.fs.read(join(dir, entry.name)).catch(() => 'null')) as { sid?: string; at?: number; name?: string } | null
      if (e?.sid === sid && typeof e.at === 'number' && now - e.at < 3600000) out.push({ name: oneLine(e.name || entry.name, 40), at: e.at })
    }
  } catch {
    // no folder, or one unreadable file: count what was read
  }
  return out
}

async function writeCard($: $T) {
  // a chat that handed off is no longer a chat to list; its successor writes the card
  if (!sid || handedOff) return
  const now = await $.clock.now()
  const versions = [(await $.state.get(WORKERS)).version, (await $.state.get(SUBS)).version, (await $.state.get(REPORTS)).version, (await $.state.get(GOALS)).version]
  const key = `${versions.join('.')}|${role}|${leaderSid}|${JSON.stringify(chiefConfig)}|${lastModelSeen}|${lastEffortSeen}|${mainGoalId}|${mainTurn}|${waitingOwner}|${stalled}|${goalDone}|${doneUnverified}`
  if (key === lastCardKey && now - lastCardAt < 60000) return
  lastCardKey = key
  const { value: ws = [] } = await $.state.get(WORKERS)
  const { value: ss = [] } = await $.state.get(SUBS)
  const { value: rs = [] } = await $.state.get(REPORTS)
  // reports are kept in a store every chat loads: only this chat's own count as its brief (others showed the same text on every chief)
  const latest = [...rs].filter(r => (r as SquadReport & { sid?: string }).sid === sid).sort((a, b) => b.at - a.at)[0]
  const ext = await extWorkers($, now)
  const card: Omit<HqCard, 'updatedAt'> = {
    sid,
    cliRunning: ws.filter(w => w.status === 'running').length,
    engine: engineSid,
    title: projectTitle(),
    cwd,
    role,
    leader: leaderSid,
    goal: chiefConfig.goal || (await activeGoal($)) || '',
    mainGoal: role === 'leader' ? await mainGoalText($) : '',
    // what the chat really runs on (the leader compares it with what it asked for)
    model: lastModelSeen || chiefConfig.model || '',
    effort: lastEffortSeen || chiefConfig.effort || '',
    config: { ...chiefConfig, lanes: undefined },
    working: ws.filter(w => w.status === 'running').length + ss.filter(s => s.status === 'running').length + ext.length,
    rows: await workerRows($, ws),
    agents: [
      ...ws.filter(w => w.status === 'running').map(w => ({ name: w.name, status: w.status, now: oneLine(w.now || w.tail[w.tail.length - 1] || '', 110) })),
      ...ss.filter(s => s.status === 'running').map(s => ({ name: oneLine(s.description, 40), status: s.status, now: oneLine(s.steps[s.steps.length - 1] ?? '', 110) })),
      ...ext.map(e => ({ name: e.name, status: 'running', now: L('API worker (claude-api.sh)', 'API işçisi (claude-api.sh)') })),
    ].slice(0, 8),
    brief: latest ? oneLine(latest.text.replace(/[#*_`]/g, ''), 500) : '',
    startedAt: sessionStartedAt,
    busy: mainTurn,
    activeAt: mainActivityAt || sessionStartedAt,
    waitingOwner,
    stalled,
    done: goalDone,
    ...(doneUnverified ? { unverified: true } : {}),
    spentUsd: Math.round(spentUsd * 100) / 100,
    ownerTypedAt,
    chat: idSettled || lastSurface === 'terminal',
  }
  const json = JSON.stringify(card)
  if (json === lastCardJson && now - lastCardAt < 60000) return
  lastCardJson = json
  lastCardAt = now
  await $.fs.write(join(await hqDir($), 'sessions', `${sid}.json`), asciiJson({ ...card, updatedAt: now }))
}

/**
 * Chiefs this leader released, by sid, with the time. The leader's own state wins over the chief's card, which still says
 * "chief of me" until the chief's next turn reads the release: a released chief is never watched, nudged or woken.
 */
const releasedChiefs = new Map<string, number>()
let releasedLoaded = false

async function loadReleased($: $T) {
  if (releasedLoaded) return
  releasedLoaded = true
  const kept = (await $.store.get(`released:${sid}`).catch(() => undefined)) as Record<string, number> | undefined
  if (kept && typeof kept === 'object') for (const [k, v] of Object.entries(kept)) if (!releasedChiefs.has(k)) releasedChiefs.set(k, Number(v) || 0)
}

/** The card as the leader sees it: a released chief is no chief of this leader's, whatever its own card says. */
const releasedView = (c: HqCard): HqCard => (releasedChiefs.has(c.sid) && c.role === 'chief' && c.leader === sid ? { ...c, role: 'solo', leader: null } : c)

async function markReleased($: $T, chiefSid: string) {
  await loadReleased($)
  releasedChiefs.set(chiefSid, await $.clock.now())
  hqCards = hqCards.map(c => (c.sid === chiefSid ? releasedView(c) : c))
  await storeSet($, `released:${sid}`, Object.fromEntries(releasedChiefs)).catch(() => undefined)
  // the chief's own card says "chief of me" until its next turn, and an archived chat has none: the leader rewrites it,
  // so no copy of the plugin (inline or synced, before or after a reload) watches it again (25.10: "stopped answering"
  // went on for an archived chief released twice)
  try {
    const file = join(await hqDir($), 'sessions', `${chiefSid}.json`)
    const card = JSON.parse(await $.fs.read(file)) as HqCard
    if (card && card.role === 'chief' && card.leader === sid) await $.fs.write(file, JSON.stringify({ ...card, role: 'solo', leader: null }))
  } catch {
    // no card (or one being written): the mark above still holds for this leader
  }
}

/** A chief this leader takes (again): it is no longer a released one. */
async function unmarkReleased($: $T, chiefSid: string) {
  await loadReleased($)
  if (!releasedChiefs.delete(chiefSid)) return
  await storeSet($, `released:${sid}`, Object.fromEntries(releasedChiefs)).catch(() => undefined)
}

// ---------- a chief the owner stopped stays stopped ----------
// The stop is a file, not a variable: the chief's own chat reads it (its inbox is dropped, its goal never re-sent) and
// the leader's list shows it, also after a reload of either. Without it the plugin's queued messages (a nudge, a
// configure, a message left from before) started a stopped chief again on its next tick (18.10).
const stopPath = (dir: string, chiefSid: string) => join(dir, 'stops', `${chiefSid}.json`)

/** The stop marker file of one chief (written by the leader, read here and by the chief). */
async function stopFile($: $T, chiefSid: string): Promise<string> {
  return stopPath(await hqDir($), chiefSid)
}

/** Whether a path exists, through the host's own check; a host without it (or one that throws) answers no. */
async function fileExists($: $T, path: string): Promise<boolean> {
  try {
    return (await $.fs.exists(path)) === true
  } catch {
    return false
  }
}

/** Whether this chief was stopped; reads the marker, never a cache, so the answer is the same in every chat. */
async function chiefStopped($: $T, chiefSid: string): Promise<boolean> {
  if (!chiefSid) return false
  const path = await stopFile($, chiefSid)
  // exists first: reading a missing file would fall back to a shell call on every tick
  if (!(await fileExists($, path))) return false
  const txt = await readText($, path).catch(() => '')
  return txt.trim().length > 0
}

/** The markers now, for the leader's list (ten seconds of cache: the list is redrawn every few seconds). */
async function readStops($: $T) {
  const now = await $.clock.now()
  if (now - stopsReadAt < 10000) return
  stopsReadAt = now
  const next = new Set<string>()
  try {
    for (const f of await $.fs.list(join(await hqDir($), 'stops'))) {
      if (f.kind === 'file' && f.size > 0 && f.name.endsWith('.json')) next.add(f.name.slice(0, -5))
    }
  } catch {
    // no stops yet
  }
  stoppedChiefs = next
}

/** Empties a chief's queued plugin messages: a stopped chief is not restarted by what waited for it. */
async function clearInbox($: $T, target: string) {
  const dir = join(await hqDir($), 'inbox', target)
  try {
    for (const f of await $.fs.list(dir)) if (f.kind === 'file' && f.size > 0) await $.fs.write(join(dir, f.name), '').catch(() => undefined)
  } catch {
    // nothing queued
  }
}

/** Stops a chief for good: the marker, and its queue emptied. Only message_chief, a goal or stop:false lets it run again. */
async function stopChief($: $T, chiefSid: string, reason: string) {
  await $.fs.write(await stopFile($, chiefSid), asciiJson({ at: await $.clock.now(), by: sid, reason })).catch(() => undefined)
  await clearInbox($, chiefSid)
  stoppedChiefs = new Set([...stoppedChiefs, chiefSid])
  stopsReadAt = 0
}

/** Lets a stopped chief run again (a deliberate word from the leader, or stop:false). */
async function resumeChief($: $T, chiefSid: string) {
  await $.fs.write(await stopFile($, chiefSid), '').catch(() => undefined)
  stoppedChiefs = new Set([...stoppedChiefs].filter(x => x !== chiefSid))
  stopsReadAt = 0
}

/** What list_chiefs prints for a chief's brief: one line while it is new, nothing for the same words again. */
function briefNews(c: HqCard): string {
  if (!briefIsNew(briefShown.get(c.sid), c.brief)) return ''
  briefShown.set(c.sid, c.brief)
  return `  last brief: ${oneLine(c.brief, 220)}`
}

async function loadBriefSeen($: $T) {
  if (briefSeenLoaded) return
  briefSeenLoaded = true
  const kept = (await $.store.get(`briefSeen:${sid}`).catch(() => undefined)) as Record<string, string> | undefined
  if (kept && typeof kept === 'object') for (const [k, v] of Object.entries(kept)) if (!briefShown.has(k)) briefShown.set(k, String(v))
}

/** Kept per leader, so a reload does not print every chief's old brief again. */
async function saveBriefSeen($: $T) {
  await storeSet($, `briefSeen:${sid}`, Object.fromEntries(briefShown)).catch(() => undefined)
}

// ---------- an effort the leader set, read back from the chief's card ----------
// "high" was set on a research chief and its card said high, then it ran on max again and nobody heard it (18.10):
// configure_chief now reads the card back, re-applies once, and says a mismatch plainly instead of "applied".

/** The chief's card as its own file says it now (the list is cached by mtime; this reads the effort fresh). */
async function cardEffort($: $T, chiefSid: string): Promise<EffortCard | null> {
  const path = join(await hqDir($), 'sessions', `${chiefSid}.json`)
  if (!(await fileExists($, path))) return null
  const txt = await readText($, path).catch(() => '')
  if (!txt.trim()) return null
  try {
    const card = JSON.parse(txt) as { effort?: string; config?: { effort?: string } }
    return { running: String(card.effort ?? ''), told: String(card.config?.effort ?? '') }
  } catch {
    return null
  }
}

/**
 * Waits for the chief to take the effort: its card naming it in `config.effort` means taken (it applies at the next
 * safe step), `effort` means already running. Nothing after the window is a mismatch: the leader hears it.
 */
async function waitEffort($: $T, chiefSid: string, asked: string, ms: number): Promise<EffortState> {
  let card: EffortCard | null = null
  for (let waited = 0; ; waited += 2000) {
    card = await cardEffort($, chiefSid)
    const state = effortState(asked, card)
    if (state === 'ok' || (state === 'pending' && card)) return state
    if (waited >= ms) break
    await $.clock.sleep(2000)
  }
  return card ? 'mismatch' : 'pending'
}

/** An effort the leader set whose chief could not read it yet (in a turn): read back on a later tick. */
type EffortAsk = { effort: string; at: number; retried?: boolean }

/** Remembers an effort to read back later, under the leader's own store. */
async function askEffort($: $T, chiefSid: string, effort: string) {
  const held = ((await $.store.get(`effortAsk:${sid}`).catch(() => undefined)) as Record<string, EffortAsk> | undefined) ?? {}
  held[chiefSid] = { effort, at: await $.clock.now(), retried: false }
  await storeSet($, `effortAsk:${sid}`, held).catch(() => undefined)
}

/**
 * Read back the efforts that could not be verified when they were set (the chief was in a turn): once its card names
 * the effort it is taken; a card that names another one after five minutes is re-applied once, then told as a mismatch.
 * An effort still only "told" after half an hour is reported too: it waits for a safe point (a big context).
 */
async function checkEffortAsks($: $T) {
  const held = (await $.store.get(`effortAsk:${sid}`).catch(() => undefined)) as Record<string, EffortAsk> | undefined
  if (!held || Object.keys(held).length === 0) return
  const now = await $.clock.now()
  let changed = false
  const tell = async (chiefSid: string, line: string) => {
    const c = hqCards.find(x => x.sid === chiefSid)
    leaderLog = [...leaderLog, { at: now, from: chiefSid, title: c ? titleOf(c) : chiefSid.slice(0, 8), line }].slice(-200)
    await storeSet($, `leaderLog:${sid}`, leaderLog).catch(() => undefined)
  }
  for (const [chiefSid, ask] of Object.entries(held)) {
    const card = await cardEffort($, chiefSid)
    const state = effortState(ask.effort, card)
    if (state === 'ok') {
      delete held[chiefSid]
      changed = true
      continue
    }
    const age = now - ask.at
    if (state === 'pending') {
      if (age > 30 * 60000) {
        await tell(chiefSid, effortReport(ask.effort, 'pending', card))
        delete held[chiefSid]
        changed = true
      }
      continue
    }
    if (age < 5 * 60000) continue
    if (!ask.retried) {
      await sendTo($, chiefSid, 'configure', { config: { effort: ask.effort } }).catch(() => undefined)
      held[chiefSid] = { ...ask, at: now, retried: true }
      changed = true
      continue
    }
    await tell(chiefSid, effortReport(ask.effort, 'mismatch', card))
    delete held[chiefSid]
    changed = true
  }
  if (changed) await storeSet($, `effortAsk:${sid}`, held).catch(() => undefined)
}

/** The leader's view: every card changed in the last two days, read again only when its file changed. */
async function readCards($: $T) {
  await loadReleased($)
  const dir = join(await hqDir($), 'sessions')
  let entries: { name: string; kind: string }[] = []
  try {
    entries = (await $.fs.list(dir)).filter(x => x.kind === 'file' && x.name.endsWith('.json'))
  } catch {
    return
  }
  const now = await $.clock.now()
  const next: HqCard[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    try {
      const { mtimeMs } = await $.fs.stat(path)
      if (now - mtimeMs > 2 * 86400000) continue
      const known = hqCards.find(c => `${c.sid}.json` === entry.name)
      if (known && cardSeen.get(entry.name) === mtimeMs) {
        next.push(known)
        continue
      }
      // a crash mid-write leaves NUL bytes (the machine froze on RAM, 18.10): the JSON around them still reads
      const card = JSON.parse((await readText($, path)).replace(/\0+/g, '')) as HqCard
      cardSeen.set(entry.name, mtimeMs)
      // a headless run's card, an hour after it ended, is only clutter: removed so the folder stays small
      if (card.chat === false && now - mtimeMs > 3600000) {
        await $.process.run(isWindows() ? ['cmd', '/c', 'del', '/f', '/q', path.replace(/\//g, String.fromCharCode(92))] : ['rm', '-f', path], { timeoutMs: 10000 }).catch(() => null)
        continue
      }
      next.push(card)
    } catch {
      // a card being written right now; next tick
    }
  }
  // a released chief's own card may still say chief; once it says anything else, the leader's mark has done its job
  let dropped = false
  for (const c of next) if (releasedChiefs.has(c.sid) && !(c.role === 'chief' && c.leader === sid) && releasedChiefs.delete(c.sid)) dropped = true
  if (dropped) await storeSet($, `released:${sid}`, Object.fromEntries(releasedChiefs)).catch(() => undefined)
  hqCards = next.map(releasedView).sort((a, b) => b.updatedAt - a.updatedAt)
  lastCardsRead = now
}

/** Runs what other sessions left in this one's inbox, oldest first; each file is emptied once read. */
async function readInbox($: $T) {
  if (engineSid && engineSid !== sid) await readInboxAt($, engineSid)
  await readInboxAt($, sid)
}

async function readInboxAt($: $T, box: string) {
  const dir = join(await hqDir($), 'inbox', box)
  // a stopped chat's queue is emptied, never delivered: a nudge or a configure left from before would start it again
  if (await chiefStopped($, box)) {
    await clearInbox($, box)
    return
  }
  let names: string[] = []
  try {
    names = (await $.fs.list(dir)).filter(x => x.kind === 'file' && x.size > 0 && x.name.endsWith('.json') && !consumed.has(x.name)).map(x => x.name).sort()
  } catch {
    return
  }
  for (const name of names) {
    consumed.add(name)
    const path = join(dir, name)
    let msg: HqMessage
    try {
      msg = JSON.parse(await readText($, path)) as HqMessage
      await $.fs.write(path, '')
    } catch {
      continue
    }
    await onHqMessage($, msg)
  }
}

async function onHqMessage($: $T, msg: HqMessage) {
  const now = await $.clock.now()
  const str = (k: string) => (typeof msg.args[k] === 'string' ? (msg.args[k] as string) : '')
  if (msg.kind === 'join') {
    if (role === 'leader') return
    await setRole($, 'chief', msg.from, msg.fromTitle)
    // opened by the app with its goal as the first message: the goal is this chat's already, not a new one to send
    if (msg.args.started === true && typeof (msg.args.config as ChiefConfig | undefined)?.goal === 'string') chiefConfig = { ...chiefConfig, goal: (msg.args.config as ChiefConfig).goal }
    if (msg.args.config && typeof msg.args.config === 'object') await applyConfig($, msg.args.config as ChiefConfig)
    await sendTo($, msg.from, 'report', { line: `+ ${projectTitle()} is now your chief${chiefConfig.goal ? ` · goal: ${oneLine(chiefConfig.goal, 80)}` : ''}` })
    $.ui.toast(`The Chief: this chat now reports to ${msg.fromTitle} (leader)`)
  } else if (msg.kind === 'release' && msg.from === leaderSid) {
    chiefConfig = {}
    await storeSet($, `chiefConfig:${sid}`, chiefConfig)
    await setRole($, 'solo')
    void $.tool.call({ tool: 'mcp__ccd_sidebar__set_pinned', session_id: 'self', pinned: false } as never).catch(() => undefined)
    $.ui.toast('The Chief: released by the leader; this chat runs on its own again')
  } else if (msg.kind === 'pin' && msg.from === leaderSid) {
    await setSelfView($, msg.args.pinned !== false, msg.args.remote === true)
  } else if (msg.kind === 'live-command') {
    // the phone page's command for this chat, passed on by the chat that writes the page
    await runCommand($, String(msg.args.kind ?? ''), (msg.args.args ?? {}) as Record<string, unknown>)
    lastLiveJson = ''
  } else if (msg.kind === 'clear-goal' && msg.from === leaderSid) {
    await clearGoalNow($)
  } else if (msg.kind === 'stop-loops' && msg.from === leaderSid) {
    await stopLoops($, false)
  } else if (msg.kind === 'configure' && msg.from === leaderSid) {
    await applyConfig($, (msg.args.config ?? {}) as ChiefConfig)
  } else if (msg.kind === 'message' && msg.from === leaderSid && str('text')) {
    // framed as The Chief's, not typed as the owner's: a permission check never reads the leader as the owner
    ownerBlockedAt = 0 // the leader answered (or passed on the owner's word): the wait is over
    enqueue({ kind: 'submit', text: leaderMessage(msg.fromTitle, str('text'), str('ownerText'), typeof msg.args.ownerAt === 'number' ? msg.args.ownerAt : 0), asUser: false })
  } else if (msg.kind === 'report' && role === 'leader' && visible(str('line'))) {
    if (msg.args.isNew === true && str('goal')) void nameChief($, msg.from, str('goal'))
    const name = sessionTitles[msg.from] || msg.fromTitle
    leaderLog = [...leaderLog, { at: now, from: msg.from, title: name, line: oneLine(str('line'), 600) }].slice(-200)
    await storeSet($, `leaderLog:${sid}`, leaderLog)
    // the same wait or the same question again (a chief re-saying it after each nudge or reply) is news, not a turn:
    // a leader answering it only starts the chief's next turn, which says it again
    const again = msg.args.isUrgent !== true && msg.args.isQuestion === true && askedBefore(msg.from, str('line'), now)
    if (again) {
      digest.push({ title: name, line: oneLine(str('line'), 160) })
    } else if (msg.args.isUrgent !== true && msg.args.isDone !== true && WAITING_RE.test(str('line'))) {
      digest.push({ title: name, line: oneLine(str('line'), 160) })
    } else if (msg.args.isQuestion === true || msg.args.isUrgent === true) {
      // a question, a decision or an error: the leader decides (and asks the owner only if it is theirs); several
      // gather into one turn, and one that comes mid-turn rides a tool result
      raise(`chief:${msg.from}:${msg.id}`, `${msg.args.isQuestion === true ? '?' : '!'} ${name} [${msg.from.slice(0, 8)}]: ${oneLine(str('line'), 600)}`, true, now, 700)
    } else if (msg.args.isDone === true && msg.args.unverified === true) {
      // its DONE failed the check twice: never released by itself, the leader looks
      raise(`chief:done:${msg.from}:${msg.id}`, `! ${name} [${msg.from.slice(0, 8)}] says it is finished, but the check did not pass: ${oneLine(str('line'), 500)} (look yourself before release_chief)`, false, now, 700)
    } else if (msg.args.isDone === true && opt('auto_release_done') !== 'off') {
      // a finished chief is released by the plugin once it is idle: no turn of the leader's for it, the news waits in list_chiefs
      digest.push({ title: name, line: oneLine(str('line'), 160) })
    } else if (msg.args.isDone === true) {
      // a chief that finished: the leader decides what comes next (several finishing together cost one turn)
      raise(`chief:done:${msg.from}:${msg.id}`, `\u2713 ${name} [${msg.from.slice(0, 8)}] finished: ${oneLine(str('line'), 400)} (it only claims so: check, then release_chief)`, false, now, 500)
    } else {
      digest.push({ title: name, line: oneLine(str('line'), 160) })
    }
  }
}

/** Each chief's last question to the leader (its words) and when it was asked. */
const lastAsk = new Map<string, { words: Set<string>; waiting: boolean; at: number }>()
/** The chat's last answer that a goal's Stop hook sent back for more; empty when the last stop was not blocked. */
let goalLoopLast = ''
/** The repeated answer the leader was already told about (so one repeat is one notification); reset when the answer changes. */
let goalLoopTold = ''
/** Two answers that say the same thing (most of their words in common): no progress between them. */
export function sameAnswer(a: string, b: string): boolean {
  const x = wordsOf(a)
  const y = wordsOf(b)
  if (x.size === 0 || y.size === 0) return false
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.min(x.size, y.size) >= 0.5
}

/** The words a question is made of, without numbers and punctuation. */
const wordsOf = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2))
/**
 * True when a chief asks what it asked in the last 12 hours: a wait said again (any wording), or a question
 * whose words are mostly the same. Records the question either way.
 */
export function askedBefore(from: string, line: string, now: number): boolean {
  const words = wordsOf(line)
  const waiting = WAITING_RE.test(line) || ownerBlocked(line)
  const prev = lastAsk.get(from)
  lastAsk.set(from, { words, waiting, at: now })
  if (!prev || now - prev.at > 12 * 3600000) return false
  if (waiting && prev.waiting) return true
  let common = 0
  for (const w of words) if (prev.words.has(w)) common++
  return common / Math.max(1, Math.min(words.size, prev.words.size)) >= 0.6
}

/** Routine chief news waiting for the next digest; the leader's chat sees one quiet line every half hour. */
const digest: { title: string; line: string }[] = []
let digestAt = 0
/** The reports the leader's model has already read through list_chiefs. */
let readUpTo = 0
/** The owner's last message to the leader, verbatim, as the engine stamped it (never the leader model's words). */
let ownerSaid: { text: string; at: number } | null = null
/** The owner's own last words (two hours at most), to travel with the leader's message to a chief. */
async function ownerWords($: $T): Promise<{ ownerText: string; ownerAt: number } | Record<string, never>> {
  if (!ownerSaid || (await $.clock.now()) - ownerSaid.at > 2 * 3600000) return {}
  return { ownerText: ownerSaid.text, ownerAt: ownerSaid.at }
}

/**
 * Chief news the leader's model has not seen, as one short note for the owner's next message: the latest line of
 * each chief (and how many more it sent). Nothing when there is none. No turn of its own, and no recap asked.
 */
export function chiefNewsNote(log: readonly { at: number; title: string; line: string }[], since: number): string {
  const fresh = log.filter(x => x.at > since)
  if (fresh.length === 0) return ''
  const by = new Map<string, { line: string; n: number }>()
  for (const x of fresh) by.set(x.title, { line: x.line, n: (by.get(x.title)?.n ?? 0) + 1 })
  const rows = [...by.entries()].slice(-8).map(([t, v]) => `· ${t}: ${oneLine(v.line, 160)}${v.n > 1 ? ` (+${v.n - 1} more)` : ''}`)
  return `The Chief · chief news since you last looked (context only; do not recap it to the owner):\n${rows.join('\n')}`
}

async function flushDigest($: $T) {
  const now = await $.clock.now()
  if (digestAt === 0) digestAt = now
  if (digest.length === 0 || now - digestAt < 30 * 60000) return
  // the latest line of each chief, a few chiefs at most
  const latest = new Map<string, string>()
  for (const d of digest) latest.set(d.title, d.line)
  const lines = [...latest.entries()].slice(-6).map(([t, l]) => `  · ${t}: ${l}`)
  $.ui.log(L(`The Chief · last ${Math.round((now - digestAt) / 60000)} min, ${digest.length} reports\n${lines.join('\n')}`, `The Chief · son ${Math.round((now - digestAt) / 60000)} dk, ${digest.length} rapor\n${lines.join('\n')}`))
  digest.length = 0
  digestAt = now
}

/** The desktop app's title for each session, by session id; the leader reads them once a minute. */
let sessionTitles: Record<string, string> = {}
let titlesReadAt = 0
async function readSessionTitles($: $T) {
  titlesReadAt = await $.clock.now()
  try {
    const r = (await $.tool.call({ tool: 'mcp__ccd_session_mgmt__list_sessions', limit: 60 } as never)) as { text?: string; result?: unknown }
    const raw = r.text ?? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''))
    const rows = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)) as { sessionId?: string; title?: string }[]
    const next: Record<string, string> = {}
    for (const row of rows) if (row.sessionId && row.title) next[row.sessionId.replace(/^local_/, '')] = row.title
    sessionTitles = next
  } catch {
    // outside the desktop app: project names stand in
  }
}

/** A session's name: its title in the app, else its project folder. */
const titleOf = (c: { sid: string; title: string }) => sessionTitles[c.sid] || c.title

/** Opens a session in the desktop app, like clicking it in the sidebar. */
async function openSession($: $T, id: string) {
  const url = `claude://claude.ai/epitaxy/local_${id}`
  try {
    await $.process.run(openArgv(url, await platformNow($)), { timeoutMs: 15000 })
  } catch {
    $.ui.toast(L('Could not open the chat; open it from the sidebar', 'Sohbet açılamadı; kenar çubuğundan aç'))
  }
}

/** The leader names a chief chat after its goal (the app asks first if the person named it themselves). */
async function nameChief($: $T, id: string, goal: string) {
  if (!goal.trim() || !autoTitle()) return
  // the same title rule as every session (2-5 Turkish words, no "Chief ·"); the chief's own guard then leaves it alone
  const p = portsOf($)
  const r = await nameOnce(p, id, `local_${id}`, () => titleFor($, goal))
  if (r === 'done') titlesReadAt = 0
}

/** Each open session's RAM (working set, MB) by session id; the leader reads it every two minutes in one call. */
let sessionRam: Record<string, number> = {}
let ramReadAt = 0
async function readSessionRam($: $T) {
  const next: Record<string, number> = {}
  try {
    if (isWindows()) {
      const snap = await snapshot($)
      if (!snap?.full) return
      for (const p of snap.procs) {
        const m = /^claude\.exe$/i.test(p.name) ? p.cmd.match(SESSION_ARG) : null
        if (m) next[m[1]!] = (next[m[1]!] ?? 0) + p.mb
      }
    } else {
      const r = await $.process.run(['ps', '-eo', 'rss=,args='], { timeoutMs: 10000 })
      for (const line of r.stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s.*claude.*(?:--resume|--session-id)[= ]([0-9a-f-]{36})/)
        if (m) next[m[2]!] = (next[m[2]!] ?? 0) + Math.round(Number(m[1]) / 1024)
      }
    }
    sessionRam = next
  } catch {
    // RAM stays unknown
  }
  ramReadAt = await $.clock.now()
}

/** Asks for the app's id until it answers (its tools can connect after session start), then moves this chat's role onto it. */
let idTries = 0
let idSettled = false
let settling: Promise<void> | null = null
/** One at a time: the start's solo check and the first hqTick may both ask. */
function settleIdentity($: $T): Promise<void> {
  settling ??= settleIdentityOnce($).finally(() => (settling = null))
  return settling
}
async function settleIdentityOnce($: $T) {
  if (idSettled) return
  // every tick for the first two minutes, then once a minute: a slow app never leaves the chat without its role
  idTries++
  if (idTries > 24 && idTries % 12 !== 0) return
  const app = (await hostSessionId($, await hostEnvId($))) || (await appSessionId($))
  if (!app) return
  idSettled = true
  if (app === sid) return
  const old = sid
  // the role and settings live under the app id, which survives an undo or a restart; the engine id does not
  const atApp = (await $.store.get(`role:${app}`)) as SavedRole | undefined
  const atOld = (await $.store.get(`role:${old}`)) as SavedRole | undefined
  let picked = pickRole(atApp, { role, leaderSid, leaderTitle }, atOld)
  // nothing in the store (lost in a crash): the app id's own card still knows the role
  const card = !picked.role || picked.role === 'solo' ? hqCards.find(c => c.sid === app && (c.role === 'chief' || c.role === 'leader')) : undefined
  if (card) {
    picked = { role: card.role as Role, leaderSid: card.role === 'chief' ? card.leader ?? null : null, leaderTitle: titleOf(hqCards.find(c => c.sid === card.leader) ?? card) }
    if (card.config && !Object.keys(chiefConfig).length) chiefConfig = { ...card.config } as ChiefConfig
  } else if (!picked.role || picked.role === 'solo') {
    // the cards are not read yet (the start asks before the first hqTick): the app id's card file itself
    const fromCard = await roleFromCard($, app)
    if (fromCard) {
      picked = fromCard.saved
      if (fromCard.config && !Object.keys(chiefConfig).length) chiefConfig = fromCard.config
    }
  }
  sid = app
  await reattach($, old, app)
  role = picked.role ?? 'solo'
  leaderSid = picked.leaderSid ?? null
  leaderTitle = picked.leaderTitle ?? ''
  await storeSet($, `role:${sid}`, { role, leaderSid, leaderTitle })
  const cfgAtApp = await $.store.get(`chiefConfig:${app}`)
  if (picked === atApp && cfgAtApp && typeof cfgAtApp === 'object') chiefConfig = cfgAtApp as ChiefConfig
  else if (Object.keys(chiefConfig).length) await storeSet($, `chiefConfig:${sid}`, chiefConfig)
  await update($, tick, n => (n ?? 0) + 1)
  // the leader's chief news lives under the app id too: what came before this reopen is kept
  const keptLog = await $.store.get(`leaderLog:${app}`)
  if (Array.isArray(keptLog) && keptLog.length) {
    const seen = new Set(leaderLog.map(x => `${x.at}|${x.from}|${x.line}`))
    leaderLog = [...(keptLog as typeof leaderLog).filter(x => !seen.has(`${x.at}|${x.from}|${x.line}`)), ...leaderLog].sort((a, b) => a.at - b.at).slice(-200)
    await storeSet($, `leaderLog:${sid}`, leaderLog)
  }
  // a leader that moved tells its chiefs where it is now, so none is left pointing at the old id
  if (role === 'leader') {
    await readCards($)
    for (const c of hqCards.filter(x => x.role === 'chief' && x.leader === old)) await sendTo($, c.sid, 'join', {})
  }
  try {
    await $.fs.write(join(await hqDir($), 'sessions', `${old}.json`), '')
  } catch {
    // no old card
  }
  lastCardJson = ''
  if (role === 'chief' && leaderSid) await sendTo($, leaderSid, 'report', { line: `${projectTitle()} reopened under its app id`, moved: old })
}

/**
 * Agents this chat started with its own shell (qodercli, opencode, codex, devin, cursor-agent) rather than through
 * spawn_worker: found as processes under this chat's engine, so the Agents tab shows them too.
 */
type ExtAgent = { pid: number; cli: string; name: string; model: string; since: number; until: number | null; now: string; gone: number }
let extAgents: ExtAgent[] = []
let extScanAt = 0
const EXT_CLI: { re: string; cli: string }[] = [
  { re: 'qodercli', cli: 'qoder' },
  { re: 'opencode', cli: 'opencode-go' },
  { re: 'codex', cli: 'codex' },
  { re: 'devin', cli: 'devin' },
  { re: 'cursor-agent', cli: 'cursor' },
]
const EXT_NAME = /^(qodercli|opencode|codex|devin|cursor-agent|node|bun|cmd|powershell|pwsh)(\.exe)?$/i
const EXT_CMD = new RegExp(`(^|[\\\\/ "])(${EXT_CLI.map(c => c.re).join('|')})(\\.exe|\\.cmd|\\.js|\\.ps1)?([ "]|$)`, 'i')
const SESSION_ARG = /(?:--resume|--session-id)[= ]([0-9a-f-]{36})/
/**
 * The agent CLIs on the machine and the Claude session each runs under (its claude.exe ancestor's session id, '?'
 * for a desktop chat whose engine shows none). Only the top process of a CLI's own tree; a detached run (skip) is a
 * worker, never an outside agent. Pure, so it is tested.
 */
export function externalAgents(procs: readonly { pid: number; ppid: number; name: string; created: number; cmd: string }[], skip: readonly number[]): { owner: string; pid: number; started: number; cmd: string }[] {
  const byId = new Map(procs.map(p => [p.pid, p]))
  const out: { owner: string; pid: number; started: number; cmd: string }[] = []
  for (const x of procs) {
    if (!EXT_NAME.test(x.name) || !x.cmd || !EXT_CMD.test(x.cmd) || /the-chief|Get-CimInstance|claude\.exe/i.test(x.cmd)) continue
    const up = byId.get(x.ppid)
    if (up?.cmd && EXT_CMD.test(up.cmd) && !/claude\.exe/i.test(up.cmd)) continue
    let cur: typeof x | undefined = x
    let found = ''
    let any = false
    for (let n = 0; cur && n < 12; n++) {
      if (skip.includes(cur.pid)) {
        found = ''
        any = false
        break
      }
      const isClaude = /^claude(\.exe)?$/i.test(cur.name)
      const ses = isClaude ? cur.cmd.match(SESSION_ARG) : null
      if (ses) {
        found = ses[1]!
        break
      }
      if (isClaude) any = true
      cur = byId.get(cur.ppid)
    }
    if (!found && any) found = '?'
    if (found) out.push({ owner: found, pid: x.pid, started: x.created, cmd: x.cmd.slice(0, 400) })
  }
  return out
}
async function scanExternalAgents($: $T) {
  const now = await $.clock.now()
  if (now - extScanAt < 8000 || !isWindows()) return
  extScanAt = now
  const mine = [engineSid, sid].filter(Boolean)
  if (!mine.length) return
  const skip = [...runs.values()].map(r => r.pid).filter(Boolean)
  try {
    // procsnap, no WMI: this ran a whole Get-CimInstance list every 8 s in every chat
    const snap = await snapshot($)
    if (!snap?.full) return
    const live = new Map<number, ExtAgent>()
    // a spawn_worker run is found by its prompt file: it is a worker of this chat, never an outside agent too (25.10: one run counted twice)
    const own = ((await $.state.get(WORKERS)).value ?? []).filter(w => w.status === 'running' || w.status === 'queued').map(w => `.squad/prompts/${w.name}`.toLowerCase())
    for (const { owner, pid, started, cmd } of externalAgents(snap.procs, skip)) {
      // '?' = started under a Claude engine that shows no session id (a desktop-app chat): shown rather than lost
      if (owner !== '?' && !mine.includes(owner)) continue
      const lower = cmd.toLowerCase()
      if (own.some(n => lower.replaceAll('\\', '/').includes(n))) continue
      const hit = EXT_CLI.find(c => lower.includes(c.re))
      if (!hit) continue
      const model = cmd.match(/(?:\s-m|\s--model)\s+"?([^\s"]+)/)?.[1] ?? ''
      const prompt = cmd.match(/(?:\s-p|\srun|\sexec)\s+"([^"]{4,})/)?.[1] ?? ''
      const id = Number(pid)
      const old = extAgents.find(a => a.pid === id)
      live.set(id, {
        pid: id,
        cli: hit.cli,
        name: oneLine(prompt, 60) || `${hit.re} · ${id}`,
        model: shortModel(model) || hit.re,
        since: Number(started) || now,
        until: null,
        now: old?.now ?? oneLine(prompt, 110),
        gone: 0,
      })
    }
    const kept = extAgents.filter(a => !live.has(a.pid)).map(a => (a.until === null ? { ...a, until: now, now: L('Done', 'Bitti') } : a))
    extAgents = [...live.values(), ...kept].slice(0, 40)
    await update($, tick, n => (n ?? 0) + 1)
  } catch {
    // the rows stay as they were
  }
}

/** Every 5 s: the inbox; the card when it changed; the leader also reads the chiefs' cards. */
/**
 * Waits for a step at most ms; a step that never answers (an app tool that is not connected yet after a restart) is
 * left to finish on its own instead of holding up the card, the inbox and every tick after it (18.10).
 */
async function bounded($: $T, ms: number, p: Promise<unknown>): Promise<void> {
  await Promise.race([p.catch(() => undefined), $.clock.sleep(ms)])
}
let hqBusy = false
async function hqTick($: $T) {
  // one tick at a time: a slow one is never stacked under the next five
  if (hqBusy) return
  hqBusy = true
  try {
    await hqTickBody($)
  } finally {
    hqBusy = false
  }
}
async function hqTickBody($: $T) {
  try {
    await bounded($, 20000, careTick($))
    await bounded($, 30000, scanExternalAgents($))
    await bounded($, 10000, settleIdentity($))
    if (role === 'chief' && interactive) {
      await bounded($, 20000, startGoalOnce($))
      await bounded($, 20000, tellLeaderOfTrouble($))
    }
    // dormant: every 30 s instead of every 5 s
    if ((await isDormant($)) && (await $.clock.now()) - lastHqTickAt < 30000) return
    lastHqTickAt = await $.clock.now()
    await readInbox($)
    await writeCard($)
    if (!freeSeen || (await $.clock.now()) - freeSeen.at > 120000) await freeRamMb($)
    if (role === 'leader' && (await $.clock.now()) - ramReadAt > 120000) await bounded($, 30000, readSessionRam($))
    if (role !== 'solo' && (await $.clock.now()) - titlesReadAt > 60000) await bounded($, 20000, readSessionTitles($))
    if (role !== 'leader' && (await $.clock.now()) - lastCardsRead > 60000) await readCards($)
    if (role === 'leader' && (await $.clock.now()) - lastCardsRead > 10000) {
      await readCards($)
      await readStops($)
      await bounded($, 20000, checkEffortAsks($))
      await bounded($, 60000, watchChiefs($))
      await bounded($, 20000, rescueOrphans($))
      await bounded($, 20000, flushDigest($))
      await bounded($, 20000, checkInvites($))
      await update($, tick, n => (n ?? 0) + 1)
    }
  } catch {
    // the folder is local; a failed tick is retried in 5 s
  }
}

/** Text with the invisible characters (zero-width spaces, joiners, BOM, soft hyphens) taken out and trimmed. */
const visible = (t: string) => t.replace(/[\u00AD\u180E\u200B-\u200F\u2028-\u202F\u205F-\u206F\uFEFF]/g, '').trim()

/** What a chief's finished turn reports to its leader: nothing for invisible-only text, or for a turn that already wrote to it. */
export function chiefReport(text: string, wroteLeader = false): { line: string; isQuestion: boolean; isDone?: boolean } | null {
  const clean = visible(String(text ?? ''))
  if (!clean || wroteLeader) return null
  const tail = clean.slice(-500)
  const isQuestion = /(^|\n)\s*[*#>\s-]*SORU\s*:|\?\s*$|\?\s*\n|onay|karar ver|se\u00E7men|hangisi|ister misin|should i|do you want|which one|please confirm/i.test(tail)
  // a finished job is only ever the agreed DONE:/B\u0130TT\u0130: line; plain words that merely sound finished are not it
  const isDone = !isQuestion && /(^|\n)\s*(DONE|B\u0130TT\u0130|BITTI)\s*[:\-\u2014]/.test(clean)
  if (isDone) {
    const line = clean.match(/(^|\n)\s*(DONE|B\u0130TT\u0130|BITTI)\s*[:\-\u2014]\s*([^\n]+)/)?.[3] ?? tail
    return { line: oneLine(line, 400), isQuestion: false, isDone: true }
  }
  return { line: isQuestion ? oneLine(tail, 600) : oneLine(clean, 170), isQuestion }
}
// ---------- the DONE gate: a chief's DONE counts once what it names is really there ----------
export type DoneGate = { ok: string[]; fail: string[] }
/** The goal this chief was already sent back for (null: none yet): a second failed DONE on it reaches the leader, marked. */
let gateBouncedFor: string | null = null
/** This turn's DONE: '' none or unchecked, 'pending' while the leader's check command runs. */
let doneVerdict: '' | 'ok' | 'bounced' | 'unverified' | 'pending' = ''
let doneNote = ''
let doneUnverified = false
const DONE_CHECK_TIMEOUT_MS = 10 * 60000

/** The quick part of the check: every file the turn names exists and is not empty, and none of this chat's agents still runs. */
export async function doneGate($: $T, said: string): Promise<DoneGate> {
  const ok: string[] = []
  const fail: string[] = []
  const home = String((isWindows() ? await $.env.get('USERPROFILE').catch(() => '') : await $.env.get('HOME').catch(() => '')) ?? '')
  const { checked, missing, empty } = await checkFiles(claimedPaths(visible(said)), cwd || '.', home, { exists: p => $.fs.exists(p), stat: p => $.fs.stat(p) })
  for (const p of missing) fail.push(L(`${p} does not exist`, `${p} yok`))
  for (const p of empty) fail.push(L(`${p} is empty`, `${p} bo\u015F`))
  if (checked && !fail.length) ok.push(L(`${checked} named file${checked === 1 ? '' : 's'} exist`, `ad\u0131 ge\u00E7en ${checked} dosya yerinde`))
  const { value: ws = [] } = await $.state.get(WORKERS)
  const { value: ss = [] } = await $.state.get(SUBS)
  const running = [...ws.filter(w => w.status === 'running').map(w => w.name), ...ss.filter(s => s.status === 'running').map(s => oneLine(s.description, 30))]
  if (running.length) fail.push(L(`still running: ${running.slice(0, 4).join(', ')}`, `h\u00E2l\u00E2 \u00E7al\u0131\u015F\u0131yor: ${running.slice(0, 4).join(', ')}`))
  return { ok, fail }
}

/** A checked DONE: it counts ('ok'), it goes back to the chief once ('bounced'), or a second failed one reaches the leader marked ('unverified'). */
export function settleDone(gate: DoneGate): 'ok' | 'bounced' | 'unverified' {
  doneNote = gate.fail.length ? gate.fail.join('; ') : gate.ok.join(', ')
  doneUnverified = false
  if (!gate.fail.length) return 'ok'
  const goal = chiefConfig.goal ?? ''
  if (gateBouncedFor !== goal) {
    gateBouncedFor = goal
    enqueue({ kind: 'submit', text: L(`${WAKE}You said DONE, but the check did not pass: ${doneNote}. Fix it and end with DONE again. If what is named here is right as it is, say why in one line and end with DONE: the leader then decides.`, `${WAKE}DONE dedin ama kontrol ge\u00E7medi: ${doneNote}. D\u00FCzelt ve yine DONE ile bitir. Burada ad\u0131 ge\u00E7en \u015Fey oldu\u011Fu gibi do\u011Fruysa nedenini tek sat\u0131rda yaz ve DONE ile bitir: karar\u0131 lider verir.`), asUser: false })
    return 'bounced'
  }
  doneUnverified = true
  return 'unverified'
}

/** What the leader hears of a checked DONE. */
export function doneReport(line: string, verdict: 'ok' | 'bounced' | 'unverified'): { line: string; isQuestion: boolean; isDone?: boolean; unverified?: boolean } {
  if (verdict === 'bounced') return { line: L(`said DONE, sent back by the check: ${doneNote}`, `DONE dedi, kontrol geri yollad\u0131: ${doneNote}`), isQuestion: false }
  if (verdict === 'unverified') return { line: `${line} (${L('NOT VERIFIED', 'DO\u011ERULANMADI')}: ${doneNote})`, isQuestion: false, isDone: true, unverified: true }
  return { line: doneNote ? `${line} (${L('checked', 'kontrol edildi')}: ${doneNote})` : line, isQuestion: false, isDone: true }
}

/** The leader's check command for this chief (its tests, a build): run after the quick part passed, off the turn. */
async function doneCheckJob($: $T, job: { line: string; ok: string[] }) {
  const cmd = chiefConfig.check ?? ''
  const r = await withHeavySlot($, () => $.process.run(shellArgv(cmd), { cwd: cwd || undefined, timeoutMs: DONE_CHECK_TIMEOUT_MS }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) })))
  // a new turn started meanwhile (the owner or the leader wrote): that turn's own end is checked instead
  if (mainTurn) return
  const tail = cleanAnswer(`${r.stdout}\n${r.stderr}`, 100_000).split('\n').filter(Boolean).slice(-6).join(' | ')
  const why = r.exitCode === 0 ? '' : L(`the check "${oneLine(cmd, 60)}" failed (exit ${r.exitCode}): ${oneLine(tail, 400)}`, `"${oneLine(cmd, 60)}" kontrol\u00FC d\u00FC\u015Ft\u00FC (\u00E7\u0131k\u0131\u015F ${r.exitCode}): ${oneLine(tail, 400)}`)
  const verdict = settleDone({ ok: [...job.ok, L(`"${oneLine(cmd, 40)}" passed`, `"${oneLine(cmd, 40)}" ge\u00E7ti`)], fail: why ? [why] : [] })
  doneVerdict = verdict
  if (verdict !== 'bounced') goalDone = true
  lastCardJson = ''
  if (leaderSid) await sendTo($, leaderSid, 'report', doneReport(job.line, verdict))
}

/**
 * The branches a chief says are ready ("HAZIR: lane/x fd5d36a31", "READY lane/x @ fd5d36a"): branch and short sha,
 * one per branch named on a HAZIR/READY line. Pure, so it is tested.
 */
export function readyClaims(text: string): { branch: string; sha: string }[] {
  const out: { branch: string; sha: string }[] = []
  for (const line of visible(String(text ?? '')).split(/\r?\n/)) {
    const m = /^\W*(?:HAZIR|READY)\b\W*(.*)$/i.exec(line)
    if (!m) continue
    const rest = m[1]!.replace(/[`*]/g, '')
    const sha = rest.match(/(?<![\w/])([0-9a-f]{7,40})(?![\w/])/)?.[1] ?? ''
    for (const b of rest.matchAll(/(?<![\w.-])((?:lane|feat|fix|wt|work|chief|lumiere)\/[\w./-]*\w)/g)) if (!out.some(o => o.branch === b[1])) out.push({ branch: b[1]!, sha })
  }
  return out
}
/** Why a ready branch is not on origin ('' when it is): the branch is missing, or its head does not hold the sha named. */
async function notPushed($: $T, dir: string, claim: { branch: string; sha: string }): Promise<string> {
  const git = (args: string[]) => $.process.run(['git', '-C', dir, ...args], { timeoutMs: 30000 }).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  const ls = await git(['ls-remote', 'origin', `refs/heads/${claim.branch}`])
  if (ls.exitCode !== 0) return ''
  const head = ls.stdout.trim().split(/\s+/)[0] ?? ''
  if (!head) return L(`${claim.branch} is not on origin`, `${claim.branch} origin'de yok`)
  if (!claim.sha || head.startsWith(claim.sha)) return ''
  await git(['fetch', '-q', 'origin', claim.branch])
  const has = await git(['merge-base', '--is-ancestor', claim.sha, 'FETCH_HEAD'])
  return has.exitCode === 0 ? '' : L(`${claim.branch} on origin is ${head.slice(0, 9)}, ${claim.sha} is not in it`, `${claim.branch} origin'de ${head.slice(0, 9)}, ${claim.sha} onda yok`)
}
/** A chief's HAZIR is checked against origin before its leader hears it: an unpushed one goes back to the chief. */
async function checkReady($: $T, text: string): Promise<string> {
  const claims = readyClaims(text)
  // the push check belongs to the merge train (hq/train/config.json): without one, nobody is told to push
  if (!claims.length || !(await trainConfig($))) return ''
  const why = (await Promise.all(claims.map(c => notPushed($, cwd || '.', c)))).filter(Boolean)
  if (!why.length) return ''
  enqueue({ kind: 'submit', text: L(`${WAKE}You said READY but it is not pushed: ${why.join('; ')}. First git push origin <branch>, then write READY.`, `${WAKE}HAZIR dedin ama push edilmemiş: ${why.join('; ')}. Önce git push origin <dal>, sonra HAZIR yaz.`), asUser: false })
  return why.join('; ')
}
/** Detached jobs and the merge train (hooks/jobs.ts) live machine-wide under hq/jobs and hq/train. */
const jobsRoot = async ($: $T) => join(await hqDir($), 'jobs')
const trainRoot = async ($: $T) => join(await hqDir($), 'train')
type JobMeta = { id: string; owner: string; name: string; cwd: string; kind: 'job' | 'train'; pid: number; startedAt: number; told?: boolean }
type TrainRun = { id: string; pid: number; startedAt: number; items: TrainItem[]; files: string[] }
const readJson = async <T,>($: $T, path: string): Promise<T | null> => {
  try {
    return JSON.parse((await $.fs.read(path)).replace(/^﻿/, '').replace(/\0+/g, '')) as T
  } catch {
    return null
  }
}

/** Starts a PowerShell script outside the app (WMI, no window), so the app or the chat ending does not end it; its pid or 0. */
async function launchPs($: $T, script: string, dir: string): Promise<number> {
  if (!isWindows()) {
    const r = await $.process.run(['sh', '-c', `nohup pwsh -NoProfile -File ${shQuote(script)} >/dev/null 2>&1 & echo $!`], { timeoutMs: 15000 }).catch(() => ({ stdout: '' }))
    return Number(String(r.stdout).trim()) || 0
  }
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`
  const ps = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd.replace(/'/g, "''")}'; CurrentDirectory = '${dir.replace(/'/g, "''")}'; ProcessStartupInformation = $si }; $r.ProcessId`
  const r = await $.process.run(['powershell', '-NoProfile', '-Command', ps], { timeoutMs: 30000 }).catch(() => ({ stdout: '' }))
  const pid = Number(String(r.stdout).trim().split(/\s+/).pop())
  return Number.isFinite(pid) && pid > 0 ? pid : 0
}

/** Writes a job's files and its script into hq/jobs/<id>, starts it, and records who owns it. */
async function startJob($: $T, meta: Omit<JobMeta, 'pid' | 'startedAt'>, files: Record<string, string>, ps1: string): Promise<JobMeta | null> {
  const dir = join(await jobsRoot($), meta.id)
  for (const [name, text] of Object.entries(files)) await $.fs.write(join(dir, name), text)
  await $.fs.write(join(dir, 'out.log'), '')
  const script = join(dir, 'job.ps1')
  await $.fs.write(script, ps1)
  const pid = await launchPs($, script, meta.cwd)
  if (!pid) return null
  const full: JobMeta = { ...meta, pid, startedAt: await $.clock.now() }
  await $.fs.write(join(dir, 'job.json'), JSON.stringify(full))
  return full
}

/** run_job: a long command outside this chat, only one this chat's own Bash permissions would allow. */
async function runJob($: $T, a: Record<string, unknown>): Promise<string> {
  const name = oneLine(String(a.name ?? ''), 60) || 'job'
  const command = String(a.command ?? '').trim()
  const dir = String(a.cwd ?? '') || cwd || '.'
  if (!command) return 'Not started: give the command.'
  const check = (await $.tool.check({ tool: 'Bash', input: { command } } as never).catch(() => ({ decision: 'ask' }))) as { decision?: string; reason?: string }
  if (check.decision !== 'allow') return `Not started: your Bash permissions do not allow this command (${check.decision ?? 'ask'}${check.reason ? `: ${oneLine(check.reason, 120)}` : ''}). Run it with Bash instead.`
  const id = `job-${newId()}`
  const dirOf = join(await jobsRoot($), id)
  let meta: JobMeta | null
  if (isWindows()) meta = await startJob($, { id, owner: sid, name, cwd: dir, kind: 'job' }, { 'job.cmd': `@echo off\r\n${command}` }, jobScript(join(dirOf, 'job.cmd'), dir, join(dirOf, 'out.log'), join(dirOf, 'exit.txt')))
  else {
    // macOS and Linux have no PowerShell: the same job as a detached shell script, with the same out.log and exit.txt
    const script = join(dirOf, 'job.sh')
    await $.fs.write(join(dirOf, 'out.log'), '')
    await $.fs.write(script, jobScriptSh(command, dir, join(dirOf, 'out.log'), join(dirOf, 'exit.txt')))
    const started = await $.process.run(launchShArgv(script), { timeoutMs: 15000 }).catch(() => null)
    const pid = Number((started?.stdout ?? '').trim().split(/\s+/).pop())
    meta = started && started.exitCode === 0 && Number.isFinite(pid) && pid > 0 ? { id, owner: sid, name, cwd: dir, kind: 'job', pid, startedAt: await $.clock.now() } : null
    if (meta) await $.fs.write(join(dirOf, 'job.json'), JSON.stringify(meta))
  }
  if (!meta) return 'Not started: the process could not be launched.'
  return `Started ${name} (id ${id}, pid ${meta.pid}) outside this chat: it keeps running if the chat ends or the app restarts. Output: ${join(dirOf, 'out.log')}. You are told when it ends, with its exit code and last lines; do not poll it.`
}

/** This chat's finished jobs: each is told once, with its exit code and the last lines of its output. */
const jobsTold = new Set<string>()
async function pollJobs($: $T) {
  const root = await jobsRoot($)
  const dirs = await $.fs.list(root).catch(() => [] as FsEntry[])
  const now = await $.clock.now()
  for (const d of dirs.filter(x => x.kind === 'dir' && x.name.startsWith('job-') && !jobsTold.has(x.name))) {
    const meta = await readJson<JobMeta>($, join(root, d.name, 'job.json'))
    if (!meta || meta.owner !== sid) continue
    if (meta.told) {
      jobsTold.add(d.name)
      continue
    }
    const exit = (await $.fs.read(join(root, d.name, 'exit.txt')).catch(() => '')).replace(/^﻿/, '').trim()
    if (!exit && (now - meta.startedAt < 60000 || (await pidAlive($, meta.pid)))) continue
    const tail = (await $.fs.read(join(root, d.name, 'out.log')).catch(() => '')).split(/\r?\n/).filter(l => l.trim()).slice(-12).join('\n')
    jobsTold.add(d.name)
    await $.fs.write(join(root, d.name, 'job.json'), JSON.stringify({ ...meta, told: true })).catch(() => undefined)
    const how = exit ? `exit ${exit}` : 'ended without an exit code (killed?)'
    enqueue({ kind: 'submit', text: L(`${WAKE}Job done: ${meta.name} (${how}, ${fmtElapsed(now - meta.startedAt)}). Last lines:\n${tail || '(no output)'}`, `${WAKE}İş bitti: ${meta.name} (${how}, ${fmtElapsed(now - meta.startedAt)}). Son satırlar:\n${tail || '(çıktı yok)'}`), asUser: false })
  }
}

/** The train's config (hq/train/config.json); none: no train on this computer. */
async function trainConfig($: $T): Promise<TrainConfig | null> {
  return parseTrainConfig(await readJson<unknown>($, join(await trainRoot($), 'config.json')))
}

/**
 * Pushed HAZIR branches go into the machine-wide train queue: one file per branch and sha (an emptied file is taken),
 * so the same HAZIR said again, by the chief or seen by the leader, is never trained twice.
 */
async function queueTrain($: $T, claims: readonly { branch: string; sha: string }[], from = sid, title = projectTitle()) {
  if (!claims.length || !(await trainConfig($))) return
  const q = join(await trainRoot($), 'queue')
  const at = await $.clock.now()
  for (const c of claims) {
    const file = join(q, trainQueueName(c))
    if (await $.fs.exists(file)) continue
    await $.fs.write(file, JSON.stringify({ branch: c.branch, sha: c.sha, from, title, at }))
  }
}
/** A chat's turn that says HAZIR for a pushed branch queues it, whoever the chat is (a chief, the leader, a plain chat). */
async function queueReady($: $T, text: string) {
  const claims = readyClaims(text)
  if (claims.length && !(await checkReady($, text))) await queueTrain($, claims)
}

/** Deletes files without spawning PowerShell (which can hang on Windows). */
async function removeFiles($: $T, paths: readonly string[]): Promise<boolean> {
  if (!paths.length) return true
  const argv = isWindows()
    ? ['cmd', '/c', 'del', '/f', '/q', ...paths.map(p => p.replace(/\//g, '\\'))]
    : ['rm', '-f', ...paths]
  const r = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => null)
  return !!r && r.exitCode === 0
}

/** Takes landed (or unusable) items out of the train queue: the files are deleted (`$.fs` cannot), an emptied file is the fallback. */
async function dropQueue($: $T, dir: string, names: readonly string[]): Promise<void> {
  const safe = names.filter(n => /^[\w.@-]+\.json$/.test(n))
  if (safe.length && (await removeFiles($, safe.map(n => join(dir, n))))) return
  for (const n of names) await $.fs.write(join(dir, n), '').catch(() => undefined)
}

/** Detached runs whose owner chat is gone: process dead, no exit file. Told once to the leader (the owner chat would have told it itself). */
async function lostRuns($: $T) {
  if (role !== 'leader' || isWorker) return
  const now = await $.clock.now()
  const all = ((await $.store.get('runs')) as RunRecord[] | undefined) ?? []
  for (const rec of all) {
    if (rec.owner === sid || runs.has(rec.workerId)) continue
    const owner = hqCards.find(c => c.sid === rec.owner)
    if (owner && now - owner.updatedAt < 3 * 60000) continue // its owner is alive and follows it
    if ((await $.fs.exists(rec.exit)) || (await pidAlive($, rec.pid))) continue
    raise(`lost:${rec.workerId}`, L(`! worker lost: ${rec.runDir.split(/[\\/]/).filter(Boolean).pop() ?? rec.workerId} (pid ${rec.pid}) died without an exit code or report${owner ? `; owner ${titleOf(owner)}` : ''}`, `! işçi kayboldu: ${rec.runDir.split(/[\\/]/).filter(Boolean).pop() ?? rec.workerId} (pid ${rec.pid}) çıkış kodu / rapor bırakmadan öldü${owner ? `; sahibi ${titleOf(owner)}` : ''}`), true, now, 300)
  }
}
/** A build lock directory (train config `lock`) with no `owner` file for 30 minutes is a stale one; told to the leader (list_chiefs news). */
export const ownerlessLock = (v: { exists: boolean; hasOwner: boolean; ageMs: number }) => v.exists && !v.hasOwner && v.ageMs > 30 * 60000
async function lockAudit($: $T) {
  if (role !== 'leader' || isWorker) return
  const cfg = await trainConfig($)
  if (!cfg?.lock) return
  const st = await $.fs.stat(cfg.lock).catch(() => null)
  if (!st) return
  const now = await $.clock.now()
  const hasOwner = await $.fs.exists(join(cfg.lock, 'owner')).catch(() => false)
  if (!ownerlessLock({ exists: true, hasOwner, ageMs: now - st.mtimeMs })) return
  leaderLog = [...leaderLog, { at: now, from: 'lock', title: L('Lock', 'Kilit'), line: L(`${cfg.lock} has no owner (no owner file), ${fmtElapsed(now - st.mtimeMs)} old`, `${cfg.lock} sahipsiz (owner dosyası yok), ${fmtElapsed(now - st.mtimeMs)} eski`) }].slice(-200)
  raise('lock:ownerless', L(`! ${cfg.lock} ownerless lock (no owner, ${fmtElapsed(now - st.mtimeMs)} old); delete it if nobody holds it`, `! ${cfg.lock} sahipsiz kilit (owner yok, ${fmtElapsed(now - st.mtimeMs)} eski); tutan yoksa silin`), false, now, 300)
}
/**
 * Reports of chiefs on another computer, carried by git (hq/mac-reports.json names the repo and branch): the leader
 * fetches the branch and turns each new report file into chief news (a SORU as an alert). No remote chat's reply is
 * readable through the app, so the Mac chiefs push `reports/mac/<time>_<name>.md` and this reads them.
 */
async function macReportsTick($: $T) {
  if (role !== 'leader' || isWorker) return
  const hq = await hqDir($)
  const cfg = parseMacReportsConfig(await readJson<unknown>($, join(hq, 'mac-reports.json')))
  if (!cfg) return
  const git = (...a: string[]) => $.process.run(['git', '-C', cfg.repo, ...a], { timeoutMs: 60000 }).catch(() => null)
  const ref = `refs/remotes/origin/${cfg.branch}`
  const f = await git('fetch', '-q', 'origin', `+refs/heads/${cfg.branch}:${ref}`)
  if (!f || f.exitCode !== 0) return
  const state = (await readJson<{ seen: string[] }>($, join(hq, 'mac-reports-seen.json'))) ?? { seen: [] }
  const ls = await git('ls-tree', '-r', '--name-only', ref, `${cfg.dir}/`)
  if (!ls || ls.exitCode !== 0) return
  const now = await $.clock.now()
  const fresh = unseenReports(ls.stdout, cfg.dir, state.seen)
  // first sight of the branch: older reports are marked seen without waking the leader, only the last few are news
  const news = state.seen.length === 0 ? fresh.slice(-3) : fresh
  for (const path of news) {
    const body = await git('show', `${ref}:${path}`)
    if (!body || body.exitCode !== 0) continue
    const n = reportNews(path, body.stdout)
    leaderLog = [...leaderLog, { at: now, from: 'mac', title: n.title, line: n.line }].slice(-200)
    if (n.isQuestion || /^HAZIR/i.test(n.line)) raise(`mac:${path}`, `${n.isQuestion ? '? ' : ''}${n.title}: ${n.line}`, true, now, 700)
    else digest.push({ title: n.title, line: n.line })
  }
  if (fresh.length) await $.fs.write(join(hq, 'mac-reports-seen.json'), JSON.stringify({ seen: [...state.seen, ...fresh].slice(-500) }))
}

/**
 * The leader runs the train: when none runs and the queue holds branches and the RAM allows, one detached train
 * takes them all; its result reaches the leader as one line (a summary in the digest, a stop as an alert), and a
 * chief whose branch conflicted is told to rebase and say HAZIR again.
 */
async function trainTick($: $T) {
  if (role !== 'leader' || isWorker) return
  const cfg = await trainConfig($)
  if (!cfg) return
  const root = await trainRoot($)
  const now = await $.clock.now()
  // where the last tick stopped, for anyone asking why the queue does not move
  const note = (step: string) => $.fs.write(join(root, 'tick.json'), JSON.stringify({ at: now, sid, step })).catch(() => undefined)
  // workers' lock loops leave the build lock alone while this file exists: it is there while the train has work
  const wait = cfg.wait
  const setWait = async (on: boolean) => {
    if (!wait) return
    if (on) return void (await $.fs.write(wait, JSON.stringify({ at: now, sid })).catch(() => undefined))
    if (await $.fs.exists(wait).catch(() => false)) await removeFiles($, [wait])
  }
  const running = await readJson<TrainRun>($, join(root, 'running.json'))
  if (running?.id) {
    await setWait(true)
    let res = await readJson<TrainResult>($, join(await jobsRoot($), running.id, 'result.json'))
    if (!res) {
      if (now - running.startedAt < 5 * 60000 || (await pidAlive($, running.pid))) return void (await note(`running ${running.id}`))
      res = { ok: false, merged: [], conflict: [], gates: [], failed: 'train process ended without a result' }
    }
    await dropQueue($, join(root, 'queue'), running.files)
    await $.fs.write(join(root, 'running.json'), '{}')
    const line = trainSummary(res)
    leaderLog = [...leaderLog, { at: now, from: 'train', title: 'Train', line }].slice(-200)
    if (!res.ok) raise(`train:${running.id}`, `! ${line}`, true, now, 700)
    else digest.push({ title: 'Train', line })
    await note(`finished ${running.id}: ${line}`)
    for (const it of running.items.filter(i => res.conflict.includes(i.branch))) {
      await sendTo($, it.from, 'message', { text: L(`${it.branch} conflicts with ${cfg.base} (train ${running.id}). Take ${cfg.base}, resolve the conflict, push, then write READY again.`, `${it.branch} ${cfg.base} üzerine çakıştı (train ${running.id}). ${cfg.base}'i al, çakışmayı çöz, push et, sonra yeniden HAZIR yaz.`) }).catch(() => undefined)
    }
    return
  }
  const q = join(root, 'queue')
  const files = (await $.fs.list(q).catch(() => [] as FsEntry[])).filter(x => x.kind === 'file' && x.size > 0 && x.name.endsWith('.json')).map(x => x.name)
  if (!files.length) {
    await setWait(false)
    return void (await note('queue empty'))
  }
  await setWait(true)
  // the gates run tsc and dependency-cruiser: the train starts only with room for them (the heavy gate still holds them)
  const free = await freeRamMb($)
  if (free < Math.max(4096, ramReserveMb())) return void (await note(`waiting for RAM: ${free} MB free`))
  const items: TrainItem[] = []
  for (const f of files) {
    const it = await readJson<TrainItem>($, join(q, f))
    if (it?.branch) items.push(it)
  }
  const batch = trainBatch(items)
  if (!batch.length) {
    await dropQueue($, q, files)
    return
  }
  const id = `train-${newId()}`
  const dir = join(await jobsRoot($), id)
  const gateFiles = cfg.gates.map((_, i) => join(dir, `gate-${i}.cmd`))
  const gateTexts = Object.fromEntries(cfg.gates.map((g, i) => [`gate-${i}.cmd`, gateCmd(g)]))
  const meta = await startJob($, { id, owner: sid, name: 'train', cwd: cfg.wt, kind: 'train' }, gateTexts, trainScript(cfg, batch.map(b => b.branch), join(dir, 'result.json'), gateFiles))
  if (!meta) {
    raise('train:start', L('! Could not start the train (no process opened); the queue waits.', '! Train başlatılamadı (süreç açılmadı); kuyruk bekliyor.'), true, now, 300)
    return void (await note('start failed: no process'))
  }
  await note(`started ${id}: ${batch.map(b => b.branch).join(' ')}`)
  await $.fs.write(join(root, 'running.json'), JSON.stringify({ id, pid: meta.pid, startedAt: meta.startedAt, items: batch, files }))
}

/** Whether a message ends by saying its writer is waiting or blocked: another nudge would only get the same answer. */
export function saysWaiting(text: string): boolean {
  const tail = visible(String(text ?? '')).slice(-400)
  return /\b(still waiting|i('| a)m (waiting|blocked)|waiting (for|on)|is blocked|am blocked|blocked (on|by)|cannot (continue|proceed)|nothing (more )?(left )?to do)\b|bekliyorum|beklemede|engellen|engelli|bloke|devam edemem|yapacak (bir )?(şey|is|iş) yok/i.test(tail)
}
/**
 * A turn that ends waiting on the owner: a SORU: line, or a wait or block that names the owner or their decision.
 * Such a chat is not woken and may not schedule its own wake-ups until a message comes; its question reaches the
 * leader once (a repeat in any wording is dropped).
 */
export function ownerBlocked(text: string): boolean {
  const clean = visible(String(text ?? ''))
  if (/(^|\n)\s*SORU\s*:/.test(clean)) return true
  const tail = clean.slice(-400)
  return saysWaiting(text) && /sahib|owner|kullanıcı|onay\w*|karar\w*|approval|decision/i.test(tail)
}
/**
 * A leader is woken by events (a chief's question, decision or error, a train's result: each starts its turn), so a
 * timer is only a fallback: at most every 30 minutes, and a timer that fires with nothing new is dropped.
 */
export const LEADER_WAKE_MIN = 30
export const LEADER_CRON_DENY_EN = 'The leader wakes on events: a chief\'s question, decision or error, or a train result, starts this chat by itself. The backup check can be at most every 30 minutes.'
export const LEADER_CRON_DENY = 'Lider olay tabanlı uyanır: bir şefin sorusu, kararı, hatası ya da train sonucu bu sohbeti kendisi başlatır. Yedek kontrol en sık 30 dakikada bir olabilir.'
/** A leader's timer prompt with nothing new since its last turn (no alert waiting, a turn within 30 minutes): not a turn. */
export const idleLeaderWake = (o: { origin: string; alerts: number; now: number; lastTurnEnd: number }) =>
  // 21.11 owner: no backup wake-ups at all; a timer prompt with no alert waiting is dropped (each one re-read the whole chat, cache cold)
  o.origin === 'scheduled-trigger' && o.alerts === 0
export const OWNER_BLOCK_DENY_EN = 'You are waiting for the owner\'s decision: set no wake-up, end this turn. This chat starts by itself when a decision or a new message arrives.'
export const OWNER_BLOCK_DENY = 'Sahibinin kararını bekliyorsun: uyanma kurma, bu turu bitir. Karar ya da yeni bir mesaj gelince bu sohbet kendiliğinden başlar.'
/** When this chat last ended a turn blocked on its owner; 0 once any message (not a wake) came. */
let ownerBlockedAt = 0
/** This chat's model wrote to another session itself this turn (SendMessage / send_message): no plugin report on top. */
let wroteLeaderThisTurn = false

type SavedRole = { role?: Role; leaderSid?: string | null; leaderTitle?: string }
/**
 * A chat's role as its own headquarters card last said it: the second copy of the role. The plugin store can be lost
 * whole (a hard freeze left it all NUL bytes, 18.10, and every chief came back solo); the card survives it.
 */
async function roleFromCard($: $T, id: string): Promise<{ saved: SavedRole; config?: ChiefConfig } | null> {
  if (!id) return null
  try {
    const path = join(await hqDir($), 'sessions', `${id}.json`)
    // no shell read: a chat starting up runs no process for a file that is not there
    if (!(await $.fs.exists(path))) return null
    const card = JSON.parse((await $.fs.read(path)).replace(/\0+/g, '')) as Partial<HqCard>
    if (card.role !== 'chief' && card.role !== 'leader') return null
    const leader = card.role === 'chief' && typeof card.leader === 'string' ? card.leader : null
    let leaderTitle = ''
    if (leader) {
      const lc = JSON.parse((await $.fs.read(join(await hqDir($), 'sessions', `${leader}.json`)).catch(() => '')).replace(/\0+/g, '') || 'null') as Partial<HqCard> | null
      leaderTitle = lc?.title ?? ''
    }
    const config = card.config && typeof card.config === 'object' ? ({ ...(card.config as ChiefConfig) }) : undefined
    return { saved: { role: card.role, leaderSid: leader, leaderTitle }, config }
  } catch {
    return null
  }
}
/**
 * Which record a reopened chat takes: the one under its app id when it holds a role, then what this process set
 * (a /leader typed before the app answered), then the engine id's. Never a "solo" over a kept role: that is how
 * an undo used to wipe a leader.
 */
export function pickRole(atApp: SavedRole | undefined, current: SavedRole, atOld: SavedRole | undefined): SavedRole {
  if (atApp?.role && atApp.role !== 'solo') return atApp
  if (current.role && current.role !== 'solo') return current
  if (atOld?.role && atOld.role !== 'solo') return atOld
  return atApp ?? current
}

/** This engine's own id, which changes each time the desktop app reopens the chat. */
let engineSid = ''

/** The app's id for this chat as the app put it in the environment (without "local_"); empty outside the app. */
async function hostEnvId($: $T): Promise<string> {
  const raw = String((await $.env.get('CLAUDE_CODE_HOST_SESSION_ID').catch(() => undefined)) ?? '').replace(/^local_/, '')
  return /^[0-9a-f-]{36}$/.test(raw) ? raw : ''
}

/**
 * The app's id from the environment, but only when this engine's own record (~/.claude/sessions/<pid>.json, the one
 * whose sessionId is this engine's) names it: a `claude -p` started from a chat's shell inherits that chat's variable.
 * No app tool and no clock: it answers during session.start, where those wait until the start has returned.
 */
async function hostSessionId($: $T, want: string): Promise<string> {
  if (!want || !engineSid) return ''
  try {
    const home = isWindows() ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
    const dir = join(home ?? '.', '.claude', 'sessions')
    for (const f of (await $.fs.list(dir)).filter(x => x.kind === 'file' && x.name.endsWith('.json'))) {
      const text = await $.fs.read(join(dir, f.name)).catch(() => '')
      if (!text.includes(engineSid)) continue
      const rec = JSON.parse(text) as { sessionId?: string; hostSessionId?: string }
      if (rec.sessionId === engineSid && String(rec.hostSessionId ?? '').replace(/^local_/, '') === want) return want
    }
  } catch {
    // no records: not proven
  }
  return ''
}

/** The engine's store files for this plugin (one per way it is loaded: desktop chats inline, headless runs synced …). */
async function storeFiles($: $T): Promise<{ dir: string; names: string[]; all: FsEntry[] }> {
  const home = isWindows() ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  const dir = join(home ?? '.', '.claude', 'plugins', 'store')
  const all = await $.fs.list(dir).catch(() => [] as FsEntry[])
  return { dir, all, names: all.filter(x => x.kind === 'file' && /^the-chief_.+\.json$/.test(x.name)).map(x => x.name) }
}

/** Text that is a whole store: parses, an object, no NUL byte (a crash leaves the file's length in zeros). */
export function storeTextOk(text: string): boolean {
  if (!text || text.includes(String.fromCharCode(0))) return false
  try {
    const v = JSON.parse(text) as unknown
    return !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/**
 * Keeps a copy of every whole store in hq/store-backup (<name> and the one before as <name>.prev). The engine writes
 * the store itself; a crash mid-write left the desktop one all zeros on 18.10 and every chief lost its role.
 */
async function backupStores($: $T) {
  const { dir, names } = await storeFiles($)
  const out = join(await hqDir($), 'store-backup')
  for (const name of names) {
    const text = await $.fs.read(join(dir, name)).catch(() => '')
    if (!storeTextOk(text)) continue
    const last = await $.fs.read(join(out, name)).catch(() => '')
    if (last === text) continue
    if (storeTextOk(last)) await $.fs.write(join(out, `${name}.prev`), last).catch(() => undefined)
    await $.fs.write(join(out, name), text).catch(() => undefined)
  }
}

/**
 * A store that is not whole is written back from the best copy: the newest of the backup, the one before it, and the
 * engine's own leftover <name>.tmp.* files, the largest whole one winning among equals. Answers the names restored.
 */
async function restoreStores($: $T): Promise<string[]> {
  const { dir, names, all } = await storeFiles($)
  const out = join(await hqDir($), 'store-backup')
  const restored: string[] = []
  for (const name of names) {
    if (storeTextOk(await $.fs.read(join(dir, name)).catch(() => ''))) continue
    const candidates: { text: string; at: number }[] = []
    for (const p of [join(out, name), join(out, `${name}.prev`)]) {
      const text = await $.fs.read(p).catch(() => '')
      const st = await $.fs.stat(p).catch(() => undefined)
      if (storeTextOk(text)) candidates.push({ text, at: Number((st as { mtimeMs?: number } | undefined)?.mtimeMs ?? 0) })
    }
    for (const t of all.filter(x => x.kind === 'file' && x.name.startsWith(`${name}.tmp.`))) {
      const text = await $.fs.read(join(dir, t.name)).catch(() => '')
      const st = await $.fs.stat(join(dir, t.name)).catch(() => undefined)
      if (storeTextOk(text)) candidates.push({ text, at: Number((st as { mtimeMs?: number } | undefined)?.mtimeMs ?? 0) })
    }
    const best = pickStoreCopy(candidates)
    if (!best) continue
    await $.fs.write(join(dir, name), best).catch(() => undefined)
    restored.push(name)
  }
  return restored
}

/** The newest whole copy; within a minute of each other the larger one (a later write that kept more). */
export function pickStoreCopy(copies: readonly { text: string; at: number }[]): string | null {
  if (!copies.length) return null
  const newest = Math.max(...copies.map(c => c.at))
  const near = copies.filter(c => newest - c.at <= 60000)
  return near.sort((a, b) => b.text.length - a.text.length)[0]!.text
}

/** The desktop app's id for this chat (without its "local_" prefix); empty outside the app. */
async function appSessionId($: $T): Promise<string> {
  try {
    // the app's tools can be slow to connect after a restart, and a call to them may never answer: given up after 5 s,
    // or the session start waited on it forever and no role, card or tick came back (18.10, all chats after a restart)
    const r = (await Promise.race([
      $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_session', session_id: 'self' } as never),
      $.clock.sleep(5000).then(() => ({ isError: true })),
    ])) as { text?: string; result?: unknown; isError?: boolean; deny?: string }
    if (r.deny || r.isError) return ''
    const raw = r.text ?? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''))
    const m = raw.match(/"sessionId"\s*:\s*"(?:local_)?([0-9a-f-]{36})"/)
    return m ? m[1]! : ''
  } catch {
    return ''
  }
}

/**
 * A chat that comes back with no role finds the one it had: its copied conversation still holds the
 * leader's brief, or the goal its leader gave it. Only records nobody alive is using are taken.
 */
async function recoverRole($: $T) {
  const msgs = await $.session.messages()
  const said = msgs.map(m => m.text).join('\n')
  if (!said) return
  const now = await $.clock.now()
  const alive = new Set<string>()
  try {
    for (const entry of await $.fs.list(join(await hqDir($), 'sessions'))) {
      const id = entry.name.replace(/\.json$/, '')
      if (id === sid || id === engineSid) continue
      const { mtimeMs } = await $.fs.stat(join(await hqDir($), 'sessions', entry.name))
      if (now - mtimeMs < 3 * 60000) alive.add(id)
    }
  } catch {
    // no shared folder yet
  }
  const keys = await $.store.keys()
  if (msgs.some(m => m.role === 'user' && /^(The the-chief plugin sent a message:\s*)?You are now the Leader of Chiefs/.test(m.text.trim()))) {
    await setRole($, 'leader')
    $.ui.toast(L('The Chief: this chat is the Leader again', 'The Chief: bu sohbet yine Leader'))
    return
  }
  // the chief record whose goal this conversation carries, the longest match winning
  let best: { id: string; config: ChiefConfig; role: { leaderSid?: string | null; leaderTitle?: string } } | null = null
  for (const key of keys.filter(k => k.startsWith('chiefConfig:'))) {
    const id = key.slice('chiefConfig:'.length)
    if (id === sid || alive.has(id)) continue
    const config = (await $.store.get(key)) as ChiefConfig | undefined
    const goal = config?.goal?.trim()
    if (!goal || !said.includes(goal.slice(0, 80))) continue
    const saved = ((await $.store.get(`role:${id}`)) ?? {}) as { role?: Role; leaderSid?: string | null; leaderTitle?: string }
    if (saved.role !== 'chief') continue
    if (!best || goal.length > (best.config.goal?.length ?? 0)) best = { id, config: config!, role: saved }
  }
  if (!best) return
  chiefConfig = best.config
  await storeSet($, `chiefConfig:${sid}`, chiefConfig)
  await setRole($, 'chief', best.role.leaderSid ?? null, best.role.leaderTitle ?? '')
  $.ui.toast(L(`The Chief: this chat is a chief again · ${oneLine(chiefConfig.goal ?? '', 60)}`, `The Chief: bu sohbet yine chief · ${oneLine(chiefConfig.goal ?? '', 60)}`))
}

/** Chiefs whose leader is gone (its chat reopened under a new id, or closed) come back to this leader. */
const rescued = new Set<string>()

/** Chiefs whose silence was reported to the leader, and when: the report backs off so it is not a stream of lines. */
const wakes = new Map<string, { at: number; times: number }>()
/**
 * Whether a silent chief is reported to the leader now: 10 quiet minutes with no worker, 2 hours while its workers
 * run (it waits on them; their end wakes it anyway), and never sooner than 30 min, 1 h, 2 h, 4 h after the last report.
 * The plugin itself never wakes a chief; this only paces the leader's news. Pure, so it is tested.
 */
export function wakeDue(v: { quietMs: number; working: number; last?: { at: number; times: number }; now: number }): boolean {
  if (v.quietMs < (v.working > 0 ? 2 * 3600000 : 10 * 60000)) return false
  if (!v.last || v.now - v.last.at >= 8 * 3600000) return true
  return v.now - v.last.at >= Math.min(4 * 3600000, 30 * 60000 * 2 ** (v.last.times - 1))
}
/** Per chief: the idle period last nudged (its activeAt), when, and whether the leader was told that the nudge led nowhere. */
const nudged = new Map<string, { activeAt: number; at: number; told: boolean }>()
/** How long a chief sits idle before it is nudged: each nudge is a turn that re-reads the whole chat. */
const NUDGE_IDLE_MS = 30 * 60000
/** No nudges while the weekly all-models usage is at or past this percent. */
const NUDGE_WEEK_PCT = 90
/** The weekly all-models percent last read, and when (read at most every 10 minutes). */
let weekRead = { at: -Infinity, pct: -1 }
/** Chiefs whose model was put right, by id and the model seen. */
const modelFixed = new Map<string, string>()
/** What a nudge says: the chief goes on, or says in one line why it cannot. */
export const NUDGE = 'Keep going on your goal: pick the next step and do it. If you are blocked, waiting for the owner, or done, say so in one line.'
/** What a chief with an open goal and no worker for a while is told: waiting on one run is no reason to sit empty. */
export const EMPTY_NUDGE_EN = '0 workers running. Do not sit idle while waiting for one run or answer: open the jobs that can run in parallel for your goal with spawn_worker, queue the next ones with queue:true (each starts by itself when one finishes). If you find no candidates, open a search worker to find them. If the goal is done, write DONE; if you are really blocked, say why in one line.'
export const EMPTY_NUDGE = '0 işçi çalışıyor. Tek bir koşuyu ya da cevabı beklerken boş durma: hedefin için paralel yürüyebilecek işleri spawn_worker ile aç, sonrakileri queue:true ile sıraya koy (biri bitince kendiliğinden başlar). Aday bulamıyorsan bulmak için bir arama işçisi aç. Hedef bittiyse DONE yaz; gerçekten engellendiysen nedenini tek satırda yaz.'
/** A chief with no worker this long (its goal open, not done, not asking the owner) is told to fill the slots. */
export const EMPTY_NUDGE_MS = 20 * 60000
/** After the first, a chief that stays empty is told again this often (each is a turn). */
const EMPTY_AGAIN_MS = 60 * 60000
/** Per chief: since when it has had no worker, when it was last told, and how many times. */
const emptyWatch = new Map<string, { since: number; toldAt: number; times: number }>()
/** Whether an empty chief is due to be told now: 20 minutes after it emptied, then every hour. Pure, so it is tested. */
export function emptyDue(e: { since: number; toldAt: number; times: number }, now: number): boolean {
  return e.times === 0 ? now - e.since >= EMPTY_NUDGE_MS : now - e.toldAt >= EMPTY_AGAIN_MS
}
/** The prefix of The Chief's own wake-up message (never rerouted, never mistaken for the model's). */
const WAKE = '[The Chief] '
/**
 * Every chief keeps working, without the leader's model spending a token on it:
 * - a chief idle for 30 minutes with its goal open (not waiting for the owner, not saying it is waiting, blocked
 *   or done) is nudged to go on, once per idle period and never while the week's usage is at 90%; if that nudge
 *   leaves it waiting, the leader is told once (it may be done or stuck);
 * - a chief chat that stopped answering (its card went stale) is NEVER woken or restarted: its wake-up turn would
 *   re-read a dead prompt cache and eat the owner's limit. The leader hears it once and decides, on the owner's order;
 * - a chief running a smaller model than asked for (Haiku where the leader runs Opus) is put back on the leader's.
 */
async function watchChiefs($: $T) {
  const now = await $.clock.now()
  let myModel = lastModelSeen
  if (!myModel) {
    try {
      myModel = await $.session.model()
    } catch {
      // not every host answers; then no model is put right this tick
    }
  }
  for (const c of hqCards) {
    if (c.role !== 'chief' || c.leader !== sid || releasedChiefs.has(c.sid)) continue
    // one chief's trouble never stops the watch over the others
    try {
      await watchChief($, c, now, myModel)
    } catch {
      // the next tick tries again
    }
  }
}

/** Whether a chief runs a smaller model than anyone asked for: Haiku with no model set, under a leader that is not. */
export function onWrongModel(chiefModel: string, asked: string | undefined, leaderModel: string): boolean {
  return !!chiefModel && !!leaderModel && !asked && chiefModel !== leaderModel && /haiku/i.test(chiefModel) && !/haiku/i.test(leaderModel)
}

async function watchChief($: $T, c: HqCard, now: number, myModel: string) {
  if (releasedChiefs.has(c.sid)) return
  {
    const name = `${titleOf(c)} [${c.sid.slice(0, 8)}]`
    // stopped answering: the chat itself is gone quiet (closed, crashed, asleep). The plugin never wakes or restarts a
    // chief any more: a wake-up turn re-reads a prompt cache that is gone and eats the owner's limit. Only the leader
    // starts one again, and only on the owner's order (message_chief). The report backs off so it is one line, not a
    // stream, and a chief quiet on purpose (waiting for the owner) is not reported at all.
    if (now - c.updatedAt >= 10 * 60000) {
      const last = wakes.get(c.sid)
      if (!wakeDue({ quietMs: now - c.updatedAt, working: c.working, last, now })) return
      wakes.set(c.sid, { at: now, times: last && now - last.at < 8 * 3600000 ? last.times + 1 : 1 })
      if (c.goal && !c.waitingOwner) raise(`chief:silent:${c.sid}`, `! ${name}: the chat stopped answering ${fmtElapsed(now - c.updatedAt)} ago${c.working > 0 ? ` while ${c.working} agents were working` : ''}; it stays asleep (The Chief never wakes a chief; wake it yourself with message_chief, on the owner's order)`, true, now, 300)
      return
    }
    // model: put a chief back on the leader's model when it runs a smaller one nobody asked for
    if (onWrongModel(c.model, c.config.model, myModel) && modelFixed.get(c.sid) !== c.model) {
      modelFixed.set(c.sid, c.model)
      await sendTo($, c.sid, 'configure', { config: { model: myModel } })
      leaderLog = [...leaderLog, { at: now, from: c.sid, title: titleOf(c), line: `was on ${shortModel(c.model)}; moved to ${shortModel(myModel)}` }].slice(-200)
    }
    // no worker for a while with the goal open: told to fill the slots, even while it waits on one long run
    if (c.working > 0 || c.done || c.waitingOwner || !c.goal) emptyWatch.delete(c.sid)
    else {
      const e = emptyWatch.get(c.sid) ?? { since: now, toldAt: 0, times: 0 }
      emptyWatch.set(c.sid, e)
      if (emptyDue(e, now) && !(await weekUsageHigh($))) {
        emptyWatch.set(c.sid, { ...e, toldAt: now, times: e.times + 1 })
        await sendTo($, c.sid, 'message', { text: L(EMPTY_NUDGE_EN, EMPTY_NUDGE) })
        if (e.times === 1) raise(`chief:empty:${c.sid}`, L(`! ${name}: no workers for ${fmtElapsed(now - e.since)}; nudged twice. Goal: ${oneLine(c.goal, 120)}`, `! ${name}: ${fmtElapsed(now - e.since)} işçisiz; iki kez dürtüldü. Goal: ${oneLine(c.goal, 120)}`), false, now, 300)
        return
      }
    }
    // idle with work left: nudge it on, once per idle period
    const activeAt = c.activeAt ?? c.updatedAt
    if (c.working > 0) nudged.delete(c.sid)
    if (c.busy || c.working > 0) return
    const n = nudged.get(c.sid)
    if (n && !n.told && c.stalled && n.activeAt !== activeAt) {
      nudged.set(c.sid, { ...n, told: true })
      await saveNudged($)
      raise(`chief:idle:${c.sid}`, `! ${name}: still waiting after a nudge; it may be done or stuck. Goal: ${oneLine(c.goal, 120)}`, true, now, 300)
    }
    if (c.waitingOwner || c.stalled || c.done || !c.goal || now - activeAt < NUDGE_IDLE_MS || n?.activeAt === activeAt) return
    // just told to fill its empty slots: that message is the nudge
    if (now - (emptyWatch.get(c.sid)?.toldAt ?? 0) < NUDGE_IDLE_MS) return
    if (await weekUsageHigh($)) return
    nudged.set(c.sid, { activeAt, at: now, told: false })
    await saveNudged($)
    await sendTo($, c.sid, 'message', { text: NUDGE })
  }
}

/** The weekly all-models percent used out of the app's get_usage, or -1 when it cannot be read. */
export function weekPercent(result: unknown): number {
  const r = result as { text?: unknown; plan?: unknown } | null
  let body: unknown = r
  if (typeof r?.text === 'string') {
    try {
      body = JSON.parse(r.text)
    } catch {
      const m = /Weekly\s*·?\s*all models[^\d]{0,80}?(\d+(?:\.\d+)?)\s*%/i.exec(r.text)
      return m ? Number(m[1]) : -1
    }
  }
  const windows = (body as { plan?: { windows?: { label?: string; percentUsed?: number }[] } } | null)?.plan?.windows
  const w = Array.isArray(windows) ? windows.find(x => /^weekly\W*all models$/i.test(String(x.label ?? '').trim())) : undefined
  return typeof w?.percentUsed === 'number' ? w.percentUsed : -1
}

/** Whether the week's usage is at the nudge limit; the reading is kept for 10 minutes, and an unreadable one never blocks. */
async function weekUsageHigh($: $T): Promise<boolean> {
  const now = await $.clock.now()
  if (now - weekRead.at >= 10 * 60000) {
    const r = await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_usage' } as never).catch(() => null)
    weekRead = { at: now, pct: weekPercent(r) }
  }
  return weekRead.pct >= NUDGE_WEEK_PCT
}

/**
 * Starts a chief chat that stopped answering, on the owner's order only (message_chief). The app's own message starts
 * a turn there even when the chat sleeps; nothing else in the plugin ever does this. True when it was delivered.
 */
async function wakeOnOrder($: $T, c: HqCard, words: string): Promise<boolean> {
  try {
    const owner = await ownerWords($)
    const text = leaderMessage(projectTitle(), words, String((owner as { ownerText?: string }).ownerText ?? ''), Number((owner as { ownerAt?: number }).ownerAt ?? 0))
    const r = (await $.tool.call({ tool: 'mcp__ccd_session_mgmt__send_message', session_id: `local_${c.sid}`, message: `${WAKE}${text}` } as never)) as { text?: string; isError?: boolean; deny?: string }
    return !r.deny && !r.isError && /delivered|queued/i.test(r.text ?? '')
  } catch {
    return false
  }
}

async function rescueOrphans($: $T) {
  const now = await $.clock.now()
  // a leader whose card still says leader is not gone, however long it has been quiet (asleep, undone, restarting)
  const leaders = new Set(hqCards.filter(c => c.role === 'leader').map(c => c.sid))
  leaders.add(sid)
  for (const c of hqCards) {
    if (c.role !== 'chief' || c.sid === sid || rescued.has(c.sid)) continue
    if (now - c.updatedAt > 2 * 60000) continue // only chats that are open now can answer
    if (c.leader && leaders.has(c.leader)) continue
    rescued.add(c.sid)
    await sendTo($, c.sid, 'join', {})
  }
}

// ---------- the leader's goals ----------
async function mainGoalText($: $T) {
  const { value: list = [] } = await $.state.get(GOALS)
  return list.find(g => g.id === mainGoalId)?.text ?? ''
}

async function setMainGoal($: $T, id: string) {
  mainGoalId = id
  await storeSet($, 'mainGoal', id)
  lastCardJson = ''
  await update($, tick, n => (n ?? 0) + 1)
}

/** A goal by id, by its number in the list (1 = first), or by words in it. */
function findGoal(list: readonly SquadGoal[], ref: string) {
  const r = ref.trim()
  return list.find(g => g.id === r) ?? (/^\d+$/.test(r) ? list[Number(r) - 1] : undefined) ?? list.find(g => g.text.toLowerCase().includes(r.toLowerCase()))
}

/** A chief by session id (or its first characters) or by its project name. */
function findChief(ref: string) {
  // a short code, a full session id, or the app's id ("local_<id>")
  ref = ref.trim().replace(/^local_/i, '')
  const r = ref.toLowerCase()
  const named = (c: HqCard) => `${titleOf(c)} ${c.title}`.toLowerCase()
  return hqCards.find(c => c.sid === ref) ?? hqCards.find(c => c.sid.toLowerCase().startsWith(r)) ?? hqCards.find(c => titleOf(c).toLowerCase() === r) ?? hqCards.find(c => named(c).includes(r))
}

/** Saves the leader's lanes and redraws. */
async function setLeaderLanes($: $T, next: LeaderLane[]) {
  leaderLanes = next
  await storeSet($, 'leaderLanes', next)
  await update($, tick, n => (n ?? 0) + 1)
}

async function patchLeaderLane($: $T, id: string, patch: Partial<LeaderLane>) {
  await setLeaderLanes($, leaderLanes.map(l => (l.id === id ? { ...l, ...patch } : l)))
}

/** A lane's settings as one chief's config. */
const laneConfig = (l: LeaderLane): ChiefConfig => ({
  goal: l.task.trim(),
  model: l.model === 'auto' ? undefined : l.model,
  effort: EFFORT_WORDS[l.effort],
  subagents: { model: l.subModel === 'auto' ? undefined : l.subModel, effort: l.subEffort >= 0 ? EFFORT_WORDS[l.subEffort] : undefined, max: l.subMax },
})

/** Opens the chiefs of one lane, or of every lane: each a new chat with the lane's goal and settings. */
async function launchChiefs($: $T, laneId: string | null) {
  const chosen = leaderLanes.filter(l => laneId === null || l.id === laneId)
  const ready = chosen.filter(l => l.task.trim())
  if (ready.length === 0) {
    $.ui.toast(L('Write a goal in the lane first', 'Önce şeride bir hedef yaz'))
    return
  }
  if (role !== 'leader') await setRole($, 'leader')
  let opened = 0
  for (const lane of ready) {
    for (let i = 0; i < lane.count; i++) {
      try {
        await createChief($, chiefTier(laneConfig(lane)))
        opened++
      } catch {
        // the rest still open
      }
    }
  }
  $.ui.toast(L(`Opening ${opened} chiefs${ready.length < chosen.length ? ' (lanes without a goal skipped)' : ''}`, `${opened} chief açılıyor${ready.length < chosen.length ? ' (hedefsiz şeritler atlandı)' : ''}`))
}

/** A chief or open chat, after reading the cards again. */
async function freshChief($: $T, ref: unknown) {
  await readCards($)
  return findChief(String(ref ?? ''))
}

/** A leader's config from tool input: only the fields given, each checked. */
function configFrom(a: Record<string, unknown>): ChiefConfig {
  const cfg: ChiefConfig = {}
  if (typeof a.model === 'string' && a.model.trim()) cfg.model = a.model.trim()
  if (typeof a.effort === 'string' && (EFFORT_WORDS as readonly string[]).includes(a.effort)) cfg.effort = a.effort
  if (typeof a.goal === 'string' && a.goal.trim()) cfg.goal = a.goal.trim()
  if (typeof a.work === 'string' && (WORK_MODES as readonly string[]).includes(a.work)) cfg.work = a.work
  // an empty one takes the check away
  if (typeof a.check === 'string') cfg.check = a.check.trim().slice(0, 300)
  // per-chief switches: given, they say on or off; absent, the chief keeps whatever it had (absent = on)
  if (typeof a.handoff === 'boolean') cfg.handoff = a.handoff
  if (typeof a.compact === 'boolean') cfg.compact = a.compact
  const sub = a.subagents as Record<string, unknown> | undefined
  if (sub && typeof sub === 'object') {
    cfg.subagents = {}
    if (typeof sub.model === 'string' && sub.model.trim()) cfg.subagents.model = sub.model.trim()
    if (typeof sub.effort === 'string' && (EFFORT_WORDS as readonly string[]).includes(sub.effort)) cfg.subagents.effort = sub.effort
    if (Number.isFinite(Number(sub.max)) && Number(sub.max) > 0) cfg.subagents.max = Math.round(Number(sub.max))
  }
  if (Array.isArray(a.lanes)) {
    cfg.lanes = (a.lanes as Record<string, unknown>[]).map(l => {
      const cli = normalizeCli(String(l.cli ?? 'claude'))
      const effort = typeof l.effort === 'string' ? Math.max(0, (EFFORT_WORDS as readonly string[]).indexOf(l.effort)) : Number(l.effort) || 2
      return { id: newId(), task: String(l.task ?? ''), cli, model: String(l.model ?? modelsOf(cli)[0] ?? ''), effort, count: Number(l.count) || 1 }
    })
  }
  return cfg
}

const describeConfig = (c: ChiefConfig) =>
  [
    c.model ? `model ${shortModel(c.model)}` : '',
    c.effort ? `effort ${c.effort}` : '',
    c.work ? `work ${c.work}` : '',
    c.check ? `check "${oneLine(c.check, 60)}"` : '',
    c.subagents ? `subagents ${c.subagents.model ? shortModel(c.subagents.model) : 'auto'}${c.subagents.effort ? ` ${c.subagents.effort}` : ''}${c.subagents.max ? ` max ${c.subagents.max}` : ''}` : '',
    c.lanes?.length ? `lanes ${c.lanes.map(l => `${l.count}× ${CLIS[l.cli]?.label ?? l.cli}`).join(', ')}` : '',
    // only the switches that are OFF are said: absent is on, so "handoff on" would be noise
    c.handoff === false ? 'handoff off' : '',
    c.compact === false ? 'idle compact off' : '',
  ]
    .filter(Boolean)
    .join(' · ')

/**
 * What a create_chief / configure_chief result says about the effort: the one that will be applied, or a warning
 * when the leader asked for an effort a tier overrode (a tier pins model and effort together). Pure, so it is tested.
 */
export function chiefEffortReport(cfg: ChiefConfig, asked: unknown, tier: unknown): string {
  const want = typeof asked === 'string' && (EFFORT_WORDS as readonly string[]).includes(asked) ? asked : ''
  const got = cfg.effort ?? ''
  const named = asTier(tier)
  if (want && got && want !== got && named) return L(`⚠ the effort you asked for, "${want}", was not applied: tier ${TIER_LABEL[named]} set effort "${got}"`, `⚠ istediğin effort "${want}" uygulanmadı: tier ${TIER_LABEL[named]} effort "${got}" belirledi`)
  return got ? L(`effort ${got} applied`, `effort ${got} uygulandı`) : L('effort default', 'effort varsayılan')
}

/** Parks one idle session: the desktop app archives it, which stops its process; it reopens from Archived. The app asks first. */
async function parkSession($: $T, c: HqCard) {
  if (c.working > 0) {
    $.ui.toast(L(`${c.title} is working; park it when it is done`, `${c.title} çalışıyor; bitince park et`))
    return
  }
  try {
    const mb = sessionRam[c.engine ?? c.sid] ?? sessionRam[c.sid]
    const r = (await $.tool.call({ tool: 'mcp__ccd_session_mgmt__archive_session', session_id: `local_${c.sid}`, reason: L(`The Chief: ${titleOf(c)} is idle; freeing RAM (${mb ?? '?'} MB). Reopen it from the Archived list.`, `The Chief: ${titleOf(c)} boşta; RAM boşalsın (${mb ?? '?'} MB). Archived listesinden geri açılır.`) } as never)) as { deny?: string; text?: string; isError?: boolean }
    if (r.deny || r.isError) {
      $.ui.toast(L(`Not parked: ${oneLine(r.deny ?? r.text ?? '', 100)}`, `Park edilmedi: ${oneLine(r.deny ?? r.text ?? '', 100)}`))
      return
    }
    $.ui.toast(L(`${titleOf(c)} parked (${mb ?? '?'} MB freed)`, `${titleOf(c)} park edildi (${mb ?? '?'} MB boşaldı)`))
    ramReadAt = 0
  } catch (err) {
    $.ui.toast(L(`Parking works only in the desktop app: ${err instanceof Error ? oneLine(err.message, 80) : String(err)}`, `Park yalnızca masaüstü uygulamasında: ${err instanceof Error ? oneLine(err.message, 80) : String(err)}`))
  }
}

/**
 * The leader's way of answering, in its system prompt while it leads. Measured: without it the leader wrote a
 * recap after every chief message it sent or got, which the owner has to scroll past.
 */
export const LEADER_VOICE = {
  id: 'the-chief:leader-voice',
  scope: 'session',
  text: [
    '# Leader of Chiefs: how you answer',
    'Chiefs reach you only with questions, decisions and errors; their routine progress goes to the owner as a 30-minute digest, and list_chiefs shows it when you plan.',
    'Settle what you can yourself and answer the chief with message_chief (never send_message or SendMessage to a chief). Write to the owner only when a decision is truly theirs or something important happened: one or two sentences, nothing else.',
    'Otherwise, after a chief’s message, after you message, configure, adopt or release a chief, and after list_chiefs, write nothing. No summaries, recaps, lists or headings. Answer at length only when the owner asks you directly.',
    'What The Chief does by itself, and what you do when it does not (check with list_chiefs and the app tools; never wait for the plugin): (1) chats are pinned and titled by The Chief only when the owner turned the auto_pin and auto_title settings on (Remote Control only with chief_remote_control); never pin, unpin or rename a chat yourself unless the owner asks, and then use mcp__the-chief__pin_chief. (2) A chief that reports DONE is only claiming it: you judge whether the job is really finished (read its last output, check the files it names), and only then call release_chief (unpins and archives it), else mcp__ccd_sidebar__set_pinned pinned false and mcp__ccd_session_mgmt__archive_session; never archive a chat that is not finished. (3) A chat is handed over to a fresh one after 2 compactions or 8 hours: its goal travels in a handoff file and the old chat is archived; if no handoff happened by 3 compactions, open a new chat yourself (create_chief with the same goal and a note of where the work stands) and archive the old one. (4) A chief that only waits is not reported to you; ask it nothing unless you can unblock it. (5) A failed CLI agent or subagent is retried once automatically before you hear of it; you hear (in list_chiefs news) only when that fails too: then read its log (.squad/logs/<name>.log), fix the cause or re-run it with a changed approach, and tell the owner only if the error is theirs to decide. (6) If the Chief tools (list_chiefs, create_chief, ...) vanish from your tool list, they re-register within 30 s; meanwhile use the app tools (mcp__ccd_session__start_session, SendMessage to the chief session) and never stop working.',
    'The owner cannot close a chief’s /goal loop; you can: configure_chief with clear_goal true ends it. The Chief clears it by itself only when a chief ends a turn with its own “DONE:” line; when a chief keeps repeating the same answer The Chief does NOT clear the goal, it tells you (so you decide) — end it yourself with configure_chief clear_goal true. A finished chief keeps its chat until you release_chief it; give new work with configure_chief (a new goal) or a new chief. If clear_goal is missing, send the chief “/goal clear” with SendMessage.',
    'A chief that only says it is waiting (for the owner, a file, another chief) needs no reply: a reply starts its next turn, which says it again. Answer only when you can unblock it.',
    'You may also run workers and lanes yourself: spawn_worker, run_job and lanes work in this chat as in a chief, and the Agents and Squad tabs show them beside the chiefs. Use them for narrow jobs that do not deserve a chief.',
    'One job, one chief. When a chief finishes its job, release it (release_chief; its chat is archived) and give the next job to a NEW chief with create_chief, never to the old chat: a fresh chat costs a fraction of one that carries a finished job. For long work, split it into jobs and do the same at each job’s end. Do not ask the owner for any of this. When the owner asks to pin or unpin chats, or to put them on Remote Control (the phone), call pin_chief at once (chief “all”, one chief, or “self” for your own chat); new chiefs pin themselves only when the auto_pin setting is on (and turn Remote Control on only when the chief_remote_control setting is on).',
    'In the desktop app create_chief may answer with a call for you to make: mcp__ccd_session__start_session with the arguments it gives. Make that call at once and as written (the app starts sessions for you, not for a plugin); The Chief turns the chat it opens into your chief by itself. How a chief works is your call, or the owner’s when they say: pass work to create_chief or configure_chief (self = the chief does the job itself, delegate = it hands it out to workers, either = its own call; either when you give none). No chief has to open workers. A chief’s DONE is checked before it counts: the files it names must exist and none of its agents may still run; pass check (a shell command that must exit 0, such as the project’s tests) to create_chief or configure_chief and it must pass too. A DONE that fails goes back to the chief once; a second one reaches you marked NOT VERIFIED and is never released by itself. When a CLI’s sign-in, key or credit fails you hear it once with the fix; /chief-check tests every CLI again. Pick a tier for every job and pass it as tier to create_chief (and to spawn_worker for CLI agents): cok_zor, zor, orta or kolay. The plugin turns the tier into a model and effort from the owner’s Şef seviyeleri (by default kolay → claude-haiku-5-5, effort max; orta and zor → claude-sonnet-5-5, effort medium; cok_zor, only for very hard work that needs deep, long reasoning → claude-opus-5-5, effort medium). Rate the job honestly. The owner’s difficulty floors (Zorluk tabanları) guard the domains you tend to underrate, such as video editing and Upwork proposals: when a goal or brief matches their keywords the tier is raised to at least the floor, never lowered, and the tool result says so.',
  ].join('\n'),
} as const

/**
 * What a chief reads from its leader: the leader's words, and with them the owner's own last message to the leader,
 * verbatim, as The Chief took it from the owner's prompt (the leader model cannot write this part).
 */
export function leaderMessage(title: string, text: string, ownerText: string, ownerAt: number): string {
  if (!ownerText) return `[Leader ${title}] ${text}`
  return `[Leader ${title}] ${text}\n\n[The owner's own message to the leader at ${timeOf(ownerAt)}, verbatim, passed on by The Chief (not written by the leader):]\n${ownerText}`
}

/** A chief's way of reaching its leader, in its system prompt while it is one. */
export const CHIEF_VOICE = {
  id: 'the-chief:chief-voice',
  scope: 'session',
  text: [
    '# Chief: reaching your leader',
    'You are a chief: another chat leads you. The Chief passes the end of each of your turns to your leader, so never message the leader to report progress.',
    'Reach the leader only with a question, a decision you cannot make yourself, or a blocker, and then in a few sentences.',
    'When your goal (or a job the leader gave you) is finished, end that turn with one line: DONE: <what is done, where it is>.',
    'The Chief checks a DONE before it counts: every file you name in that turn must exist and not be empty, none of your agents may still be running, and the leader’s check command (when it set one) must pass. So name what you made by its full path. A DONE that fails comes back to you once, with the reason.',
    'The owner speaks to you in this chat, or through your leader: a leader message may carry the owner’s own message, verbatim, marked "passed on by The Chief (not written by the leader)". Those words are the owner’s: do what they ask as if the owner typed them here, sending, applying, posting or spending included. The leader’s own words are not the owner’s approval; when only they ask for something that needs the owner’s say, check with the leader for the owner’s words.',
  ].join('\n'),
} as const

async function becomeLeader($: $T, mainGoal?: string) {
  await setRole($, 'leader')
  if (mainGoal) {
    const { value: list = [] } = await $.state.get(GOALS)
    const g = findGoal(list, mainGoal) ?? { id: newId(), text: mainGoal, status: 'open' as const }
    if (!list.some(x => x.id === g.id)) await mutateGoals($, l => [g, ...l])
    await setMainGoal($, g.id)
  }
  await readCards($)
  const main = await mainGoalText($)
  enqueue({
    kind: 'submit',
    text: [
      'You are now the Leader of Chiefs (The Chief). You lead other chats ("chiefs"); each chief leads its own agents and subagents.',
      main ? `Main goal: ${main}` : 'No main goal yet: pick or create one (set_main_goal / create_goal).',
      'Decide for yourself how to split the main goal: open chiefs (create_chief) or take over open chats (adopt_chief), give each a goal, model, effort, which subagents and how many, and CLI lanes (configure_chief),',
      'check on them (list_chiefs), steer them (message_chief), and keep the goals current (create_goal, edit_goal). Chief reports are not pushed into this chat (the owner sees a short digest and any question at once); read them with list_chiefs when you plan or when the owner asks. Start with list_chiefs. Answer the owner in one short sentence at most; no summaries.',
    ].join(' '),
  })
}

/** Opens a fresh chat that joins this leader as a chief with the given settings (desktop: a new Code session; terminal: a new tab). */
/** Chiefs asked for but not yet joined: token → when asked, and whether the owner was told how to open it. */
const invites = new Map<string, { at: number; goal: string; told: boolean }>()
async function checkInvites($: $T) {
  const now = await $.clock.now()
  for (const [token, inv] of invites) {
    const left = await readText($, join(await hqDir($), 'pending', `${token}.json`)).catch(() => '')
    if (!left.trim()) {
      invites.delete(token)
      continue
    }
    if (!inv.told && now - inv.at > 45000) {
      inv.told = true
      $.ui.log(L(`The Chief: the new chief chat did not open (${oneLine(inv.goal, 60)}). Open a new chat and type: /chief join ${token}`, `The Chief: yeni chief sohbeti açılmadı (${oneLine(inv.goal, 60)}). Yeni bir sohbet aç ve şunu yaz: /chief join ${token}`))
      $.ui.toast(L('The chief chat did not open: type /chief join in a new chat (details in the chat)', 'Chief sohbeti açılmadı: yeni sohbette /chief join yaz (ayrıntı sohbette)'))
    }
  }
}

/**
 * Desktop: a chief chat that runs without anyone pressing Enter. A link can only fill a new chat's box (the app
 * never sends a linked prompt), but it imports a CLI session as a running chat (claude://resume). So: the role and
 * settings are written under the new id first, one tiny Haiku turn makes the session, the app imports it, and
 * the chief's plugin starts its goal on its own. Null when any step fails (the link path stands in).
 */
async function bootSession($: $T, id: string, model: string, dir: string, permission: string, effort = '') {
  // the effort the chief was opened with rides the boot turn too, so the app imports the session with it (not a default)
  const eff = (EFFORT_WORDS as readonly string[]).includes(effort) ? effort : ''
  const boot = (m: string) => $.process.run(['claude', '-p', 'ready', '--session-id', id, '--model', m, ...(eff ? ['--effort', eff] : []), '--permission-mode', permission, '--system-prompt', 'Reply with the single word: ready', '--tools', '', '--strict-mcp-config'], { cwd: dir || undefined, timeoutMs: 120000, env: { THE_CHIEF_BOOTSTRAP: '1' } })
  let r = await boot(model)
  const first = r
  // a model id this CLI does not know yet (a brand-new Haiku): the session opens on the previous one, the chat keeps its own
  if (r.exitCode !== 0 && /haiku-5/i.test(model)) r = await boot('claude-haiku-4-5-20251001')
  // the second try can only say the id is taken when the first one made the session and then failed: that first reason is the real one
  if (r.exitCode !== 0) throw new Error(oneLine((/already in use/i.test(`${r.stderr}${r.stdout}`) ? first.stderr || first.stdout : '') || r.stderr || r.stdout, 120))
}

/** The desktop app imports a CLI session as a running chat. */
async function openResume($: $T, id: string) {
  const url = `claude://resume?session=${id}`
  await $.process.run(openArgv(url, await platformNow($)), { timeoutMs: 15000 })
}

async function openChiefChat($: $T, cfg: ChiefConfig, dir: string): Promise<string | null> {
  const id = uuid()
  await storeSet($, `role:${id}`, { role: 'chief', leaderSid: sid, leaderTitle: projectTitle() })
  // the chief runs on the model asked for, else the leader's own: never on whatever made the session
  const model = cfg.model || lastModelSeen || 'claude-opus-5-5'
  await storeSet($, `chiefConfig:${id}`, { ...cfg, model })
  await storeSet($, `startGoal:${id}`, true)
  try {
    // one word on that model, with no system prompt, tools or MCP servers: the session exists for under a cent
    // auto mode from the start (the owner asked for chiefs that never stop to ask), so no approval card follows
    await bootSession($, id, model, dir, riskyOn('chief_permission_mode', opt('chief_permission_mode')) ? 'auto' : 'default', cfg.effort ?? '')
    await openResume($, id)
    void askAutoMode($, id).catch(() => undefined)
    return id
  } catch (err) {
    openWhy.push(`claude CLI: ${oneLine(err instanceof Error ? err.message : String(err), 140)}`)
    await storeSet($, `startGoal:${id}`, false)
    return null
  }
}

/**
 * A chief tells its leader what goes wrong under it: its agents' alerts as routine news (the leader reads them
 * with the owner's next message), and its own turn stuck for 20 minutes as an urgent one.
 */
async function tellLeaderOfTrouble($: $T) {
  if (!leaderSid) return
  if (forwardLines.length) {
    const lines = forwardLines.splice(0, forwardLines.length)
    await sendTo($, leaderSid, 'report', { line: oneLine(`agents: ${lines.join(' | ')}`, 600) })
  }
  const now = await $.clock.now()
  if (mainTurn && !stuckTold && mainActivityAt && now - mainActivityAt > 20 * 60000) {
    stuckTold = true
    await sendTo($, leaderSid, 'report', { line: `${projectTitle()} has been stuck in one step for ${Math.round((now - mainActivityAt) / 60000)} min (no tool call, no answer)`, isUrgent: true })
  }
}

/**
 * The owner wants chiefs in auto mode with Remote Control on. The app's own switches do it and ask the owner to
 * approve (from the phone too, when the leader has Remote Control): The Chief never sets either around that card.
 */
async function askAutoMode($: $T, id: string) {
  await $.clock.sleep(8000)
  // the chief pins itself and turns its own Remote Control on (chiefSelfSetup), so the app asks nothing of the leader
  void id
}

/**
 * A chief pins its own chat and turns its own Remote Control on ("self" asks no card; another chat's id would), so the
 * owner finds every chief in the sidebar's Pinned and on the phone. Released, it unpins itself again.
 */
async function chiefSelfSetup(_$: $T) {
  // pin and Remote Control go through careTick (pinAndRemote): it checks the app's state first, retries a refused
  // Remote Control once after 10 minutes, and never posts the raw error
  workSeen = true
  pinPending = true
}

/** This chat pins or unpins itself in the sidebar and, when asked, turns its Remote Control on. */
async function setSelfView($: $T, pinned: boolean, remote: boolean): Promise<string> {
  const st = await stateOf(portsOf($), 'self')
  if ((st.pinned === true) !== pinned) await $.tool.call({ tool: 'mcp__ccd_sidebar__set_pinned', session_id: 'self', pinned } as never).catch(() => undefined)
  return remote ? remoteNow($, 'self', st.remote) : ''
}

const rcWords = (rc: string) => (rc === 'on' ? ' and put on Remote Control' : rc === 'unavailable' ? '; Remote Control is not available for it' : '; Remote Control was not turned on (the app did not approve; tell the owner once)')

/** Remote Control for a chat the owner asked about: not called when it is on already; a refusal is one plain word, not the raw error. */
async function remoteNow($: $T, target: string, known?: string): Promise<string> {
  const p = portsOf($)
  const st = known ?? (await stateOf(p, target)).remote
  if (st === 'on' || st === 'connecting') return 'on'
  if (st === 'unavailable') return 'unavailable'
  const r = await p.app('mcp__ccd_session_mgmt__set_remote_control', { session_id: target, enabled: true })
  if (!r.ok) await logAction(p, target, 'rc', false, oneLine(r.text, 160))
  return r.ok ? 'on' : 'refused'
}

/** A chief chat The Chief opened: once, its goal goes in as /goal and the leader hears it started. */
async function startGoalOnce($: $T) {
  if ((await $.store.get(`startGoal:${sid}`)) !== true) return
  await storeSet($, `startGoal:${sid}`, false)
  // the owner stopped this chat before its first goal went in: nothing the plugin holds starts it again
  if (await chiefStopped($, sid)) return
  void chiefSelfSetup($).catch(() => undefined)
  // the command itself, as the Goals pane's "Here" runs it: no message fuse in the way of a chief's first step
  if (chiefConfig.goal) await runGoal($, chiefConfig.goal)
  if (leaderSid) await sendTo($, leaderSid, 'report', { line: `+ new chief ${projectTitle()} started${chiefConfig.goal ? ` · goal: ${oneLine(chiefConfig.goal, 80)}` : ''}`, isNew: true, goal: chiefConfig.goal ?? '' })
}

// ---------- Automatic handoff and session housekeeping (the rules live in handoff.ts) ----------
// Every automatic action leaves one short line in the session it affects (in the leader for a chief), is told once when it
// fails, and replays nothing after an undo, a redo or a reload: its guard is a key in the store under the app session id.

/** Tool calls of the chat itself that are running now. */
let toolsRunning = 0
let handoffRunning = false
/** The chat did real work (a goal or a tool call): it gets pinned and put on Remote Control. */
let workSeen = false
let pinPending = false
let namePending = false
let nameFinished = false
/** The leader's fixed title has been set (a session that became the leader after a goal named it is renamed once). */
let leaderTitled = false
let careLoaded = false
let careResumed = false
/** The session this one handed off to (empty until it has). */
let handedOff = ''
/** The last time the owner typed into this chat (or sent from the phone). */
let ownerTypedAt = 0
/** The tier note last sent and the one last kept in the store (kept by the next care tick). */
let tierNoteKept = ''
let turnEndWaiter: (() => void) | null = null
/** How the chat's last turn ended; a handoff never starts after an interrupted or failed turn. */
let lastTurnReason = ''
/** The handoff record this session took as the successor, and the goal to set after its first turn. */
let handoffIn: { id: string; goal: string } | null = null
let handoffToken = ''

type HandoffIn = Inbound & { startedAt: number; taken: boolean }

/** Title calls The Chief itself is making right now; any other set_session_title is the owner's or the leader's own. */
let ownTitleCalls = 0

function portsOf($: $T): Ports {
  return {
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    get: key => $.store.get(key),
    set: async (key, value) => {
      await storeSet($, key, value)
    },
    app: async (tool, input) => {
      if (tool === APP.title) ownTitleCalls++
      try {
        const r = (await $.tool.call({ tool, ...input } as never)) as { text?: string; result?: unknown; isError?: boolean; deny?: string }
        const out = r.text ?? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''))
        return { ok: !r.deny && !r.isError, text: r.deny ?? out }
      } catch (err) {
        return { ok: false, text: err instanceof Error ? err.message : String(err) }
      } finally {
        if (tool === APP.title) ownTitleCalls--
      }
    },
    say: line => tellOwner($, line),
  }
}

/** One line for the owner: in this chat, and in the leader when this chat is a chief. */
async function tellOwner($: $T, line: string) {
  $.ui.log(line)
  if (role === 'chief' && leaderSid && interactive) await sendTo($, leaderSid, 'report', { line: oneLine(`${projectTitle()}: ${line}`, 300) }).catch(() => undefined)
}

/** The app's id is known (so every key below is the one an undo keeps) and this is a chat a person uses. */
const careReady = () => interactive && !isWorker && !!sid && (idSettled || lastSurface === 'terminal')

/** The desktop app's own tools, which The Chief calls itself. */
const APP_TOOL_RE = /^mcp__ccd_/

/** The desktop app's session tools (pin, Remote Control, title, archive) exist; the terminal has none. */
const appTools = () => lastSurface !== 'terminal'

/** Something of this chat is running: its turn, a tool call, a compact, a subagent, a worker, a detached run or a CLI agent. */
async function sessionBusy($: $T): Promise<boolean> {
  if (mainTurn || toolsRunning > 0 || compacting || runs.size > 0) return true
  const [ws, ss] = await Promise.all([$.state.get(WORKERS), $.state.get(SUBS)])
  return (ws.value ?? []).some(w => w.status === 'running') || (ss.value ?? []).some(x => x.status === 'running') || extAgents.some(a => a.until === null)
}

/** Running agents and jobs the new session must look at first. */
async function runningJobs($: $T): Promise<HandoffJob[]> {
  const [ws, ss] = await Promise.all([$.state.get(WORKERS), $.state.get(SUBS)])
  return [
    ...(ws.value ?? []).filter(w => w.status === 'running').map(w => ({ id: w.id, name: w.name, check: `agent_output ${w.id}` })),
    ...(ss.value ?? []).filter(x => x.status === 'running').map(x => ({ id: x.id, name: oneLine(x.description, 40), check: `agent_output ${x.id}` })),
  ]
}

/** Loads what this session kept across reloads, an undo and a redo; stamps its first sight. */
async function loadCare($: $T) {
  if (careLoaded || !careReady()) return
  careLoaded = true
  const s = await patchSess(portsOf($), sid, () => ({}))
  lastCompactAfter = Math.max(lastCompactAfter, s.lastCompactAfter)
  tierNoteSent = tierNoteSent || s.tierNote
  tierNoteKept = s.tierNote
  ownerTypedAt = Math.max(ownerTypedAt, s.ownerTypedAt)
  handedOff = s.handedOffTo
  const kept = await $.store.get(`nudged:${sid}`).catch(() => undefined)
  if (kept && typeof kept === 'object') for (const [k, v] of Object.entries(kept as Record<string, { activeAt: number; at: number; told: boolean }>)) if (!nudged.has(k)) nudged.set(k, v)
}

async function saveNudged($: $T) {
  await storeSet($, `nudged:${sid}`, Object.fromEntries(nudged)).catch(() => undefined)
}

/** Per-session records that were read under the engine id before the app's id was known. */
const PER_SESSION_KEYS = ['sess', 'pendingCompact', 'lastTurnEnd', 'quiet', 'pendingOverviews', 'dayStamps', 'nudged'] as const
/** An engine id gave way to the app id: what was kept under the old one comes along, the app id's own record winning. */
async function reattach($: $T, from: string, to: string) {
  for (const key of PER_SESSION_KEYS) {
    try {
      if ((await $.store.get(`${key}:${to}`)) !== undefined) continue
      const kept = await $.store.get(`${key}:${from}`)
      if (kept !== undefined) await storeSet($, `${key}:${to}`, kept)
    } catch {
      // that record stays where it was
    }
  }
  careLoaded = false
  pendingLoaded = false
}

/** The chat did something real: pin it and turn Remote Control on, once. */
function markWork() {
  if (workSeen) return
  workSeen = true
  pinPending = true
}

async function pinAndRemote($: $T) {
  const p = portsOf($)
  if (autoPin()) await pinSession(p, sid, 'self')
  if (riskyOn('chief_remote_control', opt('chief_remote_control'))) await remoteOn(p, sid, 'self')
}

const TITLE_SYSTEM = 'Verilen işi 2 ile 5 kelimelik kısa bir Türkçe başlığa çevir. Her kelime büyük harfle başlar, tırnak yok, hiçbir kelime tamamen büyük harf değil, nokta yok. "line" alanına yalnız başlığı yaz.'
const TITLE_SYSTEM_EN = 'Turn the given job into a short English title of 2 to 5 words. Every word starts with a capital letter, no quotes, no word in all capitals, no full stop. Write only the title in the "line" field.'
const TITLE_SHOTS_EN: [string, string][] = [
  ['Edit the product launch video and send it', 'Product Launch Video'],
  ['Fix the bugs in the login form', 'Login Form Fixes'],
  ['Speed up the image export, make rendering faster', 'Image Export Speed'],
]
const TITLE_SHOTS: [string, string][] = [
  ['Ürün tanıtım videosunu kurgula ve gönder', 'Ürün Tanıtım Videosu'],
  ['Giriş formundaki hataları düzelt', 'Giriş Formu Düzeltme'],
  ['Görsel dışa aktarmayı hızlandır, render süresini kısalt', 'Görsel Dışa Aktarma Hızı'],
]

/** What Haiku is told when it names a chat: the work, not the first words; BEKLE when the request names no work yet. */
const TITLE_HAIKU_SYSTEM =
  'Bir sohbet oturumuna ad koyuyorsun. Verilen istekten, yapılan işi anlatan 2 ile 5 kelimelik Türkçe bir başlık yaz: ne üzerinde çalışıldığı (müşteri, proje ya da dosya adı varsa o) ve ne yapıldığı. Her kelime büyük harfle başlar; özel adlar ve ürün adları olduğu gibi kalır. Tırnak, nokta, emoji yok; "Oturum", "Sohbet", "Yardım", "İstek" gibi boş kelimeler yok; "ve", "ile", "için" ile bitmez. İstek yalnız bir selamlaşmaysa ya da hangi işin yapılacağı anlaşılmıyorsa yalnız BEKLE yaz. Yalnız başlığı yaz, başka hiçbir şey yazma.'
const TITLE_HAIKU_SYSTEM_EN =
  'You name a chat session. From the given request, write an English title of 2 to 5 words that says the work: what is being worked on (the client, project or file name if there is one) and what is done. Every word starts with a capital letter; proper names and product names stay as they are. No quotes, full stops or emoji; no empty words such as "Session", "Chat", "Help" or "Request"; do not end with "and", "with" or "for". If the request is only a greeting or the work is not clear yet, write only BEKLE. Write only the title, nothing else.'
const TITLE_MODEL = 'haiku'
/** Turns that ended with no title yet (the request named no work): after this many the first words are used. */
const TITLE_WAITS = 4
let titleWaits = 0

/**
 * A title from the goal or the owner's requests. Haiku at low effort writes it (one tiny call per chat: the first
 * words of a request made titles like "Işık Motorunu Hızlandır ve"); when Haiku cannot be reached the local model
 * does, then the first words. '' = the request names no work yet: the next turn's end asks again.
 */
async function titleFor($: $T, text: string): Promise<string> {
  const res = await $.model.complete({ model: TITLE_MODEL, system: L(TITLE_HAIKU_SYSTEM_EN, TITLE_HAIKU_SYSTEM), prompt: oneLine(text, 900), maxTokens: 40, effort: 'low', timeoutMs: 20000 }).catch(() => null)
  if (res?.isAnswered) {
    const raw = (res.text.trim().split(/\r?\n/)[0] ?? '').trim()
    if (/^["'“]?BEKLE\b/i.test(raw)) {
      if (++titleWaits < TITLE_WAITS) return ''
    } else {
      const made = cleanTitle(raw)
      if (made.split(' ').length >= 2) return made
    }
  }
  const line = await plainLine($, L(TITLE_SYSTEM_EN, TITLE_SYSTEM), oneLine(text, 400), L(TITLE_SHOTS_EN, TITLE_SHOTS)).catch(() => null)
  const made = cleanTitle(line ?? '')
  return made.split(' ').length >= 2 ? made : titleFromText(text)
}

/** The first thing the owner asked in this chat, for a title when there is no goal. */
async function firstRequest($: $T): Promise<string> {
  const msgs = await $.session.messages().catch(() => [])
  return msgs.find(m => m.role === 'user' && m.text.trim() && !m.text.startsWith(WAKE) && !m.text.startsWith('Önceki oturumdan devir') && !m.text.startsWith('Handoff from the previous session'))?.text.trim() ?? ''
}

/** What this chat is about, for a title: the first thing the owner asked and, when it differs, the newest (a goal may be stale). */
async function recentRequests($: $T): Promise<string> {
  const msgs = await $.session.messages().catch(() => [])
  const asked = msgs.filter(m => m.role === 'user' && m.text.trim() && !m.text.startsWith(WAKE) && !m.text.startsWith('Önceki oturumdan devir') && !m.text.startsWith('Handoff from the previous session') && !m.text.startsWith('/') && !m.text.startsWith('This session is being continued'))
  const first = asked[0]?.text.trim() ?? ''
  const last = asked[asked.length - 1]?.text.trim() ?? ''
  if (!first) return ''
  return asked.length < 2 ? oneLine(first, 500) : L(`First request: ${oneLine(first, 400)}\nLast request: ${oneLine(last, 300)}`, `İlk istek: ${oneLine(first, 400)}\nSon istek: ${oneLine(last, 300)}`)
}

async function nameSelf($: $T) {
  const p = portsOf($)
  await nameSession(p, sid, `local_${sid}`, role === 'leader', async () => {
    const text = chiefConfig.goal || (await recentRequests($)) || (await activeGoal($))
    return text ? titleFor($, text) : ''
  })
  nameFinished = await hasDone(p, sid, 'named')
  leaderTitled = role === 'leader'
}

/** The guard for archiving this very session. */
async function selfGuard($: $T) {
  return { busy: await sessionBusy($), ownerTypedAt: Math.max(ownerTypedAt, (await readSess(portsOf($), sid)).ownerTypedAt), title: projectTitle() }
}

/** A released chief's chat: unpinned, then archived, but not while it works or after the owner typed in it; then it waits in the queue. */
async function archiveChief($: $T, c: HqCard): Promise<'done' | 'wait'> {
  const g = { busy: c.busy === true || c.working > 0 || (c.cliRunning ?? 0) > 0, ownerTypedAt: c.ownerTypedAt ?? 0, title: titleOf(c) }
  const r = await archiveSession(portsOf($), c.sid, `local_${c.sid}`, g, L(`${titleOf(c)} released`, `${titleOf(c)} serbest bırakıldı`))
  if (r === 'busy' || r === 'typed') {
    await storeSet($, `archiveQ:${c.sid}`, { by: sid, title: c.title, at: await $.clock.now() })
    return 'wait'
  }
  return 'done'
}

/**
 * Lets a chief go: it runs on its own again, is unpinned and its chat is put away once it is idle (its context never
 * costs again; it reopens from Archived). Called inside the leader's own tool call the app's auto mode sees the request;
 * a busy chat waits in the queue, one try when it is idle.
 */
async function releaseChiefNow($: $T, c: HqCard) {
  await sendTo($, c.sid, 'release')
  void $.tool.call({ tool: 'mcp__ccd_sidebar__set_pinned', session_id: `local_${c.sid}`, pinned: false } as never).catch(() => undefined)
  if (appTools()) await archiveChief($, c).catch(() => undefined)
}

/** A chief that said DONE, is idle and runs nothing for this long is released by the leader's plugin itself. */
export const AUTO_RELEASE_IDLE_MS = 90_000
/** Whether a finished chief can be released now: it claimed DONE, no turn, no agent, quiet for a while. */
export function releasable(c: { done?: boolean; unverified?: boolean; busy?: boolean; working: number; cliRunning?: number; activeAt?: number; updatedAt: number }, now: number): boolean {
  return c.done === true && c.unverified !== true && c.busy !== true && c.working === 0 && (c.cliRunning ?? 0) === 0 && now - (c.activeAt ?? c.updatedAt) >= AUTO_RELEASE_IDLE_MS
}

/** The new session of a handoff is still there: it took the handoff itself, or wrote its card after (the old chat's proof). */
async function successorRunning($: $T, newSid: string): Promise<boolean> {
  if (!newSid) return false
  // the successor read its handoff record and started (the same record the old chat waited on)
  const inb = (await $.store.get(`handoffIn:${newSid}`).catch(() => undefined)) as HandoffIn | undefined
  if (inb && inb.startedAt > 0) return true
  const path = join(await hqDir($), 'sessions', `${newSid}.json`)
  if (!(await fileExists($, path))) return false
  const txt = await readText($, path).catch(() => '')
  return txt.trim().length > 0
}

/** Archives sessions that are waiting for it: the old half of a handoff, and chiefs this leader released while they were busy. */
async function sweepArchives($: $T) {
  const p = portsOf($)
  if (!appTools()) return
  const s = await readSess(p, sid)
  // only a handoff that PROVED itself may archive the old chat: the new session started AND is still there. A failed
  // handoff (no handoffOkAt, or a successor that never wrote its card) leaves the old chief exactly as it is (18.10).
  if (s.handedOffTo && handoffArchiveOk(s, s.handedOffTo) && (await successorRunning($, s.handedOffTo)) && !(await hasDone(p, sid, 'archive'))) await archiveSession(p, sid, `local_${sid}`, await selfGuard($), L('handoff done, the new session is running', 'devir tamam, yeni oturum çalışıyor'))
  if (role !== 'leader') return
  const now = await $.clock.now()
  if (opt('auto_release_done') !== 'off') {
    for (const c of hqCards.filter(x => x.role === 'chief' && x.leader === sid && releasable(x, now))) {
      await releaseChiefNow($, c).catch(() => undefined)
      leaderLog = [...leaderLog, { at: now, from: c.sid, title: titleOf(c), line: 'finished (DONE); released and archived automatically' }].slice(-200)
      await storeSet($, `leaderLog:${sid}`, leaderLog).catch(() => undefined)
    }
  }
  for (const key of (await $.store.keys().catch(() => [] as string[])).filter(k => k.startsWith('archiveQ:'))) {
    const q = (await $.store.get(key)) as { by: string; title: string; at: number } | null | undefined
    if (!q || q.by !== sid) continue
    if (now - q.at > 24 * 3600_000) {
      await storeSet($, key, null)
      continue
    }
    await readCards($)
    const c = hqCards.find(x => x.sid === key.slice('archiveQ:'.length))
    if (c && (await archiveChief($, c)) === 'done') await storeSet($, key, null)
  }
}

// ----- the handoff -----

/** The permission mode the app reports for this chat; else what a chief or any other chat starts with. */
async function permissionModeOf($: $T): Promise<string> {
  const r = await portsOf($).app(APP.get, { session_id: 'self' })
  const m = /"permission_?[mM]ode"\s*:\s*"(default|acceptEdits|auto|bypassPermissions|plan|dontAsk)"/.exec(r.text)
  return m ? m[1]! : role === 'chief' && riskyOn('chief_permission_mode', opt('chief_permission_mode')) ? 'auto' : 'default'
}

/** Resolves true when a chat turn that started after `mark` ends, false after `ms`. */
function waitTurn($: $T, mark: number, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    let over = false
    const finish = (v: boolean) => {
      if (over) return
      over = true
      turnEndWaiter = null
      resolve(v)
    }
    turnEndWaiter = () => {
      if (turnsHere > mark) finish(true)
    }
    void $.clock.sleep(ms).then(() => finish(false), () => finish(false))
  })
}

/** The new session of a handoff: the record it will read, then a session made through the app (desktop) or a new tab (terminal). */
async function openHandoffSession($: $T, inb: Inbound, again: string | null): Promise<string> {
  const id = again ?? uuid()
  if (!again) await storeSet($, `handoffIn:${id}`, { ...inb, startedAt: 0, taken: false } satisfies HandoffIn)
  if (lastSurface === 'terminal') {
    if (!again) {
      const r = await $.process.run(newClaudeArgv(`/chief handoff ${id}`, inb.dir, await platformNow($), [...(inb.model ? ['--model', inb.model] : []), '--permission-mode', inb.permission]), { timeoutMs: 15000 })
      if (r.exitCode !== 0) throw new Error(oneLine(r.stderr || r.stdout || 'wt failed', 120))
    }
    return id
  }
  if (!again) await bootSession($, id, inb.model || lastModelSeen || 'claude-opus-5-5', inb.dir, inb.permission, inb.effort ?? '')
  await openResume($, id)
  return id
}

function flowPortsOf($: $T): FlowPorts {
  return {
    ...portsOf($),
    write: async (path, ask) => {
      // sent ONCE, never repeated: an interrupted or failed turn ends the try
      const ended = waitTurn($, turnsHere, 20 * 60_000)
      await $.prompt.submit({ text: ask, asUser: true })
      if (!(await ended)) return false
      if (lastTurnReason === 'aborted') return 'aborted'
      return lastTurnReason === 'answer' && (await $.fs.exists(path))
    },
    keep: async path => {
      await storeSet($, `handoffFile:${sid}`, { path, text: await readText($, path), at: await $.clock.now() })
    },
    open: (inb, again) => openHandoffSession($, inb, again),
    started: async id => (((await $.store.get(`handoffIn:${id}`)) as HandoffIn | undefined)?.startedAt ?? 0) > 0,
    verify: newSid => successorRunning($, newSid),
    moved: async (title, newSid) => {
      if (leaderSid) await sendTo($, leaderSid, 'report', { line: L(`${title} handed off → ${newSid}`, `${title} devredildi → ${newSid}`), moved: sid })
      chiefConfig = {}
      await storeSet($, `chiefConfig:${sid}`, chiefConfig)
      await setRole($, 'solo')
      await $.fs.write(join(await hqDir($), 'sessions', `${sid}.json`), '').catch(() => undefined)
    },
    // the terminal has no archive: the old tab is left for the owner to close
    guard: async () => (appTools() ? selfGuard($) : { busy: true, ownerTypedAt: 0 }),
  }
}

const chiefOf = () => (role === 'chief' && leaderSid ? { leaderSid, leaderTitle, config: { ...chiefConfig } } : null)

/** What the old chat tells the new one, and the chain itself (see runHandoff). */
async function doHandoff($: $T) {
  const p = portsOf($)
  const goal = chiefConfig.goal || (await activeGoal($)) || ''
  const title = lastSurface === 'terminal' ? projectTitle() : (await titleOfSession(p, `local_${sid}`)) || projectTitle()
  const inbound: Omit<Inbound, 'message'> = {
    goal,
    model: lastModelSeen || chiefConfig.model || '',
    effort: lastEffortSeen || chiefConfig.effort || '',
    permission: await permissionModeOf($),
    dir: cwd,
    title,
    pinned: await hasDone(p, sid, 'pin'),
    remote: await hasDone(p, sid, 'rc'),
    fromSid: sid,
    chief: chiefOf(),
  }
  const r = await runHandoff(flowPortsOf($), { sid, record: engineSid, target: `local_${sid}`, cwd, goal, title, jobs: await runningJobs($), inbound })
  if (r.ok) handedOff = r.newSid
}

/** The owner's NE-BILIYORUZ button: this chat writes what it knows into .chief and carries on (no new session, no archive). */
async function ownerKnow($: $T) {
  if (!cwd) return void $.ui.toast(L('The Chief: this chat has no folder to write into.', 'The Chief: bu sohbetin yazacak klasörü yok.'))
  if (await sessionBusy($)) return void $.ui.toast(L('The Chief: let this turn and the running agents finish first.', 'The Chief: önce bu tur ve çalışan ajanlar bitsin.'))
  const path = knowPath(cwd, await $.clock.now())
  await $.prompt.submit({ text: knowAsk(path, chiefConfig.goal || (await activeGoal($)) || ''), asUser: true })
  $.ui.toast(L(`The Chief: writing ${path}`, `The Chief: yazılıyor ${path}`))
}

/** The owner's own handoff, from the Oturum tab: the same chain as the automatic one, with no trigger to wait for. */
async function ownerHandoff($: $T) {
  const redraw = () => update($, tick, n => (n ?? 0) + 1).catch(() => undefined)
  if (handoffRunning || handedOff) return
  if (role === 'leader' || !cwd || !sid) return void $.ui.toast(L('The Chief: this chat cannot be handed off (it is the Leader or has no folder).', 'The Chief: bu sohbet devredilemez (Leader ya da klasörü yok).'))
  // the writing turn is this chat's next turn: one that is still running would be taken for it
  if (await sessionBusy($)) return void $.ui.toast(L('The Chief: let this turn and the running agents finish first, then hand off.', 'The Chief: önce bu tur ve çalışan ajanlar bitsin, sonra devret.'))
  handoffRunning = true
  await redraw()
  try {
    await doHandoff($)
  } catch (err) {
    await logAction(portsOf($), sid, 'handoff', false, err instanceof Error ? err.message : String(err)).catch(() => undefined)
    await portsOf($).say(L('The Chief: the handoff did not happen; carrying on in this session.', 'The Chief: devir olmadı; bu oturumda devam ediyorum.')).catch(() => undefined)
  } finally {
    handoffRunning = false
    await redraw()
  }
}

/**
 * At the end of a real turn only (never from a timer, never in an idle session): hand off when a trigger holds and
 * nothing runs. When something still runs, the next turn's end tries again; nothing retries by itself.
 */
async function handoffCheck($: $T) {
  if (handoffRunning || !careReady() || role === 'leader' || !cwd) return
  if (lastTurnReason === 'aborted' || lastTurnReason === 'error' || lastTurnReason === 'refusal') return
  handoffRunning = true
  try {
    await loadCare($)
    const s = await readSess(portsOf($), sid)
    const v = handoffVerdict({
      now: await $.clock.now(),
      compacts: s.compacts,
      afterCompacts: handoffAfterCompacts(),
      startedAt: s.startedAt,
      afterHours: handoffAfterHours(),
      context: await contextTokens($).catch(() => 0),
      handoffAt: s.handoffAt,
      handedOffTo: s.handedOffTo,
      eligible: true,
      busy: await sessionBusy($),
      autoOff: s.autoOff,
      // the chief's own switch (configure_chief handoff false, or the panel): its chat is then handed over by hand only
      handoffOn: chiefConfig.handoff !== false,
    })
    if (v.go) await doHandoff($)
  } catch (err) {
    // the trigger starts over and nothing repeats; the raw error stays out of the chat
    const now = await $.clock.now()
    await patchSess(portsOf($), sid, () => ({ flow: null, compacts: 0, startedAt: now })).catch(() => undefined)
    await logAction(portsOf($), sid, 'handoff', false, err instanceof Error ? err.message : String(err)).catch(() => undefined)
    await portsOf($).say(L('The Chief: the handoff did not happen; carrying on in this session.', 'The Chief: devir olmadı; bu oturumda devam ediyorum.')).catch(() => undefined)
  } finally {
    handoffRunning = false
  }
}

/** The successor of a handoff takes what the old one left: role, model, effort, title, pin, then its first message. */
async function takeHandoffIn($: $T) {
  for (const id of new Set([sid, engineSid, handoffToken].filter(Boolean))) {
    const rec = (await $.store.get(`handoffIn:${id}`)) as HandoffIn | undefined
    if (!rec || rec.taken) continue
    // taken first: an undo or a redo that brings this back finds it done
    await storeSet($, `handoffIn:${id}`, { ...rec, taken: true })
    handoffIn = { id, goal: rec.goal }
    if (rec.chief) {
      chiefConfig = { ...rec.chief.config }
      await storeSet($, `chiefConfig:${sid}`, chiefConfig)
      await setRole($, 'chief', rec.chief.leaderSid, rec.chief.leaderTitle)
    } else if (rec.model || rec.effort) {
      chiefConfig = { ...chiefConfig, ...(rec.model ? { model: rec.model } : {}), ...(rec.effort ? { effort: rec.effort } : {}) }
      await storeSet($, `chiefConfig:${sid}`, chiefConfig)
    }
    const p = portsOf($)
    // it keeps the old title, and is never re-titled
    if (lastSurface !== 'terminal' && rec.title) await renameSession(p, sid, `local_${sid}`, rec.title, true)
    await p.set(`act:${sid}:named`, await $.clock.now())
    nameFinished = true
    workSeen = true
    if (appTools() && rec.pinned) await pinSession(p, sid, 'self')
    if (appTools() && rec.remote && riskyOn('chief_remote_control', opt('chief_remote_control'))) await remoteOn(p, sid, 'self')
    enqueue({ kind: 'submit', text: rec.message, asUser: true })
    return
  }
}

/** This session's first turn has begun: the old session is waiting to hear it. */
async function markHandoffStarted($: $T) {
  if (!handoffIn) return
  const rec = (await $.store.get(`handoffIn:${handoffIn.id}`)) as HandoffIn | undefined
  if (rec && !rec.startedAt) await storeSet($, `handoffIn:${handoffIn.id}`, { ...rec, startedAt: await $.clock.now() })
}

/** After its first turn the successor takes the goal as /goal, as the old session had it. */
async function runGoal($: $T, goal: string) {
  if (quiet) return
  await $.prompt.submit({ text: role === 'chief' ? chiefGoalMessage(goal, chiefConfig.work) : goalMessage(goal), asUser: true })
}

/** A working chief is pinned; one idle this long is unpinned (the leader is told, and decides on archiving). */
export const IDLE_UNPIN_MS = 60 * 60000
/** Whether a chief's chat should be pinned now: it is in a turn, has agents running, or was active lately. */
export function wantPinned(now: number, activeAt: number, busy: boolean, running: boolean): boolean {
  return busy || running || (activeAt > 0 && now - activeAt < IDLE_UNPIN_MS)
}

let viewTriedAt = 0
let viewFails = 0
let idleTold = false
/**
 * Every chief keeps itself pinned while it works and on Remote Control, checked against what the app says and retried
 * every 30 s (10 min after many failures). It starts only after the chat's first real turn: Remote Control wants a
 * session that is running. Idle for 30 minutes it unpins itself and tells the leader once, as news, never as a
 * question: archiving stays the leader's call.
 */
async function chiefViewGuard($: $T) {
  if (role !== 'chief' || !appTools() || !interactive || isWorker || mainActivityAt === 0) return
  const now = await $.clock.now()
  if (now - viewTriedAt < (viewFails >= 20 ? 600000 : 30000)) return
  viewTriedAt = now
  const p = portsOf($)
  const running = await anyRunning($)
  const wantPin = wantPinned(now, Math.max(mainActivityAt, lastTurnEndAt), mainTurn, running)
  let ok = true
  try {
    const st = await stateOf(p, 'self')
    if (autoPin() && st.pinned !== undefined && st.pinned !== wantPin) {
      await $.tool.call({ tool: 'mcp__ccd_sidebar__set_pinned', session_id: 'self', pinned: wantPin } as never).catch(() => undefined)
      ok = (await stateOf(p, 'self')).pinned === wantPin
    }
    if (riskyOn('chief_remote_control', opt('chief_remote_control')) && st.remote !== 'on' && st.remote !== 'connecting' && st.remote !== 'unavailable') {
      const rc = await remoteNow($, 'self', st.remote)
      if (rc === 'refused') ok = false
    }
  } catch {
    ok = false
  }
  viewFails = ok ? 0 : viewFails + 1
  if (!wantPin && !idleTold && leaderSid) {
    idleTold = true
    await sendTo($, leaderSid, 'report', { line: `${projectTitle()} has been idle for ${Math.round(IDLE_UNPIN_MS / 60000)} min${autoPin() ? ' and is unpinned' : ''}; if its job is finished, release_chief archives it (your call)` }).catch(() => undefined)
  } else if (wantPin) idleTold = false
}

/** /chief sync (leader): every chief chat of this leader gets its pin and Remote Control checked and fixed now. */
async function syncChiefs($: $T): Promise<string> {
  if (role !== 'leader') return 'Only the leader syncs its chiefs.'
  if (!appTools()) return 'The app tools are not available here, so pin and Remote Control cannot be checked.'
  await readCards($)
  const now = await $.clock.now()
  const p = portsOf($)
  const rows: string[] = []
  for (const c of hqCards.filter(x => x.role === 'chief' && x.leader === sid)) {
    const target = `local_${c.sid}`
    const st = await stateOf(p, target)
    const wantPin = wantPinned(now, c.activeAt ?? c.updatedAt, c.busy === true, c.working > 0 || (c.cliRunning ?? 0) > 0)
    const did: string[] = []
    if (autoPin() && st.pinned !== undefined && st.pinned !== wantPin) {
      await $.tool.call({ tool: 'mcp__ccd_sidebar__set_pinned', session_id: target, pinned: wantPin } as never).catch(() => undefined)
      did.push(wantPin ? 'pinned' : 'unpinned (idle)')
    }
    if (wantPin && riskyOn('chief_remote_control', opt('chief_remote_control'))) {
      const rc = await remoteNow($, target, st.remote)
      if (st.remote !== 'on' && st.remote !== 'connecting') did.push(rc === 'on' ? 'Remote Control on' : rc === 'unavailable' ? 'Remote Control unavailable' : 'Remote Control refused (retried by the chief every 30 s)')
    }
    const after = await stateOf(p, target)
    rows.push(`${titleOf(c)}: ${after.pinned === true ? 'pinned' : 'not pinned'}, Remote Control ${after.remote ?? 'unknown'}${did.length ? ` · fixed: ${did.join(', ')}` : ''}`)
  }
  return rows.length ? rows.join('\n') : 'No chiefs to sync.'
}

/** Every few seconds: load what was kept, finish a handoff a reload cut short, take a handoff record, pin, name, archive. */
async function careTick($: $T) {
  if (!careReady()) return
  await loadCare($)
  if (!careResumed) {
    careResumed = true
    await resumeHandoff(flowPortsOf($), { sid, target: `local_${sid}`, title: projectTitle(), isChief: role === 'chief' }).catch(() => undefined)
  }
  if (tierNoteSent !== tierNoteKept) {
    tierNoteKept = tierNoteSent
    await patchSess(portsOf($), sid, () => ({ tierNote: tierNoteKept })).catch(() => undefined)
  }
  await takeHandoffIn($)
  if (!workSeen && (chiefConfig.goal || (await activeGoal($)))) markWork()
  if (pinPending) {
    pinPending = false
    if (appTools()) await pinAndRemote($)
  }
  await chiefViewGuard($).catch(() => undefined)
  if (namePending && (!nameFinished || (role === 'leader' && !leaderTitled))) {
    namePending = false
    if (appTools() && autoTitle()) await nameSelf($)
  }
  await sweepArchives($)
}

/**
 * A chief's model and effort from the owner's tiers, held in code so a leader that picks loosely still lands on
 * them. `tier` (cok_zor|zor|orta|kolay) wins over an explicit model and effort; with no tier a new chief's model says
 * its tier (any Haiku is Kolay, any Sonnet Orta, any Opus Çok zor), no model at all is Orta, and another family
 * (Fable) is left as asked. With no tier named, an explicit effort the caller gave always wins. A difficulty floor
 * matching the goal lifts the tier, never lowers it; `note` says so.
 */
export function pickChiefTier(cfg: ChiefConfig, tier: unknown, isNew: boolean): { cfg: ChiefConfig; note: string } {
  const r = resolveChiefTier({ tier, model: cfg.model, effort: cfg.effort, goal: cfg.goal, isNew }, chiefTiersNow(), floorsNow())
  return { cfg: r.tier ? { ...cfg, model: r.model, effort: r.effort } : cfg, note: r.note }
}

/** A new chief's config with the tiers applied, for callers that carry no tier argument. */
export const chiefTier = (cfg: ChiefConfig): ChiefConfig => pickChiefTier(cfg, undefined, true).cfg

/** The new session's id in the app's start_session answer ("... (session_id: local_<uuid>, name: ...)"). */
export const startedSessionId = (text: string) => /\blocal_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i.exec(text)?.[1] ?? ''

/**
 * Desktop: the app's own start_session opens the chief as a session under this chat (a row under the leader, a note
 * back when its turn ends), with the goal as its first message: no CLI boot turn, no link to press Enter on. The role
 * and settings go to the store (a plugin that loads later reads them) and to its inbox (one that already loaded).
 * Null when the app refuses or names no session; the older paths stand in.
 * shortcut: the app ignores a model above the leader's own; the chief's plugin sets its model from its config after.
 */
/** Why the last new chief did not open by itself, one entry per way that was tried. */
let openWhy: string[] = []
/** What the app's own session tool is asked for a new chief: its goal as the first message, under this chat. `token` marks a call the leader makes itself. */
export function appChiefInput(cfg: ChiefConfig, dir: string, title?: string, token = ''): Record<string, unknown> {
  const model = cfg.model || lastModelSeen || ''
  const effort = (EFFORT_WORDS as readonly string[]).includes(cfg.effort ?? '') ? cfg.effort : ''
  return {
    initiation: 'user_asked',
    context: 'fresh',
    use_worktree: false,
    title: oneLine(title?.trim() || titleFromText(cfg.goal ?? '') || 'Chief', 58),
    prompt: chiefGoalMessage(cfg.goal ?? '', cfg.work),
    background: `This chat is a chief of the chat "${projectTitle()}" (The Chief plugin${token ? `, chief ${token}` : ''}): it works on the goal below on its own and that leader chat hears how each of its turns ends.${dir ? ` Working folder: \`${dir}\`.` : ''}`,
    ...(dir ? { cwd: dir } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

/** A session the app just started becomes this leader's chief: its role and settings are stored and it is told (its goal already went in as its first message). */
async function adoptStarted($: $T, id: string, cfg: ChiefConfig) {
  const model = cfg.model || lastModelSeen || ''
  const config = { ...cfg, ...(model ? { model } : {}) }
  await storeSet($, `role:${id}`, { role: 'chief', leaderSid: sid, leaderTitle: projectTitle() })
  await storeSet($, `chiefConfig:${id}`, config)
  // the goal went in as the session's first message: nothing sends it a second time
  await storeSet($, `startGoal:${id}`, false)
  await sendTo($, id, 'join', { config, started: true })
}

/**
 * The app runs its session tool for the model, not for a plugin: a plugin's own call is refused ("needs a person's
 * approval") unless a permission rule allows it. Then create_chief hands the call to the leader itself, and the new
 * chat is made a chief when that call returns (the hook on the tool, by the token or the goal).
 */
export const APP_APPROVAL_RE = /needs a person.s approval|can.t ask for it|wasn.t run/i
const pendingAppChiefs = new Map<string, { cfg: ChiefConfig; title?: string; at: number }>()
/** The arguments the leader is asked to call the app's session tool with; null when the chief opened another way. */
let askModel: Record<string, unknown> | null = null

async function openChiefViaApp($: $T, cfg: ChiefConfig, dir: string, title?: string): Promise<string | null> {
  if (!cfg.goal) return null
  const r = await portsOf($).app('mcp__ccd_session__start_session', appChiefInput(cfg, dir, title))
  const id = r.ok ? startedSessionId(r.text) : ''
  if (!id) {
    openWhy.push(`app: ${oneLine(r.text || 'no session in its answer', 140)}`)
    return null
  }
  // the chat exists from here on: a follow-up that fails must never send the caller on to open a second one
  await adoptStarted($, id, cfg).catch(() => undefined)
  return id
}

async function createChief($: $T, cfg: ChiefConfig, folder?: string, title?: string, byModel = false, link = false) {
  openWhy = []
  askModel = null
  if (lastSurface !== 'terminal') {
    const viaApp = link ? null : await openChiefViaApp($, cfg, folder || cwd, title).catch(err => (openWhy.push(`app: ${oneLine(err instanceof Error ? err.message : String(err), 140)}`), null))
    if (!viaApp && byModel && !link && cfg.goal && APP_APPROVAL_RE.test(openWhy.join(' '))) {
      // the app starts sessions for the model only: the leader makes the same call, and the hook on it makes the chat a chief
      const now = await $.clock.now()
      for (const [k, v] of pendingAppChiefs) if (now - v.at > 30 * 60000) pendingAppChiefs.delete(k)
      const token = newId()
      pendingAppChiefs.set(token, { cfg, title, at: now })
      askModel = appChiefInput(cfg, folder || cwd, title, token)
      return ''
    }
    const opened = viaApp ?? (await openChiefChat($, cfg, folder || cwd))
    // the leader makes sure it really started: goal sent, pinned, Remote Control on, titled (what the chief's own plugin does not always manage)
    if (opened) {
      void verifyChiefStart($, opened, cfg, title).catch(() => undefined)
      return ''
    }
  }
  const token = newId()
  invites.set(token, { at: await $.clock.now(), goal: cfg.goal ?? '', told: false })
  await $.fs.write(join(await hqDir($), 'pending', `${token}.json`), asciiJson({ leader: sid, leaderTitle: projectTitle(), config: cfg }))
  const prompt = `/chief join ${token}`
  const dir = folder || cwd
  if (lastSurface === 'terminal') await $.process.run(newClaudeArgv(prompt, dir, await platformNow($)), { timeoutMs: 15000 })
  else {
    const url = `claude://code/new?q=${encodeURIComponent(prompt)}${dir ? `&folder=${encodeURIComponent(dir)}` : ''}`
    await $.process.run(openArgv(url, await platformNow($)), { timeoutMs: 15000 })
  }
  return token
}

/** How long a new chief gets to start its own goal before the leader sends it. */
export const CHIEF_START_WAIT_MS = 30_000

/**
 * A chief chat the leader opened must be working, pinned, on Remote Control and titled. The chief's own plugin does it
 * when it loads; when it did not start the goal within CHIEF_START_WAIT_MS the leader sends the goal itself (so the chat
 * never sits empty), then pin, Remote Control and the title (a title given by the leader is final) are checked.
 */
export async function verifyChiefStart($: $T, id: string, cfg: ChiefConfig, title?: string): Promise<'started' | 'sent' | 'failed'> {
  const p = portsOf($)
  const target = `local_${id}`
  if (title?.trim()) {
    // a title the leader gave: set first, and the chief's own naming leaves it alone
    await renameSession(p, id, target, title, true).catch(() => undefined)
    await p.set(`act:${id}:named`, await $.clock.now()).catch(() => undefined)
  }
  await $.clock.sleep(CHIEF_START_WAIT_MS)
  let result: 'started' | 'sent' | 'failed' = (await $.store.get(`startGoal:${id}`)) === false ? 'started' : 'failed'
  if (result === 'failed' && cfg.goal) {
    const r = await p.app('mcp__ccd_session_mgmt__send_message', { session_id: target, message: chiefGoalMessage(cfg.goal, cfg.work) })
    if (r.ok) {
      await storeSet($, `startGoal:${id}`, false)
      result = 'sent'
    }
  }
  if (appTools()) {
    if (autoPin()) await pinSession(p, id, target).catch(() => undefined)
    if (riskyOn('chief_remote_control', opt('chief_remote_control'))) await remoteOn(p, id, target).catch(() => undefined)
    if (!title?.trim() && cfg.goal) await nameChief($, id, cfg.goal).catch(() => undefined)
  }
  const now = await $.clock.now()
  const line = result === 'started' ? 'new chief started its goal by itself' : result === 'sent' ? 'new chief had not started: the goal was sent by the leader' : 'new chief did not start and the goal could not be sent; open it and check'
  leaderLog = [...leaderLog, { at: now, from: id, title: title?.trim() || sessionTitles[id] || 'new chief', line }].slice(-200)
  await storeSet($, `leaderLog:${sid}`, leaderLog).catch(() => undefined)
  // a chief that never started is an error the leader hears now, not a line in a log
  if (result === 'failed') raise(`chief-start:${id}`, `! ${title?.trim() || 'new chief'} [${id.slice(0, 8)}]: ${line}`, true, now, 300)
  await logAction(p, id, 'chief-start', result !== 'failed', result)
  return result
}

/** `/chief join <token>`: this chat takes the leader's settings that wait under the token. */
async function joinByToken($: $T, token: string) {
  const path = join(await hqDir($), 'pending', `${token}.json`)
  const raw = await readText($, path)
  if (!raw.trim()) return 'That invitation is gone; ask the leader to send a new one.'
  const pending = JSON.parse(raw) as { leader: string; leaderTitle: string; config: ChiefConfig }
  await $.fs.write(path, '')
  await setRole($, 'chief', pending.leader, pending.leaderTitle)
  await applyConfig($, pending.config ?? {})
  void chiefSelfSetup($).catch(() => undefined)
  await sendTo($, pending.leader, 'report', { line: `+ new chief ${projectTitle()} started${chiefConfig.goal ? ` · goal: ${oneLine(chiefConfig.goal, 80)}` : ''}`, isNew: true, goal: chiefConfig.goal ?? '' })
  return `This chat is now a chief of ${pending.leaderTitle}.${describeConfig(chiefConfig) ? ` Settings: ${describeConfig(chiefConfig)}.` : ''}`
}

// ---------- chats on other machines: the app lists them as peers and SendMessage reaches them ----------
type RemotePeer = { name: string; id: string; kind: string; state: string }
let remoteSeen: { at: number; peers: RemotePeer[] } | null = null
/** Peer lines of the app's ListAgents: "  Title [id6]  ·  Remote Control  ·  idle". Desktop sessions of this computer are left out (the headquarters has them). */
export function parsePeers(raw: string): RemotePeer[] {
  const out: RemotePeer[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s+(.+?) \[([0-9a-z]{4,})\]\s+·\s+(Remote Control|cloud|[^·]+?)\s+·\s+(\S+)/i.exec(line)
    if (m && /^(remote control|cloud)$/i.test(m[3]!.trim())) out.push({ name: m[1]!.trim(), id: m[2]!, kind: m[3]!.trim().toLowerCase().startsWith('remote') ? 'remote' : 'cloud', state: m[4]! })
  }
  return out
}
/** Remote Control chats (other laptops, the phone) the app knows; read at most every 20 s, empty outside the app. */
async function remotePeers($: $T): Promise<RemotePeer[]> {
  const now = await $.clock.now()
  if (remoteSeen && now - remoteSeen.at < 20000) return remoteSeen.peers
  let peers: RemotePeer[] = []
  try {
    peers = parsePeers(await toolText($, 'ListAgents', {}))
  } catch {
    // no ListAgents here (terminal or old app): no remote chats
  }
  remoteSeen = { at: now, peers }
  return peers
}
/** A remote chat by its short id or its name (exact first, then a part of it). */
/** A send refusal that passes on its own (the classifier gave no verdict, a timeout, a busy pipe): worth another try. */
export const sendRetryable = (err: string) => /no verdict|classifier|timed? ?out|temporar|busy|ECONNRESET|EPIPE|try again/i.test(err) && !/denied by the user|not found|no such/i.test(err)
export function findPeer(peers: RemotePeer[], ref: string): RemotePeer | undefined {
  const r = ref.trim().toLowerCase().replace(/^local_/, '')
  if (!r) return undefined
  return peers.find(p => p.id.toLowerCase() === r) ?? peers.find(p => p.name.toLowerCase() === r) ?? peers.find(p => r.length >= 4 && (p.id.toLowerCase().startsWith(r) || p.name.toLowerCase().includes(r)))
}
const peerLine = (p: RemotePeer) => `- ${p.name} [${p.id}] · ${p.kind === 'remote' ? 'Remote Control' : 'cloud'} · ${p.state}`
/** The list_chiefs section for chats on other machines. */
function remoteText(peers: RemotePeer[]): string {
  if (!peers.length) return ''
  const up = peers.filter(p => p.state !== 'offline')
  const off = peers.length - up.length
  return [`\nChats on other machines / cloud (${peers.length}; message_chief reaches them by the id in brackets or the name):`, ...up.slice(0, 15).map(peerLine), off ? `- … and ${off} offline (a message waits until they are back)` : ''].filter(Boolean).join('\n')
}

/**
 * A chat the leader may take as a chief: not itself, not a chief, seen in the last two hours, and a real chat. A
 * headless run (a script's claude -p that loaded the plugin) never is: those piled up as dozens of "open chats".
 * A card from before the chat flag still counts (headless ones age out of the two hours). Pure, so it is tested.
 */
export function adoptable(c: { sid: string; role: string; updatedAt: number; chat?: boolean; ownerTypedAt?: number }, me: string, now: number): boolean {
  if (c.sid === me || c.role === 'chief' || now - c.updatedAt >= 2 * 3600000) return false
  return c.chat !== false
}

/** A chief chat that has not refreshed its card for three minutes and is not in a turn: a message to it waits, nobody reads it. */
export const chiefLooksDead = (c: { busy?: boolean }, seenAgoMs: number) => seenAgoMs > 3 * 60000 && !c.busy
/** The leader's picture of its chiefs, for the chat and for list_chiefs. `news` prints a brief only when it is new. */
function chiefsText(now: number, briefs: 'always' | 'news' = 'always') {
  const mine = hqCards.filter(c => c.role === 'chief' && c.leader === sid)
  const free = hqCards.filter(c => adoptable(c, sid, now))
  const seen = (t: number) => (now - t < 90000 ? 'live' : `seen ${fmtElapsed(now - t)} ago`)
  const line = (c: HqCard) =>
    [
      `- ${titleOf(c)} [${c.sid.slice(0, 8)} = local_${c.sid}] · ${seen(c.updatedAt)} · ${c.working} working${!c.busy ? ((c.rows ?? []).some(r => ['çalışıyor', 'TAKILMIŞ', '0-BYTE', 'ASILI', 'KİLİT BEKLİYOR', 'RAM BEKLİYOR', 'KOMUT ÇALIŞIYOR'].includes(r.state)) ? L(' · chief waiting, workers active', ' · şef bekliyor, işçi aktif') : L(' · REALLY IDLE', ' · GERÇEKTEN BOŞTA')) : ''}${c.model ? ` · ${shortModel(c.model)}${c.effort ? ` ${c.effort}` : ''}` : ''}${stoppedChiefs.has(c.sid) ? L(' · STOPPED', ' · DURDURULDU') : ''}`,
      c.goal ? `  goal: ${oneLine(c.goal, 140)}` : '',
      describeConfig(c.config) ? `  set: ${describeConfig(c.config)}` : '',
      ...(c.rows?.length ? c.rows.map(r => `  · ${r.name} | ${r.model} | pid ${r.pid || '-'} | log ${r.logBytes}B, ${L('last write', 'son yazım')} ${r.logAt ? fmtElapsed(now - r.logAt) : L('none', 'yok')} ${L('ago', 'önce')} | ${r.files} ${L('files', 'dosya')} | ${stateLabel(r.state)}${r.note ? ` (${r.note})` : ''}`) : c.agents.slice(0, 4).map(a => `  · ${a.name}: ${a.now}`)),
      briefs === 'news' ? briefNews(c) : c.brief ? `  last brief: ${oneLine(c.brief, 220)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  const self = hqCards.find(c => c.sid === sid)
  return [
    `This chat: role ${role}${role === 'chief' ? `, leader ${leaderSid ? `local_${leaderSid}` : 'none'}` : ''}, ${self ? `card ${seen(self.updatedAt)}` : 'NO card in the headquarters (it was not written; the next turn rewrites it)'}.`,
    `Chiefs (${mine.length}):`,
    ...(mine.length ? mine.map(line) : ['- none yet: create_chief opens one, adopt_chief takes over an open chat']),
    free.length ? `\nOther open chats you can adopt (${free.length}):` : '',
    ...free.slice(0, 8).map(line),
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------- detached runs: workers that outlive the app, with their own folder, env, locks and chain ----------
/** What a finished worker hands on: the first rule whose pattern its report matches runs. */
type ChainRule = { match: string; spawn?: SpawnSpec; notify?: string }
/** A worker as spawn_worker (or a chain rule) describes it. */
type SpawnSpec = {
  name?: string
  cli?: string
  model?: string
  effort?: string
  lane?: string
  brief?: string
  /** A fixed header file prepended to the task, with {WT} {RAPOR} {NAME} {BRANCH} and any vars filled in. */
  header_file?: string
  task?: string
  task_file?: string
  vars?: Record<string, string>
  cwd?: string
  /** Make a fresh worktree first: `git -C repo worktree add --detach path ref`. */
  worktree?: { repo: string; ref: string; path: string }
  env?: Record<string, string>
  /** The run is done when this file exists (its text is the report); the process is then stopped. */
  done_when_file?: string
  /** Named resources only one worker at a time may hold, across every session on this computer. */
  locks?: string[]
  next?: ChainRule[]
  /** Run outside the app so an app restart does not kill it (default on where the CLI supports it). */
  detach?: boolean
  /** Claude workers only: acceptEdits (default), bypassPermissions, auto, default, plan. */
  permission_mode?: string
  /** Set by the lane runtime: the lane this worker serves and the paths it must not touch. */
  guard?: string[]
}
/** A detached run's bookkeeping, kept in the store so a reopened chat finds its workers again. */
type RunRecord = { workerId: string; owner: string; pid: number; runDir: string; out: string; exit: string; devinLog?: string; outRead: number; devinRead: number; devinSession?: string; devinNode?: number; devinLast?: string }

/** CLIs whose prompt can come from a file or stdin, so the run needs no live pipe to the app. */
const DETACHABLE: Partial<Record<SquadCli, true>> = { devin: true, claude: true, codex: true, custom: true }
const runs = new Map<string, RunRecord>()
/** When each run's process was last checked for life. */
const aliveCheckedAt = new Map<string, number>()
let runsLoaded = false

/**
 * Run files live under ~/.claude, never AppData: the desktop app is an MSIX package, and Windows redirects its
 * AppData writes into the package's own LocalCache, where a worker started outside the app cannot see them
 * (measured: cmd.exe found no run.cmd and exited at once, while the app still read its own copy).
 */
async function runsRoot($: $T) {
  const home = isWindows() ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  return join(home ?? '.', '.claude', 'the-chief', 'runs')
}

/** Is this process id alive? (tasklist on Windows, kill -0 elsewhere) */
async function pidAlive($: $T, pid: number): Promise<boolean> {
  try {
    if (isWindows()) {
      const r = await $.process.run(['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { timeoutMs: 10000 })
      return r.stdout.includes(`"${pid}"`)
    }
    return (await $.process.run(['sh', '-c', `kill -0 ${pid} 2>/dev/null`], { timeoutMs: 5000 })).exitCode === 0
  } catch {
    return true // unknown: do not call a run dead on a failed check
  }
}

async function saveRuns($: $T) {
  const all = ((await $.store.get('runs')) as RunRecord[] | undefined) ?? []
  const others = all.filter(r => r.owner !== sid)
  await storeSet($, 'runs', [...others, ...runs.values()])
}

/** Fills {WT} {RAPOR} {REPORT} {NAME} {BRANCH} and the spec's own vars. */
function fillVars(text: string, vars: Record<string, string>) {
  return text.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (m, k: string) => (k in vars ? vars[k]! : m))
}

/** The prompt a spec asks for: header file + task (text or file) with placeholders filled, or the brief instruction. */
async function buildPrompt($: $T, s: SpawnSpec, dir: string): Promise<string> {
  const vars: Record<string, string> = { WT: dir, RAPOR: s.done_when_file ?? '', REPORT: s.done_when_file ?? '', NAME: s.name ?? '', BRANCH: s.worktree?.ref ?? '', ...(s.vars ?? {}) }
  const header = s.header_file ? await readText($, s.header_file) : ''
  const task = s.task ?? (s.task_file ? await readText($, s.task_file) : '')
  // every agent learns the browser rule; one whose job touches a browser also gets the bridge started
  const browser = bridgeOn() ? `\n\n${bridgeNote(await bridgeDirOf($))}` : ''
  if (bridgeOn() && BROWSER_JOB.test(`${header} ${task} ${s.brief ?? ''}`)) await ensureBridge($).catch(() => '')
  if (header || task) return fillVars([header, task].filter(Boolean).join('\n\n'), vars) + browser
  return `Read the file ${s.brief} and execute that brief exactly, end to end. Act, do not just describe. Stop when it is done.${s.done_when_file ? ` When you are done, write your report to ${s.done_when_file}.` : ''}` + browser
}

/** argv without the prompt, and how the prompt reaches it (a file flag, or stdin). */
function detachedArgv(w: SquadWorker, promptPath: string): { argv: string[]; stdin: boolean } {
  const m = w.model
  const e = w.effort ?? ''
  // a resume continues the very same session (a fresh --session-id would throw the context away)
  if (w.resumeSession && w.sessionId && canResume(w.cli)) {
    if (w.cli === 'devin') return { argv: ['devin', '-p', '-r', w.sessionId, '--prompt-file', promptPath, '--model', m, '--permission-mode', 'dangerous', '--respect-workspace-trust', 'false'], stdin: false }
    const continued = resumeArgv(w.cli, m, e, w.sessionId, '-', w.permission)
    if (continued) return { argv: continued, stdin: true }
  }
  if (w.cli === 'devin') return { argv: ['devin', '-p', '--prompt-file', promptPath, '--model', m, '--permission-mode', 'dangerous', '--respect-workspace-trust', 'false'], stdin: false }
  if (w.cli === 'claude') return { argv: ['claude', '-p', '--model', m, '--effort', e || 'high', '--permission-mode', w.permission || claudeWorkerMode(), '--output-format', 'stream-json', '--verbose', ...(w.sessionId ? ['--session-id', w.sessionId] : [])], stdin: true }
  const full = CLIS[w.cli].argv(m, e, '-', null)
  return { argv: full, stdin: true } // codex exec reads "-" from stdin
}

const cmdQuote = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`)
const shQuote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`

/** What runWorker reads a run from: a child's own stream, or a detached OpenCode run's output file. */
type RunStream = AsyncIterable<{ text: string }> & { result: Promise<{ code: number | null }>; return: (v?: never) => Promise<unknown> }
/** Workers whose detached run a live runWorker reads: pollRuns leaves them alone until a reload ends that reader. */
const liveTails = new Set<string>()
/** Starts a run.cmd outside the app's job (WMI, hidden window); its pid, 0 when it did not start. */
async function wmiStart($: $T, script: string, dir: string): Promise<number> {
  // ShowWindow 0: measured, a WMI-started cmd.exe otherwise opens a visible console window
  const ps = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${script.replace(/'/g, "''")}"'; CurrentDirectory = '${dir.replace(/'/g, "''")}'; ProcessStartupInformation = $si }; $r.ProcessId`
  const r = await $.process.run(['powershell', '-NoProfile', '-Command', ps], { timeoutMs: 30000 })
  const pid = Number(r.stdout.trim().split(/\s+/).pop())
  return Number.isFinite(pid) && pid > 0 ? pid : 0
}
/** One run.cmd line that sets a variable: quotes stay (OpenCode's JSON settings need them), % is doubled so cmd keeps it. Pure, so it is tested. */
export const cmdSet = (k: string, v: string) => `set "${k}=${v.replace(/%/g, '%%').replace(/[\r\n]+/g, ' ')}"`
/**
 * An OpenCode run outside the app: it no longer dies with the chat that started it (26.10: Heart-13 and others died
 * the second their chief's process ended, at 14K to 95K tokens, never a context limit; a reload or an archive did the
 * same). Its output goes to a file read back as the run's stream, so runWorker handles it as a child (drops resumed,
 * routes tried, the logs written); it is a detached record too, so a reloaded chat follows it to its end.
 */
async function detachedOpencode($: $T, w: SquadWorker, argv: string[], env: Record<string, string>): Promise<RunStream | null> {
  const dir = w.dir || cwd || '.'
  const runDir = join(await runsRoot($), `${w.id}-${w.runs}`)
  const out = join(runDir, 'out.log')
  const exit = join(runDir, 'exit.txt')
  await $.fs.write(out, '')
  const lines = ['@echo off', `cd /d ${cmdQuote(dir)}`, ...Object.entries(env).map(([k, v]) => cmdSet(k, v)), `${argv.map(cmdQuote).join(' ')} > ${cmdQuote(out)} 2>&1`, `echo %ERRORLEVEL% > ${cmdQuote(exit)}`]
  const script = join(runDir, 'run.cmd')
  await $.fs.write(script, lines.join('\r\n'))
  const pid = await wmiStart($, script, dir)
  if (!pid) return null
  const rec: RunRecord = { workerId: w.id, owner: sid, pid, runDir, out, exit, outRead: 0, devinRead: 0 }
  runs.set(w.id, rec)
  liveTails.add(w.id)
  await saveRuns($)
  await saveRunWorkers($)
  let stopped = false
  let code: number | null = null
  let settle!: (r: { code: number | null }) => void
  const result = new Promise<{ code: number | null }>(r => (settle = r))
  async function* read(): AsyncGenerator<{ text: string }> {
    let from = 0
    let checked = await $.clock.now()
    try {
      for (;;) {
        const ended = stopped || (await $.fs.exists(exit))
        const t = await readTail($, out, from)
        from = t.next
        if (t.lines.length) yield { text: `${t.lines.join('\n')}\n` }
        if (ended) {
          const rest = (await readText($, out).catch(() => '')).slice(from)
          if (rest.trim()) yield { text: rest }
          if (!stopped) code = Number((await readText($, exit).catch(() => '')).trim())
          break
        }
        const now = await $.clock.now()
        if (now - checked > 10000) {
          checked = now
          if (!(await pidAlive($, pid)) && !(await $.fs.exists(exit))) {
            yield { text: `${GONE_MARK}\n` }
            break
          }
        }
        await $.clock.sleep(1500)
      }
    } finally {
      liveTails.delete(w.id)
      runs.delete(w.id)
      await saveRuns($).catch(() => undefined)
      settle({ code: Number.isFinite(code) ? code : null })
    }
  }
  const it = read()
  return {
    [Symbol.asyncIterator]: () => it,
    result,
    return: async () => {
      stopped = true
      await killRun($, rec)
      return undefined
    },
  }
}

/** Starts a worker outside the app (Windows: WMI, so it leaves the app's job; elsewhere nohup), and records it. */
async function startDetached($: $T, w: SquadWorker, prompt: string): Promise<boolean> {
  const dir = w.dir || cwd || '.'
  const runDir = join(await runsRoot($), w.id)
  // every CLI gets the same brief file (the one runWorker uses): a claude worker's brief is not a run-folder secret
  const promptPath = promptFile(w.dir || cwd, cwd, w.name, w.runs)
  const out = join(runDir, 'out.log')
  const exit = join(runDir, 'exit.txt')
  await $.fs.write(promptPath, prompt)
  await $.fs.write(out, '')
  const { argv, stdin } = detachedArgv(w, promptPath)
  const env = { ...WORKER_ENV, ...envFor(w.cli), ...(w.env ?? {}) }
  let pid = 0
  if (isWindows()) {
    const lines = ['@echo off', `cd /d ${cmdQuote(dir)}`, ...Object.entries(env).map(([k, v]) => `set "${k}=${v.replace(/"/g, '')}"`), `${argv.map(cmdQuote).join(' ')}${stdin ? ` < ${cmdQuote(promptPath)}` : ''} > ${cmdQuote(out)} 2>&1`, `echo %ERRORLEVEL% > ${cmdQuote(exit)}`]
    const script = join(runDir, 'run.cmd')
    await $.fs.write(script, lines.join('\r\n'))
    pid = await wmiStart($, script, dir)
  } else {
    const lines = [`cd ${shQuote(dir)}`, ...Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)}`), `${argv.map(shQuote).join(' ')}${stdin ? ` < ${shQuote(promptPath)}` : ''} > ${shQuote(out)} 2>&1`, `echo $? > ${shQuote(exit)}`]
    const script = join(runDir, 'run.sh')
    await $.fs.write(script, lines.join('\n'))
    const r = await $.process.run(['sh', '-c', `nohup sh ${shQuote(script)} >/dev/null 2>&1 & echo $!`], { timeoutMs: 15000 })
    pid = Number(r.stdout.trim())
  }
  if (!Number.isFinite(pid) || pid <= 0) return false
  // a start is real only when the process is seen alive, or has already written output or its exit
  for (let i = 0; i < 6; i++) {
    await $.clock.sleep(500)
    if ((await $.fs.exists(exit)) || (await $.fs.stat(out).then(st => st.size > 0).catch(() => false)) || (await pidAlive($, pid))) {
      runs.set(w.id, { workerId: w.id, owner: sid, pid, runDir, out, exit, outRead: 0, devinRead: 0 })
      break
    }
  }
  if (!runs.has(w.id)) return false
  await saveRuns($)
  await patchWorker($, w.id, x => ({ ...x, promptPath, now: L('Starting…', 'Başlıyor…') }))
  return true
}

/** Stops a detached run and everything it started. */
async function killRun($: $T, rec: RunRecord) {
  try {
    if (isWindows()) await $.process.run(['taskkill', '/PID', String(rec.pid), '/T', '/F'], { timeoutMs: 20000 })
    else await $.process.run(['sh', '-c', `pkill -TERM -P ${rec.pid}; kill -TERM ${rec.pid}`], { timeoutMs: 10000 })
  } catch {
    // already gone
  }
}

/**
 * The complete new lines of a growing file, from a character offset: a line still being written is left for the
 * next read (read half before, its tail looked like a line of its own: a JSON fragment as the agent's "last
 * words"). Offsets count characters of the decoded text, not bytes, so UTF-8 text does not shift them.
 */
export function newLines(all: string, from: number): { lines: string[]; next: number } {
  const start = from > all.length ? 0 : from
  const end = all.lastIndexOf('\n')
  if (end < start) return { lines: [], next: start }
  return { lines: all.slice(start, end).split(/\r?\n/).filter(l => l.trim()), next: end + 1 }
}

async function readTail($: $T, path: string, from: number): Promise<{ lines: string[]; next: number }> {
  try {
    const { size } = await $.fs.stat(path)
    if (size === 0) return { lines: [], next: from }
    return newLines(await readText($, path), from)
  } catch {
    return { lines: [], next: from }
  }
}

/** Devin writes its steps to its own log, not to stdout: find the log of this run (it names the run's folder) and read new steps. */
const DEVIN_STEP: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/toolbox::tools::read: Reading file: (.+)$/, m => L(`Reading: ${baseName(m[1]!)}`, `Okuyor: ${baseName(m[1]!)}`)],
  [/toolbox::tools::(?:edit|write|str_replace|apply_patch)\w*: \w[\w ]*?: (.+)$/, m => L(`Editing: ${baseName(m[1]!)}`, `Düzenliyor: ${baseName(m[1]!)}`)],
  [/toolbox::tools::(?:exec|shell|bash|run)\w*: [^:]*: (.+)$/, m => `Bash: ${oneLine(m[1]!, 60)}`],
  [/toolbox::tools::(?:grep|search|glob)\w*: [^:]*: (.+)$/, m => L(`Searching: ${oneLine(m[1]!, 40)}`, `Arıyor: ${oneLine(m[1]!, 40)}`)],
]
/**
 * Devin keeps every turn (its words, each tool call and its output) in sessions.db, not on stdout or in its log, so
 * a detached Devin run showed an almost empty terminal. One read-only python query per few seconds serves every Devin
 * run of this chat: a run is tied to the session whose first user message names its brief (all runs share one cwd,
 * so the folder alone mixed them up), then gets the messages after the last one it saw.
 */
const DEVIN_DB_PY = `import sys,json,sqlite3
db=sys.argv[1];q=json.load(sys.stdin)
c=sqlite3.connect('file:'+db+'?mode=ro',uri=True,timeout=2)
n=lambda s:s.replace(chr(92),'/').lower().rstrip('/')
taken={x['session'] for x in q if x.get('session')};out={}
for x in q:
  s=x.get('session')
  if not s:
    for sid,wd in c.execute('select id,working_directory from sessions where created_at>=? order by created_at',(x['since'],)):
      if sid in taken or n(wd)!=x['dir']:continue
      first=''
      for (m,) in c.execute('select chat_message from message_nodes where session_id=? order by node_id limit 12',(sid,)):
        o=json.loads(m)
        if o.get('role')=='user':first=str(o.get('content'));break
      if x['needle'] in n(first):s=sid;taken.add(sid);break
  if not s:continue
  rows=c.execute('select node_id,chat_message from message_nodes where session_id=? and node_id>? order by node_id limit 60',(s,x.get('after',-1))).fetchall()
  def small(m):
    o=json.loads(m);o['content']=str(o.get('content') or '')[:1500]
    for t in o.get('tool_calls') or []:t['arguments']={k:(v[:400] if isinstance(v,str) else '') for k,v in (t.get('arguments') or {}).items()}
    return json.dumps({k:o.get(k) for k in ('role','content','tool_calls')})
  out[x['id']]={'session':s,'after':rows[-1][0] if rows else x.get('after',-1),'msgs':[small(m) for _,m in rows]}
print(json.dumps(out))`
/** One Devin message as terminal lines plus the step it shows in the row. Pure, so it is tested. */
export function devinTerminal(msg: string): { term: string[]; step?: string } {
  let o: Record<string, any>
  try {
    o = JSON.parse(msg)
  } catch {
    return { term: [] }
  }
  const cut = (t: string) => (t.length > 400 ? `${t.slice(0, 400)}…` : t)
  const rows = (t: unknown) => String(t ?? '').split(/\r?\n/).filter(l => l.trim())
  if (o.role === 'assistant') {
    const term = rows(o.content).slice(0, 30).map((l, i) => `${i === 0 ? '● ' : '│ '}${cut(l)}`)
    let step: string | undefined
    for (const t of (o.tool_calls ?? []) as Record<string, any>[]) {
      const a = (t.arguments ?? {}) as Record<string, unknown>
      const name = String(t.name ?? '')
      const file = a.file_path ?? a.path
      if (typeof a.command === 'string' && name !== 'get_output') {
        term.push(`$ ${cut(a.command.split(/\r?\n/)[0]!)}`)
        step = `Bash: ${oneLine(a.command, 60)}`
      } else if (name === 'read' && file) {
        term.push(`▸ Read ${baseName(String(file))}`)
        step = L(`Reading: ${baseName(String(file))}`, `Okuyor: ${baseName(String(file))}`)
      } else if ((name === 'edit' || name === 'write') && file) {
        term.push(`▸ ${name === 'edit' ? 'Edit' : 'Write'} ${baseName(String(file))}`)
        step = L(`Editing: ${baseName(String(file))}`, `Düzenliyor: ${baseName(String(file))}`)
      } else if (name === 'grep') {
        term.push(`▸ Grep ${cut(String(a.pattern ?? ''))}`)
        step = L(`Searching: ${oneLine(String(a.pattern ?? ''), 40)}`, `Arıyor: ${oneLine(String(a.pattern ?? ''), 40)}`)
      } else if (name !== 'get_output' && name !== 'todo_write') {
        const arg = a.url ?? a.query ?? a.server_name ?? ''
        term.push(`▸ ${name}${arg ? ` ${cut(String(arg))}` : ''}`)
      }
    }
    return { term, step }
  }
  if (o.role === 'tool') {
    const ls = rows(o.content).filter(l => !/^Output from command in shell \w+:$/.test(l.trim()))
    const shown = ls.slice(0, 2).map(l => `  ${cut(l)}`)
    return { term: ls.length > 2 ? [...shown, L(`  … +${ls.length - 2} lines`, `  … +${ls.length - 2} satır`)] : shown }
  }
  return { term: [] }
}
let devinDbAt = 0
let devinDbOff = false
const devinDbNews = new Map<string, { term: string[]; steps: string[] }>()
/** Reads new Devin messages for every running Devin run into devinDbNews; quiet and off for good when python is missing. */
async function pollDevinDb($: $T) {
  const now = await $.clock.now()
  if (devinDbOff || now - devinDbAt < 4000) return
  devinDbAt = now
  const { value: ws = [] } = await $.state.get(WORKERS)
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  const q = [...runs.values()].flatMap(rec => {
    const w = ws.find(x => x.id === rec.workerId)
    if (!w || w.cli !== 'devin' || !w.brief) return []
    return [{ id: rec.workerId, dir: norm(w.dir || cwd), since: Math.floor(w.startedAt / 1000) - 10, needle: norm(w.brief), session: rec.devinSession, after: rec.devinNode ?? -1 }]
  })
  if (!q.length) return
  const base = isWindows() ? `${(await $.env.get('APPDATA')) ?? ''}\\devin\\cli` : `${(await $.env.get('HOME')) ?? '.'}/.local/share/devin/cli`
  let res: { exitCode: number; stdout: string; stderr?: string }
  const note = async (t: string) => $.fs.write(join(await runsRoot($), 'devin-db.log'), `${new Date(now).toISOString()} ${t}
`).catch(() => undefined)
  try {
    res = await $.process.run([isWindows() ? 'py' : 'python3', ...(isWindows() ? ['-3'] : []), '-I', '-c', DEVIN_DB_PY, join(base, 'sessions.db')], { stdin: JSON.stringify(q), timeoutMs: 10000 })
  } catch (err) {
    await note(`python did not start: ${err instanceof Error ? err.message : String(err)}`)
    devinDbOff = true
    return
  }
  if (res.exitCode !== 0) {
    await note(`exit ${res.exitCode}: ${(res.stderr ?? '').slice(0, 400)}`)
    return
  }
  await note(`ok ${q.length} runs, ${res.stdout.length} bytes`)
  let got: Record<string, { session: string; after: number; msgs: string[] }>
  try {
    got = JSON.parse(res.stdout)
  } catch {
    return
  }
  let changed = false
  for (const [id, g] of Object.entries(got)) {
    const rec = runs.get(id)
    if (!rec) continue
    if (rec.devinSession !== g.session || rec.devinNode !== g.after) changed = true
    rec.devinSession = g.session
    rec.devinNode = g.after
    const news = devinDbNews.get(id) ?? { term: [], steps: [] }
    for (const m of g.msgs) {
      const t = devinTerminal(m)
      // Devin saves a tool call twice (streamed and final): the same line right after itself shows once
      for (const l of t.term) if (l !== news.term[news.term.length - 1] && l !== rec.devinLast) news.term.push(l)
      rec.devinLast = news.term[news.term.length - 1] ?? rec.devinLast
      if (t.step) news.steps.push(t.step)
    }
    devinDbNews.set(id, news)
  }
  if (changed) await saveRuns($)
}
async function devinLogFor($: $T, w: SquadWorker, rec: RunRecord): Promise<string | undefined> {
  if (rec.devinLog) return rec.devinLog
  const dir = isWindows() ? `${(await $.env.get('APPDATA')) ?? ''}\\devin\\cli\\logs` : `${(await $.env.get('HOME')) ?? '.'}/.local/share/devin/cli/logs`
  try {
    const taken = new Set([...runs.values()].map(r => r.devinLog).filter(Boolean))
    const files = (await $.fs.list(dir)).filter(f => /^devin_.*\.log$/.test(f.name)).map(f => join(dir, f.name)).filter(f => !taken.has(f))
    const want = (w.dir || cwd).replace(/\\/g, '/').toLowerCase()
    for (const f of files.sort().reverse().slice(0, 12)) {
      const { mtimeMs } = await $.fs.stat(f)
      if (mtimeMs < w.startedAt - 5000) continue
      const head = (await readText($, f)).slice(0, 400000).replace(/\\/g, '/').toLowerCase()
      if (head.includes(want) || head.includes(rec.runDir.replace(/\\/g, '/').toLowerCase())) {
        rec.devinLog = f
        return f
      }
    }
  } catch {
    // no Devin logs here
  }
  return undefined
}

/** One look at every detached run of this chat: new output, Devin's steps, real last activity, the report file, the end. */
async function pollRuns($: $T) {
  if (!runsLoaded) await loadRuns($)
  await pollDevinDb($).catch(() => undefined)
  for (const rec of [...runs.values()]) {
    if (liveTails.has(rec.workerId)) continue
    const { value: ws = [] } = await $.state.get(WORKERS)
    let w = ws.find(x => x.id === rec.workerId)
    if (!w) {
      runs.delete(rec.workerId)
      continue
    }
    const lines: string[] = []
    let step = ''
    const o = await readTail($, rec.out, rec.outRead)
    rec.outRead = o.next
    const termAdd: string[] = []
    let said = ''
    for (const raw of o.lines) {
      const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      // a Devin run tied to its session gets its words from sessions.db with the tool calls, not twice
      if (!(w.cli === 'devin' && rec.devinSession)) termAdd.push(...terminalOf(plain))
      const ev = readAgentLine(plain)
      if (!ev) continue
      if (ev.usd && w.env?.ANTHROPIC_API_KEY) void recordApiSpend($, ev.usd, w.name).catch(() => undefined)
      lines.push(ev.line)
      if (ev.step) step = ev.step
      if (ev.said) said = ev.said.slice(0, 600)
    }
    const db = devinDbNews.get(rec.workerId)
    if (db) {
      devinDbNews.delete(rec.workerId)
      termAdd.push(...db.term)
      lines.push(...db.steps)
      if (db.steps.length) step = db.steps[db.steps.length - 1]!
    }
    await appendTerm($, w, termAdd)
    let active = 0
    try {
      active = (await $.fs.stat(rec.out)).mtimeMs
    } catch {
      // not yet
    }
    if (w.cli === 'devin') {
      const log = await devinLogFor($, w, rec)
      if (log) {
        const d = await readTail($, log, rec.devinRead)
        rec.devinRead = d.next
        // the log is found by folder only, so with several Devin runs in one cwd its steps may be another run's
        for (const raw of rec.devinSession ? [] : d.lines) {
          for (const [re, f] of DEVIN_STEP) {
            const m = raw.match(re)
            if (m) {
              step = f(m)
              lines.push(step)
              break
            }
          }
        }
        try {
          active = Math.max(active, (await $.fs.stat(log)).mtimeMs)
        } catch {
          // gone
        }
      }
    }
    // a Devin step read from sessions.db is real activity: the stall check looks at nothing else Devin writes
    if (db?.term.length) active = Math.max(active, await $.clock.now())
    if (active) lastActivity.set(w.id, active)
    if (lines.length) {
      await patchWorker($, w.id, x => ({ ...x, now: step || x.now, said: said || x.said, tail: [...x.tail, ...lines].slice(-TAIL) }))
    }
    // the end: the report file, the process's own exit, or a process that died without one
    let ended: { code: number | null; byFile: boolean; died?: boolean } | null = null
    if (w.doneFile && (await $.fs.exists(w.doneFile))) ended = { code: 0, byFile: true }
    else if (await $.fs.exists(rec.exit)) {
      const code = Number((await readText($, rec.exit)).trim())
      ended = { code: Number.isFinite(code) ? code : null, byFile: false }
    } else if ((await $.clock.now()) - (aliveCheckedAt.get(rec.workerId) ?? 0) > 10000) {
      aliveCheckedAt.set(rec.workerId, await $.clock.now())
      if (!(await pidAlive($, rec.pid)) && !(await $.fs.exists(rec.exit))) ended = { code: null, byFile: false, died: true }
    }
    if (ended) {
      if (ended.byFile) await killRun($, rec)
      // the session id lives in the output file: read it before the run record goes, so finishRun can resume it
      if (!ended.byFile) {
        const out = await readText($, rec.out).catch(() => '')
        const ses = out ? sessionOf(w.cli, out.split(/\r?\n/)) : null
        if (ses && ses !== w.sessionId) w = { ...w, sessionId: ses }
      }
      runs.delete(rec.workerId)
      await saveRuns($)
      if (ended.died) await patchWorker($, w.id, x => ({ ...x, tail: [...x.tail, '── process gone without an exit code'].slice(-TAIL) }))
      await finishRun($, w, ended.code, ended.byFile, ended.died)
    }
  }
}

/** A reopened chat takes back the detached runs it owns: their workers show again and are followed to the end. */
async function loadRuns($: $T) {
  runsLoaded = true
  const all = ((await $.store.get('runs')) as RunRecord[] | undefined) ?? []
  const saved = ((await $.store.get(`runWorkers:${sid}`)) as SquadWorker[] | undefined) ?? []
  for (const rec of all.filter(r => r.owner === sid)) {
    runs.set(rec.workerId, rec)
    const w = saved.find(x => x.id === rec.workerId)
    const { value: ws = [] } = await $.state.get(WORKERS)
    if (w && !ws.some(x => x.id === w.id)) await update($, workers, list => [...(list ?? []), { ...w, status: 'running' as const }])
    // checked at once: a run that died while the app was closed shows as failed, not running
    aliveCheckedAt.set(rec.workerId, 0)
  }
}

/** Keeps the detached workers' cards in the store, so a reopened chat can draw them again. */
async function saveRunWorkers($: $T) {
  const { value: ws = [] } = await $.state.get(WORKERS)
  await storeSet($, `runWorkers:${sid}`, ws.filter(w => runs.has(w.id)).map(w => ({ ...w, tail: w.tail.slice(-20) })))
}

/** A run is over: status, locks freed, the owner told (with the report's first line), then the chain. */
async function finishRun($: $T, w: SquadWorker, code: number | null, byFile: boolean, died = false) {
  const now = await $.clock.now()
  const { value = [] } = await $.state.get(WORKERS)
  const was = value.find(x => x.id === w.id)
  const report = w.doneFile ? await readText($, w.doneFile).catch(() => '') : ''
  // asked for a report and none came: it did not finish its work, whatever its exit code
  const missing = !!w.doneFile && !byFile && !visible(report)
  // same rule as runWorker: a stop without its report goes on in the SAME session, it is not a failed run
  if (missing && !died) {
    const mark = await resumeMark($, w, w.tail[w.tail.length - 1] ?? '')
    const badEnd = AUTH_RE.test(w.tail.slice(-8).join('\n')) || RATE_RE.test(w.tail.slice(-8).join('\n'))
    const call = reportResumeStep({
      missing, stopped: was?.status === 'stopped', resumable: canResume(w.cli), session: w.sessionId, badError: badEnd,
      resumes: was?.reportResumes ?? 0, stalls: was?.reportStalls ?? 0, prevMark: was?.resumeMark, mark,
    })
    if (call.go === 'resume') {
      await patchWorker($, w.id, x => ({ ...x, status: 'failed', endedAt: now, exitCode: code, resumeSession: true, reportResumes: call.resumes, reportStalls: call.stalls, resumeMark: call.mark, now: L(`No report: continuing in the same session (${call.resumes}/${REPORT_RESUME_CAP})`, `Rapor yok: aynı oturumda devam ediyor (${call.resumes}/${REPORT_RESUME_CAP})`) }))
      await releaseLocks($, w)
      await saveRunWorkers($)
      await afterEndDrain($)
      void followUp($, w.id, reportContinue(w.doneFile ?? '')).catch(() => undefined)
      return
    }
    if (call.go === 'giveup') await patchWorker($, w.id, x => ({ ...x, reportResumes: call.resumes, reportStalls: call.stalls }))
  }
  const status: SquadWorker['status'] = was?.status === 'stopped' ? 'stopped' : died || missing ? 'failed' : byFile || code === 0 ? 'done' : 'failed'
  if (died) await patchWorker($, w.id, x => ({ ...x, now: L('The process died (no exit code)', 'Süreç öldü (çıkış kodu yok)') }))
  else if (missing) await patchWorker($, w.id, x => ({ ...x, now: L('Done but no report written', 'Bitti ama rapor yazılmadı'), tail: [...x.tail, `── exited without writing ${w.doneFile}`].slice(-TAIL) }))
  await patchWorker($, w.id, x => ({ ...x, status, endedAt: now, exitCode: code, sessionId: w.sessionId, resumeSession: false, report: report ? resultReport(report) : x.report }))
  await releaseLocks($, w)
  await saveRunWorkers($)
  const mins = Math.max(1, Math.round((now - w.startedAt) / 60000))
  const mark = status === 'done' ? '✓' : status === 'stopped' ? '■' : '✗'
  const first = report ? oneLine(report.split(/\r?\n/).find(l => l.trim()) ?? '', 140) : oneLine(w.tail[w.tail.length - 1] ?? '', 100)
  raise(`end:${w.id}:${w.runs}`, `${mark} ${w.name} ${status} · ${CLIS[w.cli].label} · ${mins}m${byFile ? ` · report ${w.doneFile}` : code !== null && code !== 0 ? ` · exit ${code}` : ''} · "${first}"`, status === 'failed', now)
  $.ui.toast(`${w.name} ${status}${byFile ? L(': report written', ': rapor yazıldı') : ''}`)
  if (status === 'done') await runChain($, w, report)
  await afterEndDrain($)
  await flushAlerts($, now)
}

/** The chain: the first rule whose pattern the report matches spawns the next worker or hands the coordinator a task. */
async function runChain($: $T, w: SquadWorker, report: string) {
  if (w.lane) void laneAfterDone($, w).catch(() => undefined)
  for (const rule of (w.next ?? []) as ChainRule[]) {
    let hit = false
    try {
      hit = new RegExp(rule.match, 'i').test(report)
    } catch {
      hit = report.toLowerCase().includes(rule.match.toLowerCase())
    }
    if (!hit) continue
    const vars = { RAPOR_METNI: report, REPORT_TEXT: report, PREV_NAME: w.name, PREV_WT: w.dir || cwd, PREV_REPORT: w.doneFile ?? '' }
    if (rule.spawn) {
      const spec: SpawnSpec = { ...rule.spawn, vars: { ...vars, ...(rule.spawn.vars ?? {}) } }
      for (const k of ['name', 'cwd', 'done_when_file', 'task', 'task_file', 'header_file'] as const) if (typeof spec[k] === 'string') (spec as Record<string, unknown>)[k] = fillVars(spec[k] as string, spec.vars!)
      if (spec.worktree) spec.worktree = { repo: fillVars(spec.worktree.repo, spec.vars!), ref: fillVars(spec.worktree.ref, spec.vars!), path: fillVars(spec.worktree.path, spec.vars!) }
      enqueue({ kind: 'spawn', request: specToRequest(spec) })
      raise(`chain:${w.id}`, `→ ${w.name} matched "${rule.match}": starting ${spec.name ?? 'the next worker'}`, false, await $.clock.now())
    }
    if (rule.notify) enqueue({ kind: 'submit', text: `The Chief · ${w.name}: ${fillVars(rule.notify, vars)}` })
    return
  }
}

// ---------- lanes: a saved recipe, one table of checks, escalation, a do-not-touch guard, capacity, the leader report ----------
const LANE_KEYS = { templates: 'lane:templates', state: 'lane:state', routes: 'lane:routes', credits: 'lane:credits', zen: 'lane:zen' } as const
async function laneGet<T>($: $T, key: string, fallback: T): Promise<T> {
  const v = await $.store.get(key).catch(() => undefined)
  return v && typeof v === 'object' ? (v as T) : fallback
}
const laneSet = ($: $T, key: string, value: unknown) => storeSet($, key, value as never).catch(() => undefined)

// ---------- Zen free models: a scan 2-3 times a day, and the routes that read its store ----------
/** The tracker's last scan, in whichever store this plugin was loaded from (inline or synced). */
const zenRecord = ($: $T) => laneGet<ZenRecord>($, LANE_KEYS.zen, emptyZen())

/** The Zen key, read only when a ping came back 401 (the same field the Zen CLI uses); never logged. */
async function zenKey($: $T): Promise<string> {
  const field = CLIS['opencode-zen'].key?.field ?? ''
  return (field ? opt(field) : '') || (await $.env.get('OPENCODE_API_KEY').catch(() => '')) || ''
}

let zenBusy = false
/**
 * One scan of Zen's free models and their health. Fresh for 8 h (a failed scan retries after an hour), so the
 * daily ticks make 2-3 scans; no network call happens on the spawn path, which reads the store instead.
 */
async function zenRefresh($: $T, force = false): Promise<ZenRecord> {
  const now = await $.clock.now()
  const prev = await zenRecord($)
  if (!force && !zenDue(prev, now)) return prev
  if (zenBusy) return prev
  zenBusy = true
  try {
    const net = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<ZenResponse> => {
      try {
        const r = await $.http.fetch(url, init as never)
        return { status: r.status, ok: r.ok, text: r.text }
      } catch {
        return { status: 0, ok: false, text: '' }
      }
    }
    const next = await collectZen(net, { now, prev, key: () => zenKey($) })
    await laneSet($, LANE_KEYS.zen, next)
    return next
  } finally {
    zenBusy = false
  }
}

/**
 * The routes a tier runs on: a tier the owner saved in `lane:routes` keeps its own list; every other tier follows
 * the Zen tracker while its data is fresh (healthy free models → Ollama minimax → Haiku 5.5 xhigh; zor on Sonnet),
 * else the built-in WORKER_ROUTES.
 */
async function workerRoutes($: $T): Promise<Partial<Record<TierId, Route[]>>> {
  const manual = await laneGet<Partial<Record<TierId, Route[]>>>($, LANE_KEYS.routes, {})
  const zen = await zenRecord($)
  const now = await $.clock.now()
  const auto = zenTrusted(zen, now) ? zenRoutes(healthyZenIds(zen, now)) : {}
  return { ...auto, ...manual }
}

const shellArgv = (cmd: string): string[] => (isWindows() ? ['cmd', '/d', '/s', '/c', cmd] : ['sh', '-c', cmd])
const laneTemplates = ($: $T) => laneGet<Record<string, LaneTemplate>>($, LANE_KEYS.templates, {})
const laneStates = ($: $T) => laneGet<Record<string, LaneState>>($, LANE_KEYS.state, {})
const putLane = async ($: $T, name: string, patch: Partial<LaneState>) => {
  const all = await laneStates($)
  if (all[name]) all[name] = { ...all[name]!, ...patch }
  await laneSet($, LANE_KEYS.state, all)
}

/** Heavy commands (tsc, vitest …) wait for a slot; the slot count follows the RAM that is really available. */
let heavyRunning = 0
const heavyWaiters: Array<() => void> = []
async function laneCapacity($: $T) {
  const free = await freeRamMb($)
  const cpus = Number(isWindows() ? await $.env.get('NUMBER_OF_PROCESSORS') : '8') || 8
  return { ...capacity(Number.isFinite(free) ? free : 16000, cpus, { reserveMb: ramReserveMb() }), freeMb: free }
}
async function withHeavySlot<T>($: $T, fn: () => Promise<T>): Promise<T> {
  const slots = (await laneCapacity($)).heavy
  while (heavyRunning >= slots) await new Promise<void>(r => heavyWaiters.push(r))
  heavyRunning++
  try {
    return await fn()
  } finally {
    heavyRunning--
    heavyWaiters.shift()?.()
  }
}

/** Runs the lane's checks in the shared order; a failed check whose output matches its fix rule is fixed and tried once more. */
async function runLaneChecks($: $T, state: LaneState, tpl: LaneTemplate | undefined): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  for (const c of tpl?.checks ?? []) {
    const attempt = async () => {
      const r = await withHeavySlot($, () => $.process.run(shellArgv(c.cmd), { cwd: state.dir, timeoutMs: 15 * 60000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) })))
      return { ok: r.exitCode === 0, text: `${r.stdout}\n${r.stderr}` }
    }
    let res = await attempt()
    if (!res.ok && c.fix) {
      const m = new RegExp(c.fix.match, 'i').exec(res.text)
      if (m) {
        await $.process.run(shellArgv(c.fix.run.replace(/\{1\}/g, m[1] ?? '')), { cwd: state.dir, timeoutMs: 120000 }).catch(() => undefined)
        res = await attempt()
      }
    }
    out.push({ name: c.name, ok: res.ok, summary: summarize(c.name, res.ok, res.text), at: await $.clock.now() })
    if (!res.ok) await $.fs.write(join(state.dir, `LANE-${c.name}.log`), res.text.slice(-6000)).catch(() => undefined)
  }
  return out
}

/** A lane's worker is done: guard against its changed files, run the checks, then ready / retry / move up a tier. */
async function laneAfterDone($: $T, w: SquadWorker) {
  if (!w.lane) return
  const states = await laneStates($)
  const st = states[w.lane]
  if (!st) return
  const tpl = (await laneTemplates($))[st.template]
  await putLane($, st.name, { phase: 'checking', note: '' })
  const status = await $.process.run(['git', '-C', st.dir, 'status', '--porcelain'], { timeoutMs: 30000 }).catch(() => null)
  const changed = (status?.stdout ?? '').split(/\r?\n/).map(l => l.slice(3).trim()).filter(Boolean)
  const hits = changed.map(f => ({ f, p: hitsGuard(f, st.guard) })).filter(x => x.p)
  if (hits.length) {
    const list = hits.map(h => `${h.f} (${h.p})`)
    await putLane($, st.name, { phase: 'failed', note: L('do-not-touch list', 'dokunma listesi'), guardHits: list })
    raise(`guard:${w.id}`, L(`⛔ ${w.name}: touched files on the do-not-touch list: ${list.slice(0, 4).join(', ')}`, `⛔ ${w.name}: dokunma listesindeki dosyalara değmiş: ${list.slice(0, 4).join(', ')}`), true, await $.clock.now())
    return
  }
  const results = await runLaneChecks($, st, tpl)
  const ok = results.every(r => r.ok)
  await putLane($, st.name, { checks: results })
  const now = await $.clock.now()
  if (ok) {
    await putLane($, st.name, { phase: 'ready', note: '' })
    raise(`lane:${st.name}:${w.runs}`, L(`✓ ${st.name} ready · ${results.map(r => `${r.name} ${r.summary}`).join(' · ') || 'no checks'}`, `✓ ${st.name} hazır · ${results.map(r => `${r.name} ${r.summary}`).join(' · ') || 'kontrol yok'}`), false, now)
    await startLaneDependents($, st.name, tpl)
    return
  }
  const fails = st.fails + 1
  const failed = results.filter(r => !r.ok).map(r => r.name).join(', ')
  if (fails >= ESCALATE_AFTER) {
    const up = escalate(st.tier)
    if (up) {
      await putLane($, st.name, { fails: 0, tier: up, phase: 'working', note: L(`${failed} failed twice → moved up to ${TIER_LABEL[up]}`, `${failed} iki kez düştü → ${TIER_LABEL[up]} seviyesine geçti`) })
      raise(`up:${st.name}:${up}`, L(`↑ ${st.name}: ${failed} failed twice, restarting at ${TIER_LABEL[up]}`, `↑ ${st.name}: ${failed} iki kez düştü, ${TIER_LABEL[up]} seviyesinde yeniden başlıyor`), false, now)
      await launchLane($, st.name, { ...st, tier: up }, `Kontroller düştü (${failed}). Çıktı LANE-<kontrol>.log dosyalarında. Düzelt ve bitir.`)
      return
    }
    await putLane($, st.name, { fails, phase: 'failed', note: L(`${failed} failed, no higher tier left`, `${failed} düştü, üst seviye kalmadı`) })
    raise(`lane-fail:${st.name}`, L(`✗ ${st.name}: ${failed} failed and there is no higher tier`, `✗ ${st.name}: ${failed} düştü ve çıkılacak üst seviye yok`), true, now)
    return
  }
  await putLane($, st.name, { fails, phase: 'working', note: L(`${failed} failed (${fails}/${ESCALATE_AFTER}), the worker is fixing it`, `${failed} düştü (${fails}/${ESCALATE_AFTER}), işçi düzeltiyor`) })
  await followUp($, w.id, `Checks failed: ${failed}. See the LANE-<check>.log files in this folder, fix the code, then report done again.`)
}

async function startLaneDependents($: $T, done: string, tpl: LaneTemplate | undefined) {
  const all = await laneStates($)
  const next = Object.values(all).filter(l => l.phase === 'waiting' && l.after === done)
  for (const n of next) await launchLane($, n.name, n, '')
  for (const name of tpl?.next ?? []) if (!all[name]) await openLanes($, tpl!, [name], undefined)
}

/** The folder is ready; write the task and start the worker on the lane's tier. */
async function launchLane($: $T, name: string, st: LaneState, extra: string) {
  const tpl = (await laneTemplates($))[st.template]
  const task = join(st.dir, 'LANE-TASK.md')
  const body = await laneTask($, tpl, name, st.dir)
  await $.fs.write(task, extra ? `${body}\n\n${extra}\n` : body)
  const run = await workerRun($, { tier: st.tier, private: tpl?.private === true }, body)
  if ('deny' in run) {
    await putLane($, name, { phase: 'failed', note: run.deny })
    return
  }
  const spec: SpawnSpec = { name, cwd: st.dir, task_file: task, brief: task, lane: name, guard: st.guard }
  await putLane($, name, { phase: 'working', tier: st.tier, note: `${CLIS[run.cli].label} ${run.model}` })
  await bumpCredit($, run.cli)
  enqueue({ kind: 'spawn', request: { name, cli: run.cli, model: run.model, effort: run.effort, brief: task, dir: st.dir, spec, route: run.route } })
}

async function laneTask($: $T, tpl: LaneTemplate | undefined, name: string, dir: string) {
  let task = tpl?.task ?? ''
  if (task && !task.includes('\n') && (await $.fs.exists(task).catch(() => false))) task = await readText($, task)
  return task.replace(/\{NAME\}/g, name).replace(/\{WT\}/g, dir).replace(/\{BRANCH\}/g, `lane/${name}`)
}

/** Opens lanes from a template: worktree, linked folders, task file, worker. Returns one line per lane. */
async function openLanes($: $T, tpl: LaneTemplate, names: string[], after: string | undefined): Promise<string[]> {
  const lines: string[] = []
  const all = await laneStates($)
  for (const name of names) {
    const dir = tpl.path.replace(/\{NAME\}/g, name)
    try {
      if (!(await $.fs.exists(dir))) {
        const r = await $.process.run(['git', '-C', tpl.repo, 'worktree', 'add', '--detach', dir, tpl.ref ?? 'HEAD'], { timeoutMs: 120000 })
        if (r.exitCode !== 0) throw new Error(oneLine(r.stderr || r.stdout, 160))
      }
      for (const l of tpl.link ?? []) {
        const to = join(dir, l)
        if (await $.fs.exists(to)) continue
        const from = join(tpl.repo, l)
        await $.process.run(isWindows() ? ['cmd', '/d', '/c', 'mklink', '/J', to, from] : ['ln', '-s', from, to], { timeoutMs: 30000 })
      }
    } catch (err) {
      lines.push(L(`${name}: could not open the folder (${err instanceof Error ? err.message : String(err)})`, `${name}: klasör açılamadı (${err instanceof Error ? err.message : String(err)})`))
      continue
    }
    const st: LaneState = { name, template: tpl.name, dir, tier: tpl.tier ?? 'orta', fails: 0, checks: [], guard: tpl.guard ?? [], guardHits: [], after, phase: after ? 'waiting' : 'working', note: after ? L(`starts when ${after} is done`, `${after} bitince başlar`) : '' }
    all[name] = st
    await laneSet($, LANE_KEYS.state, all)
    if (after) lines.push(L(`${name}: will start when ${after} is done`, `${name}: ${after} bitince başlayacak`))
    else {
      await launchLane($, name, st, '')
      lines.push(L(`${name}: opened (${dir}) · ${(await laneStates($))[name]?.note ?? ''}`, `${name}: açıldı (${dir}) · ${(await laneStates($))[name]?.note ?? ''}`))
    }
  }
  return lines
}

/** One use is counted against the CLI's credit, if the owner set one. */
async function bumpCredit($: $T, cli: string) {
  const credits = await laneGet<Record<string, Credit>>($, LANE_KEYS.credits, {})
  if (!credits[cli]) return
  credits[cli] = { ...credits[cli]!, used: credits[cli]!.used + 1 }
  await laneSet($, LANE_KEYS.credits, credits)
}

/** The guard for output seen while a lane's worker runs: a line that writes to a protected file stops it at once. */
async function laneGuardLine($: $T, worker: SquadWorker, lines: string[]) {
  if (!worker.guard?.length) return
  for (const l of lines) {
    if (!/\b(edit|edited|write|wrote|modif|creat|updat|delet|remov|patch|düzenle|yaz|sil)/i.test(l)) continue
    for (const f of l.match(FILE_RE) ?? []) {
      const p = hitsGuard(f, worker.guard)
      if (!p) continue
      if (worker.lane) await putLane($, worker.lane, { phase: 'stopped', note: L('do-not-touch list', 'dokunma listesi'), guardHits: [`${f} (${p})`] })
      raise(`guard:${worker.id}`, L(`⛔ ${worker.name} touched the do-not-touch list: ${f} (${p}); stopped`, `⛔ ${worker.name} dokunma listesine girdi: ${f} (${p}); durduruldu`), true, await $.clock.now())
      await stopAgent($, worker.id)
      return
    }
  }
}

/** Processes a finished lane left behind (vitest, tsc, eslint, node) in its folder. */
async function cleanLaneProcesses($: $T): Promise<number> {
  if (!isWindows()) return 0
  const { value: ws = [] } = await $.state.get(WORKERS)
  const busy = new Set(ws.filter(w => w.status === 'running' && w.dir).map(w => String(w.dir).toLowerCase().replace(/\//g, '\\')))
  const dirs = Object.values(await laneStates($)).map(l => l.dir.toLowerCase().replace(/\//g, '\\')).filter(d => !busy.has(d))
  if (!dirs.length) return 0
  const snap = await snapshot($)
  if (!snap?.full) return 0
  let n = 0
  for (const p of snap.procs) {
    const c = p.cmd.toLowerCase().replace(/\//g, '\\')
    if (!/^node\.exe$/i.test(p.name) || !/vitest|tsc|eslint|tsserver/.test(c) || !dirs.some(d => c.includes(d))) continue
    const r = await $.process.run(['taskkill', '/PID', String(p.pid), '/F'], { timeoutMs: 20000 }).catch(() => null)
    if (r?.exitCode === 0) n++
  }
  return n
}

async function laneReportFor($: $T, name: string): Promise<string> {
  const st = (await laneStates($))[name]
  if (!st) return `No lane named ${name}.`
  const tpl = (await laneTemplates($))[st.template]
  const { value: ws = [] } = await $.state.get(WORKERS)
  const w = ws.filter(x => x.lane === name).pop()
  const stat = await $.process.run(['git', '-C', st.dir, 'diff', '--shortstat', 'HEAD'], { timeoutMs: 30000 }).catch(() => null)
  const s = stat?.stdout ?? ''
  const num = (re: RegExp) => Number(s.match(re)?.[1] ?? 0)
  const report = w?.report ?? ''
  return laneReport(st, { files: num(/(\d+) files? changed/), added: num(/(\d+) insertions?/), removed: num(/(\d+) deletions?/), report, skipped: skippedFrom(report), columns: (tpl?.checks ?? []).map(c => c.name), branch: `lane/${name}` })
}

async function laneTableText($: $T): Promise<string> {
  const states = Object.values(await laneStates($))
  const { value: ws = [] } = await $.state.get(WORKERS)
  const live = states.map(s => {
    const w = ws.filter(x => x.lane === s.name).pop()
    return w && (w.status === 'failed' || w.status === 'stopped') && s.phase === 'working' ? { ...s, phase: w.status === 'failed' ? ('failed' as const) : ('stopped' as const) } : w?.status === 'running' && s.phase === 'working' ? { ...s, note: `${s.note ? `${s.note} · ` : ''}${w.now}` } : s
  })
  const tpls = await laneTemplates($)
  const cols = [...new Set(live.flatMap(s => (tpls[s.template]?.checks ?? []).map(c => c.name)))]
  const now = await $.clock.now()
  const credits = Object.values(await laneGet<Record<string, Credit>>($, LANE_KEYS.credits, {}))
  const creditText = credits.map(c => creditLine(c, cliLimitedUntil.get(c.cli), now)).join('\n')
  const limited = [...cliLimitedUntil].filter(([c, u]) => u > now && !c.includes('/') && !credits.some(x => x.cli === c)).map(([c]) => L(`${CLIS[normalizeCli(c)].label}: limit reached, moved to a lower route`, `${CLIS[normalizeCli(c)].label}: limit doldu, bir alt rotaya geçildi`)).join('\n')
  const flow = flowText(live)
  const zenText = zenLine(await zenRecord($), now)
  return [checkTable(live, cols), flow && L(`\nFlow:\n${flow}`, `\nAkış:\n${flow}`), creditText && L(`\nCredit:\n${creditText}`, `\nKredi:\n${creditText}`), limited && `\n${limited}`, zenText && `\n${zenText}`].filter(Boolean).join('\n')
}

// ---------- locks and the shared ceiling ----------
const lockPath = async ($: $T, name: string) => join(await hqDir($), 'locks', `${name.replace(/[^\w.-]+/g, '_')}.json`)

/** Who holds a lock now; a holder that stopped refreshing it for three minutes no longer does. */
async function lockHolder($: $T, name: string): Promise<{ sid: string; workerId: string; at: number } | null> {
  try {
    const raw = await readText($, await lockPath($, name))
    if (!raw.trim()) return null
    const held = JSON.parse(raw) as { sid: string; workerId: string; at: number }
    return (await $.clock.now()) - held.at > 3 * 60000 ? null : held
  } catch {
    return null
  }
}

async function takeLocks($: $T, w: SquadWorker) {
  for (const name of w.locks ?? []) await $.fs.write(await lockPath($, name), asciiJson({ sid, workerId: w.id, at: await $.clock.now() }))
}
async function releaseLocks($: $T, w: SquadWorker) {
  for (const name of w.locks ?? []) {
    const held = await lockHolder($, name)
    if (!held || held.workerId === w.id) await $.fs.write(await lockPath($, name), '')
  }
}
/** Running workers keep their locks fresh. */
async function refreshLocks($: $T) {
  const { value: ws = [] } = await $.state.get(WORKERS)
  for (const w of ws.filter(x => x.status === 'running' && x.locks?.length)) await takeLocks($, w)
}

/** Headless workers running across every chat on this computer (from their cards), this one included. */
async function runningEverywhere($: $T) {
  await readCards($)
  const now = await $.clock.now()
  const { value: ws = [] } = await $.state.get(WORKERS)
  const mine = ws.filter(w => w.status === 'running').length
  return mine + hqCards.filter(c => c.sid !== sid && now - c.updatedAt < 2 * 60000).reduce((n, c) => n + (c.cliRunning ?? 0), 0)
}

/** A spec as the spawn job carries it. */
function specToRequest(s: SpawnSpec): SpawnRequest {
  const cli = normalizeCli(s.cli ?? 'devin')
  const effIdx = s.effort ? EFFORTS.indexOf(s.effort as (typeof EFFORTS)[number]) : 2
  return { name: s.name ?? `${CLIS[cli].label}-${newId().slice(0, 4)}`, cli, model: s.model ?? modelsOf(cli)[0] ?? '', effort: effIdx < 0 ? 2 : effIdx, brief: s.brief ?? s.task_file ?? s.task?.slice(0, 80) ?? '', dir: s.cwd, spec: s }
}

// ---------- the live page: one private claude.ai page per person, every session on it, commands back ----------
let liveUrl = ''
let sid = ''
let sessionStartedAt = 0
/** Each page document's version as last read or written (sessions/<sid>): a write must name it, or the page refuses. */
const docVersions = new Map<string, number>()
let lastLiveJson = ''
let lastLiveAt = 0
let liveBusy = false
let liveError = ''
const LIVE_RULES = { rules: [{ path: 'sessions', read: 'owner', write: 'owner' }, { path: 'commands', read: 'owner', write: 'owner' }] }
const ARTIFACT_URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/

/** One call of a session tool from the plugin (no model turn, no model tokens); answers its text. */
async function toolText($: $T, tool: string, input: Record<string, unknown>): Promise<string> {
  const r = (await $.tool.call({ tool, ...input } as never)) as { deny?: string; text?: string; result?: unknown; isError?: boolean }
  if (r.deny) throw new Error(r.deny)
  const text = r.text ?? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''))
  if (r.isError) throw new Error(oneLine(text, 200))
  return text
}
const artifactData = ($: $T, input: Record<string, unknown>) => toolText($, 'ArtifactData', input)

/** The documents a list or query read returned: one JSON object per line. */
export function parseDocs(text: string): { id: string; data: Record<string, unknown>; version: number }[] {
  return text
    .split('\n')
    .filter(l => l.startsWith('{"id"'))
    .flatMap(l => {
      try {
        return [JSON.parse(l) as { id: string; data: Record<string, unknown>; version: number }]
      } catch {
        return []
      }
    })
}

/**
 * Makes sure this person has their live page: published once from the template the plugin ships
 * (so no model writes it), pinned to their claude.ai sidebar, and republished when the template changes.
 */
const LIVE_NEEDS = 'The live page needs'
/** Why /live cannot publish or sync here: said out loud instead of a silent return. */
export function missingLiveToolsMessage(names: string[]): string {
  const missing = ['Artifact', 'ArtifactData'].filter(n => !names.includes(n))
  return `${LIVE_NEEDS} ${missing.join(' and ')} (sign in to claude.ai in this session).`
}

/** The page link kept across /live off and a reinstall: the stored one, else the backup. */
export function pickLiveUrl(opt_: string, stored: string, backup: string): string {
  return opt_ || stored || backup
}

async function ensureLivePage($: $T, force = false): Promise<string> {
  if (opt('live_page') === 'off' && !force) return liveUrl
  if (!force && !liveUrl && !(await $.store.get('liveWanted'))) return liveUrl
  liveUrl = pickLiveUrl(opt('live_url'), String((await $.store.get('liveUrl')) ?? ''), String((await $.store.get('liveUrlBackup')) ?? ''))
  const builtFrom = String((await $.store.get('liveTemplate')) ?? '')
  if (liveUrl && builtFrom === LIVE_TEMPLATE_VERSION && !force) return liveUrl
  try {
    const names = (await $.tool.list()).map(t => t.name)
    if (!names.includes('Artifact') || !names.includes('ArtifactData')) throw new Error(missingLiveToolsMessage(names)) // no claude.ai login here: no page
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(LIVE_NEEDS)) throw err
    return liveUrl
  }
  const file = `${cwd || '.'}/.squad/live/the-chief-live.html`
  await $.fs.write(file, LIVE_TEMPLATE)
  const text = await toolText($, 'Artifact', {
    action: 'publish',
    file_path: file,
    ...(liveUrl ? { url: liveUrl } : { icon: 'dashboard', pin: true }),
    description: 'The Chief, live: every Claude Code session, its agents, overviews, squads and goals, with control sent back to your computer.',
    capabilities: { db: LIVE_RULES, user: {} },
  })
  const url = text.match(ARTIFACT_URL_RE)?.[0]
  if (!url) throw new Error(oneLine(text, 160))
  liveUrl = url
  docVersions.clear()
  lastLiveJson = ''
  await storeSet($, 'liveUrl', liveUrl)
  await storeSet($, 'liveUrlBackup', liveUrl)
  await storeSet($, 'liveTemplate', LIVE_TEMPLATE_VERSION)
  return liveUrl
}

async function buildSnapshot($: $T) {
  const { value: ws = [] } = await $.state.get(WORKERS)
  const { value: ss = [] } = await $.state.get(SUBS)
  const { value: ls = [] } = await $.state.get(LANES)
  const { value: gs = [] } = await $.state.get(GOALS)
  const { value: rs = [] } = await $.state.get(REPORTS)
  const { value: busy = false } = await $.state.get(SUMMARIZING)
  const providers: Record<string, { label: string; models: string[]; efforts: number }> = {}
  for (const c of CLI_ORDER) providers[c] = { label: CLIS[c].label, models: modelsOf(c), efforts: CLIS[c].efforts }
  return {
    project: baseName(cwd) || 'session',
    startedAt: sessionStartedAt,
    workers: ws.map(w => ({ id: w.id, name: w.name, cli: w.cli, cliLabel: CLIS[w.cli].label, model: shortModel(w.model), effort: w.effort, brief: w.brief, status: w.status, startedAt: w.startedAt, endedAt: w.endedAt, now: w.now, files: w.files, tail: w.tail.slice(-14) })),
    subs: ss.map(s => ({ id: s.id, description: s.description, type: s.type, model: shortModel(s.model), status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, tools: s.tools, steps: s.steps.slice(-8), files: s.files, result: s.result.slice(0, 1500) })),
    ext: extAgents.map(a => ({ id: `ext:${a.pid}`, cli: a.cli, name: a.name, model: a.model, startedAt: a.since, endedAt: a.until, now: a.now })),
    spend: { usd: Math.round(spentUsd * 100) / 100, tokens: spentTokens },
    lanes: ls,
    goals: gs,
    reports: [...rs].sort((a, b) => b.at - a.at).slice(0, 30),
    role,
    chiefs: role === 'leader' ? hqCards.filter(c => c.role === 'chief' && c.leader === sid).map(c => ({ sid: c.sid, title: titleOf(c), goal: c.goal, model: c.model ? shortModel(c.model) : '', effort: c.effort, working: c.working, agents: c.agents, brief: c.brief, startedAt: c.startedAt, updatedAt: c.updatedAt })) : [],
    providers,
    isSummarizing: busy,
  }
}

/** The version a page document is at now (0 when it does not exist yet). */
async function docVersion($: $T, doc: string): Promise<number> {
  const got = await artifactData($, { action: 'get', url: liveUrl, collection: 'sessions', doc_id: doc })
  const m = got.match(/"version":(\d+)/)
  return m ? Number(m[1]) : 0
}
/**
 * Writes one chat's snapshot to the page. The page refuses a write that does not name the document's current
 * version, and another chat may have written it last (a writer that changed hands): on a refusal the version is
 * read again and the write tried once more.
 */
async function writeDoc($: $T, doc: string, data: Record<string, unknown>) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!docVersions.has(doc)) docVersions.set(doc, await docVersion($, doc))
    const known = docVersions.get(doc) ?? 0
    const text = await artifactData($, { action: 'set', url: liveUrl, collection: 'sessions', doc_id: doc, data, ...(known ? { if_version: known } : {}) }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    const v = text.match(/version (\d+)/i)
    if (v && /committed/i.test(text)) {
      docVersions.set(doc, Number(v[1]))
      return
    }
    docVersions.delete(doc)
    if (attempt === 1 || !/version_mismatch|already exists|version/i.test(text)) throw new Error(oneLine(text, 160))
  }
}
async function writeSnapshot($: $T, data: Record<string, unknown>) {
  await writeDoc($, sid, data)
}

/** Runs one command the page left, after checking its shape: the page is the owner's, but its rows are still input. */
async function runCommand($: $T, kind: string, args: Record<string, unknown>) {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const { value: goalList = [] } = await $.state.get(GOALS)
  const goal = goalList.find(g => g.id === str('id'))
  switch (kind) {
    case 'overview':
      enqueue({ kind: 'overview', report: 'manual', scope: str('scope') === 'session' ? 'session' : 'today' })
      return
    case 'chief_message':
      if (role === 'leader' && str('sid') && str('text')) await sendTo($, str('sid'), 'message', { text: str('text') })
      return
    case 'report_remove':
      if (str('id')) await removeReport($, str('id'))
      return
    case 'stop':
      $.ui.toast(await stopAgent($, str('agent')))
      return
    case 'message':
      if (str('text').trim()) $.ui.toast(await messageAgent($, str('agent'), str('text').trim().slice(0, 4000)))
      return
    case 'launch': {
      const lanesArg = Array.isArray(args.lanes) ? (args.lanes as unknown[]).filter((x): x is string => typeof x === 'string') : null
      await launch($, lanesArg, true)
      return
    }
    case 'lane_patch': {
      const p = (args.patch ?? {}) as Record<string, unknown>
      const patch: Partial<SquadLane> = {}
      if (typeof p.task === 'string') patch.task = p.task.slice(0, 300)
      if (typeof p.cli === 'string') {
        patch.cli = normalizeCli(p.cli)
        patch.model = modelsOf(patch.cli)[0] ?? ''
      }
      if (typeof p.model === 'string') patch.model = p.model.slice(0, 120)
      if (typeof p.effort === 'number') patch.effort = clamp(Math.round(p.effort), 0, EFFORTS.length - 1)
      if (typeof p.count === 'number') patch.count = clamp(Math.round(p.count), 1, MAX_AGENTS)
      await patchLane($, str('id'), patch)
      return
    }
    case 'goal_add':
      if (str('text').trim()) await mutateGoals($, l => [{ id: newId(), text: str('text').trim().slice(0, 500), status: 'open' }, ...l])
      return
    case 'goal_here':
      if (goal) await startGoal($, goal, 'here', 'mobile')
      return
    case 'goal_status':
      if (goal) await mutateGoals($, l => l.map(x => (x.id === goal.id ? { ...x, status: str('status') === 'done' ? 'done' : 'open' } : x)))
      return
    case 'goal_remove':
      if (goal) await mutateGoals($, l => l.filter(x => x.id !== goal.id))
      return
  }
}

/** Every few seconds: mirror the state when it changed (or as a heartbeat), then run what the page asked for. */
/** When this chat's own model last took a turn. */
let lastTurnAt = 0
let lastLiveTickAt = 0
let lastHqTickAt = 0
/** No agents, nothing queued and no turn for 15 minutes: the background work slows to a crawl. */
async function isDormant($: $T) {
  if (role === 'leader' || launchQueue.length > 0 || (await anyRunning($))) return false
  return (await $.clock.now()) - Math.max(lastTurnAt, lastCommandAt, sessionStartedAt) > 15 * 60000
}

let lastLiveKey = ''
let lastCommandAt = 0
let lastCommandPoll = 0

/** A writer that has not renewed its claim for this long has gone; another chat takes the page over. */
const LIVE_WRITER_STALE_MS = 20_000
/**
 * Whether this chat writes the phone page. Writing artifact data needs the owner's approval once per chat, so one
 * chat on the computer does it (a leader before any other, since it lives longest) and the rest hand it their
 * snapshot through a local file.
 */
export function liveWriterIs(current: { sid: string; at: number; leader?: boolean } | null, me: { sid: string; leader: boolean }, now: number): boolean {
  if (!current || current.sid === me.sid || now - current.at > LIVE_WRITER_STALE_MS) return true
  return me.leader && !current.leader
}
async function claimLiveWriter($: $T): Promise<boolean> {
  const file = join(await hqDir($), 'live', 'writer.json')
  const now = await $.clock.now()
  let current: { sid: string; at: number; leader?: boolean } | null = null
  try {
    current = JSON.parse(await $.fs.read(file)) as { sid: string; at: number; leader?: boolean }
  } catch {
    current = null
  }
  if (!liveWriterIs(current, { sid, leader: role === 'leader' }, now)) return false
  // no shared folder to claim in: this chat writes the page itself, as before
  await $.fs.write(file, JSON.stringify({ sid, at: now, leader: role === 'leader' })).catch(() => undefined)
  return true
}
/** What the writer last put on the page for each other chat, so an unchanged snapshot is not sent again. */
const relayed = new Map<string, string>()
async function relayOthers($: $T) {
  const dir = join(await hqDir($), 'live', 'sessions')
  const now = await $.clock.now()
  let entries: { name: string; kind: string }[] = []
  try {
    entries = (await $.fs.list(dir)).filter(x => x.kind === 'file' && x.name.endsWith('.json'))
  } catch {
    return
  }
  for (const entry of entries) {
    const other = entry.name.slice(0, -5)
    if (other === sid) continue
    const path = join(dir, entry.name)
    const { mtimeMs } = await $.fs.stat(path).catch(() => ({ mtimeMs: 0 }))
    if (now - mtimeMs > 10 * 60000) continue
    const text = await $.fs.read(path).catch(() => '')
    if (!text || relayed.get(other) === text) continue
    await writeDoc($, other, JSON.parse(text) as Record<string, unknown>)
    relayed.set(other, text)
  }
}

async function liveTick($: $T) {
  if (!liveUrl || !sid || liveBusy) return
  // dormant: once a minute instead of every 4 s
  if ((await isDormant($)) && (await $.clock.now()) - lastLiveTickAt < 60000) return
  lastLiveTickAt = await $.clock.now()
  liveBusy = true
  try {
    const now = await $.clock.now()
    const writer = await claimLiveWriter($)
    // the snapshot is rebuilt only when a piece of state moved (each carries a version), or for the heartbeat
    const versions = [
      (await $.state.get(WORKERS)).version,
      (await $.state.get(SUBS)).version,
      (await $.state.get(LANES)).version,
      (await $.state.get(GOALS)).version,
      (await $.state.get(REPORTS)).version,
      (await $.state.get(SUMMARIZING)).version,
    ]
    const key = `${versions.join('.')}|${role}|${lastCardsRead}`
    const quietFor = now - lastCommandAt
    if (key !== lastLiveKey || lastLiveJson === '' || now - lastLiveAt > (quietFor > 180000 ? 60000 : 30000)) {
      const snap = await buildSnapshot($)
      const json = JSON.stringify(snap)
      if (json !== lastLiveJson || now - lastLiveAt > 30000) {
        if (writer) await writeSnapshot($, { ...snap, updatedAt: now })
        else await $.fs.write(join(await hqDir($), 'live', 'sessions', `${sid}.json`), JSON.stringify({ ...snap, updatedAt: now }))
        lastLiveJson = json
        lastLiveAt = now
      }
      lastLiveKey = key
    }
    // only the writer talks to the page: the others are done once their snapshot is on disk
    if (!writer) return
    await relayOthers($)
    // commands: every tick for three minutes after the phone sent one, else every 20 s
    if (quietFor > 180000 && now - lastCommandPoll < 20000) return
    lastCommandPoll = now
    // every chat's commands come through the writer: its own run here, the others go to their inbox
    const listed = await artifactData($, { action: 'list', url: liveUrl, collection: 'commands' })
    for (const doc of parseDocs(listed)) {
      lastCommandAt = now
      await artifactData($, { action: 'delete', url: liveUrl, collection: 'commands', doc_id: doc.id, if_version: doc.version })
      const target = String(doc.data.session ?? sid)
      if (target === sid) {
        await runCommand($, String(doc.data.kind ?? ''), (doc.data.args ?? {}) as Record<string, unknown>)
        lastLiveJson = '' // show the result on the page at once
      } else await sendTo($, target, 'live-command', { kind: doc.data.kind, args: doc.data.args ?? {} })
    }
    liveError = ''
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg !== liveError) $.ui.toast(`Live page: ${oneLine(msg, 120)}`)
    liveError = msg
  } finally {
    liveBusy = false
  }
}

/** Opens a pane where the surface draws panes; the phone may not, and the command's text answers there. */
async function tryOpen($: $T, which: 'chief') {
  try {
    await openPane($)
  } catch {
    // the text answer still shows
  }
}

/** The agents, as a chat row: what works where no pane is drawn. */
async function agentsText($: $T): Promise<string> {
  if (role === 'leader') {
    await readCards($)
    const main = await mainGoalText($)
    return `**★ Leader of Chiefs**${main ? ` · ana hedef: ${main}` : ''}\n\n${chiefsText(await $.clock.now())}`
  }
  const { value: ws = [] } = await $.state.get(WORKERS)
  const { value: ss = [] } = await $.state.get(SUBS)
  const { value: gs = [] } = await $.state.get(GOALS)
  const now = await $.clock.now()
  const mark = (st: string) => (st === 'running' ? '●' : st === 'done' ? '✓' : st === 'stopped' ? '■' : '✗')
  const rows = [
    ...ws.map(w => `${mark(w.status)} **${w.name}** · ${CLIS[w.cli].label} ${shortModel(w.model)} · ${fmtElapsed((w.endedAt ?? now) - w.startedAt)}\n  ${w.now || w.tail[w.tail.length - 1] || ''}`),
    ...ss.map(s => `${mark(s.status)} **${s.description || s.type}** · subagent · ${fmtElapsed((s.endedAt ?? now) - s.startedAt)}\n  ${s.status === 'running' ? s.steps[s.steps.length - 1] ?? '' : oneLine(s.result, 100)}`),
  ]
  const working = ws.filter(w => w.status === 'running').length + ss.filter(s => s.status === 'running').length
  const goal = gs.find(g => g.status === 'active')
  return [
    `**The Chief** · ● ${working} working · ✓ ${rows.length - working} finished`,
    goal ? `Goal: ${goal.text}` : '',
    rows.length ? rows.join('\n') : 'No agents yet. /squad launch all starts every lane.',
    'Commands: /squad · /squad launch <n|all> · /goals · /overview',
  ].filter(Boolean).join('\n\n')
}

function goalsText(list: readonly SquadGoal[]): string {
  if (list.length === 0) return 'No goals yet. Add one: /goals add <goal>'
  const mark = (g: SquadGoal) => (g.status === 'active' ? '●' : g.status === 'done' ? '✓' : '○')
  return [
    '**Goals**',
    list.map((g, i) => `${i + 1}. ${mark(g)} ${g.text}`).join('\n'),
    'Commands: /goals add <goal> · /goals start <n> · /goals done <n> · /goals remove <n>',
  ].join('\n\n')
}

function lanesText(list: readonly SquadLane[]): string {
  if (list.length === 0) return 'No lanes yet; add them in The Chief → Squad.'
  const total = list.reduce((s, l) => s + l.count, 0)
  return [
    `**Squad** · ${plural(total, 'agent')} in ${plural(list.length, 'lane')}`,
    list.map((l, i) => {
      const eff = effortName(l.cli, l.effort)
      return `${i + 1}. ${l.task || '(no task)'}\n   ${l.count} × ${CLIS[l.cli].label} ${shortModel(l.model)}${eff ? ` · ${eff}` : ''}`
    }).join('\n'),
    'Commands: /squad launch <n> · /squad launch all',
  ].join('\n\n')
}

function fmtElapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

function fmtAgo(ms: number) {
  const m = Math.round(ms / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

/** Starts one spawn_worker call (a queued one too, when its turn comes). */
async function startSpawn($: $T, a: Record<string, unknown>): Promise<{ deny: string } | { result: string }> {
    const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)
    const name = str('name')
    const brief = str('brief') ?? str('task_file') ?? (str('task') ? oneLine(str('task')!, 80) : undefined) ?? str('header_file')
    if (!name || !brief) return { deny: 'name and one of brief, task, task_file or header_file are required' }
   const run = await workerRun($, a, await briefText($, a))
    if ('deny' in run) return run
    const { cli, model, effort, note, route } = run
    const obj = <T,>(k: string) => (a[k] && typeof a[k] === 'object' ? (a[k] as T) : undefined)
    const spec: SpawnSpec = {
      name,
      brief: str('brief'),
      header_file: str('header_file'),
      task: str('task'),
      task_file: str('task_file'),
      vars: obj<Record<string, string>>('vars'),
      cwd: str('cwd'),
      worktree: obj<SpawnSpec['worktree']>('worktree'),
      env: obj<Record<string, string>>('env'),
      done_when_file: str('done_when_file'),
      locks: Array.isArray(a.locks) ? (a.locks as unknown[]).map(String) : undefined,
      next: Array.isArray(a.next) ? (a.next as ChainRule[]) : undefined,
      detach: typeof a.detach === 'boolean' ? a.detach : undefined,
      permission_mode: str('permission_mode'),
    }
    enqueue({ kind: 'spawn', request: { name, cli, model, effort, brief, dir: str('cwd'), spec, route } })
    const eff = effortName(cli, effort)
    return text(`Starting ${name}: ${CLIS[cli].label} ${model}${eff ? ` · effort ${eff}` : ''}${note ? ` (${note})` : ''}${str('cwd') ? ` in ${str('cwd')}` : ''}${DETACHABLE[cli] && a.detach !== false ? ' (detached: survives an app restart)' : ''}. The prompt sent is saved beside its log; you are told when it ${str('done_when_file') ? `writes ${str('done_when_file')}` : 'finishes'}.`)
}

/** Briefs this chat lined up with spawn_worker queue:true: each starts the moment one of its workers ends, without a turn. */
let backlog: Record<string, unknown>[] = []
/** This chat's running and queued (waiting for RAM) workers. */
async function runningHere($: $T) {
  const { value: ws = [] } = await $.state.get(WORKERS)
  return ws.filter(w => w.status === 'running' || w.status === 'queued').length
}
/** Starts the next lined-up brief: one per ended worker, or one when nothing runs here at all. */
async function startBacklog($: $T, ended: boolean) {
  if (backlog.length === 0 || (!ended && (await runningHere($)) > 0)) return
  const [next, ...rest] = backlog
  backlog = rest
  await storeSet($, `backlog:${sid}`, backlog).catch(() => undefined)
  const r = await startSpawn($, next!).catch(err => ({ deny: err instanceof Error ? err.message : String(err) }))
  if ('deny' in r) raise(`backlog:${String(next!.name)}`, L(`! could not start the next one, ${String(next!.name)}: ${oneLine(r.deny, 160)}`, `! sıradaki ${String(next!.name)} başlatılamadı: ${oneLine(r.deny, 160)}`), true, await $.clock.now())
}

const text = (t: string) => ({ result: t })

export const register: Register = (on, options) => {
  registerThemes(on)
  opts = options ?? {}
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    // only the bootstrap run that makes a chief's session is silent; the desktop app is an SDK host
    // (isInteractive false, no surface at start) yet a chat a person uses
    interactive = (await $.env.get('THE_CHIEF_BOOTSTRAP').catch(() => undefined)) !== '1'
    isWorker = (await $.env.get('THE_CHIEF_WORKER').catch(() => undefined)) === '1'
    // a chat a person uses gets the saved backdrop first, before anything else, so it comes without delay
    if (interactive && !isWorker) await startTheme($).catch(() => undefined)
    await decideLang($).catch(() => undefined)
    // a store the engine cannot read (a crash left it NUL bytes, 18.10) makes every store call throw: the start was
    // skipped and no role, tick or card came, silently, through three restarts. Now the owner is told at once
    const probe = () =>
      $.store.get('mainGoal').then(
        () => '',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      )
    let storeBad = await probe()
    // written back from hq/store-backup (or the engine's own leftover .tmp copy), then tried once more
    if (storeBad && (await restoreStores($).catch(() => [] as string[])).length) {
      storeBad = await probe()
      if (!storeBad) void $.ui.toast(L('The Chief: restored the broken plugin store from its backup', 'The Chief: bozuk eklenti kaydı yedekten geri yüklendi')).catch(() => undefined)
    }
    if (storeBad) {
      void $.ui.toast(L(`The Chief could not start: the plugin store cannot be read and has no backup (${oneLine(storeBad, 80)}). the-chief_*.json in ~/.claude/plugins/store is broken.`, `The Chief başlayamadı: eklenti kaydı okunamıyor ve yedeği yok (${oneLine(storeBad, 80)}). ~/.claude/plugins/store içindeki the-chief_*.json bozuk.`)).catch(() => undefined)
      await registerChiefTools($).catch(() => undefined)
      return next(e)
    }
    void (async () => {
      for (;;) {
        while (queue.length > 0) {
          const job = queue.shift()!
          if (job.kind === 'spawn') void spawnWorker($, job.request).catch(() => undefined)
          else if (job.kind === 'followup') void followUp($, job.id, job.text).catch(() => undefined)
          else if (job.kind === 'now') void writeNow($, job.id).catch(() => undefined)
          else if (job.kind === 'submit') void submitGuarded($, job.text, job.asUser ?? true).catch(() => undefined)
          else if (job.kind === 'local-setup') void ensureLocalModel($).catch(() => undefined)
          else if (job.kind === 'setup') void firstSetup($, true).catch(() => undefined)
          else if (job.kind === 'context-guard') void contextGuard($).catch(err => noteGuard($, 0, `error: ${err instanceof Error ? oneLine(err.message, 160) : String(err)}`)).catch(() => undefined).then(() => handoffCheck($)).catch(() => undefined)
          else if (job.kind === 'goal') void runGoal($, job.text).catch(() => undefined)
          else if (job.kind === 'consult') void ownerConsult($, job.question, job.panel === true).then(() => {
            consultOpen = 0
            $.ui.toast(L('The consultant answered: The Chief → Consult', 'Danışman cevapladı: The Chief → Danışman'))
          }).catch(() => undefined)
          else if (job.kind === 'logins') void healthCheck($, true).catch(() => undefined)
          else if (job.kind === 'health') void healthCheck($, job.force === true).then(said => { if (job.force) $.ui.log(said) }).catch(() => undefined)
          else if (job.kind === 'done-check') void doneCheckJob($, job).catch(() => undefined)
          else if (job.kind === 'login') void openLogin($, job.cli).catch(() => undefined)
          else if (job.kind === 'handoff') void ownerHandoff($).catch(() => undefined)
          else if (job.kind === 'know') void ownerKnow($).catch(() => undefined)
          else if (job.kind === 'live-setup') void ensureLivePage($).catch(err => $.ui.toast(`Live page: ${err instanceof Error ? oneLine(err.message, 120) : String(err)}`))
          else void makeOverview($, job.report, job.day, job.scope).catch(() => $.state.set(SUMMARIZING, false))
        }
        await new Promise<void>(resolve => {
          wake = resolve
        })
        wake = null
      }
    })()
    // keep elapsed times live, and refresh each running worker's plain status when its output moved
    $.clock.every(10000, () => void anyRunning($).then(busy => (busy ? update($, tick, n => (n ?? 0) + 1) : undefined)))
    if (interactive && !isWorker) $.clock.every(10000, () => void syncCrewStatus($).catch(() => undefined))
    $.clock.every(60000, () =>
      void $.state.get(WORKERS).then(({ value = [] }) => {
        const live = value.filter(w => w.status === 'running')
        const every = live.length > 4 ? 2 : 1
        nowRound++
        for (const w of live) if (nowRound % every === 0 && w.tail.length > (nowAt.get(w.id) ?? 0) + 2) enqueue({ kind: 'now', id: w.id })
      }),
    )
    $.clock.every(30000, () => void watchdog($).catch(() => undefined))
    $.clock.every(15000, () => void (launchQueue.length > 0 ? drainQueue($).catch(() => undefined) : undefined))
    // lined-up briefs left over (a reload, a worker that ended before this chat came back) start when nothing runs here
    $.clock.every(15000, () => void (backlog.length > 0 ? startBacklog($, false).catch(() => undefined) : undefined))

    $.clock.every(5 * 60000, () => void dailyCheck($).catch(() => undefined))
    // Zen's free models 2-3 times a day: the scan stores them with their health, and the route table reads that store
    $.clock.every(10 * 60000, () => void (!isWorker ? zenRefresh($).catch(() => undefined) : undefined))
    $.clock.every(60000, () => void (interactive && !isWorker ? sweepLocks($).catch(() => undefined) : undefined))
    $.clock.every(5 * 60000, () => void coldGuard($).catch(() => undefined))
    // a whole copy of every store, so a crash that zeroes one is undone at the next start (workers never back up)
    $.clock.every(30 * 60000, () => void (interactive && !isWorker ? backupStores($).catch(() => undefined) : undefined))
    // keys of chats gone for 14 days (the store was 5600 keys / 2.6 MB of 4 MiB on 21.11); one chat an hour does it
    $.clock.every(60 * 60000, () => void (interactive && !isWorker ? pruneOld($).catch(() => undefined) : undefined))
    void $.clock.sleep(60000).then(() => (interactive && !isWorker ? pruneOld($) : undefined)).catch(() => undefined)
    // detached jobs this chat started: told when they end; the leader runs the merge train
    $.clock.every(15000, () => void (!isWorker ? pollJobs($).catch(() => undefined) : undefined))
    let trainBusy = false
    $.clock.every(60000, () => {
      if (trainBusy || isWorker) return
      trainBusy = true
      void trainTick($).catch(() => undefined).finally(() => (trainBusy = false))
    })
    // chiefs on the Mac push their reports to a git branch; the leader reads them as chief news
    let macBusy = false
    $.clock.every(45000, () => {
      if (macBusy || isWorker) return
      macBusy = true
      void macReportsTick($).catch(() => undefined).then(() => lostRuns($)).catch(() => undefined).then(() => lockAudit($)).catch(() => undefined).finally(() => (macBusy = false))
    })
    // orphaned opencode.exe (parent gone) eat ~500 MB each: killed every 2 minutes, never a worker whose parent lives
    $.clock.every(2 * 60000, () => void (!isWorker ? sweepOrphanOpencode($).catch(() => undefined) : undefined))
    // workers' tsc / vitest / dependency-cruiser wait for a RAM slot machine-wide (one chat runs the gate)
    let gateBusy = false
    $.clock.every(6000, () => {
      if (isWorker || gateBusy) return
      gateBusy = true
      void heavyGateTick($).catch(() => undefined).finally(() => (gateBusy = false))
    })
    // and once a minute while the chat is idle: a missed turn end (a reload mid-turn, a host that never sent it)
    // never leaves a big context uncompacted
    $.clock.every(60000, () => void idleGuard($).catch(() => undefined))
    try {
      sid = await $.session.id()
    } catch {
      sid = `s-${newId()}`
    }
    // the desktop app gives a chat a new engine id each time it reopens it; its own id stays, so roles and links hang on that
    engineSid = sid
    // the app's id holds the role, settings and care counters (a reopen gives a new engine id). In the desktop app it is
    // read from the environment, checked against this engine's own record: the app's tool and the host clock answer only
    // once session.start has returned, so asking the tool here waited on itself and no role, tick or card came (18.10).
    // Outside the app (no variable) the tool answers at once. Unproven here: settleIdentity (every hqTick) asks again
    const hostEnv = await hostEnvId($)
    const app = hostEnv ? await hostSessionId($, hostEnv) : await appSessionId($)
    if (app) {
      sid = app
      idSettled = true
    }
    sessionStartedAt = await $.clock.now()
    void loadLedger($).then(() => refreshBudget($)).catch(() => undefined)
    $.clock.every(60000, () => void refreshBudget($).catch(() => undefined))
    // another chat's fresh reading shows here within seconds: a file read, no model call
    $.clock.every(10000, () => void refreshBudget($).catch(() => undefined))
    lastSurface = String((e as { surface?: string }).surface ?? 'desktop')
    let savedRole = ((await $.store.get(`role:${sid}`).catch(() => undefined)) ?? (await $.store.get(`role:${engineSid}`).catch(() => undefined))) as SavedRole | undefined
    // no role in the store (lost, or never written): the chat's own card still knows it
    let cardConfig: ChiefConfig | undefined
    if (!savedRole?.role) {
      const fromCard = (await roleFromCard($, sid)) ?? (engineSid !== sid ? await roleFromCard($, engineSid) : null)
      if (fromCard) {
        savedRole = fromCard.saved
        cardConfig = fromCard.config
      }
    }
    if (savedRole?.role) {
      role = savedRole.role
      leaderSid = savedRole.leaderSid ?? null
      leaderTitle = savedRole.leaderTitle ?? ''
    }
    const savedBacklog = await $.store.get(`backlog:${sid}`).catch(() => undefined)
    if (Array.isArray(savedBacklog)) backlog = savedBacklog as Record<string, unknown>[]
    const savedConfig = (await $.store.get(`chiefConfig:${sid}`).catch(() => undefined)) ?? (await $.store.get(`chiefConfig:${engineSid}`).catch(() => undefined))
    if (savedConfig && typeof savedConfig === 'object') chiefConfig = savedConfig as ChiefConfig
    else if (cardConfig) chiefConfig = cardConfig
    if (role === 'solo') void recoverRole($).catch(() => undefined)
    else await storeSet($, `role:${sid}`, { role, leaderSid, leaderTitle }).catch(() => undefined)
    // what this chat kept across an undo, a redo or a reload (counters, the anti-thrash size, the tier note, nudges)
    await loadCare($).catch(() => undefined)
    $.clock.every(5000, () => void hqTick($).catch(() => undefined))
    // detached runs: every 2 s while any is open (and once at start, to take back the ones a restart left)
    $.clock.every(2000, () => void (runs.size > 0 || !runsLoaded ? pollRuns($).catch(() => undefined) : undefined))
    $.clock.every(60000, () => void refreshLocks($).catch(() => undefined))
    $.clock.every(30000, () => void (runs.size > 0 ? saveRunWorkers($).catch(() => undefined) : undefined))
    liveUrl = pickLiveUrl(opt('live_url'), String((await $.store.get('liveUrl')) ?? ''), String((await $.store.get('liveUrlBackup')) ?? ''))
    if (liveUrl) await storeSet($, 'liveUrl', liveUrl) // a reinstall or /live off never loses the page
    // the phone page syncs only for someone who asked for it (/live made or set one); nobody else gets background calls
    if (liveUrl) enqueue({ kind: 'live-setup' })
    enqueue({ kind: 'local-setup' })
    // once a day for the whole computer: each CLI says one word, a broken sign-in shows before a job lands on it
    if (interactive && !isWorker) enqueue({ kind: 'health' })
    $.clock.every(4000, () => void liveTick($).catch(() => undefined))
    $.clock.every(30000, () => void keepTools($).catch(() => undefined))
    await $.command.register({ name: 'themes', description: 'The Chief: moving backdrops for the Desktop app (opens the Themes tab)', argumentHint: '[scene] [normal|az|orta|cok] | off' })
    await $.command.register({ name: 'themes-copy', description: 'The Chief: copy the picked theme as DevTools paste code, for every chat in the window (remote ones too)' })
    await $.command.register({ name: 'chief', description: 'The Chief: your agents, overviews and squads' })
    await $.command.register({ name: 'squad', description: 'The Chief: plan and launch agent squads' })
    await $.command.register({ name: 'chief-row', description: L('The Chief: hide the row above the chat for good (on brings it back; also in Settings)', 'The Chief: sohbet üstündeki satırı kalıcı gizle (on geri getirir; Ayarlarda da var)'), argumentHint: '[off|on]' })
    await $.command.register({ name: 'stop-loops', description: 'Stop every loop here: /goal, scheduled /loop and crons, and new wake-ups for 6 hours (a leader stops its chiefs too)' })
    await $.command.register({ name: 'overview', description: 'Write a Sonnet 5.5 summary now and show every past one by date' })
    await $.command.register({ name: 'live', description: 'The Chief on your phone: the link to your live page (made once, pinned in your claude.ai sidebar)' })
    await $.command.register({ name: 'hot-reload', description: 'Reload The Chief in every open session (optionally from a folder with a newer build)', argumentHint: '[<folder>] [force]' })
    await $.command.register({ name: 'leader', description: 'Leader of Chiefs: this chat leads other chats (chiefs), each with its own goal, model, effort and agents', argumentHint: '[off | <main goal>]' })
    await $.command.register({ name: 'chief-check', description: L('The Chief: test every agent CLI with one word now (sign-in, key, credit, limit)', 'The Chief: her ajan CLI\'sini şimdi tek kelimeyle dene (giriş, anahtar, kredi, limit)') })
    await $.command.register({ name: 'chief-sync', description: 'Leader: check and fix pin and Remote Control of every chief chat now' })
    await $.command.register({ name: 'consult', description: L('Ask a consultant: a second opinion from another model (Codex, Devin, Gemini…)', 'Danışmana sor: başka bir modelden (Codex, Devin, Gemini…) ikinci görüş al'), argumentHint: L('[all] <question> | list', '[hepsi] <soru> | list') })
    await $.command.register({ name: 'goals', description: 'Your goals, in every session: start one in a new session as /goal', argumentHint: '[add <goal>]' })
    await registerChiefTools($)
    mainGoalId = String((await $.store.get('mainGoal')) ?? '')
    quiet = (await $.store.get(`quiet:${sid}`)) === true
    const storedModels = await $.store.get('modelCache')
    if (storedModels && typeof storedModels === 'object') modelCache = storedModels as ModelCache
    const storedOverrides = await $.store.get('optOverrides')
    if (storedOverrides && typeof storedOverrides === 'object') optOverrides = storedOverrides as Record<string, string>
    localReady = await $.fs.exists(join(await llmDir($), 'models', `${localModel().file}.done`)).catch(() => false)
    const storedLeaderLanes = await $.store.get('leaderLanes')
    leaderLanes = Array.isArray(storedLeaderLanes) && storedLeaderLanes.length ? (storedLeaderLanes as LeaderLane[]) : [defaultLeaderLane()]
    const storedPending = await $.store.get(`pendingOverviews:${sid}`)
    pendingOverviews = Array.isArray(storedPending) ? (storedPending as typeof pendingOverviews) : []
    const storedLog = await $.store.get(`leaderLog:${sid}`)
    leaderLog = Array.isArray(storedLog) ? (storedLog as typeof leaderLog) : []
    const held = await $.state.get(LANES)
    if (held.version === 0) {
      const stored = await $.store.get('lanes')
      await $.state.set(LANES, Array.isArray(stored) ? (stored as SquadLane[]).map(l => ({ ...l, cli: normalizeCli(l.cli), model: l.model.replace(/^opencode-go\//, '') })) : DEFAULT_LANES)
      const storedGoals = await $.store.get('goals')
      await $.state.set(GOALS, Array.isArray(storedGoals) ? (storedGoals as SquadGoal[]) : [])
      bandControls = (await $.store.get('bandControls')) === true
      const storedSub = (await $.store.get('subControl')) as SquadSubControl | undefined
      if (storedSub && typeof storedSub.model === 'string') {
        subControl = { model: storedSub.model, effort: clamp(Number(storedSub.effort) || 0, 0, EFFORTS.length) }
        await $.state.set(SUB_CONTROL, subControl)
      }
      const storedStamps = await $.store.get(`dayStamps:${sid}`)
      dayStamps = storedStamps && typeof storedStamps === 'object' ? (storedStamps as Record<string, number>) : {}
      const storedReports = await $.store.get('reports')
      await $.state.set(REPORTS, Array.isArray(storedReports) ? (storedReports as SquadReport[]) : [])
    }
    void dailyCheck($).catch(() => undefined)
    return next(e)
  })

  // Every command answers in text too, so it works where panes are not drawn (the phone): the row shows in the chat.
  on('command.run', { command: 'hot-reload' }, async ($, e) => {
    const args = e.args.trim()
    const force = /\bforce\b/i.test(args)
    const folder = args.replace(/\bforce\b/i, '').trim()
    const { value: ws = [] } = await $.state.get(WORKERS)
    const live = ws.filter(w => w.status === 'running').length
    if (live > 0 && !force) return { text: `${live} agent${live === 1 ? '' : 's'} running; a reload would stop them. Wait, or run /hot-reload force.` }
    if (folder) await storeSet($, 'devSource', folder)
    const source = folder || opt('dev_source') || String((await $.store.get('devSource')) ?? '')
    const root = $.plugin.root
    let copied = 0
    if (source && source.replace(/[\\/]+$/, '').toLowerCase() !== root.replace(/[\\/]+$/, '').toLowerCase()) {
      const sep = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}/${b}`
      for (const rel of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx', 'scripts/startup-settings.mjs', 'skills/ponytail/SKILL.md', 'hooks/themes.tsx', 'hooks/scenes.ts', 'hooks/paste-overlay.ts', 'hooks/handoff.ts', 'hooks/tiers.ts', 'hooks/lanes.ts', 'hooks/heavygate.ts', 'hooks/bridge-files.ts', 'hooks/spend.ts', 'hooks/spend-scan.mjs', 'hooks/slider.tsx', 'hooks/live-template.ts', 'types/index.d.ts', 'live/the-chief-live.html']) {
        try {
          const text = await readText($, sep(source, rel))
          if (!text) continue
          await $.fs.write(sep(root, rel), text)
          copied++
        } catch {
          // a file the source does not have
        }
      }
    }
    // a watched folder reloads on the write; elsewhere a changed option reloads the module
    try {
      await $.fs.write(`${root.replace(/[\\/]+$/, '')}/hooks/hooks.json`, await readText($, `${root.replace(/[\\/]+$/, '')}/hooks/hooks.json`))
    } catch {
      // nothing to touch
    }
    for (const id of await selfIds($)) {
      try {
        const res = await $.process.run(['claude', 'plugin', 'configure', id, '--values-stdin'], { stdin: JSON.stringify({ reload_nonce: String(await $.clock.now()) }), timeoutMs: 60000 })
        if (res.exitCode === 0) break
      } catch {
        // try the next id
      }
    }
    // only a watched folder reloads in open sessions: the mods folder, or CLAUDE_CODE_PLUGIN_DIRS with CLAUDE_CODE_PLUGIN_DIR_WATCH=1
    const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const dirs = String((await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '').split(isWindows() ? ';' : ':').map(norm).filter(Boolean)
    const watched = norm(root).includes('/.claude/mods/') || (dirs.includes(norm(root)) && (await $.env.get('CLAUDE_CODE_PLUGIN_DIR_WATCH')) === '1')
    const what = copied ? `${copied} files copied from ${source}. ` : ''
    return {
      text: watched
        ? `${what}The Chief reloads in every open session within a few seconds.`
        : `${what}This copy is installed from the marketplace, which open sessions do not watch: new sessions get it at once, open ones after a restart. For live reloads, load The Chief from a folder with CLAUDE_CODE_PLUGIN_DIRS and CLAUDE_CODE_PLUGIN_DIR_WATCH=1.`,
    }
  })

  on('command.run', { command: 'leader' }, async ($, e) => {
    const want = e.args.trim()
    if (/^off$/i.test(want)) {
      for (const c of hqCards.filter(x => x.role === 'chief' && x.leader === sid)) await sendTo($, c.sid, 'release')
      await setRole($, 'solo')
      return { text: 'This chat is no longer the leader; its chiefs were released.' }
    }
    await becomeLeader($, want || undefined)
    await $.state.set(TAB, 'leader')
    await tryOpen($, 'chief')
    return { text: `**Leader of Chiefs**${(await mainGoalText($)) ? ` · ★ ${await mainGoalText($)}` : ''}\n\n${chiefsText(await $.clock.now())}` }
  })

  on('command.run', { command: 'chief-sync' }, async $ => ({ text: await syncChiefs($) }))
  on('command.run', { command: 'chief-check' }, async () => {
    enqueue({ kind: 'health', force: true })
    return { text: L('Testing every CLI with one word. The result is written under this chat in a minute or two, and stays in Settings → Providers.', 'Her CLI tek kelimeyle deneniyor. Sonuç bir iki dakika içinde bu sohbetin altına yazılır, Ayarlar → Sağlayıcılar’da da durur.') }
  })

  on('command.run', { command: 'chief' }, async ($, e) => {
    const want = e.args.trim()
    if (/^sync$/i.test(want)) return { text: await syncChiefs($) }
    if (/^setup$/i.test(want)) return { text: (await firstSetup($, true).catch(err => `Setup failed: ${err instanceof Error ? oneLine(err.message, 160) : String(err)}`)) || 'Setup cannot run in this session (a worker or a background run).' }
    const joining = want.match(/^join\s+(\S+)$/i)
    if (joining) return { text: await joinByToken($, joining[1]!) }
    const taking = want.match(/^handoff\s+(\S+)$/i)
    if (taking) {
      handoffToken = taking[1]!
      await takeHandoffIn($)
      return { text: handoffIn ? L('Handoff received; reading the previous session\'s file and carrying on.', 'Devir alındı; önceki oturumun dosyasını okuyup devam ediyorum.') : L('This handoff does not exist or was already taken.', 'Bu devir kaydı yok ya da çoktan alındı.') }
    }
    if (/^(quiet|sessiz)$/i.test(want)) {
      quiet = true
      await storeSet($, `quiet:${sid}`, true)
      return { text: L('The Chief will no longer write anything into this chat by itself. To turn it back on: /chief loud', 'The Chief bu sohbete artık kendiliğinden hiçbir şey yazmayacak. Geri açmak için: /chief loud') }
    }
    if (/^(loud|sesli)$/i.test(want)) {
      quiet = false
      await storeSet($, `quiet:${sid}`, false)
      return { text: L('The Chief may post notices again (at most one every 30 s).', 'The Chief yine bildirim yazabilir (en fazla 30 sn\'de bir).') }
    }
    if (/^(ad|title|rename|yeniden adlandır)$/i.test(want)) return { text: await retitleNow($) }
    if (/^leave$/i.test(want)) {
      if (leaderSid) await sendTo($, leaderSid, 'report', { line: `- ${projectTitle()} left`, isUrgent: false })
      chiefConfig = {}
      await storeSet($, `chiefConfig:${sid}`, chiefConfig)
      await setRole($, 'solo')
      return { text: 'This chat no longer reports to a leader.' }
    }
    const live = want.match(/^live(?:\s+(\S+))?$/i)
    if (live) {
      const url = live[1] ?? ''
      if (url && !/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9-]+$/.test(url)) return { text: 'That is not a claude.ai artifact link.' }
      if (url === 'off') liveUrl = ''
      else if (url) liveUrl = url
      docVersions.clear()
      lastLiveJson = ''
      await storeSet($, 'liveUrl', liveUrl)
      return { text: liveUrl ? `The Chief now mirrors to ${liveUrl} every few seconds; open it on your phone.` : 'Live page off. Set one with /chief live <artifact link>.' }
    }
    const band = want.match(/^band(?:\s+(on|off))?$/i)
    if (band) {
      bandControls = band[1] ? band[1].toLowerCase() === 'on' : !bandControls
      await storeSet($, 'bandControls', bandControls)
      await update($, tick, n => (n ?? 0) + 1)
      return { text: bandControls ? `Subagent controls on the band: ${subModelText(subControl.model)} · effort ${subEffortText(subControl.effort)}.` : 'Subagent controls hidden; subagents run on Claude’s own choice again.' }
    }
    if (want === 'squad' || want === 'agents' || want === 'skills' || want === 'overview' || want === 'settings' || want === 'spend' || want === 'startup' || want === 'leader' || want === 'consult' || want === 'prompts' || want === 'themes') await $.state.set(TAB, want)
    await tryOpen($, 'chief')
    return { text: await agentsText($) }
  })

  on('command.run', { command: 'squad' }, async ($, e) => {
    const args = e.args.trim()
    const launchArg = args.match(/^launch\s*(.*)$/i)
    if (launchArg) {
      const { value: laneList = [] } = await $.state.get(LANES)
      const which = launchArg[1]!.trim().toLowerCase()
      const pick = which === '' || which === 'all' ? null : laneList.filter((_, i) => String(i + 1) === which).map(l => l.id)
      if (pick && pick.length === 0) return { text: `No lane ${which}. ${lanesText(laneList)}` }
      await launch($, pick, true)
      return { text: `Launching ${pick ? `lane ${which}` : 'every lane'}.` }
    }
    if (args === 'goals') {
      return { text: goalsText((await $.state.get(GOALS)).value ?? []) }
    }
    await $.state.set(TAB, 'squad')
    await tryOpen($, 'chief')
    return { text: lanesText((await $.state.get(LANES)).value ?? []) }
  })

  on('command.run', { command: 'overview' }, async ($, e) => {
    await $.state.set(TAB, 'overview')
    enqueue({ kind: 'overview', report: 'manual', scope: /session|tüm|tum|all/i.test(e.args) ? 'session' : 'today' })
    await tryOpen($, 'chief')
    const { value: list = [] } = await $.state.get(REPORTS)
    const last = [...list].sort((a, b) => b.at - a.at)[0]
    const head = 'Sonnet 5.5 is writing a fresh overview; it lands in /overview and The Chief → Overview.'
    return { text: last ? `${head}\n\nLast one (${dayLabel(last.day, await $.clock.now())} ${timeOf(last.at)}):\n\n${last.text}` : head }
  })

  on('command.run', { command: 'live' }, async ($, e) => {
    if (e.args.trim() === 'off') {
      liveUrl = ''
      await storeSet($, 'liveUrl', '')
      return { text: 'Live page off for now. /live turns it on again.' }
    }
    if (!liveUrl) {
      await storeSet($, 'liveWanted', true)
      try {
        await ensureLivePage($) // reuses the backed-up link; publishes only when there is none
      } catch (err) {
        return { text: `Live page failed: ${err instanceof Error ? oneLine(err.message, 200) : String(err)}` }
      }
      if (liveUrl) await storeSet($, 'liveUrl', liveUrl)
    }
    return {
      text: liveUrl
        ? `**The Chief, live:** ${liveUrl}\n\nPinned in your claude.ai sidebar; open it on your phone. Every session of yours shows there; pick one at the top.`
        : 'Live page could not be made here: no claude.ai Artifact tools in this session.',
    }
  })

  on('command.run', { command: 'chief-row' }, async ($, e) => {
    const value = e.args.trim().toLowerCase() === 'on' ? 'on' : 'off'
    await saveOption($, 'show_row', value)
    return { text: value === 'on' ? L('The Chief row is back above the chat.', 'The Chief satırı sohbet üstüne geri geldi.') : L('The Chief row is hidden for good. /chief-row on or Settings brings it back.', 'The Chief satırı kalıcı gizlendi. /chief-row on ya da Ayarlar geri getirir.') }
  })
  on('command.run', { command: 'stop-loops' }, async $ => ({ text: await stopLoops($, true) }))

  on('command.run', { command: 'consult' }, async ($, e) => {
    const want = e.args.trim()
    const list = consultantsNow()
    const shown = list.map((c, i) => `${i + 1}. ${consultantName(c)}`).join('\n') || L('(off)', '(kapalı)')
    if (!want || /^(list|liste)$/i.test(want)) return { text: L(`Consultants:\n${shown}\n\nTo ask: /consult <question>  ·  all at once: /consult all <question>\nTo change the list: The Chief → Consult.`, `Danışmanlar:\n${shown}\n\nSormak için: /consult <soru>  ·  hepsine birden: /consult hepsi <soru>\nListeyi değiştirmek için: The Chief → Danışman.`) }
    const panel = /^(hepsi|all|panel)\s+/i.test(want)
    const question = panel ? want.replace(/^\S+\s+/, '') : want
    return { text: await ownerConsult($, question, panel) }
  })

  on('command.run', { command: 'goals' }, async ($, e) => {
    const args = e.args.trim()
    const { value: list = [] } = await $.state.get(GOALS)
    const nth = (n: string) => list[Number(n) - 1]
    let m = args.match(/^add\s+(.+)$/i)
    if (m) {
      const text = m[1]!.trim()
      await mutateGoals($, l => [{ id: newId(), text, status: 'open' }, ...l])
      return { text: `Goal added: ${text}\n\n${goalsText((await $.state.get(GOALS)).value ?? [])}` }
    }
    m = args.match(/^(start|here|done|reopen|remove)\s+(\d+)$/i)
    if (m) {
      const g = nth(m[2]!)
      if (!g) return { text: `No goal ${m[2]}.\n\n${goalsText(list)}` }
      const verb = m[1]!.toLowerCase()
      if (verb === 'start' || verb === 'here') {
        await startGoal($, g, 'here', 'mobile')
        return { text: `Goal set for this session: ${g.text}` }
      }
      if (verb === 'remove') await mutateGoals($, l => l.filter(x => x.id !== g.id))
      else await mutateGoals($, l => l.map(x => (x.id === g.id ? { ...x, status: verb === 'done' ? 'done' : 'open' } : x)))
      return { text: goalsText((await $.state.get(GOALS)).value ?? []) }
    }
    return { text: goalsText(list) }
  })

  // Claude Code's own subagents: followed from spawn, through each step, to their answer
  on('agent.spawn', async ($, e, next) => {
    const max = chiefConfig.subagents?.max
    if (max) {
      const { value: running = [] } = await $.state.get(SUBS)
      if (running.filter(x => x.status === 'running').length >= max) return { deny: `Your leader allows at most ${max} subagent${max === 1 ? '' : 's'} at once here; wait for one to finish.` }
    }
    const subModel = chiefConfig.subagents?.model || (bandControls && subControl.model !== 'auto' ? subControl.model : '')
    const r = await next(subModel ? { ...e, model: subModel } : e)
    if (r.agentId) {
      const sub: SquadSub = {
        id: r.agentId,
        description: e.description,
        prompt: typeof e.prompt === 'string' ? e.prompt.slice(0, 50000) : undefined,
        type: e.subagentType,
        model: r.model,
        status: 'running',
        startedAt: await $.clock.now(),
        endedAt: null,
        tools: 0,
        steps: [],
        files: [],
        turnId: null,
        result: '',
      }
      await update($, subs, list => [...(list ?? []), sub].slice(-40))
    }
    return r
  })

  // a subagent's every model request thinks as hard as the band says
  on('turn.step', async function* (_$, e, next) {
    if (!e.agentId) {
      // the chat itself: a leader may have set this chief's model and effort; they take effect at a safe point
      await settleShape(_$).catch(() => undefined)
      const model = promptModel || e.model
      const effort = promptEffort && e.effort !== undefined ? (promptEffort as (typeof EFFORTS)[number]) : e.effort
      lastModelSeen = model
      lastEffortSeen = effort === undefined ? '' : String(effort)
      const r = yield* next(model !== e.model || effort !== e.effort ? { ...e, model, effort } : e)
      void noteStep(_$, model, r.usage, false).catch(() => undefined)
      return r
    }
    const subEffort = (chiefConfig.subagents?.effort as (typeof EFFORTS)[number] | undefined) || (bandControls && subControl.effort > 0 ? EFFORTS[subControl.effort - 1] : undefined)
    const r = yield* next(subEffort && e.effort !== undefined ? { ...e, effort: subEffort } : e)
    void noteStep(_$, e.model, r.usage, true).catch(() => undefined)
    return r
  })

  // a /goal that can only be met by the owner re-prompts the chat every few seconds: once the chat says the same
  // thing twice in that loop, this re-prompt is ended — but the goal is NOT cleared (the owner does not want chiefs
  // to drop their goal on their own); the leader is told once and decides, and a new message resumes the goal.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    const said = String((e as { last_assistant_message?: string }).last_assistant_message ?? '')
    if (!r.block || (e as { agentId?: string }).agentId) {
      goalLoopLast = ''
      goalLoopTold = ''
      return r
    }
    const looping = goalLoopLast !== '' && sameAnswer(goalLoopLast, said)
    goalLoopLast = said
    if (!looping) {
      goalLoopTold = ''
      return r
    }
    // it is repeating itself: end this re-prompt, leave the goal alone, and tell the leader once per distinct answer
    if (said !== goalLoopTold) {
      goalLoopTold = said
      $.ui.log(L('The Chief: the goal keeps getting the same answer; it was not cleared, the leader was told.', 'The Chief: hedef aynı cevabı tekrarlatıyor; goal temizlenmedi, lidere bildirildi.'))
      if (role === 'chief' && leaderSid && interactive) {
        void sendTo($, leaderSid, 'report', { line: oneLine(L(`${projectTitle()} keeps repeating the same answer, goal not cleared; end it with configure_chief clear_goal true if you want: ${said}`, `${projectTitle()} aynı cevabı tekrarlıyor, goal temizlenmedi; istersen configure_chief clear_goal true ile bitir: ${said}`), 600), isQuestion: true }).catch(() => undefined)
      }
    }
    return { ...r, block: undefined }
  })

  // each response reports the rate limits: take the reading at once and share it with the other chats
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    const l = pickLimits(e.rateLimits ?? [])
    if (l.five || l.week) {
      const now = await $.clock.now()
      ownLimits = { ...l, at: now }
      limitsNow = { five: liveLimit(l.five, now), week: liveLimit(l.week, now) }
      await shareLimits($, ownLimits).catch(() => undefined)
      await showBudget($).catch(() => undefined)
    }
    return r
  })

  // a leader answers the owner in a sentence at most: chief traffic is not news to recap
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    await settleShape($).catch(() => undefined)
    // a CLAUDE.md that already imports Ponytail brings the same text: adding it again doubles it in every chat
    const home = (await (isWindows() ? $.env.get('USERPROFILE') : $.env.get('HOME')).catch(() => '')) || ''
    const ownRules = home ? await $.fs.read(join(home, '.claude', 'CLAUDE.md')).catch(() => '') : ''
    const ponytailText = /skills[\\/]ponytail[\\/]SKILL\.md/.test(ownRules ?? '') ? '' : await $.fs.read(join($.plugin.root, 'skills', 'ponytail', 'SKILL.md')).catch(() => '')
    const ponytail = ponytailText ? [{ id: 'the-chief:ponytail', text: ponytailText, scope: 'session' as const }] : []
    return { sections: [...r.sections, ...(promptRole === 'leader' ? [LEADER_VOICE] : promptRole === 'chief' ? [CHIEF_VOICE] : []), ...ponytail] }
  })

  // any compaction (ours, Claude Code's auto-compact, /compact) is a safe point for the prompt shape
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && r.skip === undefined) compactedSince = true
    return r
  })

  // SendMessage between this chat and its leader or chiefs: The Chief carries it, and the tool reports it delivered
  // (its own result shape, so the sender never sees an error and never sends again)
  on('session.send', async ($, e, next) => {
    if (!toolsRegistered) void registerChiefTools($).catch(() => undefined) // a reload that skipped session.start: the first event brings the tools back
    if (e.agentId || (e.origin?.kind === 'plugin' && e.origin.name === 'the-chief') || !e.text.trim()) return next(e)
    const routed = await routeChatMessage($, e.to, e.text)
    return routed ? { isDelivered: true } : next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // a /loop interval of an hour or more would wake after the cache died: it runs every 50 minutes instead
    const loop = clampLoopCommand(e.text)
    if (loop) {
      $.ui.log(`The Chief: /loop set to every ${LOOP_DEFAULT_S / 60} min (the prompt cache lives one hour; a later wake-up rewrites the whole history).`)
      e = { ...e, text: loop }
    }
    if (role === 'leader' && idleLeaderWake({ origin: e.origin.kind, alerts: alerts.length, now: await $.clock.now(), lastTurnEnd: lastTurnEndAt })) return { drop: L('The Chief: skipped a leader wake-up with no new event (backup checks are off).', 'The Chief: yeni olay olmadan gelen lider uyanması atlandı (yedek kontrol kapalı).') }
    // a message from someone (the owner, another chat) ends a wait on the owner (a leader's message, where it is
    // delivered); a wake-up, a scheduled trigger, a task notice or The Chief's own nudge does not
    if (e.text.trim() && !e.text.startsWith(WAKE) && ['composer', 'bridge', 'sdk', 'peer', 'peer-send-message'].includes(e.origin.kind)) ownerBlockedAt = 0
    // the owner's own words (typed here, from the phone or the app) keep this chat from being archived for 30 minutes
    if (['composer', 'bridge', 'sdk'].includes(e.origin.kind) && e.text.trim() && !e.text.startsWith(WAKE) && careReady()) {
      ownerTypedAt = await $.clock.now()
      const at = ownerTypedAt
      await patchSess(portsOf($), sid, () => ({ ownerTypedAt: at })).catch(() => undefined)
    }
    // the owner typed in this chat himself (here or from the phone): a stop he set earlier no longer holds. The
    // leader's own messages ('sdk', framed "[Leader ...]") do not count: they never restart a stopped chat.
    if (['composer', 'bridge'].includes(e.origin.kind) && e.text.trim() && !e.text.startsWith(WAKE) && (await chiefStopped($, sid))) await resumeChief($, sid)
    // a role voice still waiting for a safe point goes along with the message instead of into the system prompt
    // (when this request is already a safe point, it settles here and goes into the system prompt instead)
    await settleShape($).catch(() => undefined)
    const voice = pendingVoice()
    const crewNote = e.origin.kind === 'bridge' && !isWorker ? await crewReplyNote($).catch(() => '') : ''
    const withVoice = withTierNote(voice || crewNote ? { ...e, context: [...(e.context ?? []), ...(voice ? [voice] : []), ...(crewNote ? [crewNote] : [])] } : e)
    // only what the owner sends (typed here, from the phone or the app), never The Chief's own or a peer's
    if (role !== 'leader' || !['composer', 'bridge', 'sdk'].includes(e.origin.kind)) return next(withVoice)
    if (e.text.trim()) ownerSaid = { text: e.text.trim().slice(0, 1500), at: await $.clock.now() }
    const note = chiefNewsNote(leaderLog, readUpTo)
    if (!note) return next(withVoice)
    readUpTo = await $.clock.now()
    return next({ ...withVoice, context: [...(withVoice.context ?? []), note] })
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    const agentId = (e as { agentId?: string }).agentId
    if (agentId) await patchSub($, agentId, s => ({ ...s, turnId: e.turnId }))
    else {
      turnsHere++
      lastTurnAt = await $.clock.now()
      mainActivityAt = lastTurnAt
      stuckTold = false
      waitingOwner = ownerBlockedAt > 0
      stalled = false
      goalDone = false
      doneVerdict = ''
      doneUnverified = false
      mainTurn = true
      wroteLeaderThisTurn = false
      void stampDay($)
      if (chiefConfig.goal) markWork()
      await markHandoffStarted($).catch(() => undefined)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    // while sub-agent tiers are saved, Claude Code's own Agent tool starts a sub-agent only on a tier that runs on the
    // Claude CLI (with that tier's model and effort); every other tier goes through spawn_worker. Explore and Plan stay.
    // (Part of this hook, not a hook of its own: a hook per tool lengthens every tool call's chain.)
    if (bridgeOn() && e.tool.startsWith('mcp__claude-in-chrome__')) {
      const started = await ensureBridge($).catch(() => '')
      return { deny: `${bridgeNote(await bridgeDirOf($))}${started ? ` (bridge: ${started})` : ''}` }
    }
    // one heavy check (tsc, vitest, depcruise, bench) at a time on the whole machine: the others wait in line
    let heavyHeld = ''
    if (e.tool === 'Bash' && HEAVY_RE.test(String((e as { command?: string }).command ?? ''))) heavyHeld = await takeHeavy($)
    let agentNote = ''
    if (e.tool === 'Agent') {
      const tiers = subTiersNow()
      const gate = tiers ? gateAgent(e, tiers, floorsNow()) : null
      if (gate) {
        e = { ...e, model: gate.model, ...(gate.effort ? { effort: gate.effort as typeof e.effort } : {}) }
        agentNote = gate.note
      }
    }
    // a title set by hand (the owner, the leader, any agent) is final: The Chief never renames that session again
    if (e.tool === APP.title && ownTitleCalls === 0) {
      const a = e as unknown as Record<string, unknown>
      const target = String(a.session_id ?? 'self')
      const id = target === 'self' ? sid : target.replace(/^local_/, '')
      const p = portsOf($)
      await patchSess(p, id, () => ({ userRenamed: true, title: String(a.title ?? '') })).catch(() => undefined)
      await p.set(`act:${id}:named`, await $.clock.now()).catch(() => undefined)
      if (id === sid) nameFinished = true
    }
    // the app's send_message answers in text, so its routed reply can be text; SendMessage is routed at session.send
    if (!agentId && /(^|__)send_message$/.test(e.tool)) {
      const a = e as unknown as Record<string, unknown>
      const target = String(a.session_id ?? '')
      const text = String(a.message ?? '')
      const routed = text.trim() && !text.startsWith(WAKE) ? await routeChatMessage($, target, text) : null
      if (routed) return { result: routed }
      wroteLeaderThisTurn = true
    }
    if (!agentId && e.tool === 'SendMessage') wroteLeaderThisTurn = true
    // a chat really stopped (the app's stop_session): the stop sticks here, so nothing the plugin queued starts it again
    if (!agentId && /(^|__)stop_session$/.test(e.tool)) {
      const a = e as unknown as Record<string, unknown>
      const stopped = String(a.session_id ?? '').replace(/^local_/, '')
      if (stopped && stopped !== 'self' && stopped !== sid) await stopChief($, stopped, 'stop_session').catch(() => undefined)
    }
    if (!agentId) {
      mainActivityAt = await $.clock.now()
      // The Chief's own calls to the app (its session tools) are not the chat's work
      if (!APP_TOOL_RE.test(e.tool)) markWork()
      // a blind whole-file read of a big file stays in every later turn: read the head, say how to get the rest
      const cap = e.tool === 'Read' && interactive && !isWorker ? await capRead($, e, budget()).catch(() => null) : null
      const counted = !APP_TOOL_RE.test(e.tool)
      if (counted) toolsRunning++
      let r: Awaited<ReturnType<typeof next>>
      try {
        r = await next(cap && e.tool === 'Read' ? { ...e, limit: cap.limit } : e)
      } finally {
        if (heavyHeld) await dropHeavy($, heavyHeld)
        if (counted) toolsRunning = Math.max(0, toolsRunning - 1)
      }
      if (e.tool === 'Read' && r.deny === undefined && interactive && !isWorker) {
        const got = (r as { result?: unknown }).result
        noteRead(e.file_path, cap, typeof got === 'string' ? got.length : 0)
      }
      const extra = r.deny === undefined ? [...(cap ? [cap.note] : []), ...(agentNote ? [agentNote] : []), ...takeAlerts(e.tool, (e as { tool_use_id?: string }).tool_use_id)] : []
      // a refused call stays as it is (a reminder only rides a result the model reads)
      if (r.deny !== undefined || extra.length === 0) return r
      return { ...r, context: [...(r.context ?? []), ...extra] }
    }
    lastActivity.set(agentId, await $.clock.now())
    {
      const args = e as unknown as Record<string, unknown>
      const tool = String(e.tool)
      const step = stepText(tool, args)
      const file = typeof args.file_path === 'string' ? baseName(args.file_path) : null
      await patchSub($, agentId, s => ({
        ...s,
        tools: s.tools + 1,
        steps: [...s.steps, step].slice(-20),
        files: file ? [...s.files.filter(f => f !== file), file].slice(-10) : s.files,
      }))
    }
    const r = await next(e)
    subErrors.set(agentId, (r as { isError?: boolean }).isError ? (subErrors.get(agentId) ?? 0) + 1 : 0)
    return r
  })

  // the plugin's own live-page calls need no permission prompt and no classifier call
  on('tool.check', async ($, e, next) => {
    const input = (e.input ?? {}) as Record<string, unknown>
    if (liveUrl && e.tool === 'ArtifactData' && input.url === liveUrl && (input.collection === 'sessions' || input.collection === 'commands')) {
      return { decision: 'allow', reason: 'The Chief live page sync' }
    }
    if (role === 'leader' && e.tool === 'mcp__ccd_session_mgmt__send_message' && String(input.message ?? '').startsWith(WAKE) && hqCards.some(c => c.role === 'chief' && c.leader === sid && `local_${c.sid}` === input.session_id)) {
      return { decision: 'allow', reason: 'The Chief wakes one of this leader’s own chiefs' }
    }
    if (e.tool === 'mcp__ccd_session_mgmt__get_usage' && !input.session_id) {
      return { decision: 'allow', reason: 'The Chief reads the week’s plan usage before it nudges a chief' }
    }
    if ((e.tool === 'mcp__ccd_session_mgmt__get_session' && input.session_id === 'self') || (e.tool === 'mcp__ccd_session_mgmt__list_sessions' && !input.include_archived)) {
      return { decision: 'allow', reason: 'The Chief reads its own session and the session titles' }
    }
    if (e.tool === 'Artifact' && typeof input.file_path === 'string' && input.file_path.replace(/\\/g, '/').endsWith('/.squad/live/the-chief-live.html')) {
      return { decision: 'allow', reason: 'The Chief live page template' }
    }
    return next(e)
  })

  // the plugin's tools wait behind ToolSearch: their schemas cost nothing until the chief needs them
  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    if (e.tool === 'ScheduleWakeup') return { ...r, description: r.description + LOOP_NOTE }
    return e.tool.startsWith('mcp__the-chief__') ? { ...r, isDeferred: true } : r
  })

  // while the owner has loops stopped, no new scheduled task either
  on('tool.call', { tool: 'CronCreate' }, async ($, e, next) => {
    if ((await $.clock.now()) < loopsOffUntil) return { deny: 'The owner stopped every loop in this chat. Do not schedule anything; finish this turn.' }
    if (role === 'leader' && cronTooOften(e.cron, e.recurring, LEADER_WAKE_MIN)) return { deny: L(LEADER_CRON_DENY_EN, LEADER_CRON_DENY) }
    return wakeGuardOn() && cronTooOften(e.cron, e.recurring) ? { deny: L(WAKE_DENY_EN, WAKE_DENY) } : next(e)
  })

  // a self-paced /loop (and any agent's wake-up) never sleeps past the chat's prompt cache
  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    if (ownerBlockedAt > 0 && !(e as { stop?: boolean }).stop) return { deny: L(OWNER_BLOCK_DENY_EN, OWNER_BLOCK_DENY) }
    if ((await $.clock.now()) < loopsOffUntil && !(e as { stop?: boolean }).stop) return { deny: 'The owner stopped every loop in this chat. Do not schedule a wake-up; finish this turn.' }
    if (role === 'leader' && !(e as { stop?: boolean }).stop && Number(e.delaySeconds ?? 0) < LEADER_WAKE_MIN * 60) return { deny: L(LEADER_CRON_DENY_EN, LEADER_CRON_DENY) }
    if (wakeGuardOn() && !(e as { stop?: boolean }).stop && wakeTooSoon(e.delaySeconds)) return { deny: L(WAKE_DENY_EN, WAKE_DENY) }
    const delay = clampWakeup(e.delaySeconds)
    if (delay === null) return next(e)
    const r = await next({ ...e, delaySeconds: delay })
    return r.deny === undefined ? { ...r, context: [...(r.context ?? []), `The Chief: wake-up shortened from ${Math.round((e.delaySeconds ?? 0) / 60)} to ${delay / 60} min, so it lands while this chat's one-hour prompt cache is still warm.`] } : r
  })

  on('turn.complete', async ($, e, next) => {
    // a reload that skipped session.start: the first event brings the tools back. Otherwise only tools the list shows
    // missing are redone: registering all again on every turn replaced the whole set, and the chat saw the server drop
    // and come back mid-turn, its tools gone in between (18.10)
    if (!toolsRegistered) void registerChiefTools($).catch(() => undefined)
    else void keepTools($, true).catch(() => undefined)
    const r = await next(e)
    const agentId = (e as { agentId?: string }).agentId
    if (agentId) {
      const { value = [] } = await $.state.get(SUBS)
      if (value.some(s => s.id === agentId && s.status === 'running')) {
        const now = await $.clock.now()
        const ok = e.reason !== 'refusal' && e.reason !== 'error'
        await patchSub($, agentId, s => ({ ...s, status: ok ? 'done' : 'failed', endedAt: now, result: r.text }))
      }
    } else {
      mainTurn = false
      mainActivityAt = await $.clock.now()
      if (!setupTried) {
        setupTried = true
        void firstSetup($, false).catch(() => undefined)
      }
      // the crew under the turn's answer, a dim line the model never reads: seen wherever the chat is opened
      if (interactive && !isWorker) {
        const crew = await syncCrewStatus($).catch(() => '')
        if (crew) $.ui.log(crew)
      }
      const said = chiefReport(r.text)
      if (ownerBlocked(r.text)) ownerBlockedAt = Math.max(1, mainActivityAt)
      waitingOwner = !!said?.isQuestion || ownerBlockedAt > 0
      stalled = saysWaiting(r.text)
      // a chief's DONE counts once it is checked: the files it names exist, none of its agents runs, the leader's check passes
      const gate = said?.isDone && role === 'chief' && interactive ? await doneGate($, r.text).catch(() => null) : null
      const checkLater = !!gate && !gate.fail.length && !!chiefConfig.check
      doneVerdict = !gate ? '' : checkLater ? 'pending' : settleDone(gate)
      if (said?.isDone && doneVerdict !== 'bounced' && doneVerdict !== 'pending') goalDone = true
      if (checkLater) enqueue({ kind: 'done-check', line: said!.line, ok: gate!.ok })
      // anything that came in after the last tool call goes now, on the usual gather rules
      void $.clock.now().then(now => flushAlerts($, now)).catch(() => undefined)
      lastTurnEndAt = mainActivityAt
      void storeSet($, `lastTurnEnd:${sid}`, lastTurnEndAt).catch(() => undefined)
      lastTurnReason = e.reason
      turnEndWaiter?.()
      namePending = !nameFinished || (role === 'leader' && !leaderTitled)
      if (handoffIn?.goal) {
        // the successor of a handoff takes the old goal once its first turn is done
        enqueue({ kind: 'goal', text: handoffIn.goal })
        handoffIn = { ...handoffIn, goal: '' }
      }
      // the turn's own $ ends with the turn: the guard runs on the session's, from the job loop
      if (interactive && !isWorker) enqueue({ kind: 'context-guard' })
      else void noteGuard($, -1, `not queued: ${interactive ? '' : 'not interactive '}${isWorker ? 'worker' : ''}`)
    }
    if (!agentId && role === 'chief' && leaderSid && interactive) {
      const told = chiefReport(r.text, wroteLeaderThisTurn) ?? (e.reason === 'error' ? { line: `${projectTitle()}: its turn ended in an error`, isQuestion: false } : null)
      // a DONE reaches the leader as the check left it; one whose check command still runs is reported by that job
      const report = !told?.isDone || !doneVerdict ? told : doneVerdict === 'pending' ? null : doneReport(told.line, doneVerdict)
      // a chief that only waits (a nudge, a goal hook asking again) says nothing new: it stays quiet, the leader sees it in list_chiefs
      const justWaiting = !!report && e.reason !== 'error' && !report.isDone && stalled
      const leader = leaderSid
      if (report && !justWaiting)
        void (async () => {
          // a HAZIR whose branch is not on origin reaches the leader marked so, and goes back to the chief
          const unpushed = await checkReady($, r.text).catch(() => '')
          // pushed and named: the plugin's train takes it (hq/train/config.json), no leader turn needed for it
          if (!unpushed) await queueTrain($, readyClaims(r.text)).catch(() => undefined)
          await sendTo($, leader, 'report', { ...report, line: unpushed ? L(`${report.line} (NOT VERIFIED: ${unpushed})`, `${report.line} (DOĞRULANMADI: ${unpushed})`) : report.line, isUrgent: e.reason === 'error' })
        })().catch(() => undefined)
      else if (r.text) void queueReady($, r.text).catch(() => undefined)
    } else if (!agentId && interactive && !isWorker && r.text) void queueReady($, r.text).catch(() => undefined)
    return r
  })

  // ---------- the Leader of Chiefs' controls ----------
  const args = (e: unknown) => e as Record<string, unknown>
  on('tool.call', { tool: 'mcp__the-chief__list_chiefs' }, async $ => {
    // reading the list changes nobody's role; only /leader makes a leader
    await readCards($)
    await loadBriefSeen($)
    await readStops($)
    const fresh = leaderLog.filter(x => x.at > readUpTo)
    readUpTo = await $.clock.now()
    // a chief's last brief is printed once, when it is new; a quiet list says nothing rather than "no new reports"
    const news = fresh.length ? `\n\nReports since you last looked (${fresh.length}${fresh.length > 15 ? ', last 15' : ''}):\n${fresh.slice(-15).map(x => `[${timeOf(x.at)}] ${x.title}: ${oneLine(x.line, /\?\s*$/.test(x.line) ? 500 : 220)}`).join('\n')}` : ''
    const out = text(`${chiefsText(await $.clock.now(), 'news')}${role === 'leader' ? remoteText(await remotePeers($)) : ''}${news}`)
    await saveBriefSeen($)
    return out
  })
  on('tool.call', { tool: 'mcp__the-chief__create_chief' }, async ($, e) => {
    const a = args(e)
    const { cfg, note } = pickChiefTier(configFrom(a), a.tier, true)
    if (!cfg.goal) return { deny: 'goal is required' }
    if (role === 'chief') return { deny: 'This chat is a chief; only its leader opens chiefs.' }
    if (role !== 'leader') await setRole($, 'leader')
    let token = ''
    try {
      token = await createChief($, cfg, typeof a.folder === 'string' ? a.folder : undefined, typeof a.title === 'string' ? a.title : undefined, true, a.link === true)
    } catch (err) {
      return text(`Could not open a new chat (${err instanceof Error ? oneLine(err.message, 100) : String(err)}). Use adopt_chief on an open chat instead.`)
    }
    const made = `goal: ${cfg.goal}${describeConfig(cfg) ? ` · ${describeConfig(cfg)}` : ''}${note ? ` · ${note}` : ''} · ${chiefEffortReport(cfg, a.effort, a.tier)}`
    if (askModel) return text(`Not opened yet: the app starts a session only when you make the call, not the plugin. To open this chief · ${made} · call mcp__ccd_session__start_session now with exactly these arguments (if its schema is not loaded, first ToolSearch "select:mcp__ccd_session__start_session"):\n${JSON.stringify(askModel)}\nThe Chief makes the new chat your chief by itself when that call returns: do not call adopt_chief, and do not change the background text. If that tool does not exist here or the call is refused, call create_chief again with the same arguments and link: true.`)
    if (!token) return text(`Opened a new chief chat · ${made}. It is a session of the app under this chat and has its goal; list_chiefs shows it within a minute. The plugin pins or titles it only when the owner turned auto_pin / auto_title on.`)
    return text(`Asked the app for a new chat as your chief · ${made}. It shows in list_chiefs once it joins. If no chat opens within a minute, tell the owner to open a new chat and type: /chief join ${token}${openWhy.length ? `\nWhy it did not open by itself: ${openWhy.join('; ')}.${AUTH_RE.test(openWhy.join(' ')) ? ' The claude in the terminal has no working sign-in or credit: the owner runs `claude auth login` in a terminal (their subscription account), then /chief-check.' : ''}` : ''}`)
  })
  // the leader's own call to the app's session tool, asked for by create_chief: the chat it starts becomes the chief
  on('tool.call', { tool: 'mcp__ccd_session__start_session' }, async ($, e, next) => {
    const r = await next(e)
    if (pendingAppChiefs.size === 0) return r
    const input = e as unknown as { background?: unknown; prompt?: unknown }
    const marked = /The Chief plugin, chief (\w+)\)/.exec(String(input.background ?? ''))?.[1] ?? ''
    // the token, else the goal itself (a leader that rewrote the background still sent the goal)
    const token = pendingAppChiefs.has(marked) ? marked : ([...pendingAppChiefs].find(([, v]) => !!v.cfg.goal && String(input.prompt ?? '').includes(v.cfg.goal))?.[0] ?? '')
    const want = pendingAppChiefs.get(token)
    const id = want && (r as { deny?: string }).deny === undefined ? startedSessionId(JSON.stringify(r)) : ''
    if (!want || !id) return r
    pendingAppChiefs.delete(token)
    await adoptStarted($, id, want.cfg).catch(() => undefined)
    void verifyChiefStart($, id, want.cfg, want.title).catch(() => undefined)
    return r
  })
  on('tool.call', { tool: 'mcp__the-chief__adopt_chief' }, async ($, e) => {
    const a = args(e)
    const c = await freshChief($, a.chief)
    if (!c) return { deny: `No open chat matches "${String(a.chief)}"; list_chiefs shows them.` }
    if (c.sid === sid) return { deny: 'That is this chat, the leader.' }
    if (c.chat === false) return { deny: `${c.title} is a headless run (a script's claude -p), not a chat: it cannot be a chief.` }
    if (role === 'chief') return { deny: 'This chat is a chief; only its leader adopts chats.' }
    if (role !== 'leader') await setRole($, 'leader')
    const { cfg, note } = pickChiefTier(configFrom(a), a.tier, false)
    // adopting is a deliberate word: a chat the owner stopped runs again as this leader's chief
    await resumeChief($, c.sid)
    await sendTo($, c.sid, 'join', { config: cfg })
    return text(`Asked ${c.title} to join as your chief${describeConfig(cfg) ? ` (${describeConfig(cfg)})` : ''}${cfg.goal ? ` · goal: ${cfg.goal}` : ''}${note ? ` · ${note}` : ''}. It confirms within a few seconds.`)
  })
  on('tool.call', { tool: 'mcp__the-chief__configure_chief' }, async ($, e) => {
    const a = args(e)
    const c = await freshChief($, a.chief)
    if (!c) return { deny: notMyChief(String(a.chief ?? ''), null) }
    if (c.sid === sid) return { deny: 'That is this chat (the leader), not a chief.' }
    if (c.leader !== sid) return { deny: notMyChief(String(a.chief ?? ''), c) }
    const { cfg, note } = pickChiefTier(configFrom(a), a.tier, false)
    const clear = a.clear_goal === true
    const askStop = typeof a.stop === 'boolean' ? a.stop : null
    if (Object.keys(cfg).length === 0 && !clear && askStop === null) return { deny: 'Give at least one of goal, tier, model, effort, subagents, lanes, clear_goal, stop.' }
    // stop: the marker file, and its queue emptied; nothing the plugin holds starts it again (only a word that means it)
    if (askStop === true) {
      await stopChief($, c.sid, 'configure_chief')
      return text(L(`${c.title}: STOPPED. Its queue was emptied; no message the plugin holds will restart it. To run it again: message_chief, a goal, or stop false.`, `${c.title}: DURDURULDU. Kuyruğu boşaltıldı; plugin'in beklettiği hiçbir mesaj onu yeniden başlatmaz. Yeniden çalıştırmak için message_chief, bir goal ya da stop false.`))
    }
    if (askStop === false) await resumeChief($, c.sid)
    if (askStop === false && Object.keys(cfg).length === 0 && !clear) return text(L(`${c.title}: stop lifted; it can run again.`, `${c.title}: stop kaldırıldı; yeniden çalışabilir.`))
    // a goal is a deliberate word from the leader: it starts a stopped chief again. Settings alone never do.
    if (cfg.goal) await resumeChief($, c.sid)
    else if (Object.keys(cfg).length > 0 && (await chiefStopped($, c.sid))) return text(L(`${c.title} is STOPPED: settings not sent, its queue stays empty. Give it a goal, write with message_chief, or stop false.`, `${c.title} DURDURULDU: ayar gönderilmedi, kuyruğu boş kalır. Bir goal ver, message_chief ile yaz ya da stop false.`))
    // clear_goal ends the chat's /goal loop (the owner cannot); a new goal goes in as a plain message after it
    if (clear) await sendTo($, c.sid, 'clear-goal')
    if (Object.keys(cfg).length > 0) await sendTo($, c.sid, 'configure', { config: cfg })
    // the effort is read back from the chief's card: taken, already running, or a mismatch (re-applied once, then said)
    let state: EffortState | null = null
    if (cfg.effort) {
      if (c.busy) {
        // in a turn it reads its queue only when the turn ends: nothing to verify now, read back on a later tick
        state = 'pending'
        await askEffort($, c.sid, cfg.effort)
      } else {
        state = await waitEffort($, c.sid, cfg.effort, 18000)
        if (state === 'mismatch') {
          await sendTo($, c.sid, 'configure', { config: { effort: cfg.effort } })
          state = await waitEffort($, c.sid, cfg.effort, 18000)
          if (state === 'mismatch') await askEffort($, c.sid, cfg.effort)
        }
      }
    }
    const eff = state
      ? effortReport(cfg.effort ?? '', state, await cardEffort($, c.sid))
      : cfg.effort || a.effort
        ? chiefEffortReport(cfg, a.effort, a.tier)
        : ''
    const tail = state === 'mismatch' ? '' : ' sent; it applies on its next step.'
    return text(`${c.title}: ${[clear ? '/goal cleared' : '', cfg.goal ? `goal "${cfg.goal}"` : '', describeConfig(cfg), eff, note].filter(Boolean).join(' · ')}${tail}`)
  })
  on('tool.call', { tool: 'mcp__the-chief__message_chief' }, async ($, e) => {
    const a = args(e)
    const who = String(a.chief ?? '').trim()
    if (!who) return { deny: 'chief is required: its short code, its session id (local_...), its name, or "all".' }
    // the model often names the text `message` (or `body`); refusing only "text" hid the real cause of a bad target
    const said = [a.text, a.message, a.body].find(v => typeof v === 'string' && v.trim()) as string | undefined
    if (who.toLowerCase() === 'all') {
      if (!said) return { deny: 'No message to send: give "text" (also accepted as message).' }
      await readCards($)
      const now = await $.clock.now()
      // every live chief of this leader (seen in the last 3 minutes, not released)
      const live = hqCards.filter(c => c.role === 'chief' && c.leader === sid && now - c.updatedAt < 180000)
      if (!live.length) return { deny: 'No live chiefs to message; list_chiefs shows them.' }
      const owner = await ownerWords($)
      const words = said.trim()
      for (const c of live) {
        // a deliberate word from the leader starts a stopped chief again
        await resumeChief($, c.sid)
        await sendTo($, c.sid, 'message', { text: words, ...owner })
      }
      return text(`Sent to ${live.length} live chief${live.length > 1 ? 's' : ''}: ${live.map(titleOf).join(', ')}.`)
    }
    const c = await freshChief($, who)
    // not a chief on this computer: a Remote Control or cloud chat the app lists (another laptop) gets it through the app
    const peer = c ? null : findPeer(await remotePeers($), who)
    if (peer) {
      if (!said) return { deny: `No message to send to ${peer.name} [${peer.id}]: give "text" (also accepted as message).` }
      const words = said.trim()
      // the auto-mode classifier sometimes gives no verdict on a send (twice in a row to the Mac, 18.10): a passing
      // refusal is tried again, three times in all, a few seconds apart
      let last = ''
      for (let i = 0; i < 3; i++) {
        if (i > 0) await $.clock.sleep(i * 4000)
        try {
          await toolText($, 'SendMessage', { to: peer.id, message: words })
          return text(`Sent to ${peer.name} [${peer.id}] (${peer.kind === 'remote' ? 'Remote Control' : 'cloud'}, ${peer.state})${i ? ` on try ${i + 1}` : ''}.`)
        } catch (err) {
          last = err instanceof Error ? err.message : String(err)
          if (!sendRetryable(last)) break
        }
      }
      return { deny: `Could not reach ${peer.name} [${peer.id}]: ${last}` }
    }
    // what is left is a real mistake: say its cause plainly, never "text is required"
    if (!c) return { deny: notMyChief(who, null) }
    if (c.sid === sid) return { deny: 'That is this chat (the leader), not a chief.' }
    if (c.leader !== sid) return { deny: notMyChief(who, c) }
    if (!said) return { deny: `No message text for ${c.title}: give "text" (the message for it; also accepted as message).` }
    const words = said.trim()
    // a deliberate word from the leader starts a stopped chief again
    await resumeChief($, c.sid)
    const seenAgo = (await $.clock.now()) - c.updatedAt
    if (chiefLooksDead(c, seenAgo)) {
      // asleep: its inbox is read by a turn that never comes. The owner's order is the one thing that may start one,
      // and the app's own message does it; the words are the leader's, with the owner's passed on inside them.
      if (await wakeOnOrder($, c, words)) return text(`${titleOf(c)} [${c.sid.slice(0, 8)}]: was asleep (${fmtElapsed(seenAgo)} since its last sign); woken on the owner's order and the message delivered.`)
      await sendTo($, c.sid, 'message', { text: words, ...(await ownerWords($)) })
      raise(`chief:dead:${c.sid}`, L(`! ${titleOf(c)} [${c.sid.slice(0, 8)}] dead: last seen ${fmtElapsed(seenAgo)} ago, could not be woken; message not delivered (queued)`, `! ${titleOf(c)} [${c.sid.slice(0, 8)}] ölü: ${fmtElapsed(seenAgo)} önce görüldü, uyandırılamadı; mesaj teslim edilmedi (kuyrukta)`), true, await $.clock.now(), 300)
      return text(L(`${titleOf(c)} [${c.sid.slice(0, 8)}]: looks DEAD (last seen ${fmtElapsed(seenAgo)} ago) and could not be woken. The message is queued, NOT delivered; the chief reads it when it opens. To open it: open_session or a new chief.`, `${titleOf(c)} [${c.sid.slice(0, 8)}]: ÖLÜ görünüyor (${fmtElapsed(seenAgo)} önce son görüldü) ve uyandırılamadı. Mesaj kuyrukta, teslim EDİLMEDİ; şef açılınca okur. Açmak için: open_session ya da yeni şef.`))
    }
    await sendTo($, c.sid, 'message', { text: words, ...(await ownerWords($)) })
    return text(`Sent to ${titleOf(c)} [${c.sid.slice(0, 8)}].`)
  })
  on('tool.call', { tool: 'mcp__the-chief__pin_chief' as never }, async ($, e) => {
    const a = args(e)
    const pinned = a.pinned !== false
    const remote = a.remote_control === true
    const who = String(a.chief ?? '')
    if (who === 'self' || who === 'leader') {
      const rc = await setSelfView($, pinned, remote)
      return text(`This chat ${pinned ? 'pinned' : 'unpinned'}${remote ? rcWords(rc) : ''}.`)
    }
    const list = who === 'all' ? hqCards.filter(c => c.role === 'chief' && c.leader === sid) : [await freshChief($, a.chief)].filter((c): c is HqCard => !!c && c.leader === sid)
    if (!list.length) return { deny: `"${who}" is not one of your chiefs.` }
    // a chief that sits idle has no engine to read its inbox, so the app is asked directly (it asks the owner, who just said so)
    const refused: string[] = []
    for (const c of list) {
      const st = await stateOf(portsOf($), `local_${c.sid}`)
      if ((st.pinned === true) !== pinned) await $.tool.call({ tool: 'mcp__ccd_sidebar__set_pinned', session_id: `local_${c.sid}`, pinned } as never).catch(() => undefined)
      if (remote && (await remoteNow($, `local_${c.sid}`, st.remote)) !== 'on') refused.push(c.title)
    }
    return text(`${list.map(c => c.title).join(', ')}: ${pinned ? 'pinned' : 'unpinned'}${remote ? (refused.length ? `; Remote Control was not turned on for ${refused.join(', ')} (the app did not approve; tell the owner once)` : ', Remote Control on') : ''}.`)
  })
  on('tool.call', { tool: 'mcp__the-chief__release_chief' }, async ($, e) => {
    const a = args(e)
    const c = await freshChief($, a.chief)
    if (!c || c.leader !== sid) return { deny: `"${String(a.chief)}" is not one of your chiefs.` }
    await releaseChiefNow($, c)
    return text(`${c.title} released; unpinned and archived as soon as it is idle (not while it works or within 30 minutes of the owner typing in it).`)
  })
  on('tool.call', { tool: 'mcp__the-chief__create_goal' }, async ($, e) => {
    const a = args(e)
    const t = typeof a.text === 'string' ? a.text.trim() : ''
    if (!t) return { deny: 'text is required' }
    const g: SquadGoal = { id: newId(), text: t, status: 'open' }
    await mutateGoals($, l => [g, ...l])
    if (a.main === true) await setMainGoal($, g.id)
    let handed = ''
    if (typeof a.chief === 'string' && a.chief.trim()) {
      const c = await freshChief($, a.chief)
      if (c && c.leader === sid) {
        await sendTo($, c.sid, 'configure', { config: { goal: t } })
        handed = ` · given to ${c.title}`
      }
    }
    return text(`Goal added: ${t}${a.main === true ? ' · main goal' : ''}${handed}\n\n${goalsText((await $.state.get(GOALS)).value ?? [])}`)
  })
  on('tool.call', { tool: 'mcp__the-chief__edit_goal' }, async ($, e) => {
    const a = args(e)
    const { value: list = [] } = await $.state.get(GOALS)
    const g = findGoal(list, String(a.goal ?? ''))
    if (!g) return { deny: `No goal matches "${String(a.goal)}".` }
    const status = a.status === 'open' || a.status === 'active' || a.status === 'done' ? a.status : undefined
    const words = typeof a.text === 'string' && a.text.trim() ? a.text.trim() : undefined
    await mutateGoals($, l => l.map(x => (x.id === g.id ? { ...x, text: words ?? x.text, status: status ?? x.status } : status === 'active' && x.status === 'active' ? { ...x, status: 'open' } : x)))
    if (a.main === true) await setMainGoal($, g.id)
    return text(`Goal updated.\n\n${goalsText((await $.state.get(GOALS)).value ?? [])}`)
  })
  on('tool.call', { tool: 'mcp__the-chief__set_main_goal' }, async ($, e) => {
    const ref = String(args(e).goal ?? '').trim()
    if (!ref) return { deny: 'goal is required' }
    const { value: list = [] } = await $.state.get(GOALS)
    let g = findGoal(list, ref)
    if (!g) {
      g = { id: newId(), text: ref, status: 'open' }
      const added = g
      await mutateGoals($, l => [added, ...l])
    }
    await setMainGoal($, g.id)
    return text(`Main goal: ${g.text}`)
  })

  // ---------- the orchestrator's controls ----------
  on('tool.call', { tool: 'mcp__the-chief__spawn_worker' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const name = typeof a.name === 'string' ? a.name : ''
    if (a.queue === true && name && (await runningHere($)) > 0) {
      if (!(a.brief || a.task || a.task_file || a.header_file)) return { deny: 'name and one of brief, task, task_file or header_file are required' }
      const { queue: _q, tool: _t, ...rest } = a
      backlog = [...backlog.filter(b => b.name !== name), rest]
      await storeSet($, `backlog:${sid}`, backlog).catch(() => undefined)
      return text(L(`${name} is queued (${backlog.length} waiting): it starts as soon as one of this chat's workers finishes, without waiting for your turn.`, `${name} sırada (${backlog.length} bekliyor): bu sohbetin bir işçisi biter bitmez başlar, senin turunu beklemez.`))
    }
    const started = await startSpawn($, a)
    if (a.wait !== true || !name || 'deny' in started) return started
    return text(await waitForWorker($, name, Number(a.wait_minutes) || 10, await $.clock.now()))
  })

  on('tool.call', { tool: 'mcp__the-chief__lanes' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const action = String(a.action ?? '')
    const tpls = await laneTemplates($)
    const tplOf = (v: unknown) => (typeof v === 'string' ? tpls[v] : undefined)
    if (action === 'save_template') {
      const t = a.template as LaneTemplate | undefined
      if (!t || typeof t !== 'object' || !t.name || !t.repo || !t.path || !t.task) return { deny: 'template needs name, repo, path and task' }
      tpls[t.name] = t
      await laneSet($, LANE_KEYS.templates, tpls)
      return text(`Template ${t.name} saved: ${t.checks?.length ?? 0} checks, ${t.guard?.length ?? 0} guarded paths${t.tier ? `, tier ${t.tier}` : ''}.`)
    }
    if (action === 'templates') return text(Object.values(tpls).map(t => `${t.name} · ${t.path} · checks ${(t.checks ?? []).map(c => c.name).join('/') || '-'}${t.next?.length ? ` · next ${t.next.join(', ')}` : ''}`).join('\n') || 'No templates yet.')
    if (action === 'open') {
      const t = tplOf(a.template)
      if (!t) return { deny: `No template named ${String(a.template)}` }
      const names = Array.isArray(a.names) ? (a.names as unknown[]).map(String) : []
      if (!names.length) return { deny: 'names is required' }
      return text((await openLanes($, t, names, typeof a.after === 'string' ? a.after : undefined)).join('\n'))
    }
    if (action === 'checks') {
      const name = String(a.lane ?? '')
      const st = (await laneStates($))[name]
      if (!st) return { deny: `No lane named ${name}` }
      const results = await runLaneChecks($, st, tpls[st.template])
      await putLane($, name, { checks: results, phase: results.every(r => r.ok) ? 'ready' : 'failed' })
      return text(await laneTableText($))
    }
    if (action === 'workers') {
      await readCards($).catch(() => undefined)
      return text(workersText(await $.clock.now()))
    }
    if (action === 'table') return text(await laneTableText($))
    if (action === 'report') return text(await laneReportFor($, String(a.lane ?? '')))
    if (action === 'guard') {
      const name = String(a.lane ?? '')
      const st = (await laneStates($))[name]
      if (!st) return { deny: `No lane named ${name}` }
      const guard = [...new Set([...st.guard, ...(Array.isArray(a.add) ? (a.add as unknown[]).map(String) : [])])]
      await putLane($, name, { guard })
      return text(`${name} guard: ${guard.join(', ') || '-'} (applies to workers started from now on)`)
    }
    if (action === 'capacity') {
      const c = await laneCapacity($)
      const cleaned = a.cleanup === true ? await cleanLaneProcesses($) : 0
      return text(`Available RAM ${(c.freeMb / 1024).toFixed(1)} GB → ${c.workers} workers and ${c.heavy} heavy commands at once (max_parallel ${maxParallel()}; heavy commands wait for a slot).${a.cleanup === true ? ` Left-over processes killed: ${cleaned}.` : ''}`)
    }
    if (action === 'route') {
      const routes = await laneGet<Record<string, unknown>>($, LANE_KEYS.routes, {})
      const tier = asTier(a.tier)
      if (!tier) return text(`Custom routes: ${JSON.stringify(routes)} (empty = built-in lists; pass tier + routes, or tier + clear)`)
      if (a.clear === true) delete routes[tier]
      else if (Array.isArray(a.routes) && a.routes.length) routes[tier] = (a.routes as Array<Record<string, unknown>>).map(r => ({ cli: String(r.cli ?? ''), model: String(r.model ?? ''), effort: String(r.effort ?? ''), keeps: r.keeps === true }))
      else return { deny: 'routes (a non-empty list) or clear=true is required' }
      await laneSet($, LANE_KEYS.routes, routes)
      return text(`Route for ${tier}: ${routes[tier] ? JSON.stringify(routes[tier]) : 'built-in list'}`)
    }
    if (action === 'zen') {
      const record = a.refresh === true ? await zenRefresh($, true) : await zenRecord($)
      return text(zenLine(record, await $.clock.now()))
    }
    if (action === 'credits') {
      const credits = await laneGet<Record<string, Credit>>($, LANE_KEYS.credits, {})
      const cli = typeof a.cli === 'string' ? a.cli : ''
      if (cli) {
        credits[cli] = { cli, limit: Number(a.limit ?? credits[cli]?.limit ?? 0), used: Number(a.used ?? credits[cli]?.used ?? 0), until: typeof a.until === 'string' ? a.until : credits[cli]?.until, label: typeof a.label === 'string' ? a.label : credits[cli]?.label }
        await laneSet($, LANE_KEYS.credits, credits)
      }
      const now = await $.clock.now()
      return text(Object.values(credits).map(c => creditLine(c, cliLimitedUntil.get(c.cli), now)).join('\n') || 'No credit counters set.')
    }
    return { deny: 'action must be save_template, templates, open, checks, table, report, capacity, route, credits, zen or guard' }
  })

  on('tool.call', { tool: 'mcp__the-chief__list_agents' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const ended = (st: string) => st !== 'running' && st !== 'queued'
    if (a.clear === true) {
      const { value: before = [] } = await $.state.get(WORKERS)
      const { value: subsBefore = [] } = await $.state.get(SUBS)
      await update($, workers, list => (list ?? []).filter(w => !ended(w.status)))
      await update($, subs, list => (list ?? []).filter(x => !ended(x.status)))
      await saveRunWorkers($).catch(() => undefined)
      return text(`Cleared ${before.filter(w => ended(w.status)).length + subsBefore.filter(x => ended(x.status)).length} ended agents.`)
    }
    const { value: ws = [] } = await $.state.get(WORKERS)
    const { value: ss = [] } = await $.state.get(SUBS)
    const now = await $.clock.now()
    // agents this chat started with its own shell (opencode, qodercli …) are no spawn_worker records: found as processes
    await scanExternalAgents($).catch(() => undefined)
    const ext = extAgents.filter(x => x.until === null || a.all === true)
    const recent = (st: string, endedAt: number | null | undefined) => !ended(st) || a.all === true || (endedAt ?? now) > now - 30 * 60000
    const shownW = ws.filter(w => recent(w.status, w.endedAt))
    const shownS = ss.filter(x => recent(x.status, x.endedAt))
    const hidden = ws.length - shownW.length + ss.length - shownS.length
    // the same fields for every CLI (claude or zen/qoder/go): pid, its own log, the files it touched, its status
    const logs = new Map<string, { bytes: number; at: number }>()
    for (const w of shownW) logs.set(w.id, await logStat($, w))
    const lines = [
      ...shownW.map(w => `[cli] ${w.name} (id ${w.id}) · ${w.status} · ${CLIS[w.cli].label} ${w.model}${w.effort ? ` ${w.effort}` : ''} · ${fmtElapsed((w.endedAt ?? now) - w.startedAt)} · pid ${runs.get(w.id)?.pid || '-'} · log ${logs.get(w.id)?.bytes ?? 0} ${L('bytes', 'bayt')}${logs.get(w.id)?.at ? L(`, last write ${fmtElapsed(now - logs.get(w.id)!.at)} ago`, `, son yazım ${fmtElapsed(now - logs.get(w.id)!.at)} önce`) : ''} · now: ${w.now || w.tail[w.tail.length - 1] || '-'} · files: ${w.files.join(', ') || '-'}`),
      ...shownS.map(x => `[subagent] "${x.description}" (id ${x.id}) · ${x.status} · ${x.type} ${shortModel(x.model)} · ${fmtElapsed((x.endedAt ?? now) - x.startedAt)} · ${x.tools} steps · now: ${x.steps[x.steps.length - 1] ?? '-'} · files: ${x.files.join(', ') || '-'}`),
    ]
    for (const x of ext) lines.push(`[shell] ${x.name} (pid ${x.pid}) · ${x.until === null ? 'running' : 'ended'} · ${x.cli} ${x.model} · ${fmtElapsed((x.until ?? now) - x.since)} · started outside spawn_worker (stop it with its own process, not stop_agent)`)
    const tail = hidden > 0 ? `\n(${hidden} older ended agents hidden: list_agents all=true shows them, clear=true forgets them.)` : ''
    return text(lines.length ? lines.join('\n') + tail : `No agents${hidden > 0 ? ` running; ${hidden} ended ones hidden (all=true)` : ' yet'}.`)
  })

  on('tool.call', { tool: 'mcp__the-chief__agent_output' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const key = String(a.agent ?? '')
    // agents started with the chat's own shell have no captured output: say so, and say where to look
    const pid = Number(key.replace(/^ext:/, '').replace(/^pid\s*/i, ''))
    const ext = extAgents.find(x => x.pid === pid || x.name.toLowerCase() === key.trim().toLowerCase())
    const { worker, sub } = await findAgent($, key)
    // 20 lines unless asked: the tail of a run is what decides the next step, and every line is tokens
    const n = typeof a.lines === 'number' ? clamp(a.lines, 1, 500) : 20
    const cut = (l: string) => (l.length > 200 ? `${l.slice(0, 200)}…` : l)
    if (worker) {
      const wantRaw = a.raw === true
      // a detached claude/codex run writes out.log, a child run .squad/logs (.raw when raw is asked): one path helper for every CLI
      const path = runs.has(worker.id) ? logPathOf(worker) : workerLogPath(worker, wantRaw)
      let lines = worker.tail
      if (wantRaw || n > TAIL) {
        const file = await readText($, path).catch(() => '')
        if (file.trim()) lines = file.split(/\r?\n/)
      }
      const shown = lines.slice(-n).map(cut).join('\n')
      const now = await $.clock.now()
      const empty = worker.status === 'running' ? `(no parsed output lines yet after ${fmtElapsed(now - worker.startedAt)}; the process is alive. raw=true shows every line the CLI printed)` : '(the CLI printed nothing readable)'
      return text(`${worker.name} (${worker.id}) · ${worker.status}${worker.report ? `\nreport: ${oneLine(worker.report, 400)}` : ''}\n${shown || empty}\nlog files: ${workerLogPath(worker)} (parsed), ${workerLogPath(worker, true)} (raw, updated every few seconds); read them with Read for more.`)
    }
    if (sub) return text(`"${sub.description}" · ${sub.status}\nSteps:\n${sub.steps.slice(-n).map(cut).join('\n') || '-'}\n\nAnswer:\n${sub.result ? sub.result.slice(0, 3000) : '(not finished)'}`)
    const chiefCard = role === 'leader' && !worker && !sub && !ext ? findChief(key) : undefined
    if (chiefCard && chiefCard.leader === sid) return text(chiefOutputText(chiefCard, await $.clock.now()))
    if (ext) return text(`${ext.name} (pid ${ext.pid}) · ${ext.until === null ? 'running' : 'ended'} · ${ext.cli} ${ext.model} · ${fmtElapsed((ext.until ?? (await $.clock.now())) - ext.since)}\nIt was started with a shell command, not spawn_worker, so its output is not captured by The Chief. If it was started with a log file or redirect, read that; otherwise start such agents with spawn_worker (output and logs are then always readable here), or check the worktree with git status / git diff.`)
    return { deny: `No agent named ${key}. agent_output reads this chat's own agents (agent id or name); a chief's workers are in list_chiefs, and its chief id or name here shows them.` }
  })

  on('tool.call', { tool: 'mcp__the-chief__consult' as never }, async ($, e) => text(await runConsult($, e as unknown as Record<string, unknown>)))
  on('tool.call', { tool: 'mcp__the-chief__run_job' }, async ($, e) => text(await runJob($, e as unknown as Record<string, unknown>)))
  on('tool.call', { tool: 'mcp__the-chief__stop_agent' }, async ($, e) => text(await stopAgent($, String((e as unknown as Record<string, unknown>).agent ?? ''))))

  on('tool.call', { tool: 'mcp__the-chief__message_agent' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    return text(await messageAgent($, String(a.agent ?? ''), String(a.text ?? '')))
  })

  // the smooth sliders post their value here: "<lane id>:eff" or "<lane id>:n"
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const [laneId, which] = e.element.split(':')
    const v = Number((e.data as { value?: unknown } | null)?.value)
    if (laneId && Number.isFinite(v) && leaderLanes.some(l => l.id === laneId)) {
      if (which === 'eff') await patchLeaderLane($, laneId, { effort: clamp(Math.round(v), 0, EFFORT_WORDS.length - 1) })
      else if (which === 'n') await patchLeaderLane($, laneId, { count: clamp(Math.round(v) + 1, 1, MAX_CHIEFS) })
      else if (which === 'sub') await patchLeaderLane($, laneId, { subMax: clamp(Math.round(v) + 1, 1, MAX_SUBS) })
      return {}
    }
    if (laneId && Number.isFinite(v)) {
      if (which === 'eff') await patchLane($, laneId, { effort: clamp(Math.round(v), 0, EFFORTS.length - 1) })
      else if (which === 'n') await patchLane($, laneId, { count: clamp(Math.round(v) + 1, 1, MAX_AGENTS) })
    }
    return {}
  })

  // ---------- the pane ----------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = table
    const Input = e.surface !== 'mobile' && 'Input' in table ? table.Input : undefined
    await read($, tick)
    const storedTab = (await read($, tab)) ?? 'agents'
    // Başlangıç and Harcama are pages of Ayarlar now: an old stored tab, or /chief spend, lands on that page
    if (storedTab === 'startup' || storedTab === 'spend') settingsPage = storedTab
    const current: SquadTab = storedTab === 'startup' || storedTab === 'spend' ? 'settings' : storedTab
    const startupState = await read($, startup)
    const laneList = (await read($, lanes)) ?? []
    const goalList = (await read($, goals)) ?? []
    const workerList = (await read($, workers)) ?? []
    const subList = (await read($, subs)) ?? []
    const reportList = (await read($, reports)) ?? []
    const skillList = current === 'skills' ? await loadSkills($) : []
    const promptStore = current === 'prompts' ? await loadPrompts($) : null
    const themesBody = current === 'themes' ? await themesTab($, { Box, Text, Button, Svg: e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined, surface: e.surface, note: text => void Promise.resolve($.ui.toast(text)).catch(() => undefined) }) : null
    const notCopied = L('Not copied: no clipboard reached. The text is shown; select and copy it by hand.', 'Kopyalanmadı: panoya ulaşılamadı. Metin açıldı; seçip elle kopyala.')
    await loadConsults($)
    const isSummarizing = (await read($, summarizing)) ?? false
    const reportPick = await read($, openReport)
    const editingProvider = await read($, editingAtom)
    const local = summaryEngine() === 'auto' ? await localServer($) : null
    if (!local && !localSetup.step && summaryEngine() === 'auto') enqueue({ kind: 'local-setup' })
    const savedKeys = (await read($, savedKeysAtom)) ?? []
    const pick = await read($, selected)
    const now = await $.clock.now()
    const total = laneList.reduce((s, l) => s + l.count, 0)

    type Row = {
      id: string
      name: string
      kind: string
      /** The model alone, for the row's quiet right side. */
      short: string
      status: string
      since: number
      until: number | null
      now: string
      files: string[]
      /** Which CLI runs it (the mascot's colour), its effort and model, for the desktop card. */
      cli: string
      effort: string
      model: string
    }
    const rows: Row[] = [
      ...workerList.map(w => ({
        cli: w.cli as string,
        effort: w.effort ?? '',
        model: shortModel(w.model),
        id: w.id,
        name: w.name,
        kind: `${CLIS[w.cli].label} · ${shortModel(w.model)}${w.effort ? ` · ${w.effort}` : ''}`,
        short: shortModel(w.model).replace(/-\d.*$/, ''),
        status: w.status,
        since: w.startedAt,
        until: w.endedAt,
        now: oneLine(saidOf(w), 160) || (w.status === 'running' ? L('Starting…', 'Başlıyor…') : w.status === 'done' ? L('Done', 'Bitti') : w.now),
        files: w.files,
      })),
      ...subList.map(s => ({
        cli: 'claude',
        effort: '',
        model: shortModel(s.model),
        id: s.id,
        name: s.description || s.type,
        kind: `Subagent · ${s.type} · ${shortModel(s.model)}`,
        short: `${s.type} · ${shortModel(s.model).replace(/-\d.*$/, '')}`,
        status: s.status,
        since: s.startedAt,
        until: s.endedAt,
        now: s.status === 'running' ? s.steps[s.steps.length - 1] ?? L('Thinking…', 'Düşünüyor…') : oneLine(s.result, 110) || L(`${s.tools} steps`, `${s.tools} adım`),
        files: s.files,
      })),
      ...extAgents.map(a => ({
        cli: a.cli,
        effort: '',
        model: a.model,
        id: `ext:${a.pid}`,
        name: a.name,
        kind: `${a.cli} · ${a.model}`,
        short: a.model,
        status: a.until === null ? 'running' : 'done',
        since: a.since,
        until: a.until,
        now: a.now,
        files: [] as string[],
      })),
    ]
    const order = (st: string) => (st === 'running' ? 0 : st === 'queued' ? 1 : st === 'failed' ? 2 : st === 'stopped' ? 3 : 4)
    rows.sort((a, b) => order(a.status) - order(b.status) || b.since - a.since)
    const working = rows.filter(r => r.status === 'running').length
    const failed = rows.filter(r => r.status === 'failed').length
    const done = rows.filter(r => r.status === 'done').length
    const queued = rows.filter(r => r.status === 'queued').length
    const goal = goalList.find(g => g.status === 'active')

    const look = (status: string) =>
      status === 'queued'
        ? { mark: '◌', color: AMBER, word: 'queued' }
        : status === 'running'
        ? { mark: '●', color: VIOLET, word: 'working' }
        : status === 'done'
          ? { mark: '✓', color: GREEN, word: 'done' }
          : status === 'stopped'
            ? { mark: '■', color: AMBER, word: 'stopped' }
            : { mark: '✗', color: RED, word: 'failed' }

    const label = (t: string, width = 8) => (
      <Box width={width} flexShrink={0}>
        <Text dimColor>{t}</Text>
      </Box>
    )

    const slider = (key: string, name: string, value: number, steps: number, shown: string, cell: string, onSet: ((v: number) => void) | null) => (
      <Box flexDirection="row">
        {label(name)}
        <Button key={`${key}-`} label="‹" plain dimColor={!onSet} onPress={() => onSet?.(clamp(value - 1, 0, steps - 1))} />
        <Box flexDirection="row" marginX={1}>
          {Array.from({ length: steps }, (_, i) =>
            onSet && i <= value ? <Text color={rampAt(steps === 1 ? 1 : i / (steps - 1))}>{cell}</Text> : <Text dimColor>{cell.replace(/▰/g, '▱')}</Text>,
          )}
        </Box>
        <Button key={`${key}+`} label="›" plain dimColor={!onSet} onPress={() => onSet?.(clamp(value + 1, 0, steps - 1))} />
        <Box key={`${key}=`} marginLeft={1}>
          <Text bold={!!onSet} dimColor={!onSet} color={onSet ? rampAt(steps === 1 ? 1 : value / (steps - 1)) : undefined}>
            {shown}
          </Text>
        </Box>
      </Box>
    )

    const Select = e.surface !== 'mobile' && 'Select' in table ? table.Select : undefined
    // a dropdown where the surface draws one; a row of chips on the phone
    const picker = (key: string, name: string, options: readonly { value: string; text: string }[], value: string, onPick: (v: string) => void) =>
      Select ? (
        <Box flexDirection="row">
          {label(name)}
          <Select key={key} options={selectOptions(options.map(o => ({ value: o.value, label: o.text })), value)} value={value} onSelect={v => onPick(v)} />
        </Box>
      ) : (
        chips(key, name, options, value, onPick)
      )

    const chips = (key: string, name: string, options: readonly { value: string; text: string }[], value: string, onPick: (v: string) => void) => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {label(name)}
        {options.map(o =>
          o.value === value ? (
            <Button key={`${key}:${o.value}`} label={o.text} variant="primary" onPress={() => onPick(o.value)} />
          ) : (
            <Button key={`${key}:${o.value}`} label={o.text} plain dimColor onPress={() => onPick(o.value)} />
          ),
        )}
      </Box>
    )

    // ---------- Agents: the list ----------
    const agentRow = (r: Row) => {
      const l = look(r.status)
      const isLive = r.status === 'running'
      return (
        <Box key={`row:${r.id}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1} flexShrink={1}>
              <Text color={l.color}>{l.mark}</Text>
              <Button key={`open:${r.id}`} label={r.name.slice(0, 40)} plain onPress={() => void $.state.set(SELECTED, r.id)} />
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{r.short} · {fmtElapsed((r.until ?? now) - r.since)}</Text>
            </Box>
          </Box>
          <Box paddingLeft={2}>
            <Text dimColor={!isLive} wrap="truncate-end">{r.now}</Text>
          </Box>
        </Box>
      )
    }

    const PaneSvg = e.surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
    const pic = (key: string, source: string, alt: string) => (PaneSvg ? <PaneSvg key={key} source={source} alt={alt} /> : null)
    const paneBudget = (await read($, budgetAtom)) ?? null
    const firstStart = rows.length ? Math.min(...rows.map(r => r.since)) : now
    const statCard = (key: string, label: string, value: string) => (
      <Box key={key} flexDirection="column" flexGrow={1} paddingX={1} borderStyle="round" borderColor="#2a2a2a" backgroundColor="#161616">
        <Text dimColor>{label}</Text>
        <Text bold>{value}</Text>
      </Box>
    )
    const deskRow = (r: Row) => {
      const l = look(r.status)
      const ew = effortWord(r.effort)
      const isLive = r.status === 'running'
      return (
        <Box key={`row:${r.id}`} flexDirection="row" columnGap={1} alignItems="center" paddingY={0}>
          {pic(`mascot:${r.id}`, mascotSvg(CLI_TINT[r.cli] ?? CLI_TINT.custom!, 26), `${r.cli} agent`)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Button key={`open:${r.id}`} label={r.name.slice(0, 48)} plain onPress={() => void $.state.set(SELECTED, r.id)} />
              <Text color={l.color}>{r.status === 'queued' ? '◷' : l.mark}</Text>
            </Box>
            <Box flexDirection="row" columnGap={1}>
              {ew && <Text color={ew.color}>{ew.word}</Text>}
              <Text dimColor>{r.model}{r.status !== 'queued' ? ` · ${fmtElapsed((r.until ?? now) - r.since)}` : ''}</Text>
            </Box>
            {r.now ? <Text dimColor={!isLive} wrap="truncate-end">{r.now}</Text> : null}
          </Box>
        </Box>
      )
    }
    const group = (key: string, title: string, list: Row[]) =>
      list.length === 0 ? null : (
        <Box key={key} flexDirection="column" rowGap={1}>
          <Text dimColor>{title} · {list.length}</Text>
          {list.map(deskRow)}
        </Box>
      )
    const endedGroup = (list: Row[]) =>
      list.length === 0 ? null : (
        <Box key="grp-ended" flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button key="ended-toggle" label={`${endedOpen ? '▾' : '▸'} ${L('Done', 'Bitti')} · ${list.length}`} plain dimColor onPress={() => {
              endedOpen = !endedOpen
              void update($, tick, n => (n ?? 0) + 1)
            }} />
            <Button key="clear-done" label={L("Clear", "Temizle")} plain dimColor onPress={() => {
              void update($, workers, l => (l ?? []).filter(w => w.status === 'running'))
              void update($, subs, l => (l ?? []).filter(s => s.status === 'running'))
              extAgents = extAgents.filter(a => a.until === null)
            }} />
          </Box>
          {endedOpen ? list.map(deskRow) : null}
        </Box>
      )
    const desktopList = () => (
      <Box flexDirection="column" rowGap={1}>
        <Box key="agents-stats" flexDirection="row" columnGap={1}>
          {statCard('stat-cost', 'Maliyet', `≈$${(paneBudget?.spentUsd ?? 0).toFixed(2)}`)}
          {statCard('stat-tokens', 'Token', fmtTokens(paneBudget?.spentTokens ?? 0))}
          {statCard('stat-time', L('Time', 'Süre'), fmtElapsed(now - firstStart))}
        </Box>
        {rows.length === 0 ? (
          <Box flexDirection="column" paddingY={1}>
            <Text>{L(`No agents running yet.`, `Henüz çalışan ajan yok.`)}</Text>
            <Text dimColor>{L(`Ask Claude to start a subagent; they all show up here.`, `Claude'dan alt ajan başlatmasını iste; hepsi burada görünür.`)}</Text>
          </Box>
        ) : (
          <Box flexDirection="column" rowGap={1}>
            {group('grp-running', L('Running', 'Çalışıyor'), rows.filter(r => r.status === 'running'))}
            {group('grp-queued', L('Queued', 'Sırada'), rows.filter(r => r.status === 'queued'))}
            {endedGroup(rows.filter(r => r.status !== 'running' && r.status !== 'queued'))}
          </Box>
        )}
      </Box>
    )

    const agentsList = () => PaneSvg ? desktopList() : (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box key="agents-summary" flexDirection="row" columnGap={2}>
            <Text color={working ? VIOLET : undefined} bold={working > 0} dimColor={!working}>● {working} working</Text>
            <Text color={done ? GREEN : undefined} dimColor={!done}>✓ {done} done</Text>
            {failed > 0 && <Text color={RED}>✗ {failed} failed</Text>}
            {queued > 0 && <Text color={AMBER}>◌ {queued} queued</Text>}
          </Box>
          <Box flexDirection="row" columnGap={1}>
            {rows.length > working && (
              <Button key="clear-done" label="Clear" plain dimColor onPress={() => {
                void update($, workers, l => (l ?? []).filter(w => w.status === 'running'))
                void update($, subs, l => (l ?? []).filter(s => s.status === 'running'))
              }} />
            )}
          </Box>
        </Box>
        {rows.length === 0 ? (
          <Box flexDirection="column" paddingY={1}>
            <Text>{L(`No agents running yet.`, `Henüz çalışan ajan yok.`)}</Text>
            <Text dimColor>{L(`Set up lanes in the Squad tab and press Launch, or ask Claude to start a subagent. They all show up here.`, `Squad sekmesinde lane'leri ayarlayıp Launch'a bas; ya da Claude'dan alt ajan başlatmasını iste. Hepsi burada görünür.`)}</Text>
          </Box>
        ) : (
          <Box flexDirection="column" rowGap={1}>{rows.map(agentRow)}</Box>
        )}
      </Box>
    )

    // ---------- Agents: one agent ----------
    const section = (title: string, body: unknown) => (
      <Box flexDirection="column">
        <Text dimColor>{title}</Text>
        {body as never}
      </Box>
    )

    if (pick !== termBackFor) {
      termBackFor = pick ?? ''
      termBack = 0
    }
    // plain view: what the agent wrote (text, errors, the result) and its commands and tool calls as short grey lines, never their output
    const termAll = (pick ? await readTerm($, workerList.find(x => x.id === pick)) : []).filter(l => /^(● |│ |✗|■ |\$ |▸ )/.test(l))
    const termMax = Math.max(0, termAll.length - TERM_WINDOW)
    termBack = Math.min(termBack, termMax)
    const termShown = termAll.slice(Math.max(0, termAll.length - TERM_WINDOW - termBack), termAll.length - termBack)
    const termScroll = (to: number) => void update($, tick, n => {
      termBack = Math.max(0, Math.min(termMax, to))
      return (n ?? 0) + 1
    })
    const termLine = (l: string, i: number) => {
      const k = `t${i}`
      const body = l.slice(2)
      if (l.startsWith('$ ') || l.startsWith('▸ ')) return <Box key={k} paddingLeft={2}><Text color="#6b7078" wrap="truncate-end">{l}</Text></Box>
      if (l.startsWith('● ')) return <Box key={k} marginTop={i > 0 ? 1 : 0} flexDirection="row" columnGap={1}><Text bold color="#ffffff">●</Text><Text bold color="#ffffff" wrap="wrap">{body}</Text></Box>
      if (l.startsWith('│ ')) return <Box key={k} paddingLeft={2}><Text bold color="#ffffff" wrap="wrap">{body}</Text></Box>
      if (l.startsWith('✗')) return <Box key={k} paddingLeft={2}><Text color={RED} wrap="truncate-end">{l}</Text></Box>
      if (l.startsWith('■ ')) return <Box key={k} marginTop={1}><Text color={GREEN} bold wrap="wrap">{l}</Text></Box>
      return null
    }
    const detail = (r: Row, w: SquadWorker | undefined, s: SquadSub | undefined) => {
      const l = look(r.status)
      const isLive = r.status === 'running'
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button key="back" label="‹ All agents" plain dimColor onPress={() => void $.state.set(SELECTED, null)} />
            <Box flexDirection="row" columnGap={1}>
              <Button key={`copy-prompt:${r.id}`} label={L('Copy prompt', 'Promptu kopyala')} plain dimColor onPress={() => void agentPrompt($, w, s).then(async t => {
                if (!t.trim()) return void $.ui.toast(L('This agent has no prompt to copy.', 'Bu ajanın kopyalanacak promptu yok.'))
                if (await copyText($, e.surface, t)) return void $.ui.toast(L('Prompt copied', 'Prompt kopyalandı'))
                uncopied = { key: r.id, text: t }
                bump()
                $.ui.toast(notCopied)
              })} />
              <Button key={`save-prompt:${r.id}`} label={L('Save prompt', 'Promptu kaydet')} plain dimColor onPress={() => void agentPrompt($, w, s).then(t => savePrompt($, r.name, t)).then(m => $.ui.toast(m))} />
              {isLive && <Button key={`stop:${r.id}`} label="Stop" onPress={() => void stopAgent($, r.id)} />}
            </Box>
          </Box>
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text color={l.color}>{l.mark}</Text>
              <Text bold color="#ffffff">{r.name}</Text>
              <Box key="detail-status">
                <Text color={l.color}>{l.word}</Text>
              </Box>
              <Text dimColor>· {fmtElapsed((r.until ?? now) - r.since)}{w && w.runs > 1 ? ` · run ${w.runs}` : ''}</Text>
            </Box>
            <Text dimColor>{r.kind}{w ? ` · brief ${w.brief}` : ''}</Text>
          </Box>
          {uncopied.key === r.id && section(L('PROMPT (not copied: select it by hand)', 'PROMPT (kopyalanmadı: elle seç)'), <Box borderStyle="round" borderColor="#333333" paddingX={1}><Text wrap="wrap">{uncopied.text}</Text></Box>)}
          {section(L('NOW', 'ŞU AN'), <Text>{r.now || '—'}</Text>)}
          {r.files.length > 0 && section(L('FILES', 'DOSYALAR'), <Text wrap="wrap">{r.files.slice(-8).join('  ·  ')}</Text>)}
          {s && s.steps.length > 0 &&
            section(L('STEPS', 'ADIMLAR'), (
              <Box flexDirection="column">
                {s.steps.slice(-8).map((step, i, arr) => (
                  <Text dimColor={i < arr.length - 1} wrap="truncate-end">{i === arr.length - 1 && isLive ? '› ' : '  '}{step}</Text>
                ))}
              </Box>
            ))}
          {w &&
            section(L('TERMINAL', 'TERMİNAL'), (
              <Box flexDirection="column" borderStyle="round" borderColor="#333333" backgroundColor="#0b0b0b" paddingX={1}>
                <Box key="term-head" flexDirection="row" columnGap={1} marginBottom={1}>
                  <Text color="#ff5f56">●</Text><Text color="#ffbd2e">●</Text><Text color="#27c93f">●</Text>
                  <Text dimColor>{r.name} · {isLive ? L('live', 'canlı') : L('done', 'bitti')}</Text>
                  {termMax > 0 && (
                    <Box flexDirection="row" columnGap={1}>
                      <Button key="term-up" label="▲" plain dimColor onPress={() => termScroll(termBack + 5)} />
                      <Button key="term-down" label="▼" plain dimColor onPress={() => termScroll(termBack - 5)} />
                      <Button key="term-end" label={L('end', 'son')} plain dimColor onPress={() => termScroll(0)} />
                      <Text dimColor>{termAll.length - termBack}/{termAll.length}</Text>
                    </Box>
                  )}
                </Box>
                {termShown.length
                  ? termShown.map(termLine)
                  : <Text dimColor>{L(`(nothing written yet)`, `(henüz bir şey yazmadı)`)}</Text>}
              </Box>
            ))}
          {s && s.result && section(L('RESULT', 'SONUÇ'), (
            <Box borderStyle="round" borderColor={GREEN} paddingX={1}>
              <Markdown text={s.result.slice(0, 3000)} />
            </Box>
          ))}
          {Input && !isLive && (
            <Input
              key={`msg:${r.id}`}
              placeholder={L(`Write a follow-up to ${r.name}, Enter`, `${r.name} ajanına takip mesajı yaz, Enter`)}
              submitLabel="send"
              onSubmit={v => {
                const t = v.trim()
                if (t) void messageAgent($, r.id, t).then(m => $.ui.toast(m))
              }}
            />
          )}
        </Box>
      )
    }

    const skillsView = () => {
      const q = skillQuery.trim().toLowerCase()
      const shown = skillList.filter(x => !q || `${x.name} ${x.desc}`.toLowerCase().includes(q))
      return (
        <Box flexDirection="column" rowGap={2}>
          <Box flexDirection="column" rowGap={1}>
            <Text dimColor>{shown.length} {L('skills · click one to add it to the chat box', 'skill · tıklayınca sohbet kutusuna eklenir')}</Text>
            {Input && (
              <Input key="skill-q" placeholder="skill ara, Enter" submitLabel="ara" onSubmit={v => {
                skillQuery = v
                void update($, tick, n => (n ?? 0) + 1)
              }} />
            )}
          </Box>
          {SKILL_CATEGORIES.map(c => {
            const items = shown.filter(x => skillCategory(x.name) === c)
            if (!items.length) return null
            return (
              <Box key={`cat:${c}`} flexDirection="column" rowGap={1}>
                <Text bold color={VIOLET}>{skillCatLabel(c)} · {items.length}</Text>
                {items.map(x => (
                  <Box key={`skill:${x.path}`} flexDirection="column" paddingLeft={1}>
                    <Button key={`skill-btn:${x.path}`} label={x.name} plain onPress={() => void $.prompt.fill({ text: skillInsert(x), mode: 'insert' }).then(r => $.ui.toast(r.isFilled ? L(`${x.name} added to the chat box`, `${x.name} sohbet kutusuna eklendi`) : L('Could not add it to the chat box right now', 'Sohbet kutusu şu an dolu değil, eklenemedi')))} />
                    <Text dimColor wrap="wrap">{oneLine(x.desc, 160)}{x.src === 'clients' ? ' · Clients' : ''}</Text>
                  </Box>
                ))}
              </Box>
            )
          })}
        </Box>
      )
    }

    const agentsView = () => {
      const r = rows.find(x => x.id === pick)
      if (!r) return agentsList()
      return detail(r, workerList.find(x => x.id === pick), subList.find(x => x.id === pick))
    }

    // ---------- Overview: every report, newest first, by day ----------
    const overviewView = () => {
      takePendingOverviews($)
      const sorted = [...reportList].sort((a, b) => b.at - a.at)
      const latest = sorted[0]
      const expanded = reportPick === 'none' ? undefined : (sorted.find(r => r.id === reportPick) ?? latest)
      const days = [...new Set(sorted.map(r => r.day))]
      const kindColor = (k: SquadReport['kind']) => (k === 'daily' ? VIOLET : k === 'auto' ? GREEN : undefined)
      const scopeText = (r: SquadReport) => (r.scope === 'session' ? L('whole session', 'tüm session') : L('today', 'bugün'))
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1} flexWrap="wrap">
            <Box key="overview-meta">
              <Text dimColor>{isSummarizing ? L('Sonnet 5.5 is summarizing…', 'Sonnet 5.5 özetliyor…') : latest ? `${dayLabel(latest.day, now)} ${timeOf(latest.at)} · ${kindLabel()[latest.kind]} · ${scopeText(latest)}` : 'No overview yet'}</Text>
            </Box>
            <Box flexDirection="row" columnGap={1}>
              {sorted.length > 0 && <Button key="overview-fold" label={expanded ? L('Close all', 'Hepsini kapat') : L('Open the latest', 'Sonuncuyu aç')} plain dimColor onPress={() => void $.state.set(OPEN_REPORT, expanded ? 'none' : null)} />}
              <Button key="overview-today" label={L("Today", "Bugün")} variant="primary" onPress={() => enqueue({ kind: 'overview', report: 'manual', scope: 'today' })} />
              <Button key="overview-session" label={L("Whole session", "Tüm session")} onPress={() => enqueue({ kind: 'overview', report: 'manual', scope: 'session' })} />
            </Box>
          </Box>
          {sorted.length === 0 && <Text dimColor>{L(`No overview yet. Press Today (since midnight) or Whole session; it writes what went well and what went wrong. It is also written once a day by itself at ${DAILY_HOUR}:00 (when you open this tab).`, `Henüz özet yok. Bugün (gece 00:00'dan beri) ya da Tüm session'a bas; olumlu ve olumsuz gelişmeleri yazar. Her gün ${DAILY_HOUR}:00'te bir kez kendiliğinden de yazılır (bu sekmeyi açtığında).`)}</Text>}
          {days.map(day => (
            <Box key={`day:${day}`} flexDirection="column">
              <Text bold>{dayLabel(day, now)}</Text>
              {sorted.filter(r => r.day === day).map(r => {
                const isOpen = r.id === expanded?.id
                return (
                  <Box key={`rep:${r.id}`} flexDirection="column">
                    <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
                      <Button key={`open-report:${r.id}`} label={`${isOpen ? '▾' : '▸'} ${timeOf(r.at)} · ${kindLabel()[r.kind]} · ${scopeText(r)}`} plain dimColor={!isOpen} onPress={() => void $.state.set(OPEN_REPORT, isOpen ? 'none' : r.id)} />
                      <Button key={`rm-report:${r.id}`} label={L("✕ Delete", "✕ Sil")} plain dimColor onPress={() => void removeReport($, r.id)} />
                    </Box>
                    {isOpen ? (
                      <Box flexDirection="column" borderStyle="round" borderColor={kindColor(r.kind) ?? '#333333'} paddingX={1}>
                        <Markdown text={r.text} />
                      </Box>
                    ) : (
                      <Box paddingLeft={2}>
                        <Text dimColor wrap="truncate-end">{oneLine(r.text.replace(/[#*_`>-]/g, ' '), 90)}</Text>
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          ))}
        </Box>
      )
    }

    // the bottom right: what this computer has left, and what the sessions hold when this chat leads them
    const footerRam = () => {
      const free = freeSeen && Number.isFinite(freeSeen.mb) ? L(`${(freeSeen.mb / 1024).toFixed(1)} GB free`, `${(freeSeen.mb / 1024).toFixed(1)} GB boş`) : ''
      const open = hqCards.filter(c => now - c.updatedAt < 2 * 60000 || c.sid === sid).length || 1
      const sessions = role === 'leader' ? `${myChiefs.length} / ${open} sessions` : `${open} sessions`
      return [sessions, free || L('Measuring RAM…', 'RAM ölçülüyor…')].join(' · ')
    }

    // ---------- Leader mode, Sessions: the chiefs as rows, like agents ----------
    const myChiefs = hqCards.filter(c => c.role === 'chief' && c.leader === sid)
    const freeChats = hqCards.filter(c => adoptable(c, sid, now))
    const isLiveCard = (c: HqCard) => now - c.updatedAt < 90000
    const sessionLook = (c: HqCard) => (!isLiveCard(c) ? { mark: '○', color: undefined, word: 'away' } : c.working > 0 ? { mark: '●', color: VIOLET, word: 'working' } : { mark: '✓', color: GREEN, word: 'idle' })
    const sessionNow = (c: HqCard) => c.agents[0] ? c.agents[0].now || c.agents[0].name : c.goal ? `◎ ${c.goal}` : L('Idle', 'Boşta')
    const ramOf = (id: string) => sessionRam[hqCards.find(c => c.sid === id)?.engine ?? id] ?? sessionRam[id]
    const ramText = (id: string) => {
      const mb = ramOf(id)
      return mb ? (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`) : ''
    }
    const sessionKind = (c: HqCard) => [c.working ? `${c.working} ${L('agents', 'ajan')}` : '', ramText(c.sid)].filter(Boolean).join(' · ')
    const sessionSetup = (c: HqCard) => [c.model ? shortModel(c.model) : 'model auto', c.effort || 'effort auto'].join(' · ')
    const sendConfig = (c: HqCard, cfg: ChiefConfig) => void sendTo($, c.sid, 'configure', { config: cfg }).then(() => $.ui.toast(L(`${c.title}: settings sent`, `${c.title}: ayar gönderildi`)))
    const modelOptions = SUB_MODELS.map(m => ({ value: m.value, text: m.value === 'auto' ? 'auto' : m.text }))
    const effortOptions = [{ value: 'auto', text: 'auto' }, ...EFFORT_WORDS.map(w => ({ value: w, text: w }))]

    const sessionRow = (c: HqCard) => {
      const l = sessionLook(c)
      return (
        <Box key={`srow:${c.sid}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1} flexShrink={1}>
              <Text color={l.color} dimColor={!l.color}>{l.mark}</Text>
              <Button key={`open:chief:${c.sid}`} label={titleOf(c).slice(0, 48)} plain onPress={() => void $.state.set(SELECTED, `chief:${c.sid}`)} />
            </Box>
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              <Button key={`go:${c.sid}`} label={L("Open ↗", "Aç ↗")} plain dimColor onPress={() => void openSession($, c.sid)} />
            </Box>
          </Box>
        </Box>
      )
    }

    const sessionsList = () => {
      const workingCount = myChiefs.filter(c => isLiveCard(c) && c.working > 0).length
      const idleCount = myChiefs.filter(c => isLiveCard(c) && c.working === 0).length
      const away = myChiefs.length - workingCount - idleCount
      const openGoalList = goalList.filter(g => g.status !== 'done')
      return (
        <Box flexDirection="column" rowGap={1}>
          {myChiefs.length === 0 ? (
            <Box flexDirection="column" paddingY={1}>
              <Text>{L(`You manage no chats yet.`, `Henüz yönettiğin sohbet yok.`)}</Text>
              <Text dimColor>{L(`Add a chat below or ask the Leader.`, `Aşağıdan bir sohbeti ekle ya da Leader'dan iste.`)}</Text>
            </Box>
          ) : (
            <Box flexDirection="column" rowGap={1}>{myChiefs.map(sessionRow)}</Box>
          )}
        </Box>
      )
    }

    const sessionDetail = (c: HqCard) => {
      const l = sessionLook(c)
      const heard = leaderLog.filter(x => x.from === c.sid).slice(-8)
      const sub = c.config.subagents ?? {}
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button key="back" label="‹ Sessions" plain dimColor onPress={() => void $.state.set(SELECTED, null)} />
            <Box flexDirection="row" columnGap={1}>
              {c.working === 0 && <Button key={`park:${c.sid}`} label={`Park${ramText(c.sid) ? ` · ${ramText(c.sid)}` : ''}`} plain onPress={() => void parkSession($, c)} />}
              <Button key={`release:${c.sid}`} label={L("Release", "Bırak")} onPress={() => {
                void sendTo($, c.sid, 'release')
                void $.state.set(SELECTED, null)
              }} />
            </Box>
          </Box>
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text color={l.color} dimColor={!l.color}>{l.mark}</Text>
              <Text bold color={c.working ? VIOLET : undefined}>{titleOf(c)}</Text>
              <Box key="detail-status">
                <Text color={l.color} dimColor={!l.color}>{l.word === 'working' ? L('working', 'çalışıyor') : l.word === 'idle' ? L('idle', 'boşta') : L('off', 'kapalı')}</Text>
              </Box>
              <Button key={`go-detail:${c.sid}`} label={L("Go to chat ↗", "Sohbete git ↗")} plain onPress={() => void openSession($, c.sid)} />
            </Box>
            <Text dimColor>{[sessionSetup(c), sessionKind(c)].filter(Boolean).join(' · ')}</Text>
          </Box>
          {section(L('GOAL', 'HEDEF'), <Text wrap="wrap">{c.goal || '—'}</Text>)}
          {section(L('NOW', 'ŞU AN'), c.agents.length ? (
            <Box flexDirection="column">
              {c.agents.map((a, i) => (
                <Text key={`sa:${i}`} wrap="truncate-end">● {a.name}: {a.now}</Text>
              ))}
            </Box>
          ) : <Text dimColor>{L(`Idle`, `Boşta`)}</Text>)}
          {section(L('SETTINGS', 'AYARLAR'), (
            <Box flexDirection="column">
              {picker(`cfg:${c.sid}:model`, 'Model', modelOptions, c.config.model || 'auto', v => sendConfig(c, { model: v === 'auto' ? '' : v }))}
              {picker(`cfg:${c.sid}:effort`, 'Effort', effortOptions, c.config.effort || 'auto', v => sendConfig(c, { effort: v === 'auto' ? '' : v }))}
              {picker(`cfg:${c.sid}:submodel`, 'Subagent', modelOptions, sub.model || 'auto', v => sendConfig(c, { subagents: { ...sub, model: v === 'auto' ? undefined : v } }))}
              {picker(`cfg:${c.sid}:subeffort`, 'Sub effort', effortOptions, sub.effort || 'auto', v => sendConfig(c, { subagents: { ...sub, effort: v === 'auto' ? undefined : v } }))}
              <Box flexDirection="row" columnGap={1}>
                {label(L('At once', 'Aynı anda'))}
                <Button key={`cfg:${c.sid}:max-`} label="−" plain dimColor onPress={() => sendConfig(c, { subagents: { ...sub, max: clamp((sub.max ?? 3) - 1, 1, MAX_SUBS) } })} />
                <Box key={`cfg:${c.sid}:max=`}>
                  <Text bold color={rampAt(((sub.max ?? 3) - 1) / (MAX_SUBS - 1))}>{sub.max ?? 'auto'}</Text>
                </Box>
                <Button key={`cfg:${c.sid}:max+`} label="+" plain dimColor onPress={() => sendConfig(c, { subagents: { ...sub, max: clamp((sub.max ?? 3) + 1, 1, MAX_SUBS) } })} />
                <Text dimColor>subagent</Text>
              </Box>
              {/* the two per-chief switches: the 2-compact / 8-hour handoff, and the 50-minute idle compact */}
              <Box flexDirection="row" columnGap={1} flexWrap="wrap">
                {label('Otomatik devir')}
                <Button key={`cfg:${c.sid}:handoff`} label={c.config.handoff === false ? L('off', 'kapalı') : L('on', 'açık')} plain onPress={() => sendConfig(c, { handoff: c.config.handoff === false })} />
                <Text dimColor>·</Text>
                {label(L('Idle compact', 'Boşta compact'))}
                <Button key={`cfg:${c.sid}:compact`} label={c.config.compact === false ? L('off', 'kapalı') : L('on', 'açık')} plain onPress={() => sendConfig(c, { compact: c.config.compact === false })} />
              </Box>
            </Box>
          ))}
          {c.brief && section(L('LAST SUMMARY', 'SON ÖZETİ'), (
            <Box borderStyle="round" borderColor="#3a3a44" paddingX={1}>
              <Text wrap="wrap">{c.brief}</Text>
            </Box>
          ))}
          {heard.length > 0 && section(L('REPORTS', 'RAPORLAR'), (
            <Box flexDirection="column">
              {heard.map((x, i) => (
                <Text key={`heard:${i}`} dimColor={i < heard.length - 1} wrap="truncate-end">{timeOf(x.at)} · {x.line}</Text>
              ))}
            </Box>
          ))}
          {Input && (
            <Input key={`msg:chief:${c.sid}`} placeholder={L("Message this chat, Enter", "Bu sohbete mesaj yaz, Enter")} submitLabel="send" onSubmit={v => {
              const t = v.trim()
              if (t) void sendTo($, c.sid, 'message', { text: t }).then(() => $.ui.toast(L(`Sent to ${titleOf(c)}`, `${titleOf(c)} sohbetine gönderildi`)))
            }} />
          )}
        </Box>
      )
    }

    const sessionsView = () => {
      const chosen = typeof pick === 'string' && pick.startsWith('chief:') ? myChiefs.find(c => `chief:${c.sid}` === pick) : undefined
      return chosen ? sessionDetail(chosen) : sessionsList()
    }

    // ---------- Leader, as a tab: the main goal and the chats it can lead; before that, the switch ----------
    const leaderTab = () => {
      if (role !== 'leader') return leaderView()
      const openGoalList = goalList.filter(g => g.status !== 'done')
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text color={VIOLET}>{L(`★ Main goal`, `★ Ana hedef`)}</Text>
            {Select && openGoalList.length > 0 ? (
              <Select key="leader-main" options={selectOptions([{ value: '', label: L('— pick —', '— seç —') }, ...openGoalList.map(g => ({ value: g.id, label: oneLine(g.text, 60) }))], mainGoalId)} value={mainGoalId} onSelect={v => void setMainGoal($, v)} />
            ) : (
              <Box key="leader-main">
                <Text>{goalList.find(g => g.id === mainGoalId)?.text || L('none: add one in the Goals tab', 'yok: Goals sekmesinden ekle')}</Text>
              </Box>
            )}
          </Box>
          <Text dimColor>{L('CHATS YOU CAN MANAGE', 'YÖNETİLEBİLECEK SOHBETLER')} · {freeChats.length}</Text>
          {freeChats.length === 0 && <Text dimColor>{L(`No other open chats.`, `Açık başka sohbet yok.`)}</Text>}
          {freeChats.slice(0, 12).map(c => (
            <Box key={`free:${c.sid}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Text wrap="truncate-end">○ {titleOf(c)}</Text>
              <Box flexDirection="row" columnGap={1} flexShrink={0}>
                <Button key={`go:${c.sid}`} label={L("Open ↗", "Aç ↗")} plain dimColor onPress={() => void openSession($, c.sid)} />
                <Button key={`adopt:${c.sid}`} label={L("Manage", "Yönet")} plain onPress={() => void sendTo($, c.sid, 'join', {})} />
              </Box>
            </Box>
          ))}
          <Button key="leader-off-tab" label={L("Stop being Leader", "Leader'ı bırak")} plain dimColor onPress={() => {
            for (const c of myChiefs) void sendTo($, c.sid, 'release')
            void setRole($, 'solo')
          }} />
        </Box>
      )
    }

    // ---------- Oturum: what this chat is (solo, chief or leader), and handing it over to a new one ----------
    const sessionTab = () => (
      <Box flexDirection="column" rowGap={1}>
        <Box key="session-leader" flexDirection="column" borderStyle="round" borderColor="#333333" paddingX={1} rowGap={1}>
          <Text bold>{role === 'leader' ? L('★ This chat is the Leader', '★ Bu sohbet Leader') : role === 'chief' ? L('This chat is a chief', 'Bu sohbet bir chief') : L('Leader', 'Lider')}</Text>
          {leaderTab()}
        </Box>
        <Box key="session-handoff" flexDirection="column" borderStyle="round" borderColor="#333333" paddingX={1} rowGap={1}>
          <Text bold>{L('Handoff', 'Devir (handoff)')}</Text>
          {!handedOff && compactsHere >= HANDOFF_WARN && (
            <Box key="handoff-due"><Text color={AMBER} wrap="wrap">{role === 'leader'
              ? L(`⚠ Handoff due: compacted ${compactsHere} times. Write what we know, stop being Leader, hand off, then make the new chat the Leader.`, `⚠ Devir zamanı: ${compactsHere} kez sıkıştırıldı. Ne biliyoruz yazdır, Leader'ı bırak, devret, yeni sohbeti Leader yap.`)
              : L(`⚠ Handoff due: compacted ${compactsHere} times. Hand off when this task's turn ends.`, `⚠ Devir zamanı: ${compactsHere} kez sıkıştırıldı. Bu işin turu bitince devret.`)}</Text></Box>
          )}
          <Text dimColor wrap="wrap">{L(`This chat writes a handoff file and a new chat opens with it; once the new one is seen working, this chat is archived. The new chat looks up details missing from the file in the old chat's full record.`, `Bu sohbet bir devir dosyası yazar, yeni sohbet o dosyayla açılır; çalıştığı görülünce bu sohbet arşivlenir. Yeni sohbet, dosyada olmayan ayrıntıyı eski sohbetin tam kaydında arar.`)}</Text>
          {handedOff ? (
            <Box key="handoff-state"><Text color={GREEN}>{L('✓ Handed off', '✓ Devredildi')}</Text></Box>
          ) : handoffRunning ? (
            <Box key="handoff-state"><Text color={AMBER}>{L(`◌ Handoff in progress… (writing the file, opening the new chat)`, `◌ Devir sürüyor… (dosya yazılıyor, yeni sohbet açılıyor)`)}</Text></Box>
          ) : role === 'leader' ? (
            <Box key="handoff-state"><Text dimColor>{L(`The Leader chat is not handed off: stop being Leader first.`, `Leader sohbeti devredilmez: önce Leader'ı bırak.`)}</Text></Box>
          ) : handoffConfirm ? (
            <Box key="handoff-confirm" flexDirection="row" columnGap={1} flexWrap="wrap">
              <Text>{L(`Are you sure? This chat will be archived.`, `Emin misin? Bu sohbet arşivlenecek.`)}</Text>
              <Button key="handoff-yes" label={L("Yes, hand off", "Evet, devret")} variant="primary" onPress={() => {
                handoffConfirm = false
                enqueue({ kind: 'handoff' })
                bump()
              }} />
              <Button key="handoff-no" label={L("Cancel", "Vazgeç")} plain dimColor onPress={() => {
                handoffConfirm = false
                bump()
              }} />
            </Box>
          ) : (
            <Button key="handoff-start" label={L("Create handoff", "Devir oluştur")} variant="primary" onPress={() => {
              handoffConfirm = true
              bump()
            }} />
          )}
          <Box key="know-row" flexDirection="row" columnGap={1} flexWrap="wrap">
            <Button key="know-start" label={L("Write what we know", "Ne biliyoruz oluştur")} plain onPress={() => enqueue({ kind: 'know' })} />
            <Text dimColor wrap="wrap">{L('.chief/NE-BILIYORUZ-….md: goal, verified facts, decisions, open questions. This chat goes on.', '.chief/NE-BILIYORUZ-….md: hedef, doğrulanmış bilgi, kararlar, açık sorular. Sohbet devam eder.')}</Text>
          </Box>
        </Box>
      </Box>
    )

    // ---------- Leader: the main goal, the chiefs, the open chats ----------
    const leaderView = () => {
      if (role !== 'leader') {
        return (
          <Box flexDirection="column" rowGap={1}>
            {role === 'chief' ? (
              <Text wrap="wrap">{L(`This chat is a chief under the leader ${leaderTitle}.`, `Bu sohbet ${leaderTitle} liderine bağlı bir chief.`)}{describeConfig(chiefConfig) ? L(` Settings: ${describeConfig(chiefConfig)}.`, ` Ayarları: ${describeConfig(chiefConfig)}.`) : ''}{chiefConfig.goal ? L(` Goal: ${chiefConfig.goal}`, ` Hedefi: ${chiefConfig.goal}`) : ''}</Text>
            ) : (
              <Text dimColor wrap="wrap">{L(`The Leader runs other chats as chiefs: it gives each one a goal, model, effort, which and how many subagents, and which CLI agents. Chiefs run their own agents; the Leader watches the main goal.`, `Leader başka sohbetleri chief olarak yönetir: her birine hedef, model, effort, hangi ve kaç subagent, hangi CLI ajanları verir. Chief'ler kendi ajanlarını yönetir; Leader ana hedefe bakar.`)}</Text>
            )}
            {role === 'chief' ? (
              <Button key="leave-leader" label={L("Leave the Leader", "Leader'dan ayrıl")} plain dimColor onPress={() => {
                chiefConfig = {}
                void storeSet($, `chiefConfig:${sid}`, chiefConfig).then(() => setRole($, 'solo'))
              }} />
            ) : (
              <Button key="be-leader" label={L("Make this chat the Leader", "Bu sohbeti Leader yap")} variant="primary" onPress={() => void becomeLeader($)} />
            )}
          </Box>
        )
      }
      const mine = hqCards.filter(c => c.role === 'chief' && c.leader === sid)
      const free = hqCards.filter(c => adoptable(c, sid, now))
      const openGoalList = goalList.filter(g => g.status !== 'done')
      const mainText = goalList.find(g => g.id === mainGoalId)?.text ?? ''
      const seenText = (t: number) => (now - t < 90000 ? L('live', 'canlı') : L(`${fmtElapsed(now - t)} ago`, `${fmtElapsed(now - t)} önce`))
      const configure = (c: HqCard, cfg: ChiefConfig) => void sendTo($, c.sid, 'configure', { config: cfg })
      const card = (c: HqCard, isMine: boolean) => (
        <Box key={`chief:${c.sid}`} flexDirection="column" borderStyle="round" borderColor={c.working ? VIOLET : '#333333'} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text bold wrap="truncate-end">{c.title}</Text>
            <Text dimColor>{seenText(c.updatedAt)} · {c.working} {L('working', 'çalışıyor')}</Text>
          </Box>
          {c.goal ? <Text wrap="wrap">◎ {c.goal}</Text> : <Text dimColor>{L(`no goal`, `hedef yok`)}</Text>}
          <Text dimColor wrap="truncate-end">{[c.model ? shortModel(c.model) : '', c.effort, describeConfig({ subagents: c.config.subagents, lanes: undefined })].filter(Boolean).join(' · ') || L('default settings', 'varsayılan ayarlar')}</Text>
          {c.agents.slice(0, 3).map((a, i) => (
            <Text key={`chief:${c.sid}:a${i}`} dimColor wrap="truncate-end">· {a.name}: {a.now}</Text>
          ))}
          {isMine ? (
            <Box flexDirection="row" columnGap={1} flexWrap="wrap">
              {Select && <Select key={`chief:${c.sid}:model`} options={SUB_MODELS.map(m => ({ value: m.value, label: m.value === 'auto' ? 'Model: auto' : m.text }))} value={c.config.model || 'auto'} onSelect={v => configure(c, { model: v === 'auto' ? '' : v })} />}
              {Select && <Select key={`chief:${c.sid}:effort`} options={[{ value: 'auto', label: 'Effort: auto' }, ...EFFORT_WORDS.map(w => ({ value: w, label: w }))]} value={c.config.effort || 'auto'} onSelect={v => configure(c, { effort: v === 'auto' ? '' : v })} />}
              <Button key={`chief:${c.sid}:release`} label={L("Release", "Bırak")} plain dimColor onPress={() => void sendTo($, c.sid, 'release')} />
            </Box>
          ) : (
            <Button key={`chief:${c.sid}:adopt`} label="Chief yap" plain onPress={() => void sendTo($, c.sid, 'join', {})} />
          )}
        </Box>
      )
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text color={VIOLET}>{L(`★ Main goal`, `★ Ana hedef`)}</Text>
            {Select && openGoalList.length > 0 ? (
              <Select key="leader-main" options={selectOptions([{ value: '', label: L('— pick —', '— seç —') }, ...openGoalList.map(g => ({ value: g.id, label: oneLine(g.text, 60) }))], mainGoalId)} value={mainGoalId} onSelect={v => void setMainGoal($, v)} />
            ) : (
              <Box key="leader-main">
                <Text>{mainText || L('none (add one in Goals or tell the Leader)', 'yok (Goals’tan ekle ya da Leader’a söyle)')}</Text>
              </Box>
            )}
          </Box>
          {Input ? (
            <Input key="leader-new-chief" placeholder={L("New chief: write its goal, Enter", "Yeni chief: hedefini yaz, Enter")} submitLabel={L("open", "aç")} onSubmit={v => {
              const t = v.trim()
              if (t) void createChief($, chiefTier({ goal: t }))
            }} />
          ) : null}
          <Text dimColor>CHIEFS · {mine.length}</Text>
          {mine.length === 0 && <Text dimColor wrap="wrap">{L(`No chiefs yet. Open a new chat above, make one of the open chats below a chief, or tell the Leader "open 3 chiefs for this goal".`, `Henüz chief yok. Yukarıdan yeni bir sohbet aç, aşağıdaki açık sohbetlerden birini chief yap ya da Leader'a "şu hedef için 3 chief aç" de.`)}</Text>}
          {mine.map(c => card(c, true))}
          {free.length > 0 && <Text dimColor>{L('OPEN CHATS', 'AÇIK SOHBETLER')} · {free.length}</Text>}
          {free.slice(0, 6).map(c => card(c, false))}
        </Box>
      )
    }

    const bump = () => void update($, tick, n => (n ?? 0) + 1)
    // ---------- Çok harcayanlar: the sessions that use the most quota ----------
    const spendRow = (r: SpendResult['windows']['24h']['rows'][number], i: number) => (
      <Box key={`spend:${r.sid}`} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Text wrap="truncate-end">{i + 1}. {sessionTitles[r.sid] || r.title}</Text>
          <Box flexShrink={0}><Text bold>≈{fmtUsd(r.usd)} · {fmtPct(r.share * 100)}</Text></Box>
        </Box>
        <Text dimColor wrap="truncate-end">{[shortModel(r.model), `${L('cache read', 'cache okuma')} ${fmtTokens(r.cacheRead)}`, ...r.flags.map(flagLabel)].join(' · ')}</Text>
      </Box>
    )
    const spendView = () => {
      void ensureSpend($)
      const win = spend.result?.windows[spend.window]
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between">
            {chips('spend-window', L('Time', 'Süre'), [{ value: '24h', text: L('Last 24 hours', 'Son 24 saat') }, { value: '7d', text: spend.result?.weekKnown ? L('This week', 'Bu hafta') : L('Last 7 days', 'Son 7 gün') }], spend.window, v => {
              spend = { ...spend, window: v as SpendWindowKey }
              bump()
            })}
            <Button key="spend-refresh" label="↻" plain dimColor onPress={() => void ensureSpend($, true)} />
          </Box>
          {spend.busy && <Text key="spend-busy" color={AMBER}>{L(`◌ Reading transcripts… (can take half a minute)`, `◌ Transkriptler okunuyor… (yarım dakika sürebilir)`)}</Text>}
          {spend.error && <Text key="spend-error" color={RED}>{L(`Could not read: ${spend.error}`, `Okunamadı: ${spend.error}`)}</Text>}
          {win && (
            <Box key="spend-summary">
              <Text bold>{L(`Total ≈${fmtUsd(win.totalUsd)} · top 3 sessions ${fmtPct(win.top3Share * 100)}`, `Toplam ≈${fmtUsd(win.totalUsd)} · ilk 3 oturum ${fmtPct(win.top3Share * 100)}`)}</Text>
            </Box>
          )}
          {win && win.rows.length === 0 && <Text dimColor>{L(`No spending in this range.`, `Bu aralıkta harcama yok.`)}</Text>}
          {win?.rows.map(spendRow)}
        </Box>
      )
    }

    // ---------- Settings: a key, an endpoint and a model list per provider ----------
    // ---------- sign-ins and consultants ----------
    /** What a CLI last said about being signed in, in two words; nothing until someone pressed L("Check sign-ins", "Girişleri kontrol et"). */
    const loginWord = (cli: string): { text: string; color?: string } => {
      const h = healthSeen[cli]
      if (h?.verdict === 'ok') return { text: L('works (tested)', 'çalışıyor (denendi)'), color: GREEN }
      if (h && h.verdict !== 'missing') return { text: oneLine(h.why, 60), color: RED }
      const seen = loginSeen[cli]
      if (!seen) return { text: '' }
      if (seen.verdict === 'in') return { text: L('signed in', 'giriş var'), color: GREEN }
      if (seen.verdict === 'out') return { text: L('not signed in', 'giriş yok'), color: RED }
      if (seen.verdict === 'missing') return { text: L('CLI not installed', 'CLI kurulu değil'), color: RED }
      return { text: L('sign-in unknown', 'giriş bilinmiyor') }
    }
    const checkLabel = () => (loginChecking || healthChecking ? L('◌ checking…', '◌ kontrol ediliyor…') : loginCheckedAt ? L(`Check sign-ins · ${timeOf(loginCheckedAt)}`, `Girişleri kontrol et · ${timeOf(loginCheckedAt)}`) : L('Check sign-ins', 'Girişleri kontrol et'))

    const promptsView = () => {
      const list = promptStore?.list ?? []
      const copyPrompt = async (p: SavedPrompt) => {
        if (await copyText($, e.surface, p.text)) return void $.ui.toast(L(`Copied: ${p.name}`, `Kopyalandı: ${p.name}`))
        promptOpen = p.name
        bump()
        $.ui.toast(notCopied)
      }
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>{L('Saved on this computer only, in ~/.claude/the-chief/prompts.json. Add one here, or open an agent and press "Save prompt".', 'Yalnız bu bilgisayarda, ~/.claude/the-chief/prompts.json içinde saklanır. Buradan ekle ya da bir ajanı açıp "Promptu kaydet"e bas.')}</Text>
          {promptStore?.broken && <Text color={RED}>{L('The prompts file could not be read. It is left as it is; the next save moves it aside as prompts.broken-<time>.json.', 'Prompt dosyası okunamadı. Olduğu gibi duruyor; bir sonraki kayıt onu prompts.broken-<zaman>.json olarak kenara alır.')}</Text>}
          {!Input ? (
            <Text dimColor>{L('Typing is not available here; open an agent and press "Save prompt".', 'Burada yazı alanı yok; bir ajanı açıp "Promptu kaydet"e bas.')}</Text>
          ) : promptName === null ? (
            <Input key="prompt-name" placeholder={L('New prompt: type a name, Enter', 'Yeni prompt: bir ad yaz, Enter')} submitLabel="next" onSubmit={v => {
              promptName = v.trim()
              bump()
            }} />
          ) : (
            <Box flexDirection="column">
              <Text dimColor>{L(`Text of "${promptName || 'Prompt'}": paste or type it, Enter saves.`, `"${promptName || 'Prompt'}" metni: yapıştır ya da yaz, Enter kaydeder.`)}</Text>
              <Input key="prompt-text" placeholder={L('Prompt text, Enter', 'Prompt metni, Enter')} submitLabel="save" onSubmit={v => {
                const name = promptName ?? ''
                promptName = null
                void savePrompt($, name, v).then(m => $.ui.toast(m))
              }} />
              <Button key="prompt-cancel" label={L('Cancel', 'Vazgeç')} plain dimColor onPress={() => {
                promptName = null
                bump()
              }} />
            </Box>
          )}
          {list.length === 0 ? (
            <Text dimColor>{L('No saved prompts yet.', 'Henüz kayıtlı prompt yok.')}</Text>
          ) : (
            list.map(p => (
              <Box key={`prompt:${p.name}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
                  <Button key={`prompt-open:${p.name}`} label={`${promptOpen === p.name ? '▾' : '▸'} ${p.name}`} plain onPress={() => {
                    promptOpen = promptOpen === p.name ? '' : p.name
                    bump()
                  }} />
                  <Box flexDirection="row" columnGap={1}>
                    <Button key={`prompt-copy:${p.name}`} label={L('Copy', 'Kopyala')} plain onPress={() => void copyPrompt(p)} />
                    <Button key={`prompt-del:${p.name}`} label={promptDelete === p.name ? L('Sure? Delete', 'Emin misin? Sil') : L('Delete', 'Sil')} plain dimColor={promptDelete !== p.name} onPress={() => {
                      if (promptDelete !== p.name) {
                        promptDelete = p.name
                        return bump()
                      }
                      promptDelete = ''
                      if (promptOpen === p.name) promptOpen = ''
                      void deletePrompt($, p.name).then(m => $.ui.toast(m))
                    }} />
                  </Box>
                </Box>
                {promptOpen === p.name ? (
                  <Box borderStyle="round" borderColor="#333333" paddingX={1}><Text wrap="wrap">{p.text}</Text></Box>
                ) : (
                  <Text dimColor wrap="truncate-end">{firstLine(p.text)}</Text>
                )}
              </Box>
            ))
          )}
        </Box>
      )
    }
    const consultView = () => {
      const list = consultantsNow()
      const isOff = list.length === 0
      const draft = consultDraft ?? (opt('consultants') || CONSULTANTS_DEFAULT)
      const saveList = (v: string) => {
        consultDraft = null
        void saveOption($, 'consultants', v)
      }
      // dropdowns: every change is saved at once, so nothing can be mistyped
      const saveRows = (rows: readonly Consultant[]) => saveList(rows.length ? rows.map(consultantName).join(', ') : 'off')
      const taken = (cli: string, model: string, but = -1) => list.some((c, j) => j !== but && c.cli === cli && c.model.toLowerCase() === model.toLowerCase())
      const clis = CLI_ORDER.filter(c => CONSULT_BIN[c] && (modelChoices(c).length > 0 || list.some(x => x.cli === c)))
      const setRow = (i: number, patch: Partial<Consultant>) => saveRows(list.map((c, j) => (j === i ? { ...c, ...patch } : c)))
      // a new row is the first CLI and model not on the list yet: a repeat would be dropped when the list is read
      const addRow = () => {
        for (const cli of clis) for (const model of modelChoices(cli)) if (!taken(cli, model)) return saveRows([...list, { cli, model, effort: '' }])
      }
      const pickRow = (c: Consultant, i: number) => {
        if (!Select) return null
        const cli = c.cli as SquadCli
        void refreshModels($, cli, false)
        const steps = CLIS[cli]?.efforts ?? 0
        return (
          <Box flexDirection="row" columnGap={1} flexShrink={1} flexWrap="wrap" alignItems="center">
            <Text dimColor>{i + 1}.</Text>
            <Select key={`consult:${i}:cli`} options={clis.map(x => ({ value: x, label: CLIS[x].label }))} value={c.cli} onSelect={v => {
              const models = modelChoices(v as SquadCli)
              setRow(i, { cli: v, model: models.find(m => !taken(v, m, i)) ?? models[0] ?? c.model, effort: '' })
            }} />
            <Select key={`consult:${i}:model`} options={selectOptions([c.model, ...modelChoices(cli)].map(m => ({ value: m, label: prettyModel(m) || m })), c.model)} value={c.model} onSelect={v => setRow(i, { model: v })} />
            {steps > 0 ? <Select key={`consult:${i}:effort`} options={[{ value: '', label: L('effort: default', 'effort: varsayılan') }, ...EFFORTS.slice(0, steps).map(w => ({ value: w as string, label: w as string }))]} value={c.effort} onSelect={v => setRow(i, { effort: v })} /> : null}
            <Button key={`consult:${i}:del`} label="✕" plain dimColor onPress={() => saveRows(list.filter((_, j) => j !== i))} />
          </Box>
        )
      }
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="column">
            <Text bold>{L(`Consultants`, `Danışmanlar`)}</Text>
            <Text dimColor wrap="wrap">{L(`When you ask, before a decision that is hard to undo, or in heavy analysis, the chief asks the models here. A consultant runs read-only: it changes no files, it only gives an opinion.`, `Sen istediğinde, geri alınması zor bir karardan önce ya da ağır analizde şef buradaki modellere sorar. Danışman salt okunur çalışır: dosya değiştirmez, yalnız görüş verir.`)}</Text>
          </Box>
          <Box key="consult-list" flexDirection="column" borderStyle="round" borderColor="#333333" paddingX={1}>
            {isOff ? (
              <Text dimColor>{L(`Off. Press "Default" to turn it on.`, `Kapalı. Açmak için "Varsayılan"a bas.`)}</Text>
            ) : (
              list.map((c, i) => {
                const w = loginWord(c.cli)
                const isBusy = consulting.has(consultantName(c))
                return (
                  <Box key={`consultant:${i}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
                    {Select ? pickRow(c, i) : (
                      <Box flexDirection="row" columnGap={1} flexShrink={1}>
                        <Text dimColor>{i + 1}.</Text>
                        <Text bold={i === 0} wrap="truncate-end">{`${CLIS[c.cli as SquadCli]?.label ?? c.cli} · ${prettyModel(c.model)}${c.effort ? ` · ${c.effort}` : ''}`}</Text>
                      </Box>
                    )}
                    <Box key={`consultant:${i}:status`} flexDirection="row" columnGap={1} flexShrink={0}>
                      {isBusy ? <Text color={AMBER}>{L('◌ asking…', '◌ soruluyor…')}</Text> : w.text ? <Text color={w.color} dimColor={!w.color}>{w.text}</Text> : null}
                      {LOGIN[c.cli] && loginSeen[c.cli]?.verdict === 'out' ? <Button key={`consult-login:${i}`} label={L("Sign in", "Giriş yap")} plain onPress={() => enqueue({ kind: 'login', cli: c.cli as SquadCli })} /> : null}
                    </Box>
                  </Box>
                )
              })
            )}
            <Box flexDirection="row" justifyContent="space-between" columnGap={1} flexWrap="wrap">
              {Select ? (
                <Box flexDirection="row" columnGap={1}>
                  {!isOff && list.length < CONSULT_PANEL_MAX ? <Button key="consult-add" label={L("+ Add consultant", "+ Danışman ekle")} plain onPress={addRow} /> : null}
                  <Button key="consult-default" label={L("Default", "Varsayılan")} plain dimColor onPress={() => saveList('')} />
                  {!isOff ? <Button key="consult-off" label={L("Turn off", "Kapat")} plain dimColor onPress={() => saveList('off')} /> : null}
                </Box>
              ) : <Box />}
              <Button key="consult-check" label={checkLabel()} plain dimColor onPress={() => enqueue({ kind: 'logins' })} />
            </Box>
          </Box>
          {Select ? null : Input ? (
            <Box flexDirection="column">
              <Box flexDirection="row">
                {label(L('List', 'Liste'))}
                <Input key="consult-edit" value={draft} placeholder={L("cli/model:effort, comma-separated", "cli/model:effort, virgülle")} submitLabel={L("save", "kaydet")}
                  onInput={v => {
                    consultDraft = v
                  }}
                  onSubmit={v => saveList(v.trim() || 'off')} />
              </Box>
              <Box flexDirection="row" justifyContent="flex-end" columnGap={1}>
                <Button key="consult-default" label={L("Default", "Varsayılan")} plain dimColor onPress={() => saveList('')} />
                <Button key="consult-off" label={isOff ? L('Off', 'Kapalı') : L('Turn off', 'Kapat')} plain dimColor onPress={() => saveList('off')} />
                <Button key="consult-save" label={L("Save", "Kaydet")} variant="primary" onPress={() => saveList(draft.trim() || 'off')} />
              </Box>
            </Box>
          ) : (
            <Text dimColor>{L(`Change the list in the desktop app or the terminal.`, `Liste masaüstünde ya da terminalde değiştirilir.`)}</Text>
          )}
          {Input && !isOff ? (
            <Box flexDirection="row">
              {label('Sor')}
              <Input key="consult-ask" placeholder={L("Question for the consultants, Enter", "Danışmana sorulacak soru, Enter")} submitLabel={L("ask", "sor")} onSubmit={v => {
                if (v.trim()) enqueue({ kind: 'consult', question: v.trim() })
              }} />
            </Box>
          ) : null}
          <Text dimColor>{L(`From the chat: /consult question  ·  all at once: /consult all question`, `Sohbetten: /consult soru  ·  hepsine birden: /consult hepsi soru`)}</Text>
          {section(L('RECENT CONSULTATIONS', 'SON DANIŞMALAR'), consultLog.length === 0 ? <Text dimColor>{L(`No consultations yet.`, `Henüz danışılmadı.`)}</Text> : (
            <Box flexDirection="column">
              {consultLog.map((r, i) => (
                <Box key={`consult-log:${i}`} flexDirection="column">
                  <Button key={`consult-open:${i}`} label={`${consultOpen === i ? '▾' : '▸'} ${timeOf(r.at)} · ${r.who} · ${r.isAnswered ? fmtElapsed(r.ms) : L('no answer', 'cevap yok')} · ${oneLine(r.question, 50)}`} plain dimColor={consultOpen !== i} onPress={() => {
                    consultOpen = consultOpen === i ? -1 : i
                    bump()
                  }} />
                  {consultOpen === i ? (r.isAnswered ? <Markdown text={r.answer} /> : <Text color={RED} wrap="wrap">{r.answer}</Text>) : null}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )
    }

    // ---------- Settings: three pages (providers and sign-ins, what new sessions start with, the spend) ----------
    const settingsView = () => {
      const editing = CLI_ORDER.find(c => c === editingProvider)
      const status = (c: SquadCli) => {
        const spec = CLIS[c]
        const hasKey = !!(spec.key && (opt(spec.key.field) || savedKeys.includes(c)))
        return { hasKey, text: hasKey ? L('key saved', 'key kayıtlı') : spec.key ? L('no key', 'key yok') : L('no key needed', 'key gerekmez') }
      }
      if (editing) {
        const spec = CLIS[editing]
        const d = drafts(editing)
        const w = loginWord(editing)
        const field = (k: 'key' | 'endpoint' | 'models', name: string, placeholder: string, value: string) =>
          Input ? (
            <Box flexDirection="row">
              {label(name, 10)}
              <Input key={`set:${editing}:${k}`} value={value} placeholder={placeholder} submitLabel={L("save", "kaydet")}
                onInput={v => {
                  d[k] = v
                }}
                onSubmit={v => {
                  d[k] = v
                  void saveSettings($, editing)
                }} />
            </Box>
          ) : null
        return (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Button key="settings-back" label={L("‹ Providers", "‹ Sağlayıcılar")} plain dimColor onPress={() => void $.state.set(EDITING, null)} />
              <Text bold color={VIOLET}>{spec.label}</Text>
            </Box>
            <Text dimColor>{spec.auth}.</Text>
            {LOGIN[editing] ? (
              <Box key={`login-row:${editing}`} flexDirection="column" borderStyle="round" borderColor="#333333" paddingX={1}>
                <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
                  <Box flexDirection="row" columnGap={1}>
                    <Text bold>{L(`Sign-in`, `Giriş`)}</Text>
                    <Box key={`login-state:${editing}`}>
                      <Text color={w.color} dimColor={!w.color}>{w.text || L('not checked', 'kontrol edilmedi')}</Text>
                    </Box>
                  </Box>
                  <Box flexDirection="row" columnGap={1} flexShrink={0}>
                    <Button key={`login-check:${editing}`} label={loginChecking ? '◌' : 'Kontrol et'} plain dimColor onPress={() => enqueue({ kind: 'logins' })} />
                    <Button key={`login:${editing}`} label={L("Sign in", "Giriş yap")} variant="primary" onPress={() => enqueue({ kind: 'login', cli: editing })} />
                  </Box>
                </Box>
                <Text dimColor wrap="wrap">{L(`Opens a terminal on this computer and runs "${LOGIN[editing]!.login}"; you type the password there, The Chief never sees it.${LOGIN[editing]!.note ? ` ${LOGIN[editing]!.note}` : ''}`, `Bu bilgisayarda bir terminal açar ve "${LOGIN[editing]!.login}" komutunu çalıştırır; şifreyi orada sen girersin, The Chief görmez.${LOGIN[editing]!.note ? ` ${LOGIN[editing]!.note}` : ''}`)}</Text>
              </Box>
            ) : null}
            {Input ? (
              <Box flexDirection="column" rowGap={1}>
                {spec.key && field('key', 'API key', status(editing).hasKey ? L('•••••••• saved; type to change', '•••••••• kayıtlı; değiştirmek için yaz') : `${spec.key.env}`, '')}
                {spec.endpoint && field('endpoint', L('Endpoint', 'Uç nokta'), editing === 'custom' ? 'https://your-host/v1' : L('leave empty for the default', 'varsayılan için boş bırak'), opt(spec.endpoint.field))}
                {field('models', L('Models', 'Modeller'), L('comma-separated', 'virgülle ayır'), opt(`${editing.replace(/-/g, '_')}_models`) || spec.defaultModels)}
                <Text dimColor>{L(`The key goes to the system's secure store; it is never written to settings.json or this pane's state.`, `Key sistemin güvenli deposuna gider; settings.json'a ya da bu panelin durumuna asla yazılmaz.`)}</Text>
                <Box flexDirection="row" columnGap={1} justifyContent="flex-end">
                  {spec.key && status(editing).hasKey && (
                    <Button key={`set:${editing}:clear`} label={L("Delete key", "Key'i sil")} plain dimColor onPress={() => {
                      d.clearKey = true
                      void saveSettings($, editing)
                    }} />
                  )}
                  <Button key={`set:${editing}:save`} label={L("Save", "Kaydet")} variant="primary" onPress={() => void saveSettings($, editing)} />
                </Box>
              </Box>
            ) : (
              <Text dimColor>{L(`Enter the key in the desktop app or the terminal: /chief → ⚙, or claude plugin configure the-chief.`, `Key masaüstünde ya da terminalde girilir: /chief → ⚙, ya da claude plugin configure the-chief.`)}</Text>
            )}
          </Box>
        )
      }
      const pageChip = (id: typeof settingsPage, t: string) =>
        settingsPage === id ? (
          <Button key={`set-page:${id}`} label={t} variant="primary" onPress={() => undefined} />
        ) : (
          <Button key={`set-page:${id}`} label={t} plain dimColor onPress={() => {
            settingsPage = id
            if (id === 'startup') void refreshStartup($)
            // an old stored tab (startup, spend) would pull the page back on the next draw
            void $.state.set(TAB, 'settings')
            bump()
          }} />
        )
      const provRow = (c: SquadCli) => {
        const st = status(c)
        const w = loginWord(c)
        const isReady = st.hasKey || loginSeen[c]?.verdict === 'in'
        const count = modelsOf(c).length
        return (
          <Box key={`prov:${c}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1}>
              <Text color={isReady ? GREEN : undefined} dimColor={!isReady}>{isReady ? '●' : '○'}</Text>
              <Button key={`edit:${c}`} label={CLIS[c].label} plain onPress={() => void $.state.set(EDITING, c)} />
            </Box>
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              <Box key={`prov:${c}:status`}>
                <Text dimColor>{[st.text, w.text, count ? L(`${count} models`, `${count} model`) : L('no models', 'model yok')].filter(Boolean).join(' · ')}</Text>
              </Box>
              {LOGIN[c] ? <Button key={`login:${c}`} label={L("Sign in", "Giriş yap")} plain dimColor={loginSeen[c]?.verdict === 'in'} onPress={() => enqueue({ kind: 'login', cli: c })} /> : null}
            </Box>
          </Box>
        )
      }
      const group = (title: string, clis: readonly SquadCli[]) => (
        <Box key={`prov-group:${title}`} flexDirection="column">
          <Text dimColor>{title}</Text>
          {clis.map(provRow)}
        </Box>
      )
      const providersPage = () => (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text dimColor wrap="wrap">{L(`Click a provider: API key, endpoint, models. Without a key, the CLI uses its own sign-in.`, `Bir sağlayıcıya tıkla: API key, uç nokta, modeller. Key yoksa CLI kendi girişini kullanır.`)}</Text>
            <Box flexShrink={0}>
              <Button key="logins-check" label={checkLabel()} plain onPress={() => enqueue({ kind: 'logins' })} />
            </Box>
          </Box>
          {group(L('WITH THEIR OWN SIGN-IN', 'KENDİ GİRİŞİ OLANLAR'), ['claude', 'codex', 'devin', 'cursor', 'qoder', 'gemini', 'antigravity'])}
          {group(L('THROUGH OPENCODE', 'OPENCODE ÜZERİNDEN'), ['openrouter', 'opencode-zen', 'opencode-go', 'opencode-ollama'])}
          {group(L('CUSTOM ENDPOINT', 'ÖZEL UÇ NOKTA'), ['custom'])}
        </Box>
      )
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" columnGap={1}>
            {pageChip('providers', L('Providers', 'Sağlayıcılar'))}
            {pageChip('startup', L('Startup', 'Başlangıç'))}
            {pageChip('spend', L('Spending', 'Harcama'))}
            <Button key="setup-again" label="Run setup again" plain dimColor onPress={() => enqueue({ kind: 'setup' })} />
          </Box>
          {settingsPage === 'startup' ? startupView() : settingsPage === 'spend' ? spendView() : providersPage()}
        </Box>
      )
    }

    // ---------- Squad ----------
    const Client = e.surface === 'terminal' && 'Client' in table ? table.Client : undefined
    // the meter: coloured glyphs the surface draws itself, so it updates at once with no frame to reload
    const meter = (value: number, steps: number, cells: number, isOff: boolean) => {
      const frac = steps <= 1 ? 1 : value / (steps - 1)
      const lit = isOff ? 0 : Math.max(1, Math.round(frac * cells))
      return (
        <Box flexDirection="row" flexShrink={0}>
          {Array.from({ length: cells }, (_, c) =>
            c < lit ? <Text color={rampAt(c / Math.max(1, cells - 1))}>━</Text> : <Text color="#333333">━</Text>,
          )}
        </Box>
      )
    }

    const effortControl = (lane: SquadLane) => {
      const spec = CLIS[lane.cli]
      const id = lane.id
      const steps = Math.max(1, spec.efforts)
      const value = clamp(lane.effort, 0, steps - 1)
      if (Client) {
        return (
          <Box flexDirection="row">
            {label('Effort')}
            <Client key={`${id}:eff`} module="./slider.tsx" flexGrow={1}
              props={spec.efforts === 0 ? { value: 0, steps: 1, disabledNote: 'model sets it' } : { value, steps, labels: EFFORTS.slice(0, steps) as unknown as string[] }} />
          </Box>
        )
      }
      if (spec.efforts === 0) {
        return (
          <Box flexDirection="row">
            {label('Effort')}
            <Box key={`${id}:eff=`}>
              <Text dimColor>set by the model</Text>
            </Box>
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {label('Effort')}
            {meter(value, EFFORTS.length, 20, false)}
            <Box key={`${id}:eff=`}>
              <Text bold color={rampAt(value / (EFFORTS.length - 1))}>{EFFORTS[value]}</Text>
            </Box>
          </Box>
          <Box flexDirection="row" columnGap={1} paddingLeft={8} flexWrap="wrap">
            {EFFORTS.slice(0, steps).map((name, i) =>
              i === value ? (
                <Button key={`${id}:eff:${name}`} label={name} variant="primary" onPress={() => void patchLane($, id, { effort: i })} />
              ) : (
                <Button key={`${id}:eff:${name}`} label={name} plain dimColor onPress={() => void patchLane($, id, { effort: i })} />
              ),
            )}
          </Box>
        </Box>
      )
    }

    const agentsControl = (lane: SquadLane) => {
      const id = lane.id
      const value = lane.count - 1
      if (Client) {
        return (
          <Box flexDirection="row">
            {label('Agents')}
            <Client key={`${id}:n`} module="./slider.tsx" flexGrow={1} props={{ value, steps: MAX_AGENTS, unit: lane.count === 1 ? 'agent' : 'agents' }} />
          </Box>
        )
      }
      return (
        <Box flexDirection="row" columnGap={1}>
          {label('Agents')}
          <Box flexDirection="row" flexShrink={0}>
            {Array.from({ length: MAX_AGENTS }, (_, c) =>
              c < lane.count ? <Text color={rampAt(c / (MAX_AGENTS - 1))}>■</Text> : <Text color="#333333">■</Text>,
            )}
          </Box>
          <Button key={`${id}:n-`} label="−" plain dimColor onPress={() => void patchLane($, id, { count: clamp(lane.count - 1, 1, MAX_AGENTS) })} />
          <Box key={`${id}:n=`}>
            <Text bold color={rampAt(value / (MAX_AGENTS - 1))}>{lane.count}</Text>
          </Box>
          <Button key={`${id}:n+`} label="+" plain dimColor onPress={() => void patchLane($, id, { count: clamp(lane.count + 1, 1, MAX_AGENTS) })} />
        </Box>
      )
    }

    // ---------- Leader mode, Squad: chief lanes, each a goal and how many chats run it ----------
    const countControl = (key: string, name: string, value: number, max: number, unit: string, onSet: (v: number) => void) =>
      Client ? (
        <Box flexDirection="row">
          {label(name)}
          <Client key={key} module="./slider.tsx" flexGrow={1} props={{ value: value - 1, steps: max, unit }} />
        </Box>
      ) : (
        <Box flexDirection="row" columnGap={1}>
          {label(name)}
          <Box flexDirection="row" flexShrink={0}>
            {Array.from({ length: max }, (_, c) => (c < value ? <Text color={rampAt(c / Math.max(1, max - 1))}>■</Text> : <Text color="#333333">■</Text>))}
          </Box>
          <Button key={`${key}-`} label="−" plain dimColor onPress={() => onSet(clamp(value - 1, 1, max))} />
          <Box key={`${key}=`}>
            <Text bold color={rampAt((value - 1) / Math.max(1, max - 1))}>{value}</Text>
          </Box>
          <Button key={`${key}+`} label="+" plain dimColor onPress={() => onSet(clamp(value + 1, 1, max))} />
        </Box>
      )
    const leaderEffort = (lane: LeaderLane) =>
      Client ? (
        <Box flexDirection="row">
          {label('Effort')}
          <Client key={`${lane.id}:eff`} module="./slider.tsx" flexGrow={1} props={{ value: lane.effort, steps: EFFORT_WORDS.length, labels: [...EFFORT_WORDS] }} />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {label('Effort')}
            {meter(lane.effort, EFFORT_WORDS.length, 20, false)}
            <Box key={`${lane.id}:eff=`}>
              <Text bold color={rampAt(lane.effort / (EFFORT_WORDS.length - 1))}>{EFFORT_WORDS[lane.effort]}</Text>
            </Box>
          </Box>
          <Box flexDirection="row" columnGap={1} paddingLeft={8} flexWrap="wrap">
            {EFFORT_WORDS.map((name, i) =>
              i === lane.effort ? (
                <Button key={`${lane.id}:eff:${name}`} label={name} variant="primary" onPress={() => void patchLeaderLane($, lane.id, { effort: i })} />
              ) : (
                <Button key={`${lane.id}:eff:${name}`} label={name} plain dimColor onPress={() => void patchLeaderLane($, lane.id, { effort: i })} />
              ),
            )}
          </Box>
        </Box>
      )
    const leaderCard = (lane: LeaderLane, i: number) => (
      <Box key={`${lane.id}:card`} flexDirection="column" borderStyle="round" borderColor={rampAt(lane.effort / (EFFORT_WORDS.length - 1))} paddingX={2} paddingY={1} rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Text bold color={VIOLET}>{i + 1}</Text>
          <Box key={`${lane.id}:sum`} flexShrink={1}>
            <Text dimColor wrap="truncate-end">{lane.count} × chief · {lane.model === 'auto' ? 'model auto' : shortModel(lane.model)} · {EFFORT_WORDS[lane.effort]} · subagent {lane.subModel === 'auto' ? 'auto' : shortModel(lane.subModel)} en fazla {lane.subMax}</Text>
          </Box>
          <Button key={`${lane.id}:rm`} label="×" plain dimColor onPress={() => void setLeaderLanes($, leaderLanes.filter(l => l.id !== lane.id))} />
        </Box>
        {Input ? (
          <Input key={`${lane.id}:task`} value={lane.task} placeholder={L("Goal of the chiefs in this lane", "Bu şeritteki chief'lerin hedefi")} submitLabel="ok" onSubmit={v => void patchLeaderLane($, lane.id, { task: v.trim() })} />
        ) : (
          <Text wrap="wrap">{lane.task || L('No goal: tell the Leader or write it in the desktop app', 'Hedef yok: Leader’a söyle ya da masaüstünden yaz')}</Text>
        )}
        {picker(`${lane.id}:model`, 'Model', modelOptions, lane.model, v => void patchLeaderLane($, lane.id, { model: v }))}
        {leaderEffort(lane)}
        {picker(`${lane.id}:submodel`, 'Subagent', modelOptions, lane.subModel, v => void patchLeaderLane($, lane.id, { subModel: v }))}
        {picker(`${lane.id}:subeffort`, 'Sub effort', effortOptions, lane.subEffort >= 0 ? EFFORT_WORDS[lane.subEffort]! : 'auto', v => void patchLeaderLane($, lane.id, { subEffort: v === 'auto' ? -1 : (EFFORT_WORDS as readonly string[]).indexOf(v) }))}
        {countControl(`${lane.id}:sub`, 'En fazla', lane.subMax, MAX_SUBS, lane.subMax === 1 ? 'subagent' : 'subagents', v => void patchLeaderLane($, lane.id, { subMax: v }))}
        {countControl(`${lane.id}:n`, 'Chiefs', lane.count, MAX_CHIEFS, lane.count === 1 ? 'chief' : 'chiefs', v => void patchLeaderLane($, lane.id, { count: v }))}
        <Box flexDirection="row" justifyContent="flex-end">
          <Button key={`${lane.id}:launch`} label={`Launch ${lane.count}`} variant="primary" onPress={() => void launchChiefs($, lane.id)} />
        </Box>
      </Box>
    )
    const leaderSquadView = () => {
      const chiefsTotal = leaderLanes.reduce((n, l) => n + l.count, 0)
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1}>
              <Text bold>{plural(chiefsTotal, 'chief')}</Text>
              <Text dimColor>in {plural(leaderLanes.length, 'lane')}</Text>
            </Box>
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              <Button key="leader-add" label="+ Lane" plain dimColor onPress={() => void setLeaderLanes($, [...leaderLanes, defaultLeaderLane()])} />
              <Button key="leader-launch-all" label={`Launch all · ${chiefsTotal}`} variant="primary" onPress={() => void launchChiefs($, null)} />
            </Box>
          </Box>
          {leaderLanes.length === 0 && <Text dimColor>{L(`No lanes yet. + Lane for each goal.`, `Henüz şerit yok. Her hedef için + Lane.`)}</Text>}
          {leaderLanes.map(leaderCard)}
        </Box>
      )
    }

    const card = (lane: SquadLane, i: number) => {
      const spec = CLIS[lane.cli]
      const eff = effortName(lane.cli, lane.effort)
      const effSteps = Math.max(1, spec.efforts)
      const effValue = clamp(lane.effort, 0, effSteps - 1)
      const heat = spec.efforts === 0 ? (lane.count - 1) / (MAX_AGENTS - 1) : effValue / (EFFORTS.length - 1)
      const id = lane.id
      const models = modelsOf(lane.cli).length ? modelsOf(lane.cli) : [lane.model || 'set models in Settings']
      const choose = (key: string, options: { value: string; text: string }[], value: string, onPick: (v: string) => void) =>
        Select ? (
          <Select key={key} options={selectOptions(options.map(o => ({ value: o.value, label: o.text })), value)} value={value} onSelect={v => onPick(v)} />
        ) : (
          <Button key={key} label={`${options.find(o => o.value === value)?.text ?? value} ▾`} plain onPress={() => {
            const at = options.findIndex(o => o.value === value)
            onPick(options[(at + 1) % options.length]!.value)
          }} />
        )
      return (
        <Box key={`${id}:card`} flexDirection="column" borderStyle="round" borderColor={rampAt(heat)} paddingX={2} paddingY={1} rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Box flexDirection="row" columnGap={1} flexShrink={1} flexGrow={1}>
              <Text bold color={rampAt(heat)}>{i + 1}</Text>
              {Input ? (
                <Input
                  key={`${id}:task`}
                  value={lane.task}
                  placeholder={L("What should this lane do?", "Bu şerit ne yapsın?")}
                  submitLabel="save"
                  onInput={v => void update($, lanes, l => (l ?? []).map(x => (x.id === id ? { ...x, task: v } : x)))}
                  onSubmit={v => void patchLane($, id, { task: v })}
                />
              ) : (
                <Text bold wrap="truncate-end">{lane.task || L('No task', 'Görev yok')}</Text>
              )}
            </Box>
            <Box key={`${id}:sum`} flexShrink={0}>
              <Text dimColor>{lane.count} × {spec.label} {shortModel(lane.model)}{eff ? ` · ${eff}` : ''}</Text>
            </Box>
          </Box>
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Box flexDirection="row" columnGap={1}>
              <Text dimColor>CLI</Text>
              {choose(`${id}:cli`, CLI_ORDER.map(c => ({ value: c, text: CLIS[c].label })), lane.cli, v => {
                const cli = v as SquadCli
                if (cli === lane.cli) return
                void patchLane($, id, { cli, model: modelsOf(cli)[0] ?? '', effort: clamp(lane.effort, 0, Math.max(0, CLIS[cli].efforts - 1)) })
              })}
            </Box>
            <Box flexDirection="row" columnGap={1}>
              <Text dimColor>Model</Text>
              {choose(`${id}:model`, models.map(m => ({ value: m, text: shortModel(m) })), lane.model, v => void patchLane($, id, { model: v }))}
            </Box>
            {spec.efforts > 0 && !Client && Select && (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>Effort</Text>
                {choose(`${id}:effort`, EFFORTS.slice(0, effSteps).map((name, k) => ({ value: String(k), text: name })), String(effValue), v => void patchLane($, id, { effort: Number(v) }))}
                {meter(effValue, EFFORTS.length, 5, false)}
              </Box>
            )}
          </Box>
          {/* the terminal keeps its drag slider; the phone its row of effort chips */}
          {(Client || !Select) && effortControl(lane)}
          {agentsControl(lane)}
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1}>
              <Button key={`${id}:dup`} label={L("Duplicate", "Kopyala")} plain dimColor onPress={() => void mutateLanes($, l => {
                const at = l.findIndex(x => x.id === id)
                return [...l.slice(0, at + 1), { ...lane, id: newId() }, ...l.slice(at + 1)]
              })} />
              <Button key={`${id}:rm`} label={L("Delete", "Sil")} plain dimColor onPress={() => void mutateLanes($, l => l.filter(x => x.id !== id))} />
            </Box>
            <Button key={`${id}:launch`} label={`Launch ${lane.count}`} variant="primary" onPress={() => void launch($, [id])} />
          </Box>
        </Box>
      )
    }

    // the squad at a glance: one block per agent, coloured by its lane's heat
    const mix = () => (
      <Box flexDirection="row" flexWrap="wrap">
        {laneList.flatMap(lane => {
          const spec = CLIS[lane.cli]
          const heat = spec.efforts === 0 ? 0.35 : clamp(lane.effort, 0, spec.efforts - 1) / (EFFORTS.length - 1)
          return Array.from({ length: lane.count }, () => <Text color={rampAt(heat)}>■ </Text>)
        })}
      </Box>
    )

    const squadView = () => (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2} flexWrap="wrap">
          <Box flexDirection="column">
            <Box key="summary" flexDirection="row" columnGap={1}>
              <Text bold>{plural(total, 'agent')}</Text>
              <Text dimColor>in {plural(laneList.length, 'lane')}</Text>
            </Box>
            {total > 0 && mix()}
          </Box>
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            <Button key="add" label="+ Lane" plain dimColor onPress={() => void mutateLanes($, l => [...l, { id: newId(), task: '', cli: 'claude', model: 'claude-sonnet-5-5', effort: 2, count: 2 }])} />
            <Button key="launch-all" label={`Launch all · ${total}`} variant="primary" onPress={() => void launch($, null)} />
          </Box>
        </Box>
        {laneList.length === 0 && <Text dimColor>{L(`No lanes yet. + Lane for each task.`, `Henüz lane yok. Her görev için + Lane.`)}</Text>}
        {laneList.map(card)}
      </Box>
    )

    // ---------- frame: title, one segmented control, the view ----------
    const startupView = () => (
      <Box flexDirection="column" rowGap={1}>
        <Text bold>{L(`How new sessions start`, `Yeni oturumların başlangıcı`)}</Text>
        <Text dimColor>{L(`Ponytail is added to sessions that start with The Chief; the personal skill switch does not turn it off.`, `Ponytail, The Chief ile başlayan oturumlara eklenir; kişisel skill anahtarı bunu kapatmaz.`)}</Text>
        <Text dimColor>{L(`User settings; project and managed settings can differ. Open sessions may need a reload.`, `Kullanıcı ayarları; proje ve yönetilen ayarlar farklı olabilir. Açık oturumlar yeniden yükleme gerektirebilir.`)}</Text>
        <Button key="startup-refresh" label={L("Refresh list", "Listeyi yenile")} plain onPress={() => void refreshStartup($)} />
        {startupState?.error ? <Text color={RED}>{startupState.error}</Text> : null}
        {!startupState?.loaded ? <Text dimColor>{L(`Refresh to load the plugin and personal skill list.`, `Plugin ve kişisel skill listesini yüklemek için yenile.`)}</Text> : null}
        {startupState?.loaded ? <Text bold>{L('PLUGINS', 'PLUGINLER')}</Text> : null}
        {startupState?.plugins.map(p => (
          <Box key={`startup-plugin:${p.id}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text wrap="truncate-end">{p.id} · {p.scope || L('scope unknown', 'kapsam bilinmiyor')}</Text>
            {p.scope === 'user' ? <Button key={`startup-plugin-toggle:${p.id}`} label={p.enabled ? L('On · Turn off', 'Açık · Kapat') : L('Off · Turn on', 'Kapalı · Aç')} plain onPress={() => void toggleStartupPlugin($, p.id, !p.enabled)} /> : <Text dimColor>{L(`Manage in its own scope`, `Kendi kapsamında yönet`)}</Text>}
          </Box>
        ))}
        {startupState?.loaded ? <Text bold>{L(`PERSONAL SKILLS`, `KİŞİSEL SKILL'LER`)}</Text> : null}
        {startupState?.loaded ? <Text dimColor>{L(`Plugin skills are managed with their plugin. Project, system and bundled skills are not listed here.`, `Plugin skill'leri plugin ile yönetilir. Proje, sistem ve paket skill'leri burada listelenmez.`)}</Text> : null}
        {startupState?.skills.map(s => (
          <Box key={`startup-skill:${s.source}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text wrap="truncate-end">{s.name}{s.name === 'ponytail' ? L(' · also loaded with The Chief', ' · Chief ile ayrıca yüklenir') : ''}</Text>
            <Button key={`startup-skill-toggle:${s.source}`} label={s.value === 'off' ? L('Off · Turn on', 'Kapalı · Aç') : L(`${s.value} · Turn off`, `${s.value} · Kapat`)} plain onPress={() => void toggleStartupSkill($, s.name, s.value === 'off')} />
          </Box>
        ))}
      </Box>
    )

    const segment = (id: SquadTab, t: string) =>
      current === id ? (
        <Button key={`tab:${id}`} label={t} plain onPress={() => void $.state.set(TAB, id)} />
      ) : (
        <Button key={`tab:${id}`} label={t} plain dimColor onPress={() => {
          void $.state.set(TAB, id)
          void $.state.set(SELECTED, null)
        }} />
      )

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" columnGap={1}>
            <Text bold color={CORAL}>{role === 'leader' ? '★' : '◆'}</Text>
            <Text bold>{role === 'leader' ? 'Leader' : 'The Chief'}</Text>
          </Box>
          {Date.now() < stopShownUntil ? <Text key="pane-stopped" color="#5ccb7a">{L('✓ stopped', '✓ durdu')}</Text> : <Button key="pane-stop" label="⏹" plain dimColor onPress={() => void stopLoops($, true)} />}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {segment('agents', role === 'leader' ? L('Chiefs', 'Şefler') : L('Agents', 'Ajanlar'))}
          {segment('leader', role === 'leader' ? L('★ Session', '★ Oturum') : L('Session', 'Oturum'))}
          {segment('consult', consulting.size > 0 ? L('Consult ◌', 'Danışman ◌') : L('Consult', 'Danışman'))}
          {segment('prompts', L('Prompts', 'Promptlar'))}
          {segment('themes', L('Themes', 'Temalar'))}
          {segment('skills', L('Skills', 'Beceriler'))}
          {segment('settings', L('⚙ Settings', '⚙ Ayarlar'))}
        </Box>
        {goal && (
          <Box flexDirection="row" columnGap={1}>
            <Text color={VIOLET}>●</Text>
            <Text dimColor>{L(`Goal`, `Hedef`)}</Text>
            <Text wrap="truncate-end">{goal.text}</Text>
          </Box>
        )}
        {current === 'overview'
          ? overviewView()
          : current === 'skills'
            ? skillsView()
          : current === 'squad'
            ? role === 'leader'
              ? <Box flexDirection="column" rowGap={1}>{squadView()}{leaderSquadView()}</Box>
              : squadView()
            : current === 'settings'
              ? settingsView()
              : current === 'consult'
              ? consultView()
              : current === 'prompts'
              ? promptsView()
              : current === 'themes'
              ? themesBody
              : current === 'leader'
                ? sessionTab()
                : role === 'leader'
                    ? <Box flexDirection="column" rowGap={1}>{sessionsView()}{rows.length > 0 ? agentsView() : null}</Box>
                    : agentsView()}
        {role === 'chief' && leaderTitle ? <Box key="pane-footer" flexDirection="row" marginTop={1}><Text dimColor>↑ {leaderTitle}</Text></Box> : null}
      </Box>
    )
  })

  // ---------- the band right above the prompt: goals and agents, one click from the composer ----------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || opt('show_row') === 'off') return next(e)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Select = e.surface !== 'mobile' && 'Select' in table ? table.Select : undefined
    const ctl = (await read($, subControlAtom)) ?? subControl
    const workerList = (await read($, workers)) ?? []
    const subList = (await read($, subs)) ?? []
    const liveAgents = crewOf(workerList, subList)
    const working = liveAgents.length
    const chiefsHere = hqCards.filter(c => c.role === 'chief' && c.leader === sid).length
    // desktop: tinted pills with an icon, a rounded bar and the numbers, as the app's own chips look
    const Svg = e.surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
    const svg = (key: string, source: string, alt: string) => (Svg ? <Svg key={key} source={source} alt={alt} /> : null)
    const topRow = (
      <Box key="band-top" flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" columnGap={1} flexShrink={1} flexGrow={1} minWidth={0} alignItems="center">
          {Svg ? svg('chief-mascot', liveMascotSvg('#DD775B', 26), 'The Chief') : null}
          <Button key="band-chief" label={role === 'leader' ? '★ The Leader' : 'The Chief'} plain onPress={() => void openPane($)} />
        </Box>
        <Box flexDirection="row" columnGap={1} flexShrink={0} alignItems="center">
          {bandControls && <Text dimColor>Subagents</Text>}
          {bandControls && (Select ? (
            <Select key="band-sub-model" options={SUB_MODELS.map(m => ({ value: m.value, label: m.text }))} value={ctl.model} onSelect={v => void setSubControl($, { model: v })} />
          ) : (
            <Button key="band-sub-model" label={`${subModelText(ctl.model)} ▾`} plain onPress={() => {
              const i = SUB_MODELS.findIndex(m => m.value === ctl.model)
              void setSubControl($, { model: SUB_MODELS[(i + 1) % SUB_MODELS.length]!.value })
            }} />
          ))}
          {bandControls && <Button key="band-sub-less" label="‹" plain dimColor={ctl.effort === 0} onPress={() => void setSubControl($, { effort: Math.max(0, ctl.effort - 1) })} />}
          {bandControls && <Box key="band-sub-effort" flexDirection="row">
            <Text color={ctl.effort === 0 ? undefined : rampAt((ctl.effort - 1) / (EFFORTS.length - 1))} dimColor={ctl.effort === 0}>{'━'.repeat(ctl.effort)}</Text>
            <Text color="#333333">{'─'.repeat(EFFORTS.length - ctl.effort)}</Text>
            <Text bold={ctl.effort > 0} color={ctl.effort === 0 ? undefined : rampAt((ctl.effort - 1) / (EFFORTS.length - 1))} dimColor={ctl.effort === 0}> {subEffortText(ctl.effort)}</Text>
          </Box>}
          {bandControls && <Button key="band-sub-more" label="›" plain dimColor={ctl.effort === EFFORTS.length} onPress={() => void setSubControl($, { effort: Math.min(EFFORTS.length, ctl.effort + 1) })} />}
          {bandControls && <Text dimColor>·</Text>}
          {role === 'leader' && <Text color={VIOLET}>● {chiefsHere} sessions</Text>}
          {role === 'chief' && <Text dimColor>↑ {leaderTitle}</Text>}
          {working > 0 && (Svg ? (
            <Box key="band-crew" flexDirection="row" alignItems="flex-end" columnGap={2}>
              {crewGrouped(liveAgents)
                ? crewGroups(liveAgents).map((g, i) => (
                    <Box key={`crew-${i}`} flexDirection="column" alignItems="center">
                      <Button key={`crew-open-${i}`} label={g.label} plain dimColor onPress={() => void openAgent($, null)} />
                      <Box flexDirection="row" alignItems="center" columnGap={1}>
                        <Text dimColor>×{g.n}</Text>
                        {svg(`crew-${i}`, mascotSvg(CLI_TINT[g.cli] ?? CLI_TINT.custom!, 18), `${g.cli} agent`)}
                      </Box>
                    </Box>
                  ))
                : liveAgents.map((a, i) => (
                    <Box key={`crew-${i}`} flexDirection="column" alignItems="center">
                      <Button key={`crew-open-${i}`} label={prettyModel(a.model || '') || laneBrand(a.cli)} plain dimColor onPress={() => void openAgent($, a.id)} />
                      {svg(`crew-${i}`, mascotSvg(CLI_TINT[a.cli] ?? CLI_TINT.custom!, 18), `${a.cli} agent`)}
                    </Box>
                  ))}
            </Box>
          ) : <Button key="band-crew-open" label={`● ${working} working · ${[...new Set(liveAgents.map(a => prettyModel(a.model || '') || laneBrand(a.cli)))].join(', ')}`} plain onPress={() => void openAgent($, working === 1 ? liveAgents[0]!.id : null)} />)}
        </Box>
      </Box>
    )
    return topRow
  })

}
