import { L } from './lang'
/**
 * The small rules behind the leader's chief tools, kept out of register.tsx so each one is tested on its own:
 *
 * - a brief is news once: list_chiefs printed a chief's last brief after every turn, the same words again and again;
 * - an effort the leader set is read back: a research chief showed "high" and went back to "max" and nobody heard it;
 * - a chief the owner stopped stays stopped: the plugin's queued messages started it again on the next tick;
 * - a target that is not one of the leader's chiefs is answered with its real cause, never "text is required".
 *
 * Nothing here touches the host, the store or the file system: pure functions only.
 */

/** Text with its case and spacing taken out, for "are these the same words?". */
export const words = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Whether a chief's brief is news for list_chiefs: true only when it says something new. The same brief (also with
 * other spacing or case) and an empty one are not printed again, so a long job costs one line, not one per turn.
 */
export function briefIsNew(seen: string | undefined, brief: string): boolean {
  const now = words(brief)
  if (!now) return false
  return now !== words(seen)
}

/** What a chief's card says about an effort the leader asked for. */
export type EffortState = 'ok' | 'pending' | 'mismatch'
export type EffortCard = { running?: string; told?: string }

/**
 * The read-back of an effort the leader set. `running` is what the chat really runs on (the card's own effort),
 * `told` is what it was told to run (the effort in its config):
 * - ok: the chat already runs on the asked effort;
 * - pending: the chief took it and applies it at its next request (its context is too big for a safe point now);
 * - mismatch: the card names another effort and was not even told this one, so it reverted (the research chief:
 *   "high" set, "max" on the card).
 */
export function effortState(asked: string, card: EffortCard | null | undefined): EffortState {
  const want = words(asked)
  if (!want) return 'ok'
  if (!card) return 'pending'
  if (words(card.running) === want) return 'ok'
  if (words(card.told) === want) return 'pending'
  return 'mismatch'
}

/** The line configure_chief answers with after reading the chief's card back. */
export function effortReport(asked: string, state: EffortState, card?: EffortCard | null): string {
  const running = String(card?.running ?? '').trim()
  if (state === 'ok') return L(`effort ${asked} confirmed`, `effort ${asked} doğrulandı`)
  if (state === 'pending') return L(`effort ${asked} received${running ? `; now ${running}, applied at the next step` : ''}`, `effort ${asked} alındı${running ? `; şu an ${running}, bir sonraki adımda uygulanır` : ''}`)
  // said plainly: the leader has to hear a revert, not "applied"
  return L(`⚠ effort ${asked} NOT APPLIED: the chief is still on ${running || 'an unknown effort'} (sent again)${running ? `; ${running} goes on` : ''}`, `⚠ effort ${asked} UYGULANMADI: şef hâlâ ${running || 'bilinmeyen bir effort'} (yeniden gönderildi)${running ? `; ${running} sürüyor` : ''}`)
}

/**
 * Inbox messages that would start a stopped chief again. A chief the owner stopped keeps its queue empty: these are
 * dropped, never delivered. `release`, `stop-loops`, `pin` and `clear-goal` carry no work and still go through.
 */
export const RESTART_KINDS = ['message', 'join', 'configure', 'live-command'] as const
export const restartsChief = (kind: string) => (RESTART_KINDS as readonly string[]).includes(kind)

/** A chat as the leader's card file describes it, for telling the leader why a target is not its chief. */
export type ChiefLook = { title: string; role: string; leader: string | null; chat?: boolean } | null | undefined

/**
 * Why message_chief / configure_chief cannot reach this target. A chief on another laptop is found by the peer path
 * before this, so what is left is a real mistake and is said plainly with the thing to do about it.
 */
export function notMyChief(ref: string, found: ChiefLook): string {
  const who = String(ref ?? '').trim() || '(no chief given)'
  if (!found) return `No chat matches "${who}": it is not one of your chiefs. list_chiefs shows your chiefs; a Remote Control or cloud chat is reached by its id in brackets or its name.`
  if (found.chat === false) return `${found.title} is a headless run (a script's claude -p), not a chat: it cannot be a chief.`
  if (found.role === 'chief') return `${found.title} is another leader's chief, not yours: only the chat that leads it can message it.`
  return `${found.title} is an open chat, not one of your chiefs: take it with adopt_chief first, then message it.`
}
