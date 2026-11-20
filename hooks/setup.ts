/**
 * First-run setup: the risky choices are asked once, in the person's first chat, instead of decided for them.
 * Until answered, every one of them is off (riskyOn). Pure, so it is tested.
 */

import { L } from './lang'

export type RiskyField = 'chief_permission_mode' | 'tab_bridge' | 'chief_remote_control' | 'api_credit_fallback' | 'summary_engine'

/** Whether a risky option is on: only its exact "on" value counts (tab_bridge: also a folder); unset or anything else is off. */
export function riskyOn(field: RiskyField, value: string | undefined): boolean {
  const v = String(value ?? '').trim()
  if (field === 'tab_bridge') return v !== '' && v.toLowerCase() !== 'off'
  if (field === 'chief_permission_mode' || field === 'summary_engine') return v === 'auto'
  return v === 'on'
}

/** The store key of the "setup done" marker: { state: 'asking' | 'done' | 'skipped', at }. */
export const SETUP_KEY = 'setupDone'
/** A setup left half way (the app closed during it) is asked again after this long. */
export const SETUP_STALE_MS = 10 * 60000

export const setupInfo = () => L('The Chief setup: a few choices, the safe one first. Workers can always create and edit files in the folder they are given.', 'The Chief kurulumu: birkaç seçim, güvenli olan önce. İşçiler kendilerine verilen klasörde her zaman dosya oluşturup düzenleyebilir.')

export type SetupQuestion = { field: RiskyField; header: string; question: string; safe: string; safeValue: string; risky: string; riskyValue: string }

export const setupQuestions = (dailyUsd: string): SetupQuestion[] => [
  { field: 'chief_permission_mode', header: L('New chiefs', 'Yeni şefler'), question: L('New chief chats: should they ask you before acting, or work without approval cards (auto mode)?', 'Yeni şef sohbetleri: bir şey yapmadan önce sana sorsun mu, yoksa onay kartı olmadan mı çalışsın (otomatik mod)?'), safe: L('Ask me before acting', 'Yapmadan önce bana sor'), safeValue: 'off', risky: L('Auto mode, no cards', 'Otomatik mod, kart yok'), riskyValue: 'auto' },
  { field: 'tab_bridge', header: 'Chrome', question: L('Chrome: may agents drive your real Chrome, including sites where you are signed in (Tab Bridge)?', `Chrome: ajanlar gerçek Chrome'unu, giriş yaptığın siteler dahil, kullanabilsin mi (Tab Bridge)?`), safe: L('Never use my Chrome', `Chrome'umu asla kullanma`), safeValue: 'off', risky: L('Let agents use Chrome', `Ajanlar Chrome'u kullansın`), riskyValue: 'on' },
  { field: 'chief_remote_control', header: L('Remote', 'Uzaktan'), question: L('Remote Control: turn it on for every working chat, so you can follow it from your phone?', 'Remote Control: çalışan her sohbette açılsın mı, telefondan takip edebilmen için?'), safe: L('Off', 'Kapalı'), safeValue: 'off', risky: L('On', 'Açık'), riskyValue: 'on' },
  { field: 'api_credit_fallback', header: L('API credit', 'API kredisi'), question: L(`Paid API credit: may Claude workers spend the ANTHROPIC_API_KEY in your environment, up to $${dailyUsd} a day, instead of your Claude login?`, `Ücretli API kredisi: Claude işçileri, Claude girişin yerine ortamındaki ANTHROPIC_API_KEY'i günde en fazla $${dailyUsd} harcayabilsin mi?`), safe: L('Off', 'Kapalı'), safeValue: 'off', risky: L('On', 'Açık'), riskyValue: 'on' },
  { field: 'summary_engine', header: L('Status lines', 'Durum satırları'), question: L('Status lines: may The Chief download a small local model (0.5-1.3 GB) to write what each agent is doing?', 'Durum satırları: The Chief her ajanın ne yaptığını yazmak için küçük bir yerel model (0.5-1.3 GB) indirebilsin mi?'), safe: L('Never download', 'Asla indirme'), safeValue: 'ask', risky: L('Download the model', 'Modeli indir'), riskyValue: 'auto' },
]

/** Whether this session may show the setup now: a person is there, it is not a worker or chief, and no setup was done. */
export function canAskSetup(s: { interactive: boolean; isWorker: boolean; role: string; surfaces: readonly string[]; done: unknown; now: number; force?: boolean }): boolean {
  if (!s.interactive || s.isWorker) return false
  if (s.force) return true
  // a -p run draws nowhere; a chief the plugin started is not the person's own first chat
  if (s.role === 'chief' || !s.surfaces.length) return false
  const d = s.done as { state?: string; at?: number } | undefined | null
  if (!d) return true
  return d.state === 'asking' && s.now - (d.at ?? 0) > SETUP_STALE_MS
}

export type SetupResult = { state: 'done' | 'skipped'; answers: Record<string, string>; summary: string }

/**
 * Asks every question in turn; the answers are saved only when all came back. Anything but the risky label exactly
 * (free text under "Other" too) is the safe answer. A dismissed dialog saves nothing: the options stay as they were.
 */
export async function runSetup(d: { ask: (q: string, o: { options: string[]; header: string }) => Promise<string>; save: (field: string, value: string) => Promise<void> }, dailyUsd: string): Promise<SetupResult> {
  const answers: Record<string, string> = {}
  const said: string[] = []
  for (const q of setupQuestions(dailyUsd)) {
    let a: string
    try {
      a = await d.ask(q.question, { options: [q.safe, q.risky], header: q.header })
    } catch {
      return { state: 'skipped', answers: {}, summary: '' }
    }
    const on = a === q.risky
    answers[q.field] = on ? q.riskyValue : q.safeValue
    said.push(`${q.header}: ${on ? q.risky : q.safe}`)
  }
  for (const [field, value] of Object.entries(answers)) await d.save(field, value)
  return { state: 'done', answers, summary: said.join(', ') }
}
