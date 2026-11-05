// Timestamped logging to stdout (docker logs / the add-on Log tab) and to a
// size-capped file in the data volume.

import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024
let file = null
const recent = []
let total = 0

export function initLogFile(dir) {
  fs.mkdirSync(dir, { recursive: true })
  file = path.join(dir, 'rewards.log')
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function write(level, msg) {
  const line = `${stamp()} ${level.padEnd(5)} ${msg}`
  ;(level === 'ERROR' ? console.error : console.log)(line)
  recent.push(line)
  total++
  if (recent.length > 300) recent.shift()
  if (!file) return
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`)
    fs.appendFileSync(file, line + '\n')
  } catch {}
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  recent: () => recent.slice(),
  total: () => total,
  // Lines logged after the first `seen` lines (as many as are still kept).
  since: (seen) => recent.slice(Math.max(0, recent.length - (total - seen))),
}
