// The worker entry point — listeners and message routing, nothing else.
// Every piece of behavior lives in a module with one job:
//
//   core/run-state.ts    the one-document run state (stop, batch, routine)
//   core/tabs.ts         tab capture, reuse, close, and the clear sweep
//   core/{keepalive,alarms}.ts   the MV3 worker-lifecycle machinery
//   pure/*               the verdicts, imported directly by their drivers
//   queries/*            the query sources and the prefetched chain
//   routine/search.ts    the search batch + verification loop
//   routine/routine.ts   the startup sequence and its tail
//   readers/*            the dashboard reads (stats, redeem, coupons, claim)
//   injections/*         the page-side halves, ported verbatim from src-donut/src-froyo
//   images/*             the random-image visual search
//
// Bundled by Vite into dist/ as a module service worker; build.target is set
// high enough that esbuild emits no runtime helpers, so the executeScript
// func-injections stay self-contained and serializable.
//
// Phase 1 scope: the restock-watcher alarm — and its syncs and messages
// (SET_RESTOCK_WATCH) — stays deferred (src-donut never had it either), so this
// entry point carries the search alarm, the prowl alarm (the random
// mini-batches inside the user's interval window), the scheduled-run alarm
// (the routine once a day at the user-specified time), the redeem/coupons
// runs, and the core loop's messages.

import { stopAllActivity, readRunState } from './core/run-state.ts'
import { DEFAULT_SETTINGS } from '../shared/settings.ts'
import type { Settings } from '../shared/settings.ts'
import { cancelBeats, SEARCH_ALARM } from './core/alarms.ts'
import { recordOpenedTab, clearAllTabs } from './core/tabs.ts'
import { setLastTabAction } from './core/log.ts'
import { tick, startSearchBatch, resumeSearchBatch } from './routine/search.ts'
import { ensureProwlScheduled, prowlFire, PROWL_ALARM } from './routine/prowl.ts'
import {
  ensureScheduledRun,
  runScheduledIfDue,
  SCHEDULED_ALARM,
  SCHEDULED_HEARTBEAT,
} from './routine/scheduled.ts'
import {
  runStartupSequence,
  answerRoutineConfirm,
  routineConfirmWindowRemoved,
  resumeRoutineRecovery,
  ROUTINE_RECOVERY_ALARM,
  routineSummaryQuery,
  routineSkippedQuery,
} from './routine/routine.ts'
import { refreshStats } from './readers/stats.ts'
import { checkRedeemAvailability, redeemOverwatchCoins } from './readers/redeem.ts'
import { syncOrders, closeOrphanedOrdersWindow } from './readers/orders.ts'
import { claimCoupons } from './readers/coupons.ts'
import { requestPause, resumeActivity, previewRemaining, runRemaining } from './routine/controls.ts'
import { cancelActiveRun, reconcileRunRecord } from './core/run-history.ts'
import { ensureRestockScheduled, restockFire, RESTOCK_ALARM } from './routine/restock.ts'
import { postponeRoutine, cancelPostpone, runPostponedIfDue, POSTPONED_ALARM } from './routine/scheduled.ts'
import { runManualClaim } from './readers/claim.ts'
import { probeRewardsApi } from './readers/api-probe.ts'
import { openDailySetOnRewardsDashboard, openKeepEarningActivities } from './readers/rewards-section.ts'
import { runRandomImageSearch } from './images/image-search.ts'
import { KEYS, removeLocal } from '../shared/storage.ts'
import type { Message, MessageResponse } from '../shared/messages.ts'
import { createTaskAdmission } from './core/task-admission.ts'
import { withActivityLock } from '../shared/activity-lock.ts'
import { ensureRecoveryWatchdogs } from './core/recovery-watchdogs.ts'

// Install/update: seed the settings defaults (a stored settings blob wins,
// key by key) and clear anything run-shaped the previous version left —
// which is the whole run-state document, in ONE remove. Nothing that must
// survive (lastRoutineDay, the log rows, the query history) lives in it.
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get('settings')
  const stored = (existing.settings as Partial<Settings>) || {}
  await chrome.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, ...stored } })
  await removeLocal(KEYS.runState)
  await ensureProwlScheduled()
  await ensureScheduledRun()
  await ensureRestockScheduled()
})

// The startup sequence: whatever order settings.startupOrder holds.
chrome.runtime.onStartup.addListener(async () => {
  await wakeWork
  await withActivityLock(() => runStartupSequence())
})

// The prowl's arming, on every worker wake: idempotent (only creates the
// alarm when it's missing — never resets an in-flight wait), and clears it
// when the toggle is off. Alarms persist across evictions and browser
// restarts on their own; this is the backstop for "it was never armed".
ensureProwlScheduled().catch((e) => console.warn('Prowl arming failed:', e))
ensureRestockScheduled().catch((e) => console.warn('Restock arming failed:', e))

// Same wake-up arming for the scheduled run, then an immediate due-check.
// ensureScheduledRun is idempotent (creates the periodic heartbeat when
// missing, re-targets the punctual alarm only when the user moved the time,
// clears both when the toggle is off). runScheduledIfDue('wake') then pays a
// round that is already due at this instant — which is how "the browser was
// closed at 09:00, opened at 10:00" runs the day WITHOUT depending on a
// past-due alarm ever being delivered (user report 2026-09-15/2026-09-22).
// The heartbeat re-asks the same check every few minutes as the reliability
// net; this wake-path call just makes it prompt on reopen.
const wakeWork = ensureScheduledRun()
  .then(async () => {
    await ensureRecoveryWatchdogs(await readRunState(), { search: SEARCH_ALARM, routine: ROUTINE_RECOVERY_ALARM })
    return withActivityLock(async () => {
    await reconcileRunRecord(await readRunState())
    await runPostponedIfDue()
    await runScheduledIfDue('wake')
    await resumeSearchBatch()
    await resumeRoutineRecovery()
    })
  })
  .catch((e) => console.warn('Scheduled-run wake check failed:', e))

// Same wake-up hygiene for the orders sync's window: a run that died with
// the previous worker (a reload mid-rescan) leaves its window behind —
// close it the moment the worker comes back, before the user ever has to
// press anything (user report, 2026-09-10: two windows, neither doing
// anything).
closeOrphanedOrdersWindow().catch((e) => console.warn('Orphan orders-window sweep failed:', e))

// The prowl's and the scheduled run's toggles live in the settings blob, so
// the worker learns of them through storage events, not a message: arming,
// clearing, or re-targeting the alarms is the same idempotent call as above.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    ensureProwlScheduled().catch((e) => console.warn('Prowl arming failed:', e))
    ensureScheduledRun().catch((e) => console.warn('Scheduled-run arming failed:', e))
    ensureRestockScheduled().catch((e) => console.warn('Restock arming failed:', e))
  }
})

// Revive an interrupted batch (also fires on the normal schedule). The
// restock watcher (Phase 2) will ride the same event with its own alarm name.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESTOCK_ALARM) withActivityLock(() => restockFire()).catch(e => console.warn('Restock watch failed:', e))
  if (alarm.name === POSTPONED_ALARM) withActivityLock(() => runPostponedIfDue()).catch(async e => {
    console.warn('Postponed routine deferred:', e)
    await chrome.alarms.create(POSTPONED_ALARM, { delayInMinutes: 5 })
  })
  if (alarm.name === SEARCH_ALARM) {
    withActivityLock(() => tick()).catch((e) => console.warn('Search watchdog failed:', e))
  }
  if (alarm.name === ROUTINE_RECOVERY_ALARM) {
    withActivityLock(() => resumeRoutineRecovery()).catch((e) => console.warn('Routine recovery failed:', e))
  }
  if (alarm.name === PROWL_ALARM) {
    withActivityLock(() => prowlFire()).catch(async e => {
      console.warn('Prowl deferred:', e)
      await ensureProwlScheduled()
    })
  }
  // The punctual one-shot and the periodic heartbeat both funnel through the
  // same due-check; the punctual source gets the "already ran today" note, the
  // heartbeat stays quiet. Re-arm AFTER the check (not before): a run latches
  // today, so ensureScheduledRun then re-points the just-consumed punctual
  // one-shot at TOMORROW's occurrence — and re-creates it even on a no-op tick,
  // keeping the alarm self-healing.
  if (alarm.name === SCHEDULED_ALARM || alarm.name === SCHEDULED_HEARTBEAT) {
    withActivityLock(() => runScheduledIfDue(alarm.name === SCHEDULED_ALARM ? 'punctual' : 'heartbeat'))
      .then(() => ensureScheduledRun())
      .catch((e) => console.warn('Scheduled run failed:', e))
  }
})

// Tab capture: tabs opened while a step is capturing belong to that step.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab && tab.id != null) {
    recordOpenedTab(tab).catch((e) => console.warn('Tab capture failed:', e))
  }
})

// The routine's confirm dialog closing without an answer. The buttons resolve
// through handleMessage below; this is the other way the prompt can end.
// Guarded like the prompt itself — a Chrome without the windows API must still
// run.
chrome.windows.onRemoved.addListener(routineConfirmWindowRemoved)

// Persisted work can outlive a worker. Re-arm its watchdog on any wake,
// including when an alarm was lost across a full browser restart.

// ---------- Message routing ----------
//
// The popup's buttons. The contract is the discriminated union in
// shared/messages.ts, so this switch is exhaustively checkable and the popup
// cannot send a typo. Every handler is one call into a module — this
// function's only job is dispatch.

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e instanceof Error ? e.message : e) }))
  return true // the reply is async
})

const launchExclusive = createTaskAdmission(readRunState, error =>
  setLastTabAction(`Task stopped: ${error instanceof Error ? error.message : String(error)}`, false), withActivityLock)

async function handleMessage(message: Message): Promise<MessageResponse> {
  switch (message.type) {
    case 'START_SEARCH_BATCH':
      return launchExclusive(() => startSearchBatch())
    case 'RUN_DAILY_SET':
      // Long-running; don't hold the popup's callback open for it.
      return launchExclusive(() => openDailySetOnRewardsDashboard())
    case 'RUN_FULL_ROUTINE':
      // The Run view's big button (ADR-020): the whole startup sequence on
      // demand, with the master-switch and once-per-day launch gates opted
      // out — the press IS the permission to run. The confirm dialog still
      // asks when 'Ask before running' is on (user request, 2026-09-07).
      // Long-running like the daily set: fire-and-forget, the status pill
      // and the Activity rows report as it goes.
      return launchExclusive(() => runStartupSequence({ manual: true }))
    case 'RUN_KEEP_EARNING':
      return launchExclusive(() => openKeepEarningActivities())
    case 'RUN_CLAIM':
      // Long-running; don't hold the popup's callback open for it.
      return launchExclusive(() => runManualClaim())
    case 'REFRESH_STATS':
      // Fire-and-forget: worst case the read waits out a slow dashboard for
      // ~30s, longer than the popup's response channel should be held open.
      // The popup learns the outcome from lastStats instead.
      return launchExclusive(() => refreshStats())
    case 'REFRESH_REDEEM':
      // Same fire-and-forget reasoning as REFRESH_STATS: three page loads and
      // hydration waits, ~45s — the popup's Redeem view learns the outcome
      // from lastRedeem and lastRedeemLog.
      return launchExclusive(() => checkRedeemAvailability())
    case 'SYNC_ORDERS':
      // The dashboard's Orders panel. Fire-and-forget: a page load plus the
      // detail dialogs of every order that isn't stored yet (forceAll:
      // every order, the Rescan-all button) — the panel learns the outcome
      // from lastOrders and lastOrdersLog.
      return launchExclusive(() => syncOrders(message.forceAll ? { forceAll: true } : {}))
    case 'REDEEM_OVERWATCH':
      // The Redeem view's button. Fire-and-forget: the outcome is the page
      // itself (opened in the foreground, pressed only when enabled) plus the
      // lastRedeemLog row — and a foreground tab's lifetime is not something
      // the popup's response channel should wait on.
      return launchExclusive(() => redeemOverwatchCoins(message.url, message.label))
    case 'OPEN_REDEEM_PAGE': {
      // The dashboard coin card's press (user request 2026-09-09): navigate
      // to that amount's redeem page — and ONLY navigate. The Redeem Now
      // press stays on the page, a deliberate act (unlike REDEEM_OVERWATCH,
      // which is the Redeem view's explicit "redeem" button). The reader
      // stores sku hrefs relative ("/redeem/sku/…"), so resolve against the
      // Rewards origin — same new URL(url, base) idiom as the redeem watch —
      // instead of requiring https:// outright (the first cut did, and
      // silently did nothing on live data; user report 2026-09-09).
      let target = ''
      try {
        target = new URL(String(message.url || ''), 'https://rewards.bing.com/').toString()
      } catch {
        target = ''
      }
      if (target.startsWith('https://')) {
        chrome.tabs.create({ url: target, pinned: false, active: true })
        return { ok: true }
      }
      return { ok: false, error: 'No page to open.' }
    }
    case 'CLAIM_COUPONS':
      // The Run view's Coupons button (experimental). Fire-and-forget: the
      // outcome lands in lastCoupons and the page's own panel, which the user
      // is looking at.
      return launchExclusive(() => claimCoupons())
    case 'OPEN_DASHBOARD':
      // The topbar's full-screen analytics button: one foreground tab, nothing
      // to wait on. The page reads its data from storage on open.
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html'), active: true })
      return { ok: true }
    case 'RUN_IMAGE_SEARCH':
      return launchExclusive(() => runRandomImageSearch())
    case 'PAUSE_ACTIVITY':
      await requestPause()
      await chrome.alarms.clear(ROUTINE_RECOVERY_ALARM)
      return { ok: true }
    case 'RESUME_ACTIVITY':
      if ((await readRunState()).pause?.effectiveAt) {
        void withActivityLock(() => resumeActivity()).catch(e => setLastTabAction(`Resume failed: ${String(e)}`, false))
      } else await resumeActivity()
      return { ok: true }
    case 'PREVIEW_REMAINING':
      return withActivityLock(async () => ({ ok: true, ...(await previewRemaining()) }))
    case 'RUN_REMAINING':
      return launchExclusive(() => runRemaining(message.steps))
    case 'POSTPONE_ROUTINE':
      await postponeRoutine(message.minutes)
      return { ok: true }
    case 'CANCEL_POSTPONE':
      await cancelPostpone()
      return { ok: true }
    case 'STOP_BATCH':
      // Cancel the schedule first so no late beat races the stop write; the
      // write then takes down the batch, the routine, the verification loop,
      // and the capture bookkeeping together. Stopping is not finishing: the
      // tabs stay open, and lastRoutineDay is never written by a stop.
      cancelBeats()
      answerRoutineConfirm(false)
      const stoppedHistoryId = (await readRunState()).routine?.historyId
      await stopAllActivity()
      void cancelActiveRun(stoppedHistoryId)
      await chrome.alarms.clear(ROUTINE_RECOVERY_ALARM)
      return { ok: true }
    case 'OPEN_ROUTINE_DONE': {
      // Developer Option: the popup's finish-screen opener — the same
      // dashboard overlay the genuine endRoutine call opens, with the same
      // summary, so the preview is the real thing. The extra dev=1 flag turns
      // on the overlay's own preview chip; endRoutine never sets it, so a real
      // finish still opens the honest screen. Fire-and-forget: the outcome is
      // the overlay itself.
      try {
        const summary = await routineSummaryQuery()
        // Whatever skip list is still stored joins the preview (a finished
        // routine's list was consumed by its own endRoutine — usually empty
        // here, and honest when it isn't).
        const state = await readRunState()
        const params = new URLSearchParams({ dev: '1' })
        if (summary) params.set('q', summary)
        const skippedQuery = routineSkippedQuery(state.routine ? state.routine.skipped : [])
        if (skippedQuery) params.set('s', skippedQuery)
        await chrome.tabs.create({ url: `dashboard.html?${params.toString()}`, active: true })
      } catch (e) {
        console.warn('Could not open the finish screen:', e)
      }
      return { ok: true }
    }
    case 'CLEAR_ALL_TABS':
      // ClearResult is a subset of MessageResponse (ok + closed/kept). Spread
      // into a fresh literal so it satisfies the response's index signature.
      return { ...(await clearAllTabs(message.windowId)) }
    case 'RESET_ROUTINE_DAY':
      // Developer Option: clears the once-per-day done-mark, so the next
      // browser launch runs the startup routine again, as if it had never run
      // today. Only the done-mark goes: a routine running right now is not this
      // button's business (its own endRoutine re-marks its day when it
      // finishes — it did run).
      await removeLocal(KEYS.lastRoutineDay)
      await setLastTabAction('Dev — routine will run on the next browser start', true)
      return { ok: true }
    case 'PROBE_REWARDS_API':
      // Developer Option: the one-shot Rewards-API probe (readers/api-probe)
      // — fetches the JSON endpoint the dashboard itself loads and logs the
      // shape + full response to the worker console. Fire-and-forget like
      // REFRESH_STATS: the Activity row carries the headline.
      probeRewardsApi()
      return { ok: true }
    case 'RELOAD_EXTENSION': {
      // The Restart control (6.9.8), shown on the popup's banner area and on
      // the routine's finish screen only while an update is waiting on disk.
      // The one-click updater writes the new files but cannot make Chrome load
      // them — it holds the extension in memory and never re-reads the folder,
      // and no API outside the extension can press Reload. This is the press.
      //
      // The response is sent FIRST: reload() tears the worker down, so a reply
      // queued after it would never leave, and the caller would see a dead
      // channel instead of an acknowledgement. Nothing waits on the answer —
      // the popup closes itself on reload — but sending a shaped failure is
      // worse than sending nothing.
      setTimeout(() => chrome.runtime.reload(), 0)
      return { ok: true }
    }
    case 'routineConfirmAnswer':
      // The routine's confirm dialog reporting its buttons.
      answerRoutineConfirm(message.proceed)
      return { ok: true }
    default:
      // Exhaustive: `message` is `never` here if every variant is handled.
      return { ok: false, error: 'unknown message type' }
  }
}
