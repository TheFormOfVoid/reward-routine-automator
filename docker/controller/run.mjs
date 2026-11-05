// One routine run: launch the browser, check the Microsoft sign-in, start the
// extension's full routine, follow it to the end, and report the result.

import { log } from './log.mjs'
import { BrowserError } from './browser.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const POLL_MS = 15000
const FINISH_GRACE_MS = 20000

export class SignedOutError extends Error {
  constructor(message) { super(message); this.code = 'SIGNED_OUT' }
}

// Where the Earn page lands tells us whether the profile is signed in.
// Signed out, /earn bounces to login.live.com and the root goes to the public
// /about page. A security challenge lands on account.live.com.
export function classifyRewardsPage(page) {
  let url
  try { url = new URL(page.href) } catch { return { signedIn: false, reason: `unreadable page URL "${page.href}"` } }
  const host = url.hostname.toLowerCase()
  if (/^(login|account)\.(live|microsoftonline|microsoft)\.com$/.test(host)) {
    return { signedIn: false, reason: `redirected to ${host}` }
  }
  if (host !== 'rewards.bing.com') return { signedIn: false, reason: `unexpected page ${host}${url.pathname}` }
  if (/^\/(about|welcome|signin|createuser)(\/|$)/i.test(url.pathname)) {
    return { signedIn: false, reason: `landed on the public ${url.pathname} page` }
  }
  if (/^sign in\b/i.test(page.title || '')) return { signedIn: false, reason: 'page asks to sign in' }
  return { signedIn: true, reason: '' }
}

function points(n) { return Number.isFinite(n) ? n.toLocaleString('en-US') : '?' }
function dur(ms) {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

export async function checkSignIn(browser) {
  const page = await browser.probePage('https://rewards.bing.com/earn')
  const verdict = classifyRewardsPage(page)
  if (!verdict.signedIn) {
    throw new SignedOutError(`Not signed in to Microsoft Rewards (${verdict.reason}). Open the web UI, press "Open browser for sign-in" and sign in once.`)
  }
  log.info('Sign-in check: signed in to Microsoft Rewards')
}

// Runs one attempt. Resolves to a result object; throws on hard failures
// (browser could not start, signed out, routine never started).
export async function runOnce(browser, cfg, { onProgress } = {}) {
  const started = Date.now()
  await browser.launch('routine')
  log.info(`Extension ${browser.extensionVersion()} loaded (id ${browser.extensionId})`)
  await checkSignIn(browser)

  const before = await browser.readLocal(['runHistory', 'activeRun', 'runState'])
  const known = new Set((before.runHistory || []).map((r) => r?.id))
  if (before.runState?.routine || before.runState?.batch || before.runState?.activity) {
    log.warn('A previous routine was still marked active; stopping it first')
    await browser.sendMessage({ type: 'STOP_BATCH' }).catch(() => {})
    await sleep(3000)
  }

  const reply = await browser.sendMessage({ type: 'RUN_FULL_ROUTINE' })
  if (!reply?.ok) throw new BrowserError(`The extension refused to start the routine: ${reply?.error || 'no reply'}`)
  log.info('Routine started')

  const deadline = started + cfg.timeoutMin * 60000
  let runId = null
  let loggedEvents = 0
  let sawActive = false
  let idlePolls = 0
  let lastAction = ''
  const ACTIVITY_KEYS = ['lastStatsLog', 'lastRewards', 'lastImageSearch', 'lastTabAction']
  const seen = {}
  const initial = await browser.readLocal(ACTIVITY_KEYS).catch(() => ({}))
  for (const k of ACTIVITY_KEYS) seen[k] = initial[k]?.detail || ''

  while (true) {
    if (!browser.running) throw new BrowserError('Chromium exited during the routine')
    if (Date.now() > deadline) {
      log.error(`Routine did not finish within ${cfg.timeoutMin} minutes; stopping it`)
      await browser.sendMessage({ type: 'STOP_BATCH' }).catch(() => {})
      return { status: 'timeout', detail: `Timed out after ${cfg.timeoutMin} minutes`, durationMs: Date.now() - started }
    }
    await sleep(POLL_MS)
    let s
    try {
      s = await browser.readLocal(['activeRun', 'runHistory', 'runState', ...ACTIVITY_KEYS])
    } catch (e) {
      log.warn(`Could not read extension state: ${e.message}`)
      continue
    }
    const active = s.activeRun
    if (active && !known.has(active.id)) runId = active.id
    if (active && active.id === runId) {
      for (const ev of active.events.slice(loggedEvents)) {
        log.info(`  step ${ev.step}: ${ev.outcome}${ev.detail ? ` - ${ev.detail}` : ''}${ev.durationMs ? ` (${dur(ev.durationMs)})` : ''}`)
      }
      loggedEvents = Math.max(loggedEvents, active.events.length)
    }
    for (const k of ACTIVITY_KEYS) {
      const entry = s[k]
      const detail = entry?.detail || ''
      if (detail && detail !== seen[k]) {
        seen[k] = detail
        lastAction = detail
        const mark = entry.ok === false ? 'problem' : 'activity'
        log[entry.ok === false ? 'warn' : 'info'](`  ${mark}: ${String(detail).slice(0, 200)}`)
      }
    }
    onProgress?.({ runId, events: loggedEvents, action: lastAction })

    const finished = (s.runHistory || []).find((r) => r && !known.has(r.id) && (!runId || r.id === runId))
    if (finished) {
      for (const ev of finished.events.slice(loggedEvents)) {
        log.info(`  step ${ev.step}: ${ev.outcome}${ev.detail ? ` - ${ev.detail}` : ''}`)
      }
      await sleep(FINISH_GRACE_MS)
      const gained = Number.isFinite(finished.afterPoints) && Number.isFinite(finished.beforePoints)
        ? finished.afterPoints - finished.beforePoints : null
      return {
        status: finished.status,
        detail: finished.detail || '',
        beforePoints: finished.beforePoints,
        afterPoints: finished.afterPoints,
        gained,
        events: finished.events,
        durationMs: Date.now() - started,
      }
    }

    // Fallback when run history is unavailable: the run state going idle.
    const st = s.runState || {}
    const busy = !!(st.routine || st.batch || st.activity)
    if (busy) { sawActive = true; idlePolls = 0 } else if (sawActive && ++idlePolls >= 3) {
      return { status: 'unknown', detail: 'Routine went idle without a run record', durationMs: Date.now() - started }
    } else if (!sawActive && Date.now() - started > 5 * 60000) {
      throw new BrowserError('The routine never became active')
    }
  }
}

export function describeResult(r) {
  const parts = [`status ${r.status}`]
  if (Number.isFinite(r.beforePoints) || Number.isFinite(r.afterPoints)) {
    parts.push(`points ${points(r.beforePoints)} -> ${points(r.afterPoints)}${r.gained != null ? ` (+${points(r.gained)})` : ''}`)
  }
  if (r.durationMs) parts.push(`took ${dur(r.durationMs)}`)
  if (r.detail) parts.push(r.detail)
  return parts.join(', ')
}
