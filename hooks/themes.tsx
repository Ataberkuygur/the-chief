import { storeSet } from './storekeep'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeSetArgs, Timer } from 'claude-code'

import { L } from './lang'
import { OVERLAY } from './paste-overlay'
import { drawLite, SCENES } from './scenes'

// The Chief's moving scenes (the eleven kept below) as the app's own backdrop: sharp or blurred at three
// strengths, the frosted glass over the chat on or off, one scene or changing on their own every few seconds. Only the backdrop changes; the app keeps its colours.
const BLURS = { az: ['Light', 'Az'], orta: ['Medium', 'Orta'], cok: ['Strong', 'Çok'] } as const
// how far the whole scene blurs, in screen pixels at 1440 wide
const BLUR_PX: Record<Kind, number> = { normal: 0, az: 4, orta: 10, cok: 22 }
type Kind = 'normal' | keyof typeof BLURS
// the scenes the tab offers, in the order auto-change walks them
export const LIST = ['cloud-drift', 'honu-lagoon', 'paper-boats', 'bamboo-mist', 'murmuration', 'jellyfish', 'snow-cabin', 'deep-space', 'rain-window', 'neon-grid', 'aurora']
// seconds between auto changes; 0 holds one scene
export const AUTOS = [0, 5, 10, 30] as const
// rot: the scenes auto-change walks, picked under each picture; all of them at first
// at: when the choice was made; auto-change counts its steps from it, so every chat shows the same scene at once
// move: the scene animates. Off by default: measured in Chrome, a moving scene took 70-200% CPU, a still one 2%
type Choice = { scene: string; kind: Kind; frost: boolean; auto: number; rot: string[]; at: number; move: boolean }
const DEFAULT: Choice = { scene: 'cloud-drift', kind: 'normal', frost: true, auto: 0, rot: LIST, at: 0, move: false }
const isKind = (k: unknown): k is Kind => k === 'normal' || (typeof k === 'string' && k in BLURS)
const nameOf = (id: string) => SCENES.find(s => s.id === id)?.name ?? id
const blurLabel = (k: keyof typeof BLURS) => L(BLURS[k][0], BLURS[k][1])

const sceneName = (c: Choice) => `${c.scene}--${c.kind}--${c.move ? 'move' : 'still'}`
const PAUSE = (svg: string) => svg.replace('<style>', '<style>*{animation-play-state:paused!important}')
// frosted: the veil takes the app's panel colour, near black in dark mode, so the default 0.6 (and 0.85 before)
// read as black; a strong blur under a thin veil lets the scene's colours through. Clear: no blur, a light tint
const FROSTED = { blur: 32, opacity: 0.3 }
export function look(c: Choice): ThemeSetArgs {
  return { backdrop: { scene: sceneName(c), glass: c.frost ? FROSTED : { blur: 0, opacity: 0.25 } } }
}

const svgCache = new Map<string, string>()
export function scene(id: string, kind: Kind, move: boolean) {
  const key = `${id}--${kind}--${move}`
  let svg = svgCache.get(key)
  if (svg === undefined) {
    svg = SCENES.find(s => s.id === id)!.draw().out(BLUR_PX[kind])
    if (!move) svg = PAUSE(svg)
    svgCache.set(key, svg)
  }
  return svg
}

// a still frame for the picker, lite and paused, blurred like the backdrop it stands for
const thumbCache = new Map<string, string>()
export function thumb(id: string, kind: Kind) {
  const key = `${id}--${kind}`
  let svg = thumbCache.get(key)
  if (svg === undefined) {
    svg = drawLite(SCENES.find(s => s.id === id)!).out(BLUR_PX[kind])
    svg = PAUSE(svg)
    thumbCache.set(key, svg)
  }
  return svg
}

// what the tab draws from; $.store keeps the choice across sessions
const choiceAtom = atom({ plugin: 'the-chief', key: 'themeChoice' } as const, '')
const toText = (c: Choice | 'off') => (c === 'off' ? 'off' : `${c.scene}:${c.kind}:${c.frost ? 1 : 0}:${c.auto}:${c.rot.join(',')}:${c.at}:${c.move ? 1 : 0}`)
function valid(c: unknown): Choice | 'off' {
  if (c === 'off') return 'off'
  const { scene = '', kind = '', frost, auto, rot, at, move } = (c ?? {}) as { scene?: string; kind?: string; frost?: unknown; auto?: unknown; rot?: unknown; at?: unknown; move?: unknown }
  // a choice saved by an older version (a scene no longer offered, no auto) is mended
  return {
    scene: LIST.includes(scene) ? scene : DEFAULT.scene,
    kind: isKind(kind) ? kind : 'normal',
    frost: frost !== false,
    auto: (AUTOS as readonly unknown[]).includes(auto) ? (auto as number) : 0,
    // kept in LIST's order; none saved yet means all
    rot: Array.isArray(rot) ? LIST.filter(id => rot.includes(id)) : LIST,
    at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
    move: move === true,
  }
}
const fromText = (t: string) => {
  const [scene, kind, frost, auto, rot, at, move] = t.split(':')
  return t === 'off' ? 'off' : valid({ scene, kind, frost: frost !== '0', auto: Number(auto ?? 0), rot: rot === undefined ? undefined : rot.split(','), at: Number(at ?? 0), move: move === '1' })
}

async function apply($: EngineInterface, c: Choice | 'off') {
  const saved = c === 'off' ? c : { ...c, at: await $.clock.now() }
  await storeSet($, 'themeChoice', saved)
  await update($, choiceAtom, () => toText(saved))
  return show($, saved, true)
}

// the scene a choice shows at time `now`: the picked one for the first period, then the picked ones in LIST's
// order after it, wrapping. A function of the saved choice and the clock alone, so all chats agree
export function sceneAt(c: Choice, now: number) {
  const step = c.auto && c.rot.length ? Math.floor((now - c.at) / (c.auto * 1000)) : 0
  if (step <= 0) return c.scene
  const from = c.rot.findIndex(id => LIST.indexOf(id) > LIST.indexOf(c.scene))
  return c.rot[((from < 0 ? 0 : from) + step - 1) % c.rot.length]!
}

// what this session last drew, so a tick that changes nothing draws nothing
let shown = ''
async function show($: EngineInterface, c: Choice | 'off', force = false) {
  const now = await $.clock.now()
  const want = c === 'off' ? 'off' : toText({ ...c, scene: sceneAt(c, now), auto: 0, at: 0 })
  if (want === shown && !force) return { isDrawn: true as const, requestId: '' }
  shown = want
  return c === 'off' ? await $.theme.clear() : await $.theme.set(look({ ...c, scene: sceneAt(c, now) }))
}

// one light check per session on each 5 s mark of the clock (5, 10 and 30 all fall on them): it reads the saved
// choice and redraws only when the scene differs, so a pick or an auto step reaches every chat within 5 s, together
let timer: Timer | undefined
const TICK = 5000
async function tick($: EngineInterface) {
  timer?.cancel()
  const now = await $.clock.now()
  timer = $.clock.after(TICK - (now % TICK) + 50, () => {
    void current($).then(c => show($, c)).catch(() => undefined).finally(() => void tick($).catch(() => undefined))
  })
}
async function current($: EngineInterface) {
  const saved = await $.store.get('themeChoice')
  return saved === undefined ? DEFAULT : valid(saved)
}
// a press reads the saved choice, not the one the tab was drawn with, which may be a press behind
async function baseOf($: EngineInterface) {
  const was = await current($)
  return was === 'off' ? DEFAULT : was
}
async function setKind($: EngineInterface, k: Kind | 'blur') {
  const base = await baseOf($)
  return apply($, { ...base, kind: k !== 'blur' ? k : base.kind === 'normal' ? 'orta' : base.kind })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The pane's own elements, from `$.ui.resolve(e)`; Svg only where the surface draws one. */
export type ThemeUi = { Box: any; Text: any; Button: any; Svg?: any; surface?: string; note?: (text: string) => void }

/** The Themes tab of the Chief's pane. */
export async function themesTab($: EngineInterface, ui: ThemeUi) {
  const { Box, Text, Button, Svg, surface = 'desktop', note } = ui
  const c = fromText((await read($, choiceAtom)) || toText(await current($)))
  const kind: Kind = c === 'off' ? 'normal' : c.kind
  const sel = c === 'off' ? '' : c.scene
  const auto = c === 'off' ? 0 : c.auto
  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="theme-kind-normal" label={L('Sharp', 'Normal')} plain dimColor={c === 'off' || kind !== 'normal'} onPress={() => void setKind($, 'normal')} />
        <Button key="theme-kind-blur" label={L('Blurred', 'Bulanık')} plain dimColor={c === 'off' || kind === 'normal'} onPress={() => void setKind($, 'blur')} />
        <Button key="theme-off" label={L('Off', 'Kapalı')} plain dimColor={c !== 'off'} onPress={() => void apply($, 'off')} />
        <Button key="theme-frost" label={c !== 'off' && !c.frost ? L('Chat blur: off', 'Sohbet bulanık: kapalı') : L('Chat blur: on', 'Sohbet bulanık: açık')} plain dimColor={c === 'off' || !c.frost}
          onPress={() => void baseOf($).then(b => apply($, { ...b, frost: !b.frost }))} />
        <Button key="theme-move" label={c !== 'off' && c.move ? L('Motion: on (uses CPU)', 'Hareket: açık (işlemci yer)') : L('Motion: off', 'Hareket: kapalı')} plain dimColor={c === 'off' || !c.move}
          onPress={() => void baseOf($).then(b => apply($, { ...b, move: !b.move }))} />
        {Svg && <Button key="theme-copy" label={L('Copy for all chats (DevTools)', 'Tüm sohbetler için kopyala (DevTools)')} plain
          onPress={() => void copyPaste($, surface).then(t => note?.(t))} />}
      </Box>
      {c !== 'off' && kind !== 'normal' && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text dimColor>{L('Blur:', 'Bulanıklık:')}</Text>
          {(Object.keys(BLURS) as (keyof typeof BLURS)[]).map(k => (
            <Button key={`theme-blur-${k}`} label={blurLabel(k)} plain dimColor={k !== kind} onPress={() => void setKind($, k)} />
          ))}
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text dimColor>{L('Auto-change:', 'Otomatik geçiş:')}</Text>
        {AUTOS.map(a => (
          <Button key={`theme-auto-${a}`} label={a ? L(`${a} s`, `${a} sn`) : L('Off', 'Kapalı')} plain dimColor={c === 'off' || a !== auto}
            onPress={() => void baseOf($).then(b => apply($, { ...b, auto: a }))} />
        ))}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
        {LIST.map(id => SCENES.find(s => s.id === id)!).map(sc => {
          const pick = <Button key={`theme-pick-${sc.id}`} label={sc.name} plain dimColor={sc.id !== sel} onPress={() => void baseOf($).then(b => apply($, { ...b, scene: sc.id }))} />
          const inRot = c !== 'off' && c.rot.includes(sc.id)
          return (
            <Box key={`theme-card-${sc.id}`} flexDirection="column" width={Svg ? 156 : undefined} borderStyle={sc.id === sel ? 'round' : undefined} borderColor={sc.id === sel ? 'claude' : undefined}>
              {/* an Svg takes no press, and the desktop drops a button laid over it: the name under it picks */}
              {Svg && <Svg source={thumb(sc.id, kind)} alt={L(`${sc.name} preview`, `${sc.name} önizleme`)} width={150} height={94} />}
              {pick}
              <Button key={`theme-rot-${sc.id}`} label={inRot ? L('✓ In auto-change', '✓ Geçişte') : L('+ Add to auto-change', '+ Geçişe ekle')} plain dimColor={!inRot}
                onPress={() => void baseOf($).then(b => apply($, { ...b, rot: b.rot.includes(sc.id) ? b.rot.filter(x => x !== sc.id) : LIST.filter(x => x === sc.id || b.rot.includes(x)) }))} />
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

// the DevTools paste code with the tab's choice inside: it draws in the Claude window itself, so remote chats
// and every chat in that window show it. The Themes tab's own backdrop goes off, or both would draw
// shortcut: same order as the Chief's copyText (engine copy, then the system tool); kept here because $ cannot be handed to a callback
async function clip($: EngineInterface, surface: string, text: string) {
  try {
    if ((await $.ui.copy({ text, surface: surface as never }))?.isCopied) return true
  } catch {
    // an older host has no $.ui.copy
  }
  const win = /^[A-Za-z]:[\\/]/.test($.plugin.root)
  const argv = win ? ['powershell', '-NoProfile', '-Command', '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'] : ['pbcopy']
  const res = await $.process.run(argv, { stdin: text, timeoutMs: 10000, ...(win ? {} : { env: { LANG: 'en_US.UTF-8' } }) }).catch(() => undefined)
  return res?.exitCode === 0
}
async function copyPaste($: EngineInterface, surface: string) {
  const c = await baseOf($)
  const scenes = LIST.map(id => SCENES.find(s => s.id === id)!).map(s => ({ id: s.id, name: s.name, accent: s.accent, svg: s.draw().out(1).replace(/(<filter id="bl"[^>]*><feGaussianBlur stdDeviation=")[^"]*"/, '$1__BL__"') }))
  const code = OVERLAY.replace('/*SCENES*/[]', () => JSON.stringify(scenes)).replace('/*CHOICE*/null', () => JSON.stringify({ ...c, off: false }))
  if (!(await clip($, surface, code))) return L('Not copied: no clipboard reached.', 'Kopyalanmadı: panoya ulaşılamadı.')
  await apply($, 'off')
  return L(`Copied (${nameOf(c.scene)}). In the Claude window: Developer → Show Dev Tools → Console → paste → Enter. Every chat in that window, remote ones too, shows it. The tab's own theme is off now so the two don't overlap; change the theme with ✦ Theme (⌘⇧T) in the window.`,
    `Kopyalandı (${nameOf(c.scene)}). Claude penceresinde: Geliştirici → Dev Tools → Console → yapıştır → Enter. O penceredeki bütün sohbetlerde, remote olanlarda da görünür. Şef'in kendi teması kapandı ki ikisi üst üste binmesin; temayı artık penceredeki ✦ Tema (⌘⇧T) ile değiştir.`)
}

/** Called from the Chief's own session.start: the backdrop is display only and does not come back with --resume. */
export async function startTheme($: EngineInterface) {
  const c = await current($)
  await update($, choiceAtom, () => toText(c))
  if (c !== 'off') await show($, c, true)
  await tick($)
}

export const register = (on: Parameters<Register>[0]) => {

  // /themes opens the Themes tab; /themes <scene> [normal|az|orta|cok] picks without the pane
  on('command.run', { command: 'themes' }, async ($, e) => {
    const norm = (x: string) => x.toLowerCase().replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/[^a-z0-9]/g, '')
    const words = e.args.trim().split(/\s+/).map(norm).filter(Boolean)
    const open = async () => {
      await $.state.set({ plugin: 'the-chief', key: 'tab' }, 'themes')
      await $.ui.open({ id: 'squad', title: 'The Chief', focus: true, closeOnEscape: true, rows: 38, columns: 90 }).catch(() => undefined)
    }
    if (!words.length) {
      await open()
      return { text: L('Themes tab opened: click a picture.', 'Temalar sekmesi açıldı: bir resme tıkla.') }
    }
    if (words[0] === 'off' || words[0] === 'kapali') {
      await apply($, 'off')
      return { text: L('Theme off.', 'Tema kapatıldı.') }
    }
    const base = await baseOf($)
    const kindWord = (w: string) => (w === 'bulanik' || w === 'blur' || w === 'blurred' ? 'orta' : w)
    const kind = words.map(kindWord).find(isKind)
    const rest = words.filter(w => !isKind(kindWord(w))).join('')
    const id = rest ? SCENES.find(s => LIST.includes(s.id) && (norm(s.id) === rest || norm(s.name) === rest))?.id : undefined
    if ((rest && !id) || (!id && !kind)) {
      await open()
      return { text: L(`Not found: ${e.args}. Pick in the Themes tab.`, `Bulamadım: ${e.args}. Temalar sekmesinden seç.`) }
    }
    const next: Choice = { ...base, scene: id ?? base.scene, kind: kind ?? base.kind }
    const set = await apply($, next)
    const how = next.kind === 'normal' ? L('Sharp', 'Normal') : `${L('Blurred', 'Bulanık')} (${blurLabel(next.kind)})`
    return { text: `${L('Theme', 'Tema')}: ${nameOf(next.scene)} · ${how}${set.isDrawn ? '' : ` (${set.reason})`}` }
  })

  on('command.run', { command: 'themes-copy' }, async $ => ({ text: await copyPaste($, 'desktop') }))

  // draws only this plugin's scenes; another mod's backdrop goes on to its own hook
  on('ui.render', { component: 'Backdrop' }, ($, e, next) => {
    const [id = '', kind = 'normal', motion = 'still'] = String(e.props.scene).split('--')
    if (e.props.plugin !== $.plugin.name || (e.surface !== 'desktop' && e.surface !== 'mobile') || !SCENES.some(s => s.id === id) || !isKind(kind)) return next(e)
    const { Svg } = $.ui.resolve(e)
    return <Svg source={scene(id, kind, motion === 'move')} alt={L(`${nameOf(id)} backdrop`, `${nameOf(id)} arka planı`)} isInteractive />
  })
}
