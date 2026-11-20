/**
 * The person's language, decided once per session: English unless something clearly says Turkish.
 * Order: the plugin's `language` option > Claude Code's own `language` setting > the system locale > English.
 */

export type Lang = 'en' | 'tr'

const trWord = (s: string) => /^\s*(tr|tur|turkish|türkçe|turkce|türk|turk)\b/i.test(s)
const trLocale = (s: string) => /^\s*"?tr([-_.@]|"|\s*$)/i.test(s)

/** Pure, so it is tested. `locales`: the system's preferred locales, first one wins (LANG, AppleLanguages, Windows LocaleName). */
export function pickLang(s: { option?: string; claudeLanguage?: unknown; locales?: readonly (string | undefined)[] }): Lang {
  const o = String(s.option ?? '').trim().toLowerCase()
  if (o === 'en' || o === 'tr') return o
  const c = typeof s.claudeLanguage === 'string' ? s.claudeLanguage.trim() : ''
  if (c) return trWord(c) ? 'tr' : 'en'
  const first = (s.locales ?? []).map(x => String(x ?? '').trim()).find(x => x && !/^(c|posix)([._].*)?$/i.test(x))
  return first && trLocale(first) ? 'tr' : 'en'
}

/** The first locale in `defaults read -g AppleLanguages` output: ( "tr-TR", "en-US" ). */
export const firstAppleLanguage = (out: string) => out.match(/"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?/g)?.map(x => x.replace(/"/g, ''))[0]

let lang: Lang = 'en'
export const setLang = (l: Lang) => void (lang = l)
export const getLang = () => lang
/** The person-visible text in the session's language. */
export const L = <T,>(en: T, tr: T): T => (lang === 'tr' ? tr : en)
