#!/usr/bin/env node
// The panel edits only the user's personal skill visibility; project and managed settings can override it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const L = (en, tr) => (process.env.THE_CHIEF_LANG === 'tr' ? tr : en)
const home = process.env.CHIEF_STARTUP_HOME || os.homedir()
const settingsFile = path.join(home, '.claude', 'settings.json')
const skillDir = path.join(home, '.claude', 'skills')
function settings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e }
}
function list() {
  const config = settings()
  let entries
  try { entries = fs.readdirSync(skillDir, { withFileTypes: true }) }
  catch (e) { if (e.code === 'ENOENT') return []; throw e }
  return entries.flatMap(entry => {
    try {
      const content = fs.readFileSync(path.join(skillDir, entry.name, 'SKILL.md'), 'utf8')
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || ''
      const name = (frontmatter.match(/^name:\s*["']?([^\s"']+)/m)?.[1] || entry.name).trim()
      const value = config.skillOverrides?.[name] || 'on'
      return [{ name, value, source: entry.name }]
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR') return []; throw e }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
function setSkill(name, state) {
  if (!['on', 'off'].includes(state) || !list().some(s => s.name === name)) throw new Error(L('Invalid skill or state', 'Skill veya durum geçersiz'))
  const config = settings()
  if (config.skillOverrides != null && (typeof config.skillOverrides !== 'object' || Array.isArray(config.skillOverrides))) throw new Error(L('skillOverrides is not a valid object', 'skillOverrides geçerli bir nesne değil'))
  config.skillOverrides = { ...config.skillOverrides, [name]: state }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  const tmp = `${settingsFile}.chief-${process.pid}-${Date.now()}.tmp`
  try {
    const mode = fs.existsSync(settingsFile) ? fs.statSync(settingsFile).mode & 0o777 : 0o600
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode, flag: 'wx' })
    fs.renameSync(tmp, settingsFile)
  } finally { try { fs.unlinkSync(tmp) } catch {} }
}
try {
  const [, , action, name, value] = process.argv
  if (action === 'list') console.log(JSON.stringify(list()))
  else if (action === 'set') { setSkill(name, value); console.log(JSON.stringify(list())) }
  else throw new Error(L('Unknown action', 'Bilinmeyen işlem'))
} catch (e) { console.error(e.message); process.exitCode = 1 }
