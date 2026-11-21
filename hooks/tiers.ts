import { L } from './lang'
// The owner's difficulty tiers: four levels for sub-agents and four for chief chats, the keyword floors that keep a job
// from being rated too low, and the model lists the Settings pickers show. Pure functions, no engine.

export const TIER_IDS = ['cok_zor', 'zor', 'orta', 'kolay'] as const
export type TierId = (typeof TIER_IDS)[number]
export const TIER_LABEL: Record<TierId, string> = { get cok_zor() { return L('Very hard', 'Çok zor') }, get zor() { return L('Hard', 'Zor') }, get orta() { return L('Medium', 'Orta') }, get kolay() { return L('Easy', 'Kolay') } }
/** The Agent-tool refusal; it names the tier argument spawn_worker takes. */
/** The context note every session gets while sub-agent tiers are saved. */
export const TIER_HINT = "Alt ajan gerektiğinde spawn_worker'ı tier ile kullan: işin zorluğuna göre çok zor/zor/orta/kolay. Ajan CLI'sını (opencode, qodercli, codex, devin…) kabuktan başlatma; yalnızca spawn_worker."

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** Read-only built-in search agents; they stay allowed (denying them would break the app's own searches). */
const READ_ONLY_AGENTS = ['explore', 'plan']

/** How hard a tier is: 3 for the hardest, 0 for the easiest. */
const rank = (t: TierId) => TIER_IDS.length - 1 - TIER_IDS.indexOf(t)

/** Lower case without Turkish marks, so "BAŞVURU", "Başvuru" and "basvuru" are one word. */
export function fold(s: string): string {
  return s
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')
}

/** A tier id from what a model or a person typed: "çok zor", "cok-zor" and "COK_ZOR" are all cok_zor. */
export function asTier(v: unknown): TierId | null {
  const id = typeof v === 'string' ? fold(v).trim().replace(/[\s-]+/g, '_') : ''
  return (TIER_IDS as readonly string[]).includes(id) ? (id as TierId) : null
}

// ---------- sub-agent tiers: a CLI, a model and an effort per level ----------
export type SubTier = { cli: string; model: string; effort: string }
export type SubTiers = Record<TierId, SubTier>

/** What the Settings rows start from before anything is saved (they are not enforced until saved). */
export const SUB_TIER_STARTS: SubTiers = {
  cok_zor: { cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  zor: { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
  orta: { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  kolay: { cli: 'claude', model: 'claude-haiku-5-5', effort: 'medium' },
}

/** The saved `subagent_tiers` value; null when nothing valid is saved (then no tier is enforced). */
export function parseSubTiers(raw: string): SubTiers | null {
  const o = parseJson(raw)
  if (!o) return null
  const out = {} as SubTiers
  for (const id of TIER_IDS) {
    const row = o[id] as Record<string, unknown> | undefined
    if (!row || typeof row.cli !== 'string' || !row.cli) return null
    out[id] = { cli: row.cli, model: typeof row.model === 'string' ? row.model : '', effort: typeof row.effort === 'string' ? row.effort : '' }
  }
  return out
}

const parseJson = (raw: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}

// ---------- chief tiers: a Claude model and an effort per level ----------
export type ChiefTier = { model: string; effort: string }
export type ChiefTiers = Record<TierId, ChiefTier>

export const CHIEF_TIER_DEFAULTS: ChiefTiers = {
  cok_zor: { model: 'claude-opus-5-5', effort: 'medium' },
  zor: { model: 'claude-sonnet-5-5', effort: 'medium' },
  orta: { model: 'claude-sonnet-5-5', effort: 'medium' },
  kolay: { model: 'claude-haiku-5-5', effort: 'max' },
}

/** The saved `chief_tiers` value, row by row over the defaults. */
export function parseChiefTiers(raw: string): ChiefTiers {
  const o = parseJson(raw) ?? {}
  const out = { ...CHIEF_TIER_DEFAULTS }
  for (const id of TIER_IDS) {
    const row = o[id] as Record<string, unknown> | undefined
    if (row && typeof row.model === 'string' && row.model) out[id] = { model: row.model, effort: typeof row.effort === 'string' ? row.effort : CHIEF_TIER_DEFAULTS[id].effort }
  }
  return out
}

/** The tier a Claude model stands for; another family (Fable) has none and is left as asked. */
export function familyTier(model: string): TierId | null {
  const m = model.toLowerCase()
  return /haiku/.test(m) ? 'kolay' : /sonnet/.test(m) ? 'orta' : /opus/.test(m) ? 'cok_zor' : null
}

// ---------- difficulty floors: keywords that lift a job to at least a tier ----------
export type Floor = { words: string[]; tier: TierId }

export const FLOOR_DEFAULTS: Floor[] = [
  { words: ['video', 'edit', 'kurgu', 'reel', 'montaj', 'caption', 'thumbnail'], tier: 'zor' },
  { words: ['upwork', 'başvuru', 'proposal'], tier: 'orta' },
]

/** The saved `difficulty_floors` value; empty or unreadable is the defaults, and "[]" is no floors at all. */
export function parseFloors(raw: string): Floor[] {
  if (!raw.trim()) return FLOOR_DEFAULTS
  try {
    const list = JSON.parse(raw) as { words?: unknown; tier?: unknown }[]
    if (!Array.isArray(list)) return FLOOR_DEFAULTS
    return list.flatMap(f => {
      const tier = asTier(f.tier)
      const words = Array.isArray(f.words) ? f.words.map(w => String(w).trim()).filter(Boolean) : []
      return tier && words.length ? [{ words, tier }] : []
    })
  } catch {
    return FLOOR_DEFAULTS
  }
}

/** "video, edit" as a word list. */
export const splitWords = (text: string) => text.split(/[,;\n]/).map(w => w.trim()).filter(Boolean)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The hardest floor whose keyword starts a word of the text (so "kurgusu" and "videoyu" match "kurgu" and "video"). */
export function matchFloor(text: string, floors: readonly Floor[]): { tier: TierId; word: string } | null {
  const hay = fold(text)
  let best: { tier: TierId; word: string } | null = null
  for (const f of floors) {
    const word = f.words.find(w => fold(w).trim() && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(fold(w).trim())}`, 'u').test(hay))
    if (word && (!best || rank(f.tier) > rank(best.tier))) best = { tier: f.tier, word }
  }
  return best
}

export type Raised = { tier: TierId; from: TierId | null; word: string }

/** The tier a job gets: the one asked for, or the floor its text matches when that is harder. Never lower. */
export function raiseTier(asked: TierId, text: string, floors: readonly Floor[]): Raised {
  const hit = matchFloor(text, floors)
  return hit && rank(hit.tier) > rank(asked) ? { tier: hit.tier, from: asked, word: hit.word } : { tier: asked, from: null, word: '' }
}

/** The line a tool result carries when a floor lifted the tier. */
export const floorNote = (r: Raised) => (r.from ? L(`Difficulty floor: "${r.word}" appears, so ${TIER_LABEL[r.from]} → ${TIER_LABEL[r.tier]}.`, `Zorluk tabanı: "${r.word}" geçtiği için ${TIER_LABEL[r.from]} → ${TIER_LABEL[r.tier]}.`) : '')

// ---------- picking a chief's model and effort ----------
export type ChiefAsk = { tier?: unknown; model?: string; effort?: string; goal?: string; isNew: boolean }
export type ChiefPick = { model?: string; effort?: string; tier: TierId | null; note: string }

/**
 * A chief's model and effort from its tier: the tier argument wins; with none, a new chief's own model says its tier
 * (no model at all is Orta) and an explicit model of another family stays as asked; a chat that is only being
 * configured or adopted keeps what it was given. A floor can lift the tier. With no tier named, an explicit effort
 * the caller gave always wins over the tier's own effort (it is the caller's word on how hard the chat should think).
 */
export function resolveChiefTier(ask: ChiefAsk, tiers: ChiefTiers, floors: readonly Floor[]): ChiefPick {
  const given = asTier(ask.tier)
  const base = given ?? (ask.isNew ? (ask.model ? familyTier(ask.model) : 'orta') : null)
  if (!base) return { model: ask.model, effort: ask.effort, tier: null, note: '' }
  const r = raiseTier(base, ask.goal ?? '', floors)
  const explicit = given === null && ask.effort && EFFORTS.includes(ask.effort) ? ask.effort : undefined
  return { model: tiers[r.tier].model, effort: explicit ?? tiers[r.tier].effort, tier: r.tier, note: floorNote(r) }
}

// ---------- picking a sub-agent's CLI, model and effort ----------
export type WorkerPick = { tier: TierId; cli: string; model: string; effort: string; note: string }

/** A sub-agent's run from its tier; the brief's text can lift the tier through a floor. */
export function resolveWorkerTier(asked: TierId, brief: string, tiers: SubTiers, floors: readonly Floor[]): WorkerPick {
  const r = raiseTier(asked, brief, floors)
  return { tier: r.tier, ...tiers[r.tier], note: floorNote(r) }
}

// ---------- Claude Code's own Agent tool ----------
const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type AgentAlias = (typeof ALIASES)[number]
export type AgentInput = { subagent_type?: string; model?: string; description?: string; prompt?: string }
export type AgentGate = { tier: TierId; model: AgentAlias; effort?: string; note: string } | null

/** The model name the Agent tool takes, for a Claude model id. */
export const agentAlias = (model: string): AgentAlias | null => ALIASES.find(a => model.toLowerCase().includes(a)) ?? null

/**
 * What to do with a call of Claude Code's Agent tool while sub-agent tiers are saved. Read-only searches (Explore,
 * Plan) pass untouched (null). The call's tier is the one its model names (none: Orta), lifted by the floors on its
 * description and prompt; when that tier runs on the Claude CLI the call goes on with the tier's model and effort.
 * Nothing is refused or swapped (1.42.0): a model the call names runs as named (its own tier only adds the effort),
 * and a tier that runs on another CLI leaves the call as it is.
 */
export function gateAgent(input: AgentInput, tiers: SubTiers, floors: readonly Floor[]): AgentGate {
  if (READ_ONLY_AGENTS.includes(String(input.subagent_type ?? '').toLowerCase())) return null
  const named = input.model ? agentAlias(input.model) : null
  const asked = (input.model ? familyTier(input.model) : null) ?? 'orta'
  const r = named ? null : raiseTier(asked, `${input.description ?? ''}\n${input.prompt ?? ''}`, floors)
  const tier = r?.tier ?? asked
  const row = tiers[tier]
  const model = row.cli === 'claude' ? agentAlias(row.model) : null
  if (!model || (named && named !== model)) return null
  return { tier, model, effort: EFFORTS.includes(row.effort) ? row.effort : undefined, note: r ? floorNote(r) : '' }
}

/** The context note: the four tiers and what to do with them. `cliLabel` names a CLI as the Settings do. */
export function tierNote(tiers: SubTiers, cliLabel: (cli: string) => string): string {
  const rows = TIER_IDS.map(id => `${TIER_LABEL[id].toLowerCase()} = ${cliLabel(tiers[id].cli)} ${tiers[id].model || L('default', 'varsayılan')}${tiers[id].effort ? ` (${tiers[id].effort})` : ''}`)
  return `The Chief · alt ajan seviyeleri: ${rows.join('; ')}. ${TIER_HINT}`
}

// ---------- model lists for the Settings pickers ----------
/** Models whose id holds every word of the search (case-insensitive); an empty search keeps them all. */
export function filterModels(models: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return models.filter(m => words.every(w => m.toLowerCase().includes(w)))
}

/** A live model list stays good for a day. */
export const MODEL_CACHE_MS = 24 * 3600_000
export type ModelCache = Record<string, { at: number; models: string[] }>
export const cacheFresh = (entry: { at: number } | undefined, now: number) => !!entry && now - entry.at < MODEL_CACHE_MS

/** The command that lists a CLI's models, where it has one (opencode takes its provider as the argument). */
export const LIST_COMMANDS: Record<string, string[]> = {
  codex: ['codex', 'debug', 'models'],
  devin: ['devin', 'models', 'list'],
  cursor: ['cursor-agent', '--list-models'],
  qoder: ['qodercli', '--list-models'],
  antigravity: ['agy', 'models'],
  openrouter: ['opencode', 'models', 'openrouter'],
  'opencode-zen': ['opencode', 'models', 'opencode'],
  'opencode-go': ['opencode', 'models', 'opencode-go'],
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

const LIST_PARSERS: Record<string, (out: string) => string[]> = {
  codex: out => ((parseJson(out)?.models as { slug?: string; visibility?: string }[] | undefined) ?? []).filter(m => m.slug && (!m.visibility || m.visibility === 'list')).map(m => m.slug!),
  // "Name (family)" heads a group; its members are indented ids. The family id is a model too.
  devin: out => out.split('\n').flatMap(l => [l.match(/^\S.*\(([\w.-]+)\)\s*$/)?.[1], l.match(/^\s{2}([\w.-]+)\s{2,}\S/)?.[1]].filter((x): x is string => !!x)),
  cursor: out => out.split('\n').flatMap(l => l.match(/^(\S+) - /)?.[1] ?? []),
  qoder: out => out.split('\n').map(l => l.trim()).filter(l => /^[A-Za-z][\w.-]*$/.test(l) && l !== 'MODEL'),
  // "gemini-4-carbon-high   Gemini 4 Carbon (High)": the slug is the first word
  antigravity: out => out.split('\n').flatMap(l => l.match(/^\s*([a-z][\w.-]*-[\w.-]+)\s{2,}\S/)?.[1] ?? []),
}
const opencodeList = (out: string) => out.split('\n').flatMap(l => l.trim().match(/^[\w.-]+\/(\S+)$/)?.[1] ?? [])
for (const cli of ['openrouter', 'opencode-zen', 'opencode-go']) LIST_PARSERS[cli] = opencodeList

/** The models a CLI's list command printed, without duplicates; empty when the CLI has no list or the output is not one. */
export function parseModelList(cli: string, output: string): string[] {
  const parse = LIST_PARSERS[cli]
  return parse ? [...new Set(parse(stripAnsi(output)).map(m => m.trim()).filter(Boolean))] : []
}

/** The picker's list: the built-in and configured models first, then the live ones, each once. */
export const mergeModels = (known: readonly string[], live: readonly string[]) => [...new Set([...known, ...live])]

// ---------- OpenCode Go: a curated list instead of the live 32 ----------
/** The OpenCode Go models on offer (ids checked against `opencode models opencode-go`). */
export const OPENCODE_GO_MODELS = [
  'gemini-4-argon-contributor', 'kimi-k2.7-code', 'space-bunny', 'minimax-m3', 'claude-haiku-5-5', 'gpt-6-luna', 'qwen3.7-plus',
  'glm-5.3-flash', 'mimo-v2.6-flash', 'deepseek-v4.1-flash', 'muse-spark-1.3-contributor', 'longcat-2.5-preview-free', 'step-5-preview-free', 'cat-jam-free',
]
/** Free on OpenCode Go: a `-free` id, or DeepSeek V4.1 Flash (free without saying so in its id). */
export const isFreeModel = (m: string) => /-free$/.test(m) || m === 'deepseek-v4.1-flash'
/** How the picker shows a model: free ones are tagged. */
export const modelText = (m: string) => (isFreeModel(m) ? `${m} (free)` : m)

// ---------- worker routes: which CLI a spawn_worker tier lands on, in order, with the fallback when a limit is hit ----------
export type Route = { cli: string; model: string; effort: string; /** the provider keeps what it sees: never for private data */ keeps?: boolean }

/**
 * The owner's routes (16.10), best first. Longcat runs on OpenCode Zen (`opencode/longcat-2.5-preview-free`): the OpenCode Go copy of it hangs.
 * Zen's free models may keep what they see, so they carry `keeps`. A CLI that hit its limit is skipped, so the next entry runs. OpenCode Go's
 * free DeepSeek V4.1 Flash keeps data: it is skipped when the job is private.
 */
export const WORKER_ROUTES: Record<TierId, Route[]> = {
  kolay: [
    // Qoder model names are case-sensitive: `qodercli --list-models` prints Qwen3.8-Flash, and qwen3.8-flash falls back to auto
    { cli: 'qoder', model: 'Qwen3.8-Flash', effort: 'high' },
    { cli: 'opencode-zen', model: 'longcat-2.5-preview-free', effort: '', keeps: true },
    { cli: 'claude', model: 'claude-haiku-5-5', effort: 'xhigh' },
  ],
  orta: [
    { cli: 'opencode-zen', model: 'longcat-2.5-preview-free', effort: '', keeps: true },
    { cli: 'opencode-go', model: 'deepseek-v4.1-flash', effort: 'high', keeps: true },
    { cli: 'claude', model: 'claude-haiku-5-5', effort: 'xhigh' },
  ],
  zor: [
    { cli: 'opencode-go', model: 'deepseek-v4.1-flash', effort: 'high', keeps: true },
    { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  ],
  cok_zor: [
    { cli: 'qoder', model: 'Qwen3.8-Max', effort: 'high' },
    { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  ],
}

/** The words that mark a job's data as private (a client's files, credentials): the free, data-keeping routes are skipped. */
const PRIVATE_RE = /\b(private|confidential|nda|client|müşteri|musteri|gizli|özel veri|ozel veri|credential|password|şifre|api[_ -]?key|token)\b/i
export const looksPrivate = (text: string) => PRIVATE_RE.test(fold(text)) || PRIVATE_RE.test(text)

/** How a route is told apart from the others of its tier. */
export const routeKey = (r: { cli: string; model: string }) => `${r.cli}/${r.model}`

export type RoutePick = Route & { tier: TierId; note: string }

/**
 * The route a tier runs on: the tier (lifted by the difficulty floors), then the first entry whose CLI is not limited
 * and, for private jobs, does not keep data. `spread` rotates among the entries that qualify, so parallel workers do
 * not all land on one provider. When nothing qualifies the last entry runs anyway (Claude, the one that never keeps data).
 */
export function resolveWorkerRoute(asked: TierId, brief: string, floors: readonly Floor[], opts: { limited?: ReadonlySet<string>; isPrivate?: boolean; spread?: number; routes?: Partial<Record<TierId, Route[]>>; skip?: ReadonlySet<string> } = {}): RoutePick {
  const r = raiseTier(asked, brief, floors)
  const list = opts.routes?.[r.tier]?.length ? opts.routes[r.tier]! : WORKER_ROUTES[r.tier]
  const ok = list.filter(x => !opts.limited?.has(x.cli) && !(opts.isPrivate && x.keeps) && !opts.skip?.has(routeKey(x)))
  const usable = ok.length ? ok : list.filter(x => !x.keeps)
  // only the entries that are not the paid fallback take turns; the fallback stays the fallback
  const free = usable.filter(x => x.cli !== 'claude')
  const pick = free.length > 1 ? free[(opts.spread ?? 0) % free.length]! : usable[0]!
  const notes = [floorNote(r), opts.isPrivate && list.some(x => x.keeps) ? L('private data: skipped a free route that keeps data', 'özel veri: veri saklayan ücretsiz rota atlandı') : '', opts.limited?.size && list.some(x => opts.limited!.has(x.cli)) ? L('skipped a CLI at its limit', 'limit dolan CLI atlandı') : ''].filter(Boolean)
  return { tier: r.tier, ...pick, note: notes.join(' · ') }
}

/**
 * The route after one that failed: the next entry of the tier's list that has not been tried, is not limited and (for
 * private jobs) keeps no data. Null when every entry was tried, so the failure is real and the leader is told.
 */
export function nextWorkerRoute(tier: TierId, tried: ReadonlySet<string>, opts: { limited?: ReadonlySet<string>; isPrivate?: boolean; routes?: Partial<Record<TierId, Route[]>> } = {}): RoutePick | null {
  const list = opts.routes?.[tier]?.length ? opts.routes[tier]! : WORKER_ROUTES[tier]
  const pick = list.find(x => !tried.has(routeKey(x)) && !opts.limited?.has(x.cli) && !(opts.isPrivate && x.keeps))
  return pick ? { tier, ...pick, note: L('the previous route failed: moved to the next route', 'önceki rota başarısız oldu: sıradaki rotaya geçildi') } : null
}

/** The tried set after a 0-BYTE log (a snapshot hang, not a limit): that model is never retried, the next route runs. */
export const afterZeroByte = (route: { cli: string; model: string }, tried: readonly string[] = []) => new Set([...tried, routeKey(route)])

// ---------- OpenCode Zen free models: the tracker's healthy list becomes the automatic route order ----------
/**
 * The free models the owner wants first (10/22): DeepSeek V4.1 Flash, then MiMo, Nemotron, Laguna, LongCat and GLM
 * 5.3 Flash. A pattern matches anywhere in the id, so a new version of a family still lands in its place; the rest
 * follows by id. Laguna is kept for when Zen offers it again.
 */
export const ZEN_PRIORITY = ['deepseek-v4.1-flash-free', 'mimo', 'nemotron', 'laguna', 'longcat', 'glm-5.3-flash-free'] as const

/** The local stop after the free Zen models: OpenCode talks to Ollama. It keeps data, so private jobs skip it. */
export const OLLAMA_ROUTE: Route = { cli: 'opencode-ollama', model: 'minimax-m3.1-flash', effort: '', keeps: true }

/** Healthy free-model ids in the owner's order: named families first, the rest after, each once. */
export function zenRouteOrder(ids: readonly string[]): string[] {
  const rank = (id: string) => {
    const at = ZEN_PRIORITY.findIndex(p => id.toLowerCase().includes(p))
    return at < 0 ? ZEN_PRIORITY.length : at
  }
  return [...new Set(ids.filter(Boolean))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/**
 * The automatic routes while the Zen tracker has fresh data: kolay and orta run the healthy free models in the
 * owner's order, then Ollama's minimax, then Haiku 5.5 xhigh; zor runs Sonnet 5.5 medium (never a free model).
 * Every free and local stop keeps what it sees, so a private job skips them through the existing `keeps` rule.
 */
export function zenRoutes(healthy: readonly string[], o: { max?: number } = {}): Record<TierId, Route[]> {
  const zen: Route[] = zenRouteOrder(healthy)
    .slice(0, o.max ?? 8)
    .map(id => ({ cli: 'opencode-zen', model: id, effort: '', keeps: true }))
  const haiku: Route = { cli: 'claude', model: 'claude-haiku-5-5', effort: 'xhigh' }
  return {
    kolay: [...zen, OLLAMA_ROUTE, haiku],
    orta: [...zen, OLLAMA_ROUTE, haiku],
    zor: [{ cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }],
    cok_zor: WORKER_ROUTES.cok_zor,
  }
}
