// Run by "Çok harcayanlar": streams Claude Code's transcripts (~/.claude/projects/**/*.jsonl) and prints the ranking
// of the last 24 hours and 7 days as JSON. Needs Node 22.18 or later (it loads spend.ts as it is).
// Usage: node spend-scan.mjs [projects folder] [--week-reset=<ISO time the weekly limit resets>]
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { INTERESTING, createSpendScan } from './spend.ts'

const now = Date.now()
const args = process.argv.slice(2)
const weekReset = args.find(a => a.startsWith('--week-reset='))?.slice('--week-reset='.length) || null
const root = args.find(a => !a.startsWith('--')) || join(homedir(), '.claude', 'projects')
const scan = createSpendScan(now, weekReset)
const markers = INTERESTING.map(m => Buffer.from(m))

/** Every transcript changed within the last 7 days (an older file cannot hold a newer line). */
function recentFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) recentFiles(p, out)
    else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs > now - 7 * 86400_000 - 3600_000) out.push(p)
  }
  return out
}

/** Lines are cut from chunks as bytes; only a line holding a marker is decoded, so a gigabyte file stays a stream. */
async function readLines(file, onLine) {
  let rest = Buffer.alloc(0)
  const take = line => {
    if (markers.some(m => line.indexOf(m) >= 0)) onLine(line.toString('utf8'))
  }
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
    let start = 0
    for (let end = buf.indexOf(10, start); end >= 0; end = buf.indexOf(10, start)) {
      take(buf.subarray(start, end))
      start = end + 1
    }
    rest = Buffer.from(buf.subarray(start))
  }
  if (rest.length) take(rest)
}

for (const file of recentFiles(root)) {
  try {
    await readLines(file, scan.addLine)
  } catch {
    // a file that vanished or is locked is skipped
  }
}
process.stdout.write(JSON.stringify(scan.result()))
