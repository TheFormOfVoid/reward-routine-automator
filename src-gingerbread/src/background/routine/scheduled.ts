// The scheduled run (user request, 2026-09-12): fire the startup routine once
// a day at the user-specified time, in a browser that never closes and
// reopens. The once-per-day logic itself stays where it lives
// (runStartupSequence's lastRoutineDay gate) — this driver is only the clock.
//
// WHY A HEARTBEAT, NOT A ~24h ONE-SHOT (user report 2026-09-15, restated
// 2026-09-22 "the schedule feature does not work"): the close-time test fired,
// the next-day leave never did. The old design armed a one-shot `when` alarm
// ~24h out and trusted Chrome to deliver it — but Chrome NEVER delivers a
// past-due alarm: a browser closed or a PC asleep at the moment drops the fire
// with no replacement, and even awake, a far-future one-shot is the fragile
// case the search watchdog already abandoned (core/alarms.ts documents the
// same one-shot→periodic lesson). So the clock is no longer "wait for one
// alarm to land at exactly 09:00"; it is "a periodic heartbeat (plus every
// worker wake, plus a punctual alarm for on-time firing) keeps asking the pure
// scheduledDue() check, which fires the moment the wall clock is at or past
// today's time and today hasn't run yet." Delivery reliability stops mattering
// — the wall clock is the source of truth, and a missed heartbeat only delays
// the round to the next tick, never loses the day.
//
// ensureScheduledRun() is idempotent on every worker wake and every settings
// change: it clears both alarms when the toggle is off, creates the heartbeat
// when missing, and re-targets the punctual alarm only when the user moved the
// time. The toggle is OFF by default — a routine that starts itself at nine
// sharp must be opted into, never a fresh-install surprise.

import { getSettings } from '../../shared/settings.ts'
import { readRunState } from '../core/run-state.ts'
import { setLastTabAction } from '../core/log.ts'
import { scheduledDue, nextScheduledAt } from '../pure/schedule.ts'
import { runStartupSequence } from './routine.ts'
import { getLocal, setLocal, KEYS } from '../../shared/storage.ts'
import { inQuietHours } from '../pure/run-tools.ts'
import { localDayKey } from '../core/day.ts'

// The punctual alarm: a one-shot at the next occurrence, so an idle-but-awake
// worker fires ON the minute instead of waiting for the next heartbeat tick.
export const SCHEDULED_ALARM = 'scheduledRun'
// The reliability net: a periodic alarm that keeps waking the worker to re-ask
// scheduledDue(). This is what makes "left it for a day" work — no single
// delivery has to land at the right instant.
export const SCHEDULED_HEARTBEAT = 'scheduledHeartbeat'
export const POSTPONED_ALARM = 'postponedRoutine'
export interface PostponedRoutine { day: string; until: number; source?: 'user' | 'startup' }

export async function postponeRoutine(minutes: number): Promise<void> {
  const duration = Math.max(5, Math.min(24 * 60, Math.floor(Number(minutes) || 60)))
  const until = Date.now() + duration * 60_000
  await setLocal(KEYS.postponedRoutine, { day: localDayKey(), until, source: 'user' })
  await chrome.alarms.create(POSTPONED_ALARM, { when: until })
  await setLastTabAction(`Routine postponed for ${duration} minutes`, true)
}

export async function cancelPostpone(): Promise<void> {
  await chrome.storage.local.remove(KEYS.postponedRoutine)
  await chrome.alarms.clear(POSTPONED_ALARM)
}

let postponedRunning = false
export async function runPostponedIfDue(): Promise<void> {
  if (postponedRunning) return
  postponedRunning = true
  try { await runPostponedOwned() } finally { postponedRunning = false }
}

async function runPostponedOwned(): Promise<void> {
  const deferred = await getLocal<PostponedRoutine>(KEYS.postponedRoutine)
  if (!deferred || !Number.isFinite(deferred.until)) return
  if (deferred.until > Date.now()) {
    await chrome.alarms.create(POSTPONED_ALARM, { when: deferred.until })
    return
  }
  const settings = await getSettings()
  if (deferred.source === 'startup' && !settings.startupEnabled) { await cancelPostpone(); return }
  const state = await readRunState()
  if (inQuietHours(settings) || state.batch || state.routine || state.activity) {
    await chrome.alarms.create(POSTPONED_ALARM, { delayInMinutes: 5 })
    return
  }
  const outcome = await runStartupSequence({ scheduled: true })
  const current = await getLocal<PostponedRoutine>(KEYS.postponedRoutine)
  if (current?.until !== deferred.until) return
  if (outcome === 'ran' || outcome === 'already-today') await cancelPostpone()
  else await chrome.alarms.create(POSTPONED_ALARM, { delayInMinutes: 5 })
}
// Every 5 minutes. Fine enough that a scheduled round starts within ~5 min of
// its time in the worst case (worker was evicted, no punctual delivery), cheap
// enough to be invisible. MV3's alarm floor is 30s; this is well clear of it.
const HEARTBEAT_PERIOD_MINUTES = 5
// A standing punctual alarm within this of the freshly computed target is
// considered on-target — sub-minute jitter in the wake-time computation must
// not churn the alarm on every worker wake.
const RETARGET_TOLERANCE_MS = 60000

// A synchronous re-entrancy guard. The punctual alarm and a heartbeat tick can
// both pass the due-check in the same instant (both wake the worker, both read
// the same not-yet-handled day before either writes it). This closes that race
// WITHOUT a storage round-trip: it flips before the first `await`, so the
// second caller sees it set and bails. Module-level = one worker, one guard.
let scheduledRunning = false

// Idempotent arming — safe (and intended) to call on every worker wake and on
// every settings change.
export async function ensureScheduledRun(): Promise<void> {
  const settings = await getSettings()
  const punctual = await chrome.alarms.get(SCHEDULED_ALARM)
  const heartbeat = await chrome.alarms.get(SCHEDULED_HEARTBEAT)

  if (!settings.scheduledRunEnabled) {
    if (punctual) await chrome.alarms.clear(SCHEDULED_ALARM)
    if (heartbeat) await chrome.alarms.clear(SCHEDULED_HEARTBEAT)
    return
  }

  // The heartbeat runs whenever the schedule is on, regardless of the time
  // parsing — it is the net that re-asks the due-check. Create it only when
  // missing so an in-flight period isn't reset on every wake.
  if (!heartbeat) {
    chrome.alarms.create(SCHEDULED_HEARTBEAT, {
      periodInMinutes: HEARTBEAT_PERIOD_MINUTES,
      // First tick one period out; the wake-path due-check below already
      // covers "due right now", so the heartbeat needn't fire immediately.
      delayInMinutes: HEARTBEAT_PERIOD_MINUTES,
    })
  }

  const at = nextScheduledAt(settings.scheduledRunTime)
  if (at == null) {
    // An unparsable time is a broken clock: the heartbeat stays (harmless —
    // scheduledDue returns bad-time), but no punctual alarm points at nonsense.
    if (punctual) await chrome.alarms.clear(SCHEDULED_ALARM)
    return
  }
  if (!punctual || Math.abs(punctual.scheduledTime - at) > RETARGET_TOLERANCE_MS) {
    chrome.alarms.create(SCHEDULED_ALARM, { when: at })
  }
}

// The single funnel every trigger flows through — the punctual alarm, each
// heartbeat tick, and every worker wake. The pure scheduledDue() check decides;
// this only handles the effects (busy-guard, the once-a-day latch, the visible
// notes) and the re-entrancy race. `source` shapes only which skips are worth
// a log row — the decision itself is identical for all three.
export async function runScheduledIfDue(source: 'punctual' | 'heartbeat' | 'wake'): Promise<void> {
  const settings = await getSettings()
  if (inQuietHours(settings)) return
  const postponed = await getLocal<PostponedRoutine>(KEYS.postponedRoutine)
  if (postponed && postponed.until > Date.now()) return
  const decision = scheduledDue({
    enabled: settings.scheduledRunEnabled,
    scheduledTime: settings.scheduledRunTime,
    lastHandledDay: (await getLocal<string>(KEYS.lastScheduledDay)) ?? null,
    now: new Date(),
  })

  if (!decision.due) {
    // The punctual alarm firing onto an already-handled day is the ordinary
    // "the heartbeat or a wake already ran it" case — worth ONE visible row so
    // the user sees the schedule is alive, but only from the punctual source
    // (a heartbeat/wake saying it every 5 minutes would be log spam).
    if (decision.reason === 'done-today' && source === 'punctual') {
      await setLastTabAction('Scheduled — the routine already ran today, skipped', true)
    }
    return
  }

  // Re-entrancy: flip the guard BEFORE the first await after the decision, so a
  // second trigger racing this same instant sees it and bails. Everything past
  // here runs exactly once for the day.
  if (scheduledRunning) return
  scheduledRunning = true
  try {
    const state = await readRunState()
    const busy = state.batch != null || state.routine != null || state.activity != null
    if (busy) {
      // Do NOT latch the day: a round that couldn't start because something
      // else was running should be retried by the next heartbeat, not lost.
      await setLastTabAction('Scheduled — something else was running, will retry shortly', true)
      return
    }

    // Latch the day BEFORE running: if the routine below crashes, the day must
    // not re-fire on the next heartbeat — a visible failure is recoverable, a
    // twice-run routine is not. (The busy path above deliberately does NOT
    // reach this line, so it stays retryable.)
    await setLocal(KEYS.lastScheduledDay, decision.day)

    // The once-per-day gate lives inside runStartupSequence, applied exactly as
    // a browser start applies it; the 15s confirm window deliberately does NOT
    // apply here — a time the user set IS the intent, and an unattended window
    // would auto-cancel every scheduled round (2026-09-12: the schedule
    // silently never ran with the confirm default-on).
    await setLastTabAction(`Scheduled — starting the routine (${settings.scheduledRunTime})`, true)
    await runStartupSequence({ scheduled: true })
  } finally {
    scheduledRunning = false
  }
}
