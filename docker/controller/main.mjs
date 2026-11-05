// The container's one long-running process: it keeps the virtual display up,
// runs the routine once a day at RUN_TIME, retries failures, records every
// run, and serves a small web UI (status, run now, sign-in via noVNC).

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadConfig } from './config.mjs'
import { log, initLogFile } from './log.mjs'
import { Browser } from './browser.mjs'
import { runOnce, describeResult, checkSignIn } from './run.mjs'
import { startWebServer } from './web.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let cfg
try {
  cfg = loadConfig()
} catch (e) {
  console.error(`Configuration error: ${e.message}`)
  process.exit(2)
}
initLogFile(cfg.logDir)

// ---------- state ----------

function dayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function readState() {
  try { return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')) } catch { return {} }
}
function writeState(patch) {
  const next = { ...readState(), ...patch }
  const tmp = `${cfg.stateFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, cfg.stateFile)
  return next
}
function appendRunLog(entry) {
  try { fs.appendFileSync(path.join(cfg.logDir, 'runs.jsonl'), JSON.stringify(entry) + '\n') } catch (e) { log.warn(`Could not write runs.jsonl: ${e.message}`) }
}
function recentRuns(limit = 15) {
  try {
    const lines = fs.readFileSync(path.join(cfg.logDir, 'runs.jsonl'), 'utf8').trim().split('\n')
    return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

// ---------- notifications ----------

async function notify(title, message, priority = 'default') {
  if (!cfg.notifyUrl) return
  try {
    const isNtfy = /ntfy/i.test(cfg.notifyUrl)
    const res = await fetch(cfg.notifyUrl, isNtfy
      ? { method: 'POST', body: message, headers: { Title: title, Priority: priority, Tags: 'gift' } }
      : { method: 'POST', body: JSON.stringify({ title, message, priority }), headers: { 'Content-Type': 'application/json' } })
    if (!res.ok) log.warn(`Notification failed: HTTP ${res.status}`)
  } catch (e) {
    log.warn(`Notification failed: ${e.message}`)
  }
}

// ---------- display stack (Xvfb + x11vnc + websockify) ----------

const children = new Map()
function supervise(name, cmd, args) {
  let restarts = 0
  const start = () => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: cfg.display } })
    let tail = ''
    proc.stderr.on('data', (d) => { tail = (tail + d).slice(-1000) })
    proc.on('error', (e) => log.error(`${name} failed to start: ${e.message}`))
    proc.on('exit', (code, signal) => {
      if (shuttingDown) return
      restarts++
      log.warn(`${name} exited (${signal || code}); restarting${tail ? `: ${tail.trim().split('\n').pop()}` : ''}`)
      setTimeout(start, Math.min(30000, 1000 * restarts))
    })
    children.set(name, proc)
  }
  start()
}

async function startDisplayStack() {
  if (!cfg.displayStack) return
  for (const f of [`/tmp/.X${cfg.display.slice(1)}-lock`, `/tmp/.X11-unix/X${cfg.display.slice(1)}`]) {
    try { fs.rmSync(f, { force: true }) } catch {}
  }
  supervise('Xvfb', 'Xvfb', [cfg.display, '-screen', '0', `${cfg.screenWidth}x${cfg.screenHeight}x24`, '-nolisten', 'tcp', '-ac'])
  await sleep(1500)
  supervise('x11vnc', 'x11vnc', ['-display', cfg.display, '-localhost', '-rfbport', '5900', '-forever', '-shared', '-nopw', '-quiet', '-noxdamage'])
  supervise('websockify', 'websockify', ['--web', cfg.novncDir, '127.0.0.1:6080', '127.0.0.1:5900'])
}

// ---------- scheduling ----------

const browser = new Browser(cfg)
const status = {
  phase: 'idle', // idle | running | waiting-retry | login
  attempt: 0,
  message: '',
  nextRunAt: null,
  progress: null,
  startedAt: Date.now(),
}

function plannedTime(day) {
  const st = readState()
  const [h, m] = cfg.runTime.split(':').map(Number)
  const base = new Date(`${day}T00:00:00`)
  base.setHours(h, m, 0, 0)
  // One random offset per day, kept across restarts.
  let offset = 0
  if (cfg.jitterMin > 0) {
    if (st.jitterDay === day && st.jitterKey === `${cfg.runTime}/${cfg.jitterMin}`) offset = st.jitterOffsetMin
    else {
      offset = Math.floor(Math.random() * (cfg.jitterMin + 1))
      writeState({ jitterDay: day, jitterKey: `${cfg.runTime}/${cfg.jitterMin}`, jitterOffsetMin: offset })
    }
  }
  return new Date(base.getTime() + offset * 60000)
}

function nextRun(now = new Date()) {
  const st = readState()
  const today = dayKey(now)
  const todayAt = plannedTime(today)
  if (st.lastRunDay !== today) {
    if (now < todayAt) return todayAt
    // Already past today's time and today has not run: catch up shortly.
    if (cfg.catchUp) return new Date(Math.max(now.getTime(), status.startedAt + 2 * 60000))
  }
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return plannedTime(dayKey(tomorrow))
}

let busy = false
let shuttingDown = false

async function runRoutine(trigger) {
  if (busy) return { ok: false, error: 'A run is already in progress' }
  busy = true
  const day = dayKey()
  const runStarted = new Date()
  log.info(`===== Run started (${trigger}) for ${day} =====`)
  let result = null
  let lastError = null
  try {
    for (let attempt = 1; attempt <= cfg.maxAttempts && !shuttingDown; attempt++) {
      status.phase = 'running'
      status.attempt = attempt
      status.message = `Attempt ${attempt} of ${cfg.maxAttempts}`
      log.info(`Attempt ${attempt}/${cfg.maxAttempts}`)
      try {
        result = await runOnce(browser, cfg, { onProgress: (p) => { status.progress = p } })
        log.info(`Attempt ${attempt} finished: ${describeResult(result)}`)
        if (result.status === 'completed') break
        lastError = new Error(`Routine ended with status "${result.status}"`)
      } catch (e) {
        lastError = e
        log.error(`Attempt ${attempt} failed: ${e.message}`)
        if (e.code === 'SIGNED_OUT') break
      } finally {
        await browser.close()
        status.progress = null
      }
      if (attempt < cfg.maxAttempts && !shuttingDown) {
        const waitMin = cfg.retryDelayMin * attempt
        status.phase = 'waiting-retry'
        status.message = `Retrying in ${waitMin} minutes`
        log.info(`Retrying in ${waitMin} minutes`)
        await sleep(waitMin * 60000)
      }
    }
  } finally {
    busy = false
    status.phase = 'idle'
    status.attempt = 0
  }

  const ok = result?.status === 'completed'
  const outcome = ok ? 'success' : lastError?.code === 'SIGNED_OUT' ? 'signed-out' : result ? 'partial' : 'failed'
  const entry = {
    day,
    trigger,
    startedAt: runStarted.toISOString(),
    endedAt: new Date().toISOString(),
    outcome,
    ...(result ? { status: result.status, beforePoints: result.beforePoints, afterPoints: result.afterPoints, gained: result.gained, detail: result.detail } : {}),
    ...(!ok && lastError ? { error: lastError.message } : {}),
  }
  appendRunLog(entry)
  writeState({ lastRunDay: day, lastOutcome: outcome, lastRunAt: entry.endedAt })
  const summary = result ? describeResult(result) : lastError?.message || 'no result'
  status.message = `Last run: ${outcome} - ${summary}`
  log.info(`===== Run ${outcome.toUpperCase()}: ${summary} =====`)

  if (outcome === 'signed-out') await notify('Rewards: sign-in needed', lastError.message, 'high')
  else if (!ok) await notify(`Rewards run ${outcome}`, summary, 'high')
  else if (cfg.notifyOnSuccess) await notify('Rewards run done', summary, 'low')
  return { ok: true, outcome }
}

async function schedulerLoop() {
  while (!shuttingDown) {
    const at = nextRun()
    status.nextRunAt = at.toISOString()
    if (Date.now() >= at.getTime() && !busy && !loginBusy()) {
      await runRoutine('schedule').catch((e) => log.error(`Run crashed: ${e.stack || e}`))
      continue
    }
    // Close an idle sign-in browser so it does not sit open all day.
    if (browser.running && browser.purpose === 'login' && Date.now() - browser.startedAt > cfg.loginIdleCloseMin * 60000) {
      log.info(`Closing the sign-in browser after ${cfg.loginIdleCloseMin} minutes`)
      await browser.close()
      status.phase = 'idle'
    }
    try { fs.writeFileSync('/tmp/rewards-heartbeat', String(Date.now())) } catch {}
    await sleep(Math.min(30000, Math.max(1000, at.getTime() - Date.now())))
  }
}

function loginBusy() { return browser.running && browser.purpose === 'login' }

// ---------- web UI actions ----------

const actions = {
  logSince: (seen) => ({ lines: log.since(seen), total: log.total() }),
  status: () => ({
    ...status,
    busy,
    browser: browser.running ? browser.purpose : null,
    runTime: cfg.runTime,
    jitterMin: cfg.jitterMin,
    timezone: cfg.timezone,
    now: new Date().toISOString(),
    lastRunDay: readState().lastRunDay || null,
    runs: recentRuns(),
    log: log.recent().slice(-120),
    logTotal: log.total(),
  }),
  runNow: () => {
    if (busy) return { ok: false, error: 'A run is already in progress' }
    if (loginBusy()) return { ok: false, error: 'Close the sign-in browser first' }
    runRoutine('manual').catch((e) => log.error(`Run crashed: ${e.stack || e}`))
    return { ok: true }
  },
  openLogin: async () => {
    if (busy) return { ok: false, error: 'A run is in progress; watch it in the screen view instead' }
    await browser.launch('login')
    await browser.openTab('https://rewards.bing.com/')
    status.phase = 'login'
    log.info('Sign-in browser opened. Sign in on the screen view, then press "Close browser".')
    return { ok: true }
  },
  checkLogin: async () => {
    if (busy) return { ok: false, error: 'A run is in progress' }
    const wasOpen = browser.running
    try {
      if (!wasOpen) await browser.launch('check')
      await checkSignIn(browser)
      return { ok: true, message: 'Signed in to Microsoft Rewards' }
    } catch (e) {
      return { ok: false, error: e.message }
    } finally {
      if (!wasOpen) await browser.close()
    }
  },
  closeBrowser: async () => {
    if (busy) return { ok: false, error: 'A run is in progress' }
    const wasLogin = browser.purpose === 'login'
    await browser.close()
    status.phase = 'idle'
    // Today's run stopped for want of a sign-in: let it catch up now (it
    // re-checks the sign-in first, so a still-signed-out profile costs one
    // quick check, not a routine).
    if (wasLogin && readState().lastRunDay === dayKey() && readState().lastOutcome === 'signed-out') {
      writeState({ lastRunDay: null })
      if (cfg.catchUp) log.info("Today's run was waiting for a sign-in; it will run now")
    }
    return { ok: true }
  },
}

// ---------- start ----------

async function main() {
  log.info(`Reward Routine controller starting (${cfg.haAddon ? 'Home Assistant add-on' : 'docker'})`)
  log.info(`Daily run at ${cfg.runTime} ${cfg.timezone}${cfg.jitterMin ? ` + up to ${cfg.jitterMin} min` : ''}; timeout ${cfg.timeoutMin} min; ${cfg.maxAttempts} attempts`)
  if (!fs.existsSync(path.join(cfg.extensionDir, 'manifest.json'))) {
    log.error(`No extension at ${cfg.extensionDir}`)
    process.exit(2)
  }
  await startDisplayStack()
  startWebServer(cfg, actions)
  const once = process.argv.includes('--run-once')
  if (once) {
    const r = await runRoutine('cli')
    await shutdown(r.outcome === 'success' ? 0 : 1)
    return
  }
  log.info(`Next run: ${nextRun().toString()}`)
  await schedulerLoop()
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log.info('Shutting down')
  await browser.close().catch(() => {})
  for (const proc of children.values()) { try { proc.kill('SIGTERM') } catch {} }
  process.exit(code)
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
process.on('unhandledRejection', (e) => log.error(`Unhandled: ${e?.stack || e}`))

main().catch((e) => { log.error(`Fatal: ${e.stack || e}`); shutdown(1) })
