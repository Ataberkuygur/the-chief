/**
 * Saved prompts: a plain list kept in one JSON file on the person's machine (~/.claude/the-chief/prompts.json),
 * never in the plugin folder. Pure, so it is tested.
 */

export type SavedPrompt = { name: string; text: string; at: number }

/** The stored file read back; `broken` when it exists but is not a prompt list (it is kept, never overwritten). */
export function parsePrompts(raw: string | null | undefined): { list: SavedPrompt[]; broken: boolean } {
  if (raw == null || !raw.trim()) return { list: [], broken: false }
  try {
    const v = JSON.parse(raw.replace(/^﻿/, ''))
    if (!Array.isArray(v)) return { list: [], broken: true }
    const list = v
      .filter(p => p && typeof p.name === 'string' && typeof p.text === 'string' && p.name.trim() && p.text.trim())
      .map(p => ({ name: p.name.trim(), text: p.text, at: typeof p.at === 'number' ? p.at : 0 }))
    return { list, broken: false }
  } catch {
    return { list: [], broken: true }
  }
}

/**
 * Adds a prompt, newest first. Empty text changes nothing. The same name with the same text is not added twice;
 * the same name with other text gets " (2)", " (3)"…, so nothing saved is ever replaced.
 */
export function addPrompt(list: readonly SavedPrompt[], name: string, text: string, at: number): { list: SavedPrompt[]; name: string; added: boolean } {
  const body = text.replace(/\s+$/, '')
  const base = name.replace(/\s+/g, ' ').trim().slice(0, 60) || firstLine(body).slice(0, 40) || 'Prompt'
  if (!body.trim()) return { list: [...list], name: base, added: false }
  if (list.some(p => p.name === base && p.text === body)) return { list: [...list], name: base, added: false }
  let n = base
  for (let i = 2; list.some(p => p.name === n); i++) n = `${base} (${i})`
  return { list: [{ name: n, text: body, at }, ...list], name: n, added: true }
}

export const removePrompt = (list: readonly SavedPrompt[], name: string) => list.filter(p => p.name !== name)

/** The first non-empty line, for the list. */
export const firstLine = (text: string) => text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''
