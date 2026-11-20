import { L } from './lang'
/**
 * Lanes: the owner's repeatable worker recipe (worktree, node_modules link, brief, worker, checks, report),
 * the shared check table, escalation up the tiers, the "do not touch" guard, machine capacity and the leader report.
 * Pure helpers only; register.tsx runs the processes and keeps the state.
 */
import type { TierId } from './tiers'

export type CheckDef = {
  /** Column name in the table: tsc, deps, eslint, vitest … */
  name: string
  cmd: string
  /** A failed check whose output matches `match` runs `run` (with {1} = first capture group) and is tried once more. */
  fix?: { match: string; run: string }
}

export type LaneTemplate = {
  name: string
  /** Path of the repository the worktrees are cut from. */
  repo: string
  /** Ref a worktree starts at (default HEAD). */
  ref?: string
  /** Where a lane's worktree goes; {NAME} is the lane name. */
  path: string
  /** Folders linked into the worktree from the repo, e.g. node_modules. */
  link?: string[]
  /** Task text (or a file path) written into the folder as LANE-TASK.md; {NAME} {WT} {BRANCH} are filled in. */
  task: string
  tier?: TierId
  checks?: CheckDef[]
  /** Paths and patterns a worker must not touch. */
  guard?: string[]
  /** Lanes (by name) that start when this one is done and its checks pass. */
  next?: string[]
  private?: boolean
}

export type CheckResult = { name: string; ok: boolean; summary: string; at: number }

export type LaneState = {
  name: string
  template: string
  dir: string
  tier: TierId
  workerId?: string
  fails: number
  checks: CheckResult[]
  guard: string[]
  guardHits: string[]
  after?: string
  phase: 'waiting' | 'working' | 'checking' | 'ready' | 'failed' | 'stopped'
  note: string
}

export const TIER_UP: Record<TierId, TierId | null> = { kolay: 'orta', orta: 'zor', zor: 'cok_zor', cok_zor: null }
/** The next tier up after the checks fell twice, or null at the top. */
export const escalate = (tier: TierId): TierId | null => TIER_UP[tier]
export const ESCALATE_AFTER = 2

const slash = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/** Does a file path hit a guard pattern? A pattern is a path fragment; * matches anything. */
export function hitsGuard(file: string, patterns: readonly string[]): string | null {
  const f = slash(file)
  for (const raw of patterns) {
    const p = slash(raw).trim()
    if (!p) continue
    if (p.includes('*')) {
      const re = new RegExp(p.replace(/[.+?^${}()|[\]]/g, '\\$&').replace(/\*/g, '.*'))
      if (re.test(f)) return raw
    } else if (f.includes(p)) return raw
  }
  return null
}

/** A one-cell summary of a check's output. */
export function summarize(name: string, ok: boolean, out: string): string {
  const text = out.replace(/\x1b\[[0-9;]*m/g, '')
  const n = (re: RegExp) => Number(text.match(re)?.[1] ?? NaN)
  if (/vitest|jest/i.test(name)) {
    const passed = n(/(\d+)\s+passed/i)
    const failed = n(/(\d+)\s+failed/i)
    const total = n(/Tests\s+.*\((\d+)\)/i)
    if (Number.isFinite(passed) || Number.isFinite(failed)) {
      const f = Number.isFinite(failed) ? failed : 0
      const p = Number.isFinite(passed) ? passed : 0
      return `${p}/${Number.isFinite(total) ? total : p + f}${f ? L(` · ${f} failed`, ` · ${f} düştü`) : ''}`
    }
  }
  if (/tsc|type/i.test(name)) {
    const errs = (text.match(/error TS\d+/g) ?? []).length
    return ok ? L('clean', 'temiz') : L(`${errs || '?'} errors`, `${errs || '?'} hata`)
  }
  if (/eslint|lint/i.test(name)) {
    const m = text.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?/i)
    return ok ? L('clean', 'temiz') : m ? L(`${m[2]} errors`, `${m[2]} hata`) : L('errors', 'hata')
  }
  if (/deps|gate/i.test(name)) return ok ? L('clean', 'temiz') : /cycl|döngü|circular/i.test(text) ? L('cycle', 'döngü') : L('violation', 'ihlal')
  return ok ? 'ok' : L('failed', 'düştü')
}

const cell = (c: CheckResult | undefined) => (c ? `${c.ok ? '✓' : '✗'} ${c.summary}` : '·')

/** The one table: a row per lane, a column per check, the phase last. */
export function checkTable(lanes: readonly LaneState[], columns: readonly string[]): string {
  if (!lanes.length) return 'No lanes yet.'
  const head = ['Lane', ...columns, L('Status', 'Durum')]
  const rows = lanes.map(l => [l.name, ...columns.map(c => cell(l.checks.find(x => x.name === c))), l.note ? `${l.phase} · ${l.note}` : l.phase])
  const line = (r: string[]) => `| ${r.join(' | ')} |`
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n')
}

/** The chain as text: `media2 → render2 (bekliyor)`. */
export function flowText(lanes: readonly LaneState[]): string {
  const edges = lanes.filter(l => l.after).map(l => `${l.after} → ${l.name} (${l.phase})`)
  return edges.length ? edges.join('\n') : ''
}

/** How many workers and heavy commands (tsc, vitest …) this machine runs at once, from the RAM that is really available. */
export function capacity(availMb: number, cpus: number, o: { reserveMb?: number; workerMb?: number; heavyMb?: number } = {}) {
  const reserve = o.reserveMb ?? 3072
  const workerMb = o.workerMb ?? 900
  const heavyMb = o.heavyMb ?? 1500
  const usable = Math.max(0, availMb - reserve)
  // a root tsc holds ~3 GB: slots come from (free RAM - reserve) / 3.5 GB, so 1-2 on a normal machine
  const heavy = Math.max(1, Math.min(Math.floor(usable / Math.max(heavyMb, 3500)), Math.max(1, Math.floor(cpus / 2)), 4))
  const workers = Math.max(1, Math.min(Math.floor((usable - heavy * heavyMb) / workerMb) + heavy, 12))
  return { workers, heavy, usableMb: Math.round(usable) }
}

/** The leader report: ready, counts, checks, what was not moved and why. Plain text, copyable. */
export function laneReport(l: LaneState, o: { files: number; added: number; removed: number; report: string; skipped: readonly string[]; columns: readonly string[]; branch?: string }): string {
  const checks = o.columns.map(c => `${c} ${cell(l.checks.find(x => x.name === c))}`).join(' · ')
  const skipped = o.skipped.length ? o.skipped.map(s => `- ${s}`).join('\n') : L('- none', '- yok')
  const ready = l.phase === 'ready' ? L('READY', 'HAZIR') : L(`NOT READY (${l.phase}${l.note ? `: ${l.note}` : ''})`, `HAZIR DEĞİL (${l.phase}${l.note ? `: ${l.note}` : ''})`)
  return [
    `${l.name}: ${ready}`,
    L(`Count: ${o.files} files, +${o.added} −${o.removed}${o.branch ? ` · branch ${o.branch}` : ''}`, `Sayım: ${o.files} dosya, +${o.added} −${o.removed}${o.branch ? ` · dal ${o.branch}` : ''}`),
    L(`Checks: ${checks || '-'}`, `Kontroller: ${checks || '-'}`),
    l.guardHits.length ? L(`Do-not-touch list violation: ${l.guardHits.join(', ')}`, `Dokunma listesi ihlali: ${l.guardHits.join(', ')}`) : '',
    L(`Not moved, and why:\n${skipped}`, `Taşınmayanlar ve nedenleri:\n${skipped}`),
    o.report ? L(`Worker report: ${o.report.slice(0, 600)}`, `İşçi raporu: ${o.report.slice(0, 600)}`) : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Lines of a worker report that say something was left out. */
export function skippedFrom(report: string): string[] {
  return report
    .split(/\r?\n/)
    .map(s => s.replace(/^[-*\s]+/, '').trim())
    .filter(s => /taşınma|taşınmadı|atlandı|bırakıldı|skipped|not moved|left out|excluded/i.test(s))
    .slice(0, 12)
}

export type Credit = { cli: string; limit: number; used: number; until?: string; label?: string }
/** "Qoder: 1840/2000 kaldı" style line. */
export function creditLine(c: Credit, limitedUntil?: number, now = 0): string {
  const name = c.label ?? c.cli
  if (limitedUntil && limitedUntil > now) return L(`${name}: limit reached, moved to a lower route`, `${name}: limit doldu, bir alt rotaya geçildi`)
  const left = Math.max(0, c.limit - c.used)
  return L(`${name}: ${left}/${c.limit} left${c.until ? ` (until ${c.until})` : ''}`, `${name}: ${left}/${c.limit} kaldı${c.until ? ` (${c.until}'e kadar)` : ''}`)
}

/** How long ago, in the owner's words: L("just now", "az önce"), "12 dk önce", "3 sa önce". */
const agoText = (ms: number) => (ms < 90000 ? L('just now', 'az önce') : ms < 90 * 60000 ? L(`${Math.round(ms / 60000)} min ago`, `${Math.round(ms / 60000)} dk önce`) : L(`${Math.round(ms / 3600000)} h ago`, `${Math.round(ms / 3600000)} sa önce`))

/** The Zen tracker line of the lanes table: the free models it found, how many answered, and which it skips. */
export function zenLine(r: { at: number; fetchedAt: number; models: { id: string; check?: { health: string; at: number } }[] } | null | undefined, now: number): string {
  if (!r || (!r.at && !r.models.length)) return L('Zen: not scanned yet', 'Zen: henüz taranmadı')
  const ok = r.models.filter(m => m.check?.health === 'ok')
  const bad = r.models.filter(m => m.check && m.check.health !== 'ok')
  const parts = [L(`Zen: ${r.models.length} free models`, `Zen: ${r.models.length} ücretsiz model`), L(`${ok.length} healthy`, `${ok.length} sağlıklı`)]
  if (r.fetchedAt) parts.push(`tarama ${agoText(Math.max(0, now - r.fetchedAt))}`)
  if (ok.length) parts.push(`ilk: ${ok.slice(0, 3).map(m => m.id).join(', ')}`)
  if (bad.length) parts.push(`atlanan: ${bad.slice(0, 4).map(m => `${m.id} ${m.check!.health}`).join(', ')}`)
  return parts.join(' · ')
}

