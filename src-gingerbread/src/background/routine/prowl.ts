// The prowl loop (user request, 2026-09-09): at a random moment inside the
// user's time window (default 15–45 minutes), run 2–5 background searches —
// on all the time while the browser runs, off only via the Settings toggle.
//
// Alarm-driven, not setTimeout-driven: the MV3 worker is evicted between
// events, so a timer variable would die with it. chrome.alarms persist across
// evictions AND browser restarts, so the prowl survives without re-arming on
// every wake — ensureProwlScheduled() only creates the alarm when it doesn't
// exist (arming on every worker start would push the next prowl out forever,
// since the worker wakes constantly for unrelated tab events).
//
// Every fire draws a FRESH random delay for the round after it, whether it ran
// searches, skipped (something else is running), or found the day's search
// points already done — the loop never stops while the toggle is on.

import { getSettings } from '../../shared/settings.ts'
import { readRunState } from '../core/run-state.ts'
import { setLastTabAction } from '../core/log.ts'
import { KEYS, getLocal } from '../../shared/storage.ts'
import type { Stats } from '../../shared/storage.ts'
import { progressPair, statsAreCurrent } from '../pure/verdicts.ts'
import { prowlDelayMs, prowlSearchCount, prowlWindowMs } from '../pure/prowl.ts'
import { startSearchBatch } from './search.ts'
import { inQuietHours } from '../pure/run-tools.ts'

export const PROWL_ALARM = 'prowlTick'

async function drawAndArm(): Promise<void> {
  const settings = await getSettings()
  const window = prowlWindowMs(settings.prowlMinIntervalMin, settings.prowlMaxIntervalMin)
  chrome.alarms.create(PROWL_ALARM, { delayInMinutes: prowlDelayMs(undefined, window) / 60000 })
}

// Idempotent arming — safe (and intended) to call on every worker wake and on
// every settings change: it clears the alarm when the toggle is off and
// creates it only when it's missing, never resetting an in-flight wait.
// A settings change re-arms ONLY when the existing wait would land outside
// the new window — a user narrowing the range wants the next prowl sooner, a
// user widening it keeps the wait they already have.
export async function ensureProwlScheduled(): Promise<void> {
  const settings = await getSettings()
  const existing = await chrome.alarms.get(PROWL_ALARM)
  if (!settings.randomSearchEnabled) {
    if (existing) await chrome.alarms.clear(PROWL_ALARM)
    return
  }
  if (!existing) {
    await drawAndArm()
    return
  }
  // The window moved: keep the wait only if it still lands inside it.
  const [lo, hi] = prowlWindowMs(settings.prowlMinIntervalMin, settings.prowlMaxIntervalMin)
  const waitMs = existing.scheduledTime - Date.now()
  if (waitMs < lo - 5000 || waitMs > hi + 5000) {
    await drawAndArm()
  }
}

// The alarm's fire: run a mini batch if there's room to, then always arm the
// next round. Guarded on every side — the toggle, a busy run state, and the
// day's search cap — because nobody is watching this run.
export async function prowlFire(): Promise<void> {
  const settings = await getSettings()
  // The toggle-off path clears the alarm too; this is the belt to that
  // suspenders, for the race where the toggle landed after the alarm fired.
  if (!settings.randomSearchEnabled) return
  if (inQuietHours(settings)) { await drawAndArm(); return }

  const state = await readRunState()
  const busy = state.batch != null || state.routine != null || state.activity != null
  if (!busy) {
    // A fresh read showing the day's search points already done means this
    // round has nothing to earn — and startSearchBatch's right-sizing would
    // happily run the full count past a met cap, so the check lives here.
    const stats = await getLocal<Stats>(KEYS.lastStats)
    const pair = statsAreCurrent(stats) ? progressPair(stats?.searchPoints) : null
    if (!pair || pair[1] - pair[0] > 0) {
      const count = prowlSearchCount()
      await setLastTabAction(`Prowl — ${count} background search${count === 1 ? '' : 'es'}`, true)
      await startSearchBatch({ count, prowl: true })
    } else {
      await setLastTabAction('Prowl — today’s searches are already done, skipped', true)
    }
  }

  await drawAndArm()
}
