// The Chief's 27 canvas scenes, redrawn as self-running SVG (CSS animation only: the
// Backdrop frame runs no script). Skies are the overlay's own gradient stops.
const W = 1600
const H = 1000
const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace'
const SANS = '"Inter Tight","Helvetica Neue",Arial,sans-serif'

// thumbnails are drawn lite: a seventh of the particles, no loop copies
let LITE = false
const few = (n: number) => (LITE ? Math.ceil(n * 0.15) : n)
const f = (n: number) => String(Math.round(n * 10) / 10)

export class Svg {
  defs: string[] = []
  css: string[] = []
  body: string[] = []
  private n = 0
  private r: () => number
  constructor(seed: number) {
    let s = seed
    this.r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
  }
  rnd(a = 0, b = 1) { return a + this.r() * (b - a) }
  id(p = 'k') { return `${p}${this.n++}` }
  add(s: string) { this.body.push(s); return this }

  stops: [string, number][] = []
  sky(...stops: [string, number][]) {
    this.stops = stops
    this.defs.push(`<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops.map(([c, o]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`)
    return this.add(`<rect width="${W}" height="${H}" fill="url(#sky)"/>`)
  }
  // soft round light
  glow(x: number, y: number, r: number, c: string, a = 1, cls = '') {
    const id = this.id('g')
    this.defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="${c}" stop-opacity="${a}"/><stop offset=".3" stop-color="${c}" stop-opacity="${a * 0.35}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`)
    return this.add(`<circle class="${cls}" cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="url(#${id})"/>`)
  }
  // keyframes with a fresh name; returns the animation shorthand
  kf(frames: string, dur: number, tail = 'linear infinite') {
    const id = this.id('a')
    this.css.push(`@keyframes ${id}{${frames}}`)
    return `animation:${id} ${f(dur)}s ${tail}`
  }
  // content drawn twice, one copy (dx,dy) behind, the pair slid by (dx,dy): a seamless loop
  loop(content: string, dx: number, dy: number, dur: number) {
    if (LITE) return this.add(content)
    const a = this.kf(`to{transform:translate(${dx}px,${dy}px)}`, dur)
    return this.add(`<g style="${a}">${content}<g transform="translate(${-dx},${-dy})">${content}</g></g>`)
  }
  stars(n: number, y0: number, y1: number, col = '#e8edff', size = 14) {
    n = few(n)
    let s = ''
    for (let i = 0; i < n; i++) {
      const g = this.r() < 0.12 ? '+' : this.r() < 0.4 ? '*' : '.'
      s += `<text class="tw" x="${f(this.rnd(0, W))}" y="${f(this.rnd(y0, y1))}" font-size="${f(size * this.rnd(0.7, 1.3))}" style="animation-delay:-${f(this.rnd(0, 6))}s;animation-duration:${f(this.rnd(2.5, 6))}s">${g}</text>`
    }
    return this.add(`<g fill="${col}">${s}</g>`)
  }
  // a band of ASCII water glyphs that slides sideways
  waves(y0: number, y1: number, rows: number, col: string, dur = 40, glyphs = '~-~.~ ~-') {
    if (LITE) rows = Math.min(rows, 4)
    let s = ''
    for (let i = 0; i < rows; i++) {
      const y = y0 + ((y1 - y0) * i) / rows
      const sz = 12 + (14 * i) / rows
      let line = ''
      for (let x = 0; x < 140; x++) line += glyphs[Math.floor(this.rnd(0, glyphs.length))]
      s += `<text x="0" y="${f(y)}" font-size="${f(sz)}" opacity="${f(0.25 + (0.5 * i) / rows)}" textLength="${W}" lengthAdjust="spacing">${line}</text>`
    }
    return this.loop(`<g fill="${col}">${s}</g>`, W, 0, dur)
  }
  // glyphs scattered over the frame and looped by (dx,dy)
  drift(n: number, glyphs: string, col: string, dx: number, dy: number, dur: number, size = 16, y0 = 0, y1 = H, op = 0.8) {
    n = few(n)
    let s = ''
    for (let i = 0; i < n; i++) s += `<text x="${f(this.rnd(0, W))}" y="${f(this.rnd(y0, y1))}" font-size="${f(size * this.rnd(0.6, 1.4))}" opacity="${f(op * this.rnd(0.4, 1))}">${glyphs[Math.floor(this.rnd(0, glyphs.length))]}</text>`
    return this.loop(`<g fill="${col}">${s}</g>`, dx, dy, dur)
  }
  // a bird: two curved wings and a small body, beating from up to down
  bird(x: number, y: number, size: number, col: string) {
    const beat = this.rnd(0.32, 0.6)
    return `<g transform="translate(${f(x)} ${f(y)}) scale(${f(size / 24)})"><path class="fl" fill="none" stroke="${col}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" style="animation-duration:${f(beat)}s;animation-delay:-${f(this.rnd(0, beat))}s" d="M-13 2 Q-7 -9 0 1 Q7 -9 13 2"/></g>`
  }
  // a loose line of birds crossing the sky, looped so they keep coming
  flock(n: number, y0: number, y1: number, col: string, size: number, dur: number, x0 = 0, x1 = W) {
    let g = ''
    for (let i = 0; i < few(n); i++) g += this.bird(this.rnd(x0, x1), this.rnd(y0, y1), size * this.rnd(0.7, 1.2), col)
    return this.loop(`<g>${g}</g>`, W, 0, dur)
  }
  // a mountain / hill ridge filled to the bottom
  ridge(base: number, amp: number, col: string, seed: number, op = 1, step = 80) {
    let d = `M0 ${H} L0 ${f(base)}`
    for (let x = step; x <= W + step; x += step) d += ` L${x} ${f(base - amp * (0.5 + 0.5 * Math.sin(x * 0.004 + seed) * Math.cos(x * 0.0017 + seed * 2)) - this.rnd(0, amp * 0.25))}`
    return `<path d="${d} L${W + step} ${H} Z" fill="${col}" opacity="${op}"/>`
  }
  // the scene as drawn; blur (in screen pixels at 1440 wide) softens all of it, moving parts too,
  // with the plain sky left sharp underneath so the blurred edges never fade to nothing
  out(blur = 0) {
    let defs = this.defs.join('')
    let body = this.body.join('')
    if (blur) {
      defs += `<filter id="bl" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${f(blur * W / 1440)}"/></filter>`
      body = `${this.body[0]}<g filter="url(#bl)">${body}</g>`
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><defs>${defs}</defs><style>text{font-family:${MONO}}.tw{animation:tw 4s ease-in-out infinite alternate}@keyframes tw{from{opacity:.12}to{opacity:1}}.fb,.bob,.fl{transform-box:fill-box;transform-origin:center}.fl{animation:fl .45s ease-in-out infinite alternate}@keyframes fl{from{transform:scaleY(1)}to{transform:scaleY(.2)}}@media (prefers-reduced-motion:reduce){*{animation:none!important}}${this.css.join('')}</style>${body}</svg>`
  }

}

/* ---------------- scenes ---------------- */

function cloudPuff(s: Svg, x: number, y: number, sc: number, op: number) {
  let c = ''
  for (let i = 0; i < 6; i++) c += `<ellipse cx="${f(x + (i - 2.5) * 46 * sc)}" cy="${f(y - Math.sin((i / 5) * Math.PI) * 30 * sc)}" rx="${f(60 * sc)}" ry="${f(40 * sc)}"/>`
  return `<g fill="#ffffff" opacity="${f(op)}">${c}</g>`
}
function cloud() {
  const s = new Svg(12).sky(['#12508c', 0], ['#3b8dd4', 0.5], ['#9fd6f5', 0.88], ['#dcf3fb', 1])
  s.glow(1350, 160, 300, '#fff6d8', 0.6)
  ;[[0.5, 0.35, 260], [0.8, 0.55, 170], [1.25, 0.8, 110]].forEach(([sc, op, dur]) => {
    let c = ''
    for (let i = 0; i < 6; i++) c += cloudPuff(s, s.rnd(0, W), s.rnd(80, 900), sc! * s.rnd(0.7, 1.3), op!)
    s.loop(c, W, 0, dur!)
  })
  s.drift(40, '~ -', '#ffffff', W, 0, 120, 18, 0, H, 0.4)
  return s
}

function turtle() {
  const s = new Svg(13).sky(['#14a3ad', 0], ['#077584', 0.35], ['#044d5f', 0.7], ['#02283a', 1])
  let rays = ''
  for (let i = 0; i < 7; i++) {
    const x = 150 + i * 220 + s.rnd(-40, 40)
    rays += `<polygon points="${f(x)},0 ${f(x + 70)},0 ${f(x + 320)},${H} ${f(x + 160)},${H}" fill="#bff6ff" style="${s.kf(`0%,100%{opacity:.03}50%{opacity:.13}`, s.rnd(6, 11), 'ease-in-out infinite')}"/>`
  }
  s.add(rays)
  s.drift(45, 'o°.', '#c9fbff', 0, -H, 40, 15, 0, H, 0.5)
  // the honu: shell, head, four flippers that row
  const fl = (x: number, y: number, r: number, d: number) => `<ellipse class="fb" cx="${x}" cy="${y}" rx="42" ry="14" fill="#5bbf9a" style="transform:rotate(${r}deg);${s.kf(`0%,100%{transform:rotate(${r}deg)}50%{transform:rotate(${r + d}deg)}`, 2.4, 'ease-in-out infinite')}"/>`
  const honu = `<g>${fl(-40, -46, -35, 30)}${fl(-40, 46, 35, -30)}${fl(-95, -24, -20, 15)}${fl(-95, 24, 20, -15)}<ellipse cx="18" cy="0" rx="22" ry="16" fill="#7fd4b0"/><ellipse cx="-50" cy="0" rx="70" ry="52" fill="#2f7f68"/><g fill="none" stroke="#9fe6c6" stroke-width="3" opacity=".7"><path d="M-90 0 L-50 -30 L-10 0 L-50 30 Z"/><path d="M-50 -30 V-52 M-50 30 V52 M-90 0 H-120 M-10 0 H20"/></g></g>`
  s.add(`<g style="${s.kf('from{transform:translate(-300px,330px)}to{transform:translate(1900px,230px)}', 70)};animation-delay:-24s"><g style="${s.kf('0%,100%{transform:translateY(0)}50%{transform:translateY(30px)}', 7, 'ease-in-out infinite')}">${honu}</g></g>`)
  s.add(s.ridge(930, 70, '#012030', 0.9))
  return s
}

function koiFish(col: string, spot: string) {
  return `<g><path d="M60 0 C40 -26 -30 -24 -60 0 C-30 24 40 26 60 0 Z" fill="${col}"/><circle cx="20" cy="-8" r="9" fill="${spot}"/><circle cx="-14" cy="6" r="11" fill="${spot}"/><path class="fb" d="M-58 0 L-100 -24 L-90 0 L-100 24 Z" fill="${col}" opacity=".85"/></g>`
}
function koi() {
  const s = new Svg(14).sky(['#0b332c', 0], ['#0f4a3e', 0.6], ['#08261f', 1])
  s.drift(30, '~ .', '#6fbf9a', W, 0, 150, 18, 0, H, 0.3)
  // ripples
  for (let i = 0; i < 5; i++) s.add(`<circle class="fb" cx="${f(s.rnd(200, 1400))}" cy="${f(s.rnd(150, 850))}" r="60" fill="none" stroke="#b7e3c6" stroke-width="2" style="${s.kf('0%{transform:scale(.1);opacity:.7}100%{transform:scale(2.4);opacity:0}', 6)};animation-delay:-${f(i * 1.3)}s"/>`)
  // three koi on slow circuits around off-centre points
  ;[[1250, 300, 230, 38, '#ff8a4c', '#fff3e6'], [380, 260, 200, 52, '#f3efe6', '#e5484d'], [1150, 760, 170, 44, '#ffb347', '#1b1b1b']].forEach(([cx, cy, r, d, c, sp], i) => {
    const dir = i % 2 ? -360 : 360
    s.add(`<g transform="translate(${cx} ${cy})"><g style="${s.kf(`to{transform:rotate(${dir}deg)}`, d as number)}"><g transform="translate(0 ${-(r as number)}) ${dir < 0 ? 'scale(-1 1)' : ''}">${koiFish(c as string, sp as string)}</g></g></g>`)
  })
  // lily pads, gently turning
  for (let i = 0; i < 7; i++) {
    const x = s.rnd(80, 1520), y = s.rnd(80, 920), r = s.rnd(34, 70)
    if (x > 450 && x < 1150 && y > 250 && y < 800) continue
    s.add(`<g transform="translate(${f(x)} ${f(y)})"><g style="${s.kf('0%,100%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}', s.rnd(14, 24), 'ease-in-out infinite')}"><path d="M0 0 L${f(r)} ${f(-r * 0.25)} A${f(r)} ${f(r)} 0 1 1 ${f(r)} ${f(r * 0.25)} Z" fill="#2f7a4c"/>${i % 3 === 0 ? `<circle r="${f(r * 0.3)}" cx="${f(-r * 0.2)}" fill="#ffc6d9"/>` : ''}</g></g>`)
  }
  return s
}

function jellyShape(s: Svg, col: string) {
  let t = ''
  for (let i = 0; i < 5; i++) {
    const x = -36 + i * 18
    t += `<path d="M${x} 0 q8 30 0 60 t0 60 t0 50" stroke="${col}" stroke-width="3" fill="none" opacity=".7" style="${s.kf(`0%,100%{transform:skewX(-8deg)}50%{transform:skewX(8deg)}`, 3 + i * 0.3, 'ease-in-out infinite')}"/>`
  }
  return `<g>${t}<path d="M-55 4 C-55 -60 55 -60 55 4 Q42 -6 28 4 Q14 -6 0 4 Q-14 -6 -28 4 Q-42 -6 -55 4 Z" fill="${col}" opacity=".75"/></g>`
}
function jelly() {
  const s = new Svg(15).sky(['#183a86', 0], ['#0d2462', 0.45], ['#061440', 0.8], ['#030a24', 1])
  s.drift(90, '.·', '#9fd8ff', 0, -H, 70, 12, 0, H, 0.55)
  ;[[220, 280, 0.9, '#cba7ff'], [1350, 220, 1.1, '#8fe3ff'], [1180, 700, 0.7, '#ff9fe0'], [330, 760, 0.8, '#a7b8ff'], [1500, 520, 0.55, '#cba7ff']].forEach(([x, y, sc, c], i) => {
    s.glow(x as number, y as number, 150 * (sc as number), c as string, 0.35)
    s.add(`<g transform="translate(${x} ${y}) scale(${sc})"><g style="${s.kf('0%,100%{transform:translateY(20px) scale(1,1)}45%{transform:translateY(-40px) scale(.92,1.08)}', 6 + i, 'ease-in-out infinite')}">${jellyShape(s, c as string)}</g></g>`)
  })
  return s
}

function boatShape(col: string) {
  return `<g><path d="M-60 0 L60 0 L40 22 L-40 22 Z" fill="${col}"/><path d="M0 -70 L0 0 L48 0 Z" fill="#fff3e6"/><path d="M-4 -60 L-4 0 L-44 0 Z" fill="#ffd2a8"/></g>`
}
function boat() {
  const s = new Svg(16).sky(['#262a66', 0], ['#7a4d8e', 0.28], ['#e0798a', 0.42], ['#ffc18e', 0.5], ['#4a5a94', 0.5], ['#1c2a5c', 0.8], ['#0f1a3e', 1])
  s.stars(30, 20, 240, '#ffe9d6')
  s.glow(1180, 500, 330, '#ffc18e', 0.9)
  s.add(`<circle cx="1180" cy="500" r="80" fill="#ffe2b8" opacity=".9"/>`)
  s.waves(520, 1000, 16, '#ffd2a8', 60)
  s.flock(6, 250, 430, '#2a1d3e', 40, 90)
  ;[[300, 640, 1.1], [1400, 760, 0.8], [700, 880, 1.4]].forEach(([x, y, sc], i) =>
    s.add(`<g transform="translate(${x} ${y}) scale(${sc})"><g class="bob" style="${s.kf('0%,100%{transform:rotate(-5deg) translateY(0)}50%{transform:rotate(5deg) translateY(-8px)}', 4 + i, 'ease-in-out infinite')}">${boatShape('#2a1d3e')}</g></g>`))
  return s
}

function pine(x: number, base: number, h: number, col: string) {
  return `<path d="M${f(x)} ${f(base - h)} L${f(x + h * 0.28)} ${f(base - h * 0.45)} L${f(x + h * 0.16)} ${f(base - h * 0.45)} L${f(x + h * 0.36)} ${f(base)} L${f(x - h * 0.36)} ${f(base)} L${f(x - h * 0.16)} ${f(base - h * 0.45)} L${f(x - h * 0.28)} ${f(base - h * 0.45)} Z" fill="${col}"/>`
}
function fireflies() {
  const s = new Svg(17).sky(['#0d2a33', 0], ['#0d2a23', 0.55], ['#06140f', 1])
  s.stars(40, 10, 350, '#cfe8d8', 12)
  let back = '', front = ''
  for (let x = -40; x < W + 60; x += s.rnd(50, 90)) back += pine(x, 1000, s.rnd(260, 480), '#0a2019')
  for (let x = -20; x < W + 60; x += s.rnd(90, 160)) front += pine(x, 1010, s.rnd(160, 300), '#04100b')
  s.add(back)
  for (let i = 0; i < few(40); i++) {
    const x = s.rnd(0, W), y = s.rnd(300, 960)
    const mv = s.kf(`0%,100%{transform:translate(0,0)}33%{transform:translate(${f(s.rnd(-60, 60))}px,${f(s.rnd(-40, 40))}px)}66%{transform:translate(${f(s.rnd(-60, 60))}px,${f(s.rnd(-40, 40))}px)}`, s.rnd(9, 16), 'ease-in-out infinite')
    s.add(`<g style="${mv}"><circle class="tw" cx="${f(x)}" cy="${f(y)}" r="${f(s.rnd(2.5, 4.5))}" fill="#e8ff9e" style="animation-duration:${f(s.rnd(1.2, 3))}s;animation-delay:-${f(s.rnd(0, 3))}s"/></g>`)
    if (i % 4 === 0) s.glow(x, y, 26, '#d9f78f', 0.35, 'tw')
  }
  s.add(front)
  return s
}

function moon() {
  const s = new Svg(18).sky(['#060b28', 0], ['#141e58', 0.55], ['#28377c', 0.74], ['#18245e', 0.74], ['#080f33', 1])
  s.stars(110, 10, 700)
  s.glow(1260, 210, 260, '#f2d9a0', 0.55)
  s.add(`<circle cx="1260" cy="210" r="70" fill="#f6e6bd"/><circle cx="1235" cy="195" r="12" fill="#e2cc95"/><circle cx="1285" cy="235" r="8" fill="#e2cc95"/>`)
  // shooting star every ~11 s
  s.add(`<g style="${s.kf('0%{transform:translate(0,0);opacity:0}2%{opacity:1}9%{transform:translate(-520px,260px);opacity:0}100%{opacity:0;transform:translate(-520px,260px)}', 11)}"><line x1="900" y1="90" x2="1010" y2="35" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"/></g>`)
  s.waves(745, 1000, 12, '#8fa2e6', 70)
  let path = ''
  for (let i = 0; i < 26; i++) path += `<text class="tw" x="${f(1260 + s.rnd(-60, 60) * (1 + i / 12))}" y="${f(760 + i * 9.5)}" font-size="${f(12 + i * 0.6)}" style="animation-duration:${f(s.rnd(1, 2.5))}s;animation-delay:-${f(s.rnd(0, 2))}s">${i % 2 ? '~' : '-'}</text>`
  return s.add(`<g fill="#f6e6bd">${path}</g>`)
}

function aurora() {
  const s = new Svg(19).sky(['#020815', 0], ['#05203a', 0.6], ['#0b3346', 0.78], ['#03101a', 1])
  s.stars(90, 10, 650)
  s.defs.push('<filter id="blur" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="28"/></filter>')
  ;[['#7dffc2', 260, 0.55, 26], ['#5fe0ff', 330, 0.4, 34], ['#c47dff', 200, 0.28, 41]].forEach(([c, y, op, d], i) => {
    const yy = y as number
    s.add(`<g filter="url(#blur)" style="${s.kf(`0%,100%{transform:translateX(-80px) skewX(-6deg)}50%{transform:translateX(80px) skewX(6deg)}`, d as number, 'ease-in-out infinite')}"><path d="M-100 ${yy + 60} C300 ${yy - 90} 600 ${yy + 140} 900 ${yy} S1400 ${yy - 120} 1700 ${yy + 40} L1700 ${yy + 180} C1300 ${yy + 60} 1000 ${yy + 240} 700 ${yy + 130} S200 ${yy + 220} -100 ${yy + 200} Z" fill="${c}" style="${s.kf(`0%,100%{opacity:${f((op as number) * 0.5)}}50%{opacity:${op}}`, 9 + i * 3, 'ease-in-out infinite')}"/></g>`)
  })
  s.add(s.ridge(860, 160, '#04121c', 3))
  s.add(s.ridge(930, 90, '#010810', 5))
  return s
}

function synth() {
  const s = new Svg(20).sky(['#0a0220', 0], ['#2a0a4e', 0.38], ['#7a1a78', 0.54], ['#ff4f8f', 0.62], ['#140028', 0.62], ['#0b0018', 1])
  s.stars(60, 10, 420, '#ffd6f5')
  s.defs.push('<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe66b"/><stop offset="1" stop-color="#ff3fa4"/></linearGradient><clipPath id="sunc"><rect x="0" y="0" width="1600" height="620"/></clipPath>')
  s.glow(800, 520, 380, '#ff5fd2', 0.5)
  let bars = ''
  for (let i = 0; i < 6; i++) bars += `<rect x="560" y="${500 + i * 22}" width="480" height="${4 + i * 2}" fill="#2a0a4e"/>`
  s.add(`<g clip-path="url(#sunc)"><circle cx="800" cy="520" r="210" fill="url(#sun)"/>${bars}</g>`)
  s.add(s.ridge(620, 70, '#1a0533', 7, 1, 60))
  s.add(`<rect y="620" width="1600" height="380" fill="#0b0018"/>`)
  let g = ''
  for (let i = -16; i <= 16; i++) g += `<line x1="${800 + i * 22}" y1="620" x2="${800 + i * 190}" y2="1000"/>`
  s.add(`<g stroke="#ff5fd2" stroke-width="2" opacity=".55">${g}</g>`)
  const a = s.kf('0%{transform:translateY(0) scaleY(1);opacity:0}10%{opacity:.8}100%{transform:translateY(380px);opacity:.9}', 6, 'cubic-bezier(.55,0,1,.45) infinite')
  let h = ''
  for (let i = 0; i < 8; i++) h += `<line x1="0" y1="620" x2="1600" y2="620" stroke="#ff5fd2" stroke-width="2" style="${a};animation-delay:-${f(i * 0.75)}s"/>`
  return s.add(h)
}

function rain() {
  const s = new Svg(21).sky(['#0b1220', 0], ['#131c2e', 0.5], ['#1b2233', 1])
  // city lights out of focus
  const cols = ['#8fc4ff', '#ffcf7a', '#ff8f8f', '#c9f0ff', '#ffe2a8']
  for (let i = 0; i < few(34); i++) s.glow(s.rnd(0, W), s.rnd(560, 1000), s.rnd(20, 70), cols[i % 5]!, s.rnd(0.25, 0.6), 'tw')
  let blocks = ''
  for (let x = 0; x < W; x += s.rnd(60, 130)) blocks += `<rect x="${f(x)}" y="${f(s.rnd(450, 700))}" width="${f(s.rnd(50, 120))}" height="600" fill="#0d1424" opacity=".7"/>`
  s.add(blocks)
  s.drift(160, '|│¦', '#9fc8ff', -120, H, 1.6, 22, 0, H, 0.45)
  s.drift(90, '|', '#cfe4ff', -80, H, 2.6, 14, 0, H, 0.3)
  // drops sliding on the glass
  for (let i = 0; i < few(14); i++) s.add(`<circle cx="${f(s.rnd(0, W))}" cy="0" r="${f(s.rnd(4, 9))}" fill="#cfe4ff" opacity=".35" style="${s.kf(`0%{transform:translateY(${f(s.rnd(0, 300))}px)}100%{transform:translateY(1050px)}`, s.rnd(9, 20), 'cubic-bezier(.6,0,1,1) infinite')};animation-delay:-${f(s.rnd(0, 15))}s"/>`)
  return s
}

function space() {
  const s = new Svg(22).sky(['#05040f', 0], ['#0a0820', 0.6], ['#120a26', 1])
  s.glow(380, 700, 520, '#5b3fae', 0.35)
  s.glow(1100, 300, 420, '#2f5fae', 0.25)
  s.drift(120, '.·', '#c9c4ff', -W, 0, 120, 12, 0, H, 0.7)
  s.drift(50, '*+', '#ffffff', -W, 0, 55, 15, 0, H, 0.8)
  s.drift(18, '—', '#ffffff', -W, 0, 14, 22, 0, H, 0.5)
  s.defs.push('<linearGradient id="pl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d7c2ff"/><stop offset="1" stop-color="#4b2f8e"/></linearGradient>')
  s.add(`<g transform="translate(1270 250)"><g style="${s.kf('0%,100%{transform:translateY(-10px)}50%{transform:translateY(10px)}', 14, 'ease-in-out infinite')}"><ellipse rx="230" ry="46" fill="none" stroke="#b9a2ff" stroke-width="10" opacity=".45" transform="rotate(-18)"/><circle r="120" fill="url(#pl)"/><path d="M-226 26 A230 46 0 0 0 226 -26" transform="rotate(-18)" fill="none" stroke="#e2d6ff" stroke-width="10" opacity=".8"/></g></g>`)
  return s
}

function sakura() {
  const s = new Svg(23).sky(['#2a1f3d', 0], ['#6b3f6e', 0.45], ['#e89ab0', 0.82], ['#ffd9c7', 1])
  s.glow(1150, 800, 360, '#ffe0c8', 0.8)
  s.add(`<circle cx="1150" cy="800" r="110" fill="#fff0e0" opacity=".85"/>`)
  s.add(s.ridge(900, 80, '#5a3254', 9, 0.8))
  // a branch from the top-left corner, blossoms along it
  s.add(`<path d="M-20 120 C200 140 320 90 520 160 S760 150 860 90 M300 118 C360 200 420 220 520 260 M620 152 C660 80 720 50 800 30" stroke="#2a1622" stroke-width="16" fill="none" stroke-linecap="round"/>`)
  let bl = ''
  for (let i = 0; i < (LITE ? 18 : 46); i++) bl += `<circle cx="${f(s.rnd(40, 860))}" cy="${f(s.rnd(30, 280))}" r="${f(s.rnd(8, 18))}" fill="${i % 3 ? '#ffb7cf' : '#ffd6e4'}" opacity="${f(s.rnd(0.7, 1))}"/>`
  s.add(bl)
  let p = ''
  for (let i = 0; i < few(40); i++) p += `<ellipse cx="${f(s.rnd(0, W))}" cy="${f(s.rnd(0, H))}" rx="7" ry="4" fill="#ffc2d6" opacity="${f(s.rnd(0.5, 0.95))}" transform="rotate(${f(s.rnd(0, 180))} 0 0)"/>`
  s.loop(`<g>${p}</g>`, W * 0.4, H, 36)
  return s
}

function snow() {
  const s = new Svg(24).sky(['#0c1630', 0], ['#1b2c54', 0.55], ['#3a4f80', 1])
  s.stars(50, 10, 400, '#dfe9ff', 12)
  s.add(s.ridge(760, 160, '#5d6f99', 2, 0.8))
  s.add(s.ridge(860, 90, '#c9d6ee', 4))
  let trees = ''
  for (let i = 0; i < 9; i++) trees += pine(s.rnd(0, 520) + (i > 4 ? 1000 : 0), 900 + s.rnd(-10, 20), s.rnd(120, 220), '#14213d')
  s.add(trees)
  // cabin, lower right, window light breathing
  s.glow(1240, 830, 160, '#ffb85c', 0.55, 'tw')
  s.add(`<g transform="translate(1160 760)"><rect x="0" y="40" width="170" height="110" fill="#2a1f22"/><path d="M-20 44 L85 -30 L190 44 Z" fill="#e9f1ff"/><rect x="30" y="70" width="40" height="34" fill="#ffc46b" class="tw" style="animation-duration:3s"/><rect x="104" y="90" width="34" height="60" fill="#3a2a2a"/><rect x="128" y="-14" width="18" height="40" fill="#2a1f22"/></g>`)
  s.drift(120, '*.·', '#ffffff', 60, H, 30, 16, 0, H, 0.8)
  s.drift(60, '*', '#ffffff', -40, H, 14, 24, 0, H, 0.9)
  return s
}

function dunes() {
  const s = new Svg(25).sky(['#191433', 0], ['#4b2559', 0.22], ['#c2553f', 0.4], ['#ffb066', 0.5], ['#ffdca6', 0.6], ['#ffdca6', 1])
  s.stars(30, 10, 180, '#ffe2c8', 11)
  s.glow(420, 470, 300, '#ffd28a', 0.8)
  s.add(`<circle cx="420" cy="470" r="90" fill="#fff0c8" opacity=".9"/>`)
  const dune = (y: number, a: number, c: string, ph: number) => `<path d="M0 ${y} C300 ${y - a} 500 ${y - a * 0.2} 800 ${y - a * 0.7} S1300 ${y + a * 0.2} 1600 ${y - a * 0.6} L1600 1000 L0 1000 Z" fill="${c}" transform="translate(${ph} 0)"/>`
  s.add(dune(620, 120, '#d98a4c', 0) + dune(720, 140, '#b8653a', -60) + dune(840, 110, '#8a4228', 40) + dune(930, 80, '#5e2a1e', 0))
  s.drift(80, '-–.·', '#fff0d0', W, 0, 22, 14, 560, 1000, 0.5)
  return s
}

function lighthouse() {
  const s = new Svg(26).sky(['#03060f', 0], ['#0a1a33', 0.5], ['#1a3552', 0.7], ['#0b1d31', 0.7], ['#030912', 1])
  s.stars(100, 10, 640)
  s.defs.push('<linearGradient id="beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffe9b0" stop-opacity=".55"/><stop offset="1" stop-color="#ffe9b0" stop-opacity="0"/></linearGradient>')
  // beam sweeps by squashing a fan to nothing and flipping it, like a turning lamp
  s.add(`<g transform="translate(1300 380)"><g style="${s.kf('0%{transform:scaleX(1)}25%{transform:scaleX(0)}50%{transform:scaleX(-1)}75%{transform:scaleX(0)}100%{transform:scaleX(1)}', 10)}"><polygon points="0,0 -1400,-180 -1400,200" fill="url(#beam)" transform="scale(-1 1)"/></g></g>`)
  s.glow(1300, 380, 90, '#ffe9b0', 0.9)
  s.add(`<path d="M1170 700 L1240 610 L1420 640 L1470 700 Z" fill="#05101c"/><path d="M1270 640 L1284 400 L1316 400 L1330 640 Z" fill="#e9eef5"/><path d="M1274 560 L1326 560 L1324 590 L1276 590 Z M1279 470 L1321 470 L1320 500 L1280 500 Z" fill="#c2453f"/><rect x="1278" y="360" width="44" height="40" fill="#1a2433"/><path d="M1272 360 L1300 330 L1328 360 Z" fill="#c2453f"/>`)
  s.waves(700, 1000, 13, '#7fa6cf', 55)
  return s
}

function bamboo() {
  const s = new Svg(27).sky(['#0e2a26', 0], ['#1d4a3c', 0.45], ['#3f7a5a', 0.8], ['#6fa27a', 1])
  let rays = ''
  for (let i = 0; i < 5; i++) rays += `<polygon points="${900 + i * 140},0 ${960 + i * 140},0 ${600 + i * 160},1000 ${470 + i * 160},1000" fill="#e8ffd0" style="${s.kf('0%,100%{opacity:.03}50%{opacity:.12}', 8 + i, 'ease-in-out infinite')}"/>`
  s.add(rays)
  const stalk = (x: number, w: number, c: string) => {
    let seg = ''
    for (let y = -60; y < H; y += s.rnd(110, 170)) seg += `<rect x="${f(-w / 2)}" y="${f(y)}" width="${f(w)}" height="6" fill="#0e2a20" opacity=".6"/><path d="M0 ${f(y)} q40 -30 90 -24 q-50 6 -90 24" fill="${c}" opacity=".8"/>`
    return `<g transform="translate(${f(x)} 1000)"><g style="${s.kf(`0%,100%{transform:rotate(-1.5deg)}50%{transform:rotate(1.5deg)}`, s.rnd(6, 10), 'ease-in-out infinite')};transform-origin:0 0"><g transform="translate(0 -1000)"><rect x="${f(-w / 2)}" y="-60" width="${f(w)}" height="1100" fill="${c}"/>${seg}</g></g></g>`
  }
  for (let i = 0; i < 9; i++) { const x = i < 5 ? 40 + i * 95 + s.rnd(-20, 20) : 1150 + (i - 5) * 110 + s.rnd(-20, 20); s.add(stalk(x, s.rnd(18, 34), i % 2 ? '#2f6b45' : '#3f8a52')) }
  s.drift(26, '~  ~', '#e8ffe0', W, 0, 90, 60, 300, 1000, 0.18)
  return s
}

function balloonShape(c1: string, c2: string) {
  return `<g><path d="M0 -90 C60 -90 70 -30 40 10 L14 40 L-14 40 L-40 10 C-70 -30 -60 -90 0 -90 Z" fill="${c1}"/><path d="M0 -90 C22 -90 26 -30 14 10 L6 40 L-6 40 L-14 10 C-26 -30 -22 -90 0 -90 Z" fill="${c2}"/><path d="M-12 42 L-10 60 M12 42 L10 60" stroke="#3a2a2a" stroke-width="2"/><rect x="-12" y="60" width="24" height="18" fill="#6b4a3a"/></g>`
}
function balloons() {
  const s = new Svg(28).sky(['#27306b', 0], ['#6f6fb0', 0.3], ['#f0a58f', 0.58], ['#ffdcae', 0.74], ['#ffeccb', 1])
  s.glow(800, 900, 400, '#fff2d0', 0.8)
  s.add(s.ridge(820, 140, '#8a7aa8', 1, 0.6) + s.ridge(900, 90, '#6a5a88', 3, 0.8))
  s.flock(5, 150, 420, '#3a2e52', 36, 110)
  s.add(s.ridge(970, 50, '#4a3e66', 6))
  ;[[220, 360, 1.2, '#ffb347', '#e5484d'], [1340, 260, 1, '#7fc4ff', '#ffe66b'], [1120, 560, 0.6, '#ff8fb0', '#fff'], [480, 620, 0.5, '#8fd06a', '#ffe66b'], [1500, 640, 0.45, '#ffcf7a', '#c47dff']].forEach(([x, y, sc, a, b], i) =>
    s.add(`<g transform="translate(${x} ${y}) scale(${sc})"><g style="${s.kf('0%,100%{transform:translate(0,0)}50%{transform:translate(18px,-46px)}', 12 + i * 3, 'ease-in-out infinite')}">${balloonShape(a as string, b as string)}</g></g>`))
  return s
}

function train() {
  const s = new Svg(29).sky(['#070b1f', 0], ['#121c44', 0.5], ['#27376b', 0.72], ['#3b4a7c', 1])
  s.stars(80, 10, 500)
  s.glow(1200, 180, 160, '#e6ecff', 0.6)
  s.add(`<circle cx="1200" cy="180" r="44" fill="#eef2ff"/>`)
  s.loop(s.ridge(700, 160, '#1f2b55', 1, 1, 100), -W, 0, 90)
  s.loop(s.ridge(800, 110, '#141d40', 4, 1, 80), -W, 0, 45)
  // far windows of a village
  let lights = ''
  for (let i = 0; i < 24; i++) lights += `<rect x="${f(s.rnd(0, W))}" y="${f(s.rnd(790, 860))}" width="5" height="5" fill="#ffd27a" opacity=".8"/>`
  s.loop(lights, -W, 0, 45)
  s.loop(s.ridge(890, 50, '#0a1028', 7, 1, 60), -W, 0, 18)
  let poles = ''
  for (let x = 0; x < W; x += 400) poles += `<rect x="${x}" y="560" width="10" height="440" fill="#04060f"/><path d="M${x - 200} 600 Q${x} 640 ${x + 5} 580 Q${x + 200} 640 ${x + 400} 600" stroke="#04060f" stroke-width="2" fill="none"/>`
  s.loop(poles, -400, 0, 2.2)
  // the window frame
  s.add(`<path d="M0 0 H1600 V1000 H0 Z M60 60 Q60 40 80 40 H1520 Q1540 40 1540 60 V940 Q1540 960 1520 960 H80 Q60 960 60 940 Z" fill="#0b0f22" fill-rule="evenodd"/>`)
  return s
}

function silk() {
  const s = new Svg(30).sky(['#0a0a14', 0], ['#0e0d1f', 0.5], ['#08080f', 1])
  s.defs.push('<filter id="soft" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>')
  ;[['#8f7bff', 300, 40], ['#ff7bc8', 520, 52], ['#5fd0ff', 720, 46], ['#7bffcf', 180, 60]].forEach(([c, y, d], i) => {
    const yy = y as number
    s.add(`<g filter="url(#soft)" opacity=".45" style="${s.kf(`0%,100%{transform:translate(-120px,0) scaleY(1)}50%{transform:translate(120px,${i % 2 ? 60 : -60}px) scaleY(1.4)}`, d as number, 'ease-in-out infinite')}"><path d="M-200 ${yy} C200 ${yy - 160} 500 ${yy + 160} 800 ${yy} S1400 ${yy - 160} 1800 ${yy}" stroke="${c}" stroke-width="${60 - i * 8}" fill="none" stroke-linecap="round"/></g>`)
  })
  return s
}

function dots() {
  const s = new Svg(31).sky(['#0b0c10', 0], ['#0d0f16', 1])
  const a = s.kf('0%,100%{transform:scale(.35);opacity:.25}50%{transform:scale(1);opacity:.9}', 6, 'ease-in-out infinite')
  let d = ''
  const step = LITE ? 150 : 50
  for (let y = 30; y < H; y += step) for (let x = 30; x < W; x += step) {
    const ph = (Math.sin(x * 0.004) + Math.cos(y * 0.006)) * 1.5 + (x + y) * 0.002
    d += `<circle class="fb" cx="${x}" cy="${y}" r="5" style="${a};animation-delay:-${f(((ph % 6) + 6) % 6)}s"/>`
  }
  return s.add(`<g fill="#8fa6ff">${d}</g>`)
}

function mist() {
  const s = new Svg(32).sky(['#1a2536', 0], ['#3a4d66', 0.4], ['#74899e', 0.62], ['#8fa2b4', 1])
  s.glow(1200, 260, 220, '#e6eef6', 0.5)
  const band = (y: number, op: number, d: number) => s.loop(`<ellipse cx="400" cy="${y}" rx="520" ry="34" fill="#e6eef6" opacity="${op}"/><ellipse cx="1250" cy="${y + 20}" rx="460" ry="28" fill="#e6eef6" opacity="${op}"/>`, W, 0, d)
  ;[[560, 140, '#5a6e86', 1], [660, 130, '#4a5d75', 3], [760, 110, '#3a4b61', 5], [860, 90, '#2a384b', 7], [950, 60, '#1c2735', 9]].forEach(([b, a, c, sd], i) => {
    s.add(s.ridge(b as number, a as number, c as string, sd as number, 1, 70))
    band((b as number) - 10, 0.25, 60 + i * 20)
    if (i === 0) s.flock(5, 320, 470, '#2a384b', 34, 120)
  })
  return s
}

const LIME = '#d4ff3d'
function cutline() {
  const s = new Svg(33).add(`<rect width="${W}" height="${H}" fill="#0a0a0a"/>`)
  const TR: [string, number, number][] = [['V2', 9, 0.5], ['V1', 6, 0], ['A1', 11, 0], ['A2', 7, 0.35]]
  let g = '<g font-size="20" fill="#777">'
  TR.forEach(([n], i) => (g += `<text x="40" y="${640 + i * 80}">${n}</text>`))
  g += '</g>'
  s.add(g)
  let clips = ''
  TR.forEach(([n, cnt], i) => {
    let x = 110
    for (let k = 0; k < cnt * 2; k++) {
      const w = s.rnd(80, 260)
      clips += `<rect x="${f(x)}" y="${615 + i * 80}" width="${f(w)}" height="44" rx="4" fill="${n[0] === 'V' ? '#2b2b2b' : '#1f1f1f'}" stroke="#3a3a3a"/>`
      if (n[0] === 'A' && !LITE) { let wv = ''; for (let q = 6; q < w - 6; q += 6) wv += `M${f(x + q)} ${637 + i * 80 - s.rnd(2, 16)} V${f(637 + i * 80 + s.rnd(2, 16))}`; clips += `<path d="${wv}" stroke="#555" stroke-width="2"/>` }
      x += w + s.rnd(4, 30)
    }
  })
  s.loop(clips, -W, 0, 80)
  let ticks = ''
  for (let x = 110; x < W; x += 40) ticks += `<line x1="${x}" y1="580" x2="${x}" y2="${x % 200 === 110 % 200 ? 560 : 570}" stroke="#555"/>`
  s.add(ticks)
  s.add(`<g style="${s.kf('from{transform:translateX(110px)}to{transform:translateX(1560px)}', 16)}"><line x1="0" y1="560" x2="0" y2="940" stroke="${LIME}" stroke-width="3"/><path d="M-10 548 H10 V560 L0 570 L-10 560 Z" fill="${LIME}"/></g>`)
  s.add(`<text x="110" y="500" font-size="64" fill="#f2f2f2" font-family='${SANS}' font-weight="700">Cut<tspan fill="${LIME}">.</tspan></text>`)
  return s
}

const CUTS = [['Cut', 'to', 'what', 'matters.'], ['Every', 'frame', 'earns', 'its', 'place.'], ['Start', 'on', 'the', 'strongest', 'line.'], ['Hold.', 'Then', 'cut.'], ['One', 'idea', 'per', 'card.'], ['Kill', 'the', 'dead', 'air.']]
function cutrazor() {
  const s = new Svg(34).add(`<rect width="${W}" height="${H}" fill="#0a0a0a"/>`)
  const n = CUTS.length, slot = 4
  CUTS.forEach((words, i) => {
    const a = s.kf(`0%{opacity:0}3%,${f(100 / n - 3)}%{opacity:1}${f(100 / n)}%,100%{opacity:0}`, n * slot)
    let x = 120
    let t = ''
    words.forEach((w, k) => {
      const struck = (k + i) % 3 === 1
      t += `<tspan x="${x}" fill="${struck ? '#555' : '#f2f2f2'}" ${struck ? 'text-decoration="line-through"' : ''}>${w}</tspan>`
      x += w.length * 46 + 34
    })
    s.add(`<g opacity="0" style="${a};animation-delay:${f(i * slot - n * slot)}s"><text y="820" font-size="84" font-weight="700" font-family='${SANS}'>${t}</text><line x1="100" y1="${740}" x2="100" y2="860" stroke="${LIME}" stroke-width="4" style="${s.kf(`from{transform:translateX(0)}to{transform:translateX(${Math.min(x, 1500) - 100}px)}`, slot, 'ease-in-out infinite')}"/></g>`)
  })
  s.add(`<text x="120" y="120" font-size="22" fill="#666">00:00:${'0'}4:12 ▸ razor</text>`)
  return s
}

function cutfilm() {
  const s = new Svg(35).add(`<rect width="${W}" height="${H}" fill="#f7f7f4"/>`)
  let strip = `<rect x="0" y="0" width="${W}" height="260" fill="#111"/>`
  for (let x = 10; x < W; x += 40) strip += `<rect x="${x}" y="14" width="22" height="16" rx="3" fill="#f7f7f4"/><rect x="${x}" y="230" width="22" height="16" rx="3" fill="#f7f7f4"/>`
  for (let x = 20; x < W; x += 320) strip += `<rect x="${x}" y="48" width="290" height="164" fill="${['#2a2a2a', '#333', '#262626', '#303030', '#2d2d2d'][(x / 320) | 0]}"/>`
  s.add(`<g transform="translate(0 600)">`)
  s.loop(strip, -320 * 5, 0, 40)
  s.add(`</g>`)
  s.add(`<rect x="652" y="640" width="296" height="172" fill="none" stroke="${LIME}" stroke-width="5" class="tw" style="animation-duration:1.6s"/>`)
  s.add(`<text x="120" y="160" font-size="22" fill="#999">reel 01 · 24 fps</text>`)
  return s
}

function murmur() {
  const s = new Svg(36).sky(['#1c2444', 0], ['#5a4a78', 0.35], ['#d98a6a', 0.68], ['#ffcf96', 0.86], ['#ffe6bd', 1])
  s.glow(1300, 860, 300, '#fff0d0', 0.8)
  let birds = ''
  for (let i = 0; i < (LITE ? 70 : 200); i++) {
    const a = s.rnd(0, Math.PI * 2), r = Math.sqrt(s.rnd(0, 1))
    birds += s.bird(Math.cos(a) * r * 240, Math.sin(a) * r * 100, s.rnd(11, 17), '#1a1426')
  }
  const morph = s.kf('0%{transform:translate(1150px,300px) rotate(0deg) scale(1,1)}20%{transform:translate(900px,220px) rotate(25deg) scale(1.3,.6)}40%{transform:translate(1250px,180px) rotate(-15deg) scale(.7,1.4)}60%{transform:translate(1380px,330px) rotate(40deg) scale(1.2,.8)}80%{transform:translate(1000px,360px) rotate(-30deg) scale(.9,1.2)}100%{transform:translate(1150px,300px) rotate(0deg) scale(1,1)}', 40, 'ease-in-out infinite')
  const twist = s.kf('0%,100%{transform:skewX(-20deg)}50%{transform:skewX(20deg)}', 9, 'ease-in-out infinite')
  s.add(`<g opacity=".9" style="${morph}"><g style="${twist}">${birds}</g></g>`)
  s.flock(4, 520, 680, '#2a1a2e', 42, 70)
  s.add(s.ridge(930, 70, '#2a1a2e', 4))
  return s
}

function topo() {
  const s = new Svg(37).sky(['#0c1a1c', 0], ['#0f2226', 0.5], ['#0a1517', 1])
  const ring = (cx: number, cy: number, r: number, seed: number) => {
    let d = ''
    const pts = LITE ? 16 : 48
    for (let k = 0; k <= pts; k++) {
      const t = (k / pts) * Math.PI * 2
      const rr = r * (1 + 0.12 * Math.sin(t * 3 + seed) + 0.07 * Math.cos(t * 5 + seed * 2))
      d += `${k ? 'L' : 'M'}${f(cx + Math.cos(t) * rr)} ${f(cy + Math.sin(t) * rr * 0.8)}`
    }
    return d + 'Z'
  }
  ;[[300, 300, 1], [1300, 700, 2], [1250, 180, 3]].forEach(([cx, cy, sd], j) => {
    let g = ''
    for (let i = 1; i <= (LITE ? 6 : 11); i++) g += `<path d="${ring(0, 0, i * 42, sd! + i * 0.3)}" fill="none" stroke="${i % 5 === 0 ? '#6fd0bf' : '#2f6b63'}" stroke-width="${i % 5 === 0 ? 2.2 : 1.2}" opacity="${f(0.9 - i * 0.05)}"/>`
    s.add(`<g transform="translate(${cx} ${cy})"><g style="${s.kf(`0%,100%{transform:rotate(0deg) scale(1)}50%{transform:rotate(${j % 2 ? -12 : 12}deg) scale(1.08)}`, 30 + j * 7, 'ease-in-out infinite')}">${g}</g></g>`)
  })
  s.add(`<g font-size="14" fill="#6fd0bf" opacity=".6"><text x="300" y="300" text-anchor="middle">▲ 1240</text><text x="1300" y="700" text-anchor="middle">▲ 980</text></g>`)
  return s
}

/* ---------------- catalogue ---------------- */

export type Scene = {
  id: string
  name: string
  tag: string
  accent: string
  /** the page colour the panels sit on */
  bg: string
  mode: 'dark' | 'light'
  draw: () => Svg
}

export const SCENES: Scene[] = [
  { id: 'cloud-drift', name: 'Cloud Drift', tag: 'Paralaks gökyüzü', accent: '#4aa8e8', bg: '#0a2036', mode: 'dark', draw: cloud },
  { id: 'honu-lagoon', name: 'Honu Lagoon', tag: 'Kaplumbağa · ışık huzmeleri', accent: '#68e6d6', bg: '#02283a', mode: 'dark', draw: turtle },
  { id: 'koi-pond', name: 'Koi Pond', tag: 'Koi · nilüfer · halka', accent: '#ff9b63', bg: '#08261f', mode: 'dark', draw: koi },
  { id: 'jellyfish', name: 'Jellyfish', tag: 'Biyolüminesans', accent: '#cba7ff', bg: '#030a24', mode: 'dark', draw: jelly },
  { id: 'paper-boats', name: 'Paper Boats', tag: 'Gün batımı · yansıma', accent: '#ffb27a', bg: '#0f1a3e', mode: 'dark', draw: boat },
  { id: 'fireflies', name: 'Fireflies', tag: 'Gece ormanı', accent: '#d9f78f', bg: '#06140f', mode: 'dark', draw: fireflies },
  { id: 'moonlit', name: 'Moonlit', tag: 'Kayan yıldız · deniz', accent: '#f2d9a0', bg: '#080f33', mode: 'dark', draw: moon },
  { id: 'aurora', name: 'Aurora', tag: 'Kuzey ışıkları', accent: '#7dffc2', bg: '#03101a', mode: 'dark', draw: aurora },
  { id: 'neon-grid', name: 'Neon Grid', tag: 'Synthwave', accent: '#ff5fd2', bg: '#0b0018', mode: 'dark', draw: synth },
  { id: 'rain-window', name: 'Rain Window', tag: 'Yağmur · şehir ışıkları', accent: '#8fc4ff', bg: '#0b1220', mode: 'dark', draw: rain },
  { id: 'deep-space', name: 'Deep Space', tag: 'Yıldız akışı · halkalı gezegen', accent: '#b9a2ff', bg: '#05040f', mode: 'dark', draw: space },
  { id: 'sakura', name: 'Sakura', tag: 'Gün batımı · kiraz çiçeği', accent: '#ff9fbd', bg: '#1f1730', mode: 'dark', draw: sakura },
  { id: 'snow-cabin', name: 'Snow Cabin', tag: 'Kar · kulübe ışığı', accent: '#cfe2ff', bg: '#0c1630', mode: 'dark', draw: snow },
  { id: 'golden-dunes', name: 'Golden Dunes', tag: 'Alacakaranlık · savrulan kum', accent: '#ffb866', bg: '#191433', mode: 'dark', draw: dunes },
  { id: 'lighthouse', name: 'Lighthouse', tag: 'Dönen ışık · gece denizi', accent: '#ffe9b0', bg: '#030912', mode: 'dark', draw: lighthouse },
  { id: 'bamboo-mist', name: 'Bamboo Mist', tag: 'Salınan koru · ışık huzmeleri', accent: '#8fd06a', bg: '#0b221e', mode: 'dark', draw: bamboo },
  { id: 'balloon-dawn', name: 'Balloon Dawn', tag: 'Balonlar · vadi sisi', accent: '#ffb347', bg: '#1d2452', mode: 'dark', draw: balloons },
  { id: 'night-train', name: 'Night Train', tag: 'Cam kenarı · geçen tepeler', accent: '#9db4ff', bg: '#070b1f', mode: 'dark', draw: train },
  { id: 'silk', name: 'Silk', tag: 'Sakin · ağır renk şeritleri', accent: '#8f7bff', bg: '#08080f', mode: 'dark', draw: silk },
  { id: 'dot-wave', name: 'Dot Wave', tag: 'Sakin · nefes alan nokta ızgarası', accent: '#8fa6ff', bg: '#0b0c10', mode: 'dark', draw: dots },
  { id: 'misty-peaks', name: 'Misty Peaks', tag: 'Sakin · kat kat dağlar', accent: '#9fb6cc', bg: '#141d2b', mode: 'dark', draw: mist },
  { id: 'cut-timeline', name: 'Cut · Timeline', tag: 'Siyah · yeşil playhead altında izler', accent: LIME, bg: '#0a0a0a', mode: 'dark', draw: cutline },
  { id: 'cut-razor', name: 'Cut · Razor', tag: 'Siyah · jiletin kestiği cümleler', accent: LIME, bg: '#0a0a0a', mode: 'dark', draw: cutrazor },
  { id: 'cut-film', name: 'Cut · Film', tag: 'Beyaz sayfa · siyah film şeridi', accent: '#5a7a00', bg: '#ecece6', mode: 'light', draw: cutfilm },
  { id: 'murmuration', name: 'Murmuration', tag: 'Gün batımında sığırcık sürüsü', accent: '#ffcf96', bg: '#161c36', mode: 'dark', draw: murmur },
  { id: 'contour', name: 'Contour', tag: 'Yaşayan eş yükselti haritası', accent: '#6fd0bf', bg: '#0a1517', mode: 'dark', draw: topo },
]

/** A scene drawn light enough for a picker thumbnail. */
export function drawLite(sc: Scene) {
  LITE = true
  try {
    return sc.draw()
  } finally {
    LITE = false
  }
}
