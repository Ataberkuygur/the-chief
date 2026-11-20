import type { ClientModule, ClientSurface } from 'claude-code'

/** What the pane hands a slider. `value` is a step index, 0..steps-1. */
export type SliderProps = {
  value: number
  steps: number
  /** One label per step, drawn under the track (effort); absent, the value shows as a number. */
  labels?: string[]
  /** Added after the number when there are no labels ("agents"). */
  unit?: string
  /** A slider the CLI does not take: drawn flat, with this note instead of a value. */
  disabledNote?: string
}

type SliderState = {
  /** Where the knob is drawn, in steps; eases toward `target` every frame. */
  shown: number
  target: number
  isDragging: boolean
  isHover: boolean
  /** The latest props, read by the frame clock and the listeners. */
  ref: { props: SliderProps }
}

// grey to white to Claude's coral: the further right, the warmer
const STOPS = ['#5c5c5c', '#8f8f8f', '#cfcfcf', '#f4f4f4', '#d97757']
const RAIL = '#333333'
const VALUE_WIDTH = 13

function hexToRgb(h: string) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
}

/** The ramp's colour at f in 0..1, interpolated between its stops. */
export function rampColor(f: number): string {
  const x = Math.max(0, Math.min(1, f)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(x))
  const t = x - i
  const a = hexToRgb(STOPS[i]!)
  const b = hexToRgb(STOPS[i + 1]!)
  const c = a.map((v, k) => Math.round(v + (b[k]! - v) * t))
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

const trackWidth = (s: ClientSurface<SliderState>) => Math.max(8, (s.columns || 40) - VALUE_WIDTH)

function valueAt(x: number, width: number, steps: number) {
  if (steps <= 1) return 0
  return Math.max(0, Math.min(steps - 1, Math.round((x / Math.max(1, width - 1)) * (steps - 1))))
}

const Slider: ClientModule<SliderProps, SliderState> = (props, s) => {
  const { Box, Text } = s.elements
  const steps = Math.max(1, props.steps)
  const disabled = props.disabledNote !== undefined

  if (s.state === undefined) {
    const ref = { props }
    s.setState({ shown: props.value, target: props.value, isDragging: false, isHover: false, ref })

    // the frame clock: glide toward the target, and follow new props while not dragging
    s.every(16, () => {
      const st = s.state
      if (!st) return
      let target = st.target
      if (!st.isDragging && st.ref.props.value !== target) target = st.ref.props.value
      const gap = target - st.shown
      if (Math.abs(gap) < 0.02 && target === st.target) {
        if (st.shown !== target) s.setState({ ...st, shown: target })
        return
      }
      s.setState({ ...st, target, shown: Math.abs(gap) < 0.02 ? target : st.shown + gap * 0.28 })
    })

    const set = (v: number) => {
      const st = s.state
      if (!st || v === st.target) return
      s.setState({ ...st, target: v })
      s.post({ value: v })
    }

    s.onPointer(e => {
      const st = s.state
      if (!st || st.ref.props.disabledNote !== undefined) return
      const w = trackWidth(s)
      const x = e.fine?.x ?? e.x
      const n = Math.max(1, st.ref.props.steps)
      if (e.type === 'down') {
        s.setState({ ...st, isDragging: true })
        set(valueAt(x, w, n))
      } else if (e.type === 'move' && st.isDragging) {
        set(valueAt(x, w, n))
      } else if (e.type === 'up') {
        const now = s.state
        if (now) s.setState({ ...now, isDragging: false })
      } else if (e.type === 'enter' || e.type === 'leave') {
        s.setState({ ...st, isHover: e.type === 'enter' })
      }
    })

    s.onKey(e => {
      const st = s.state
      if (!st || st.ref.props.disabledNote !== undefined) return
      const n = Math.max(1, st.ref.props.steps)
      if (e.key === 'right' || e.key === 'up') set(Math.min(n - 1, st.target + 1))
      else if (e.key === 'left' || e.key === 'down') set(Math.max(0, st.target - 1))
      else if (e.key === 'home') set(0)
      else if (e.key === 'end') set(n - 1)
    })
  }

  const st = s.state ?? { shown: props.value, target: props.value, isDragging: false, isHover: false, ref: { props } }
  st.ref.props = props

  const w = trackWidth(s)
  const frac = steps <= 1 ? 1 : st.shown / (steps - 1)
  const knob = Math.round(frac * (w - 1))
  const isLive = st.isDragging || st.isHover
  const heat = rampColor(steps <= 1 ? 1 : st.target / (steps - 1))

  const cells = Array.from({ length: w }, (_, c) => {
    if (disabled) return <Text color={RAIL}>─</Text>
    if (c < knob) return <Text color={rampColor(c / Math.max(1, w - 1))}>━</Text>
    if (c === knob) return <Text color={rampColor(frac)} bold>{isLive ? '◉' : '●'}</Text>
    return <Text color={RAIL}>─</Text>
  })

  const shownValue = disabled
    ? props.disabledNote ?? ''
    : props.labels
      ? props.labels[st.target] ?? ''
      : `${st.target + 1}${props.unit ? ` ${props.unit}` : ''}`

  // labels under the track, each centred on its stop; the chosen one lit
  let labelRow: unknown = null
  if (props.labels && !disabled) {
    const parts: { text: string; isOn: boolean }[] = []
    let col = 0
    props.labels.forEach((label, i) => {
      const at = Math.round((steps <= 1 ? 0 : i / (steps - 1)) * (w - 1))
      const start = Math.max(col, Math.min(w - label.length, at - Math.floor(label.length / 2)))
      if (start > col) parts.push({ text: ' '.repeat(start - col), isOn: false })
      parts.push({ text: label, isOn: i === st.target })
      col = start + label.length
    })
    labelRow = (
      <Box flexDirection="row">
        {parts.map(p => (p.isOn ? <Text color={heat} bold>{p.text}</Text> : <Text dimColor>{p.text}</Text>))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box flexDirection="row">{cells}</Box>
        <Box width={VALUE_WIDTH} paddingLeft={2}>
          <Text bold={!disabled} color={disabled ? undefined : heat} dimColor={disabled} wrap="truncate-end">{shownValue}</Text>
        </Box>
      </Box>
      {labelRow as never}
    </Box>
  )
}

export default Slider
