import { L } from './lang'
/**
 * Reports from chiefs on another computer (the Mac), carried by git: each report is one markdown file under
 * reports/mac/ on a reports branch of origin (name starts with a sortable timestamp). The leader fetches the branch
 * and reads the files it has not seen. The app gives no way to read a remote chat's replies, git is the shared wire.
 * Everything here is pure, so it is tested.
 */

/** Config (hq/mac-reports.json): the repo to fetch, the branch and the folder of reports in it. */
export type MacReportsConfig = { repo: string; branch: string; dir: string }

const SAFE = /^[A-Za-z0-9_][\w./-]*$/

export function parseMacReportsConfig(raw: unknown): MacReportsConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const repo = typeof c.repo === 'string' ? c.repo.trim() : ''
  const branch = typeof c.branch === 'string' ? c.branch.trim() : 'lane/mac-reports'
  const dir = (typeof c.dir === 'string' ? c.dir.trim() : 'reports/mac').replace(/\/+$/, '')
  if (!repo || !SAFE.test(branch) || branch.includes('..') || !SAFE.test(dir) || dir.includes('..')) return null
  return { repo, branch, dir }
}

/** Report files in a `git ls-tree -r --name-only` listing that are not seen yet, oldest first (names sort by time). */
export function unseenReports(listing: string, dir: string, seen: readonly string[]): string[] {
  const have = new Set(seen)
  return listing
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.startsWith(`${dir}/`) && l.endsWith('.md') && SAFE.test(l) && !l.includes('..') && !have.has(l))
    .sort()
}

/** A report as news: the first line that says HAZIR / DURUM / SORU, else the first line; and whether it is a question. */
export function reportNews(path: string, text: string): { title: string; line: string; isQuestion: boolean } {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const key = lines.find(l => /^(HAZIR|DURUM|SORU|READY|STATUS|QUESTION)\b/i.test(l.replace(/^[#>*\s-]+/, ''))) ?? lines[0] ?? L('(empty report)', '(boş rapor)')
  const who = /^[\dT-]+(?:_([\w.-]+))?\.md$/.exec(path.split('/').pop() ?? '')?.[1] ?? 'mac'
  return { title: `Mac ${who}`, line: key.replace(/^[#>*\s-]+/, '').slice(0, 400), isQuestion: /^(SORU|QUESTION)\b/i.test(key.replace(/^[#>*\s-]+/, '')) }
}
