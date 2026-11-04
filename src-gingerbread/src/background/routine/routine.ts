// The startup routine: the ordered step sequence, its skip-when-done
// verdicts, the post-search tail, and the end-of-routine sweep. The
// routine's own state (start day, pending tail, stashed tabs, skip list) is
// one field of the run-state document rather than four storage keys — a stop
// clears all of it in the single stop write, and endRoutine consumes it
// atomically via consumeRoutine().

import { localDayKey } from '../core/day.ts'
import { getSettings } from '../../shared/settings.ts'
import type { Settings, StepId } from '../../shared/settings.ts'
import { readRunState, updateRunState, currentStopEpoch, consumeRoutine, pauseBoundary, reserveRecoveryActions } from '../core/run-state.ts'
import { holdKeepAlive, releaseKeepAlive } from '../core/keepalive.ts'
import { sleep } from '../core/delays.ts'
import { closeTabs, closeOtherDashboardTabs, closeBingRewardsTabs } from '../core/tabs.ts'
import { setLastTabAction, setLastRewards, reportImageSearch } from '../core/log.ts'
import { KEYS, getLocal, setLocal } from '../../shared/storage.ts'
import type { Activities, SkippedStep, Stats } from '../../shared/storage.ts'
import { slotMissingDefaults } from '../pure/orders.ts'
import { STEP_DONE_CHECKS, statsAreCurrent, stepSkipReason } from '../pure/verdicts.ts'
import { planRoutineRecovery } from '../pure/routine-recovery.ts'
import { refreshStats } from './reads.ts'
import { invalidateStatsEvidence } from '../readers/stats.ts'
import { startRunRecord, recordRunEvent, finishRunRecord } from '../core/run-history.ts'
import { inQuietHours, quietHoursEndAt } from '../pure/run-tools.ts'
import { remainingSteps } from '../pure/remaining.ts'
import { startSearchBatch } from './search.ts'
import { runStartupClaim } from '../readers/claim.ts'
import { openDailySetOnRewardsDashboard, openKeepEarningActivities } from '../readers/rewards-section.ts'
import { runRandomImageSearch } from '../images/image-search.ts'

// How long the routine's cancel-before-start dialog waits for an answer
// before silence counts as consent.
const ROUTINE_CONFIRM_TIMEOUT_MS = 15000
// The routine's finish screen (6.8.0): the DASHBOARD, opened with the streak
// summary in the ?q= query — the finish overlay covers the board until the
// user presses Done (which blurs out to it), instead of a blank tab or a
// page of its own.
const FINISH_URL = 'dashboard.html'
// The finish-page settle: after the last routine step, wait this long, then
// re-read stats before building the summary — see endRoutine.
const ROUTINE_FINISH_SETTLE_MS = 3000
export const ROUTINE_RECOVERY_ALARM = 'routineRecovery'
const ORIGINAL_STEP_LEASE_MS = 3 * 60_000

// ---------- The step registry ----------

interface StartupStep {
  enabledKey: keyof Settings
  run: () => Promise<void>
}

// The startup steps, keyed by the ids stored in settings.startupOrder. The
// popup mirrors these ids in each step row.
const STARTUP_STEPS: Record<StepId, StartupStep> = {
  // First key on purpose: normalizeStartupOrder() slots a step missing from a
  // saved order at its default index, so existing users get the stats read
  // slotted first, matching the new default order — it must reflect the day
  // before the steps churn the dashboard.
  stats: {
    enabledKey: 'statsStartupEnabled',
    run: () => runStartupReads(),
  },
  claim: {
    enabledKey: 'claimStartupEnabled',
    run: () => runStartupClaim(),
  },
  dailySet: {
    enabledKey: 'dailySetStartupEnabled',
    run: () => openDailySetOnRewardsDashboard(),
  },
  keepEarning: {
    enabledKey: 'keepEarningStartupEnabled',
    run: () => openKeepEarningActivities(),
  },
  search: {
    enabledKey: 'searchStartupEnabled',
    run: () => startSearchBatch(),
  },
  imageSearch: {
    enabledKey: 'imageSearchStartupEnabled',
    run: () => runRandomImageSearch(),
  },
}

export const DEFAULT_STARTUP_ORDER = Object.keys(STARTUP_STEPS) as StepId[]

// Tolerates a stale or hand-edited value: unknown ids and duplicates go, and
// anything missing is slotted into its default position. Mirrored in the popup.
export function normalizeStartupOrder(order: StepId[] | null | undefined): StepId[] {
  return slotMissingDefaults(order, DEFAULT_STARTUP_ORDER)
}

// The routine's opening reads, as one step: the Rewards stats (dashboard +
// Earn pages, merged), then the redeem watch — src-donut's second half. Both are
// convenience reads that never throw, so the watch cannot fail the step the
// stats read just passed. As a step it can be turned off (statsStartupEnabled)
// and dragged around like any other; the default order keeps it first so the
// numbers still reflect the day before the steps churn the dashboard.
async function runStartupReads(): Promise<void> {
  await refreshStats()
}

// ---------- Skip-when-done ----------

// The routine's skip verdict for a step: a reason string when today's read
// already shows it done, null when it should run. The verdicts themselves
// are pure (pure/verdicts.ts); this adds the one effect they refuse to have
// — reading today's stats.
async function routineStepSkipped(id: StepId): Promise<string | null> {
  if (!STEP_DONE_CHECKS[id]) return null

  const stats = await getLocal<Stats>(KEYS.lastStats)
  if (!statsAreCurrent(stats)) return null

  // statsAreCurrent guarantees stats is present and today's; the cast is that
  // guarantee expressed to the type system (it is not a type predicate).
  return stepSkipReason(id, stats as Stats)
}

// A skipped step says so in the Activity section, in its own row where it
// has one. The search step owns no row (its rows show the last query, which
// a skip must not fabricate), so its note lands in the Tabs row — the
// routine's news row, which already carries the end-of-routine sweep line.
async function reportSkippedStep(id: StepId, reason: string): Promise<void> {
  const labels: Partial<Record<StepId, string>> = {
    search: 'Search',
    claim: 'Claim',
    dailySet: 'Daily set',
    keepEarning: 'Keep earning',
    imageSearch: 'Image search',
  }
  const detail = `${labels[id] || id} — skipped, ${reason}`
  if (id === 'claim' || id === 'dailySet' || id === 'keepEarning') {
    await setLastRewards(detail, null)
  } else if (id === 'imageSearch') {
    await reportImageSearch(`skipped, ${reason}`, null)
  } else {
    await setLastTabAction(detail, null)
  }
  // The finish page names what was skipped: the record rides in the run-state
  // document because the post-search tail finishes in a later worker
  // instance, and endRoutine() consumes it when the page opens.
  await updateRunState((state) => {
    if (state.routine) state.routine.skipped.push({ id, reason })
  })
  await recordRunEvent((await readRunState()).routine?.historyId, id, 'skipped', reason)
}

// ---------- The confirm dialog ----------

// Resolver of the routine's cancel-before-start dialog: the answer message
// and the awaiting confirmRoutineStart() are separate functions, so the live
// prompt's outcome crosses through here. Null while no prompt is waiting —
// which is what makes a stale click after the timeout a no-op.
let routineConfirmResolver: ((proceed: boolean) => void) | null = null
// Tab id of that prompt, so windows.onRemoved (wired in the background) can
// distinguish a dismissed confirmation from unrelated tab closures.
let routineConfirmWindowId: number | null = null

// The routine's cancel-before-start dialog. Resolves true when the routine
// may run ('Start now', the timeout, or no tabs API to ask with) and
// false when the user cancelled. The wait lives inside the async onStartup
// handler, within the worker's 30s idle window — same pattern as the
// grace-period sleeps in closeCapturedTabs().
export function confirmRoutineStart(): Promise<boolean> {
  // Very old Chrome: no API to ask with, so the routine is never blocked on it.
  if (!(chrome.windows && chrome.windows.create)) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let settled = false

    const settle = (proceed: boolean): void => {
      if (settled) return
      settled = true
      routineConfirmResolver = null
      // Taking the dialog down fires onRemoved too; the nulled resolver above
      // is what makes that a no-op. The remove() itself can reject if the
      // window is already gone — fine either way.
      if (routineConfirmWindowId != null) {
        chrome.windows.remove(routineConfirmWindowId).catch(() => {})
        routineConfirmWindowId = null
      }
      resolve(proceed)
    }

    // Handed to the answer message and the onRemoved listener; nulled by
    // settle() after use, so a click arriving after the outcome is a no-op.
    routineConfirmResolver = settle

    // The 15s window: silence means the user is away, and this is an
    // automator — proceed rather than dropping the routine on the floor.
    setTimeout(() => settle(true), ROUTINE_CONFIRM_TIMEOUT_MS)

    chrome.windows
      .create({
        url: chrome.runtime.getURL('confirm.html'),
        // Select the normal tab inside Brave without bringing its OS window
        // to the foreground or creating a separate taskbar item.
        type: 'popup',
        width: 510,
        height: 350,
        focused: true,
      })
      .then((win) => {
        // The prompt never went up — the routine must not hang waiting on an
        // answer nobody can give.
        if (!win) {
          console.warn('Startup: confirm dialog could not be shown.')
          settle(true)
          return
        }
        // A fast answer/timeout may have settled while window creation waited.
        if (settled) {
          if (win.id != null) chrome.windows.remove(win.id).catch(() => {})
        } else routineConfirmWindowId = win.id ?? null
      })
      .catch((e) => {
        console.warn('Startup: confirm dialog could not be shown:', e)
        settle(true)
      })
  })
}

// The dialog's buttons reporting in (the 'routineConfirmAnswer' message).
// A stale message after the prompt settled finds a nulled resolver and is a
// no-op.
export function answerRoutineConfirm(proceed: boolean): void {
  if (routineConfirmResolver) routineConfirmResolver(proceed === true)
}

// The prompt's window closing without an answer (windows.onRemoved, wired in the
// background). Dismissing it is an explicit gesture, so closing the window
// counts as Cancel — only the 15s timeout (user away) proceeds on
// its own.
export function routineConfirmWindowRemoved(windowId: number): void {
  if (windowId !== routineConfirmWindowId || !routineConfirmResolver) return
  routineConfirmResolver(false)
}

// ---------- The finish page's queries ----------

// The finish page's streak summary, built from the last stats read: which
// activities read as not-done, as 'key:label;key:label' (the query the page
// parses). A display string's trailing progress pair is the verdict — the
// same parse the popup's Bing-app banner uses, so the page and the banner
// can never disagree about whether a streak is done. A null or unparseable
// value never enters the query: the page should say 'every streak is
// complete' only when a read actually answered, not because a value went
// missing. Returns '' when every answered streak is done — a query-less page
// is the plain 'The daily routine finished.'
export async function routineSummaryQuery(
  verification?: { enabledSteps: string[]; readStartedAt: number },
): Promise<string> {
  const stats = await getLocal<Stats>(KEYS.lastStats)
  const activities: Partial<Activities> = (stats && stats.activities) || {}
  const parts: string[] = []
  const fresh = !verification || (statsAreCurrent(stats) && Number(stats?.at) >= verification.readStartedAt && Number(stats?.at) <= Date.now())
  const stepForActivity: Partial<Record<keyof Activities, StepId>> = {
    bingSearch: 'search', dailySet: 'dailySet', visualSearch: 'imageSearch',
  }
  for (const key of ['bingSearch', 'dailySet', 'bingApp', 'visualSearch'] as (keyof Activities)[]) {
    const enabled = verification?.enabledSteps.includes(stepForActivity[key] || '')
    // The search streak alone is not the daily search-credit cap. A fresh
    // 57/60 points read must remain visible even when the streak says 1/1.
    const value = key === 'bingSearch' && enabled ? stats?.searchPoints : activities[key]
    const match = String(value == null ? '' : value).match(/(\d+)\s*\/\s*(\d+)\s*$/)
    if (!fresh || !match) {
      if (enabled) parts.push(`${key}:not verified`)
      continue
    }
    const done = Number(match[1]) >= Number(match[2]) && Number(match[2]) > 0
    if (!done) parts.push(`${key}:${value}`)
  }
  if (verification) {
    const settings = await getSettings()
    for (const step of remainingSteps(fresh ? stats : null, settings)) {
      if (!['claim', 'keepEarning'].includes(step.id) || !verification.enabledSteps.includes(step.id) || step.status === 'complete') continue
      parts.push(`${step.id}:${step.status === 'unknown' ? 'not verified' : 'incomplete'}`)
    }
  }
  return parts.join(';')
}

// The finish page's skip list: which steps the routine skipped as already
// done, as 'id:reason;id:reason' (the ?s= query the page parses — the same
// compact shape the streak summary's ?q= uses). Reasons come from the
// routine's own verdicts, which carry no ';' or ':'; an entry that somehow
// does is dropped rather than mis-parsed.
export function routineSkippedQuery(skipped: SkippedStep[]): string {
  return (Array.isArray(skipped) ? skipped : [])
    .filter(
      (entry) =>
        entry &&
        typeof entry.id === 'string' &&
        typeof entry.reason === 'string' &&
        entry.id &&
        entry.reason &&
        !entry.id.includes(':') &&
        !entry.reason.includes(':') &&
        !entry.reason.includes(';'),
    )
    .map((entry) => `${entry.id}:${entry.reason}`)
    .join(';')
}

// ---------- The sequence ----------

// The sequence. `manual` (the popup's 'Run the routine' button, ADR-020)
// opts out of the first two LAUNCH gates — the master switch and the
// once-per-day skip — because a button press is an explicit user action that
// must always be able to run. The confirm dialog still asks (user request,
// 2026-09-07): 'Ask before running' promises a chance to cancel every start.
// Everything else is identical: the per-step skip-when-done verdicts still
// apply (no search batch at 60/60), a Stop still cancels, the finish page
// still opens, and a genuinely finished routine still marks its day (so the
// launch routine does not redo what the manual one completed).
// Why a startup sequence ended. 'ran' even when the search batch carries the
// tail (startSearchBatch's handoff IS the routine running); the skip reasons
// let the scheduled driver surface them to the Activity row instead of a
// console.log nobody reads.
export type StartupOutcome = 'ran' | 'disabled' | 'already-today' | 'cancelled' | 'quiet-hours' | 'postponed'

let sequenceStarting = false
export async function runStartupSequence(
  options: { manual?: boolean; scheduled?: boolean; selectedSteps?: StepId[] } = {},
): Promise<StartupOutcome> {
  if (sequenceStarting) return 'cancelled'
  sequenceStarting = true
  let preparationEpoch: number | null = null
  try {
    const state = await readRunState()
    preparationEpoch = state.stopEpoch
    if (state.routine || state.batch || state.activity) {
      // A duplicate click never clears a live owner. It may recover an old
      // worker's expired original routine, which otherwise blocks every later
      // manual/startup attempt forever.
      if (state.routine && !state.batch && !pendingTailInFlight && !routineFinishInFlight) {
        await recoverInterruptedOriginalRoutine()
      }
      return 'cancelled'
    }
    let claimed = false
    await updateRunState(current => {
      if (current.stopEpoch === preparationEpoch && !current.routine && !current.batch && !current.activity) {
        current.activity = { label: 'Preparing routine' }
        claimed = true
      }
    })
    if (!claimed) return 'cancelled'
    return await runStartupSequenceOwned(options, preparationEpoch)
  } finally {
    sequenceStarting = false
    await updateRunState(state => {
      if (state.stopEpoch === preparationEpoch && state.activity?.label === 'Preparing routine') state.activity = null
    })
  }
}

async function runStartupSequenceOwned(
  { manual = false, scheduled = false, selectedSteps }: { manual?: boolean; scheduled?: boolean; selectedSteps?: StepId[] } = {},
  myEpoch: number = 0,
): Promise<StartupOutcome> {
  const settings = await getSettings()

  // A stop during an earlier step must also cancel the steps not started yet:
  // stopAllActivity() bumps the epoch, and a mismatch means 'stopped'.
  if ((await currentStopEpoch()) !== myEpoch) return 'cancelled'

  // A sequence interrupted by the last shutdown must not resume now that a
  // fresh one is starting, and tab ids from the last session are meaningless.
  // The start day goes too: whatever it held belongs to the dead sequence.
  // One write: the routine field and the capture bookkeeping are both inside
  // the document.
  await updateRunState((state) => {
    if (state.stopEpoch === myEpoch) {
      state.routine = null
      state.captures = { capturing: [], opened: {} }
    }
  })

  // The master switch governs BROWSER STARTS only: a scheduled run answers to
  // its own toggle (scheduledRunEnabled, checked by routine/scheduled.ts —
  // the clock never fires the routine the user didn't opt into), and a manual
  // press IS the permission to run (ADR-020).
  if (!manual && !scheduled && !settings.startupEnabled) return 'disabled'
  if (!manual) {
    const postponed = await getLocal<{ until: number }>(KEYS.postponedRoutine)
    if (postponed && postponed.until > Date.now()) return 'postponed'
    const quietUntil = quietHoursEndAt(settings)
    if (quietUntil) {
      await setLocal(KEYS.postponedRoutine, { day: localDayKey(), until: quietUntil, source: 'startup' })
      await chrome.alarms.create('postponedRoutine', { when: quietUntil })
      return 'quiet-hours'
    }
  }

  // Once per day: if the routine already completed today, don't redo it on a
  // second browser launch. The stale-state cleanup above has already run by
  // here, which is what we want either way — the skip is the whole routine.
  // (lastRoutineDay stays a key of its own, outside the document: it is the
  // whole point that it survives stops, updates and evictions.)
  if (!manual && settings.startupOncePerDay) {
    const lastDay = await getLocal<string>(KEYS.lastRoutineDay)
    if (lastDay === localDayKey()) {
      console.log('Startup: routine already ran today — skipping.')
      return 'already-today'
    }
  }

  // Last gate: with 'Ask before running' on, the user gets a 15s window to
  // cancel before a single tab opens. It sits after the once-per-day skip on
  // purpose — there is nothing to ask about when the routine would not run
  // anyway — and before the routine field is set, so a cancel leaves nothing
  // routine-shaped behind. Manual runs ask too (user request, 2026-09-07):
  // the Run view's button starts the SAME routine, and 'Ask before running'
  // reads as a promise about every start — the button press confirms intent,
  // not the details. Scheduled runs are the one exemption (2026-09-12, the
  // user's schedule silently never ran): a time the user set IS the intent —
  // an unattended 15s window would auto-cancel every scheduled round, making
  // the whole feature dead on arrival with the confirm default-on.
  if (settings.confirmBeforeRoutine && !scheduled && !(await confirmRoutineStart())) {
    // Cancel: same shape as the once-per-day skip above — stale state away,
    // nothing routine-shaped left. lastRoutineDay is NOT written: today does
    // not count as done, so the next launch retries the routine.
    await updateRunState((state) => {
      if (state.stopEpoch === myEpoch) {
        state.routine = null
        state.captures = { capturing: [], opened: {} }
      }
    })
    console.log('Startup: routine cancelled at the confirm dialog.')
    return 'cancelled'
  }

  const queue = normalizeStartupOrder(settings.startupOrder).filter(
    (id) => settings[STARTUP_STEPS[id].enabledKey] && (!selectedSteps || selectedSteps.includes(id)),
  )
  if ((await currentStopEpoch()) !== myEpoch) return 'cancelled'
  const historyId = await startRunRecord(manual ? selectedSteps ? 'remaining-work' : 'manual' : scheduled ? 'scheduled' : 'startup', queue, await getLocal<Stats>(KEYS.lastStats))

  // Marks every step below as part of the routine, so in routine mode their
  // tabs are stashed for endRoutine() instead of closed per step. The start
  // day is captured here so endRoutine() can credit THAT day, even if the
  // sequence finishes after midnight in a later worker instance.
  // Arm first: eviction immediately after persisting the routine must leave
  // a wake-up available. An alarm with no routine is harmless and self-clears.
  await chrome.alarms.create(ROUTINE_RECOVERY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 })
  await updateRunState((state) => {
    if (state.stopEpoch === myEpoch) {
      state.routine = {
        startDay: localDayKey(), pendingSteps: [], pendingTabs: [], skipped: [], enabledSteps: queue,
        ownerUntilAt: Date.now() + ORIGINAL_STEP_LEASE_MS,
        startedAt: Date.now(), historyId, recoveryActions: 0,
      }
      if (state.activity?.label === 'Preparing routine') state.activity = null
    }
  })
  if ((await currentStopEpoch()) !== myEpoch) return 'cancelled'

  // A fresh read before the steps: the skip-when-done verdicts below must
  // judge the dashboard as it is NOW, not as an older same-day read left it —
  // a morning's '0 pending' must not skip an evening claim that has points
  // waiting. The stats step IS that read when it leads the queue (the default
  // order); when it is turned off or moved later, the read runs here instead,
  // so every verdict is made on current numbers either way. No
  // verdict-carrying step in the queue → no extra read.
  if (queue[0] !== 'stats' && queue.some((id) => STEP_DONE_CHECKS[id])) {
    await refreshStats()
  }

  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]

    // Stop checkpoint: a bumped epoch means the remaining steps, this one
    // included, are cancelled.
    if ((await currentStopEpoch()) !== myEpoch) break
    if (await pauseBoundary()) {
      await updateRunState(state => {
        if (state.stopEpoch === myEpoch && state.routine) {
          state.routine.pendingSteps = queue.slice(i)
          state.routine.recovering = true
        }
      })
      await recordRunEvent(historyId, id, 'paused', 'Waiting at an action boundary')
      return 'ran'
    }
    await renewOriginalStepLease(myEpoch)

    // Skip-when-done: a step whose today's read already shows complete never
    // runs — no search batch at 60/60, no claim at 0 pending. Checked before
    // the search branch on purpose: a skipped search means the rest of the
    // sequence simply continues inline, with no batch to hand the tail to.
    const skipReason = await routineStepSkipped(id)
    if (skipReason) {
      console.log(`Startup: skipping "${id}" — ${skipReason}.`)
      await reportSkippedStep(id, skipReason)
      continue
    }
    if ((await currentStopEpoch()) !== myEpoch) break

    // The batch runs for minutes after startSearchBatch() resolves, so the rest
    // of the sequence is handed to finishBatch() instead of racing it. The
    // routine stays live — endRoutine() is runPendingStartupSteps' business.
    if (id === 'search') {
      const rest = queue.slice(i + 1)
      try {
        if (rest.length) {
          await updateRunState((state) => {
            if (state.routine) state.routine.pendingSteps = rest
          })
        }
        await recordRunEvent(historyId, id, 'started')
        await startSearchBatch()
        return 'ran'
      } catch (e) {
        console.warn('Startup: web search batch failed to start:', e)
        await updateRunState((state) => {
          if (state.routine) state.routine.pendingSteps = []
        })
        continue // nothing to wait for; keep going inline
      }
    }

    try {
      const started = Date.now()
      await recordRunEvent(historyId, id, 'started')
      await STARTUP_STEPS[id].run()
      if (id !== 'stats') invalidateStatsEvidence()
      await recordRunEvent(historyId, id, 'action-finished', 'Progress is checked during final verification', Date.now() - started)
    } catch (e) {
      await recordRunEvent(historyId, id, 'failed', 'The step failed; final verification will check remaining work')
      console.warn(`Startup: step "${id}" failed:`, e)
    }
  }

  // The sequence ran to its end inline — no search batch to wait for. A no-op
  // after a stop: the stop write already nulled the routine, so the stashed
  // tabs are never swept.
  await endRoutine()
  return 'ran'
}

// One tail owner per worker. Its queue is shifted durably before each effect,
// so an eviction leaves the unstarted steps available to the recovery wake-up.
let pendingTailInFlight = false
let routineFinishInFlight = false

async function renewOriginalStepLease(epoch: number): Promise<void> {
  await updateRunState(state => {
    if (state.stopEpoch === epoch && state.routine && !state.routine.recovering) {
      state.routine.ownerUntilAt = Date.now() + ORIGINAL_STEP_LEASE_MS
    }
  })
}

// A newly awakened worker cannot resume the JS stack of an interrupted
// original step. After its lease expires, inspect actual fresh Rewards stats
// and use bounded final recovery instead of blindly replaying the whole run.
async function recoverInterruptedOriginalRoutine(): Promise<boolean> {
  const state = await readRunState()
  if (state.pause) return false
  if (!state.routine || state.routine.recovering || state.batch ||
      Number(state.routine.ownerUntilAt || 0) > Date.now()) return false
  let claimed = false
  await updateRunState(s => {
    if (s.stopEpoch !== state.stopEpoch || !s.routine || s.routine.recovering || s.batch ||
        Number(s.routine.ownerUntilAt || 0) > Date.now()) return
    s.routine.recovering = true
    s.routine.pendingSteps = []
    s.activity = null // this owner belonged to the expired worker
    s.captures.capturing = []
    claimed = true
  })
  if (claimed) await endRoutine()
  return claimed
}

async function runQueuedStartupSteps(): Promise<void> {
  const initial = await readRunState()
  if (!initial.routine || initial.batch || await pauseBoundary()) return
  const myEpoch = initial.stopEpoch
  const queue = initial.routine.pendingSteps
  if (queue.includes('claim') && queue[0] !== 'stats') await refreshStats()

  while (true) {
    const state = await readRunState()
    if (state.stopEpoch !== myEpoch || !state.routine || state.batch || await pauseBoundary()) return
    const id = state.routine.pendingSteps[0] as StepId | undefined
    if (!id) return
    let claimed = false
    await updateRunState(s => {
      if (s.stopEpoch === myEpoch && s.routine?.pendingSteps[0] === id && !s.batch) {
        s.routine.pendingSteps.shift()
        claimed = true
      }
    })
    if (!claimed) return
    await renewOriginalStepLease(myEpoch)
    const step = STARTUP_STEPS[id]
    const settings = await getSettings()
    if (!step || !settings[step.enabledKey]) continue
    if ((await currentStopEpoch()) !== myEpoch) return
    const reason = await routineStepSkipped(id)
    if (reason) {
      await reportSkippedStep(id, reason)
      continue
    }
    if ((await currentStopEpoch()) !== myEpoch) return
    try {
      const started = Date.now()
      await recordRunEvent(state.routine.historyId, id, 'started')
      if (id === 'search') {
        await startSearchBatch()
        return
      }
      await step.run()
      if (id !== 'stats') invalidateStatsEvidence()
      await recordRunEvent(state.routine.historyId, id, 'action-finished', 'Progress is checked during final verification', Date.now() - started)
    } catch (error) {
      await recordRunEvent(state.routine.historyId, id, 'failed', 'The step failed')
      console.warn('Routine: queued step failed:', id, error)
    }
  }
}

// The normal post-search tail also resumes a persisted final-recovery queue.
export async function runPendingStartupSteps(): Promise<void> {
  if (pendingTailInFlight) return
  pendingTailInFlight = true
  try {
    await runQueuedStartupSteps()
    await endRoutine()
  } finally {
    pendingTailInFlight = false
  }
}

// The background entry point calls this on worker wake/watchdog. Initial
// routines are not replayed; only a final verification/recovery already marked
// in storage is resumed, and an active search batch remains its own owner.
export async function resumeRoutineRecovery(): Promise<void> {
  if (sequenceStarting || pendingTailInFlight || routineFinishInFlight) return
  const state = await readRunState()
  if (state.pause) return
  if (!state.routine) {
    await chrome.alarms.clear(ROUTINE_RECOVERY_ALARM)
    return
  }
  if (state.routine?.recovering && !state.batch) await runPendingStartupSteps()
  else if (!state.batch) await recoverInterruptedOriginalRoutine()
}

// The end of a startup sequence. In routine mode this is the one moment the
// stashed tabs are all closed at once; a no-op when no routine ran, so callers
// don't need to care which mode they're in. A routine that genuinely finished
// also marks the day it started as done for the once-per-day gate.
export async function endRoutine(): Promise<void> {
  if (routineFinishInFlight) return
  routineFinishInFlight = true
  const finishingEpoch = await currentStopEpoch()
  holdKeepAlive()
  try {
    await verifyAndFinishRoutine()
  } finally {
    routineFinishInFlight = false
    releaseKeepAlive()
    await updateRunState(state => {
      if (state.stopEpoch === finishingEpoch && state.activity?.label === 'Finishing routine') state.activity = null
    })
  }
}

async function verifyAndFinishRoutine(): Promise<void> {
  const initial = await readRunState()
  if (!initial.routine || initial.batch) return
  const myEpoch = initial.stopEpoch
  await updateRunState(state => {
    if (state.stopEpoch === myEpoch && state.routine) state.routine.recovering = true
  })
  if (await pauseBoundary()) return
  // Persist the wake-up before the first settle/read. A worker eviction here
  // must not strand a routine with its completion marker still unwritten.
  await chrome.alarms.create(ROUTINE_RECOVERY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 })
  let finalReadStartedAt = 0

  // Every retry round is reserved in storage before starting effects. Stop
  // still owns the routine until the last fresh verification is complete.
  while (true) {
    if ((await currentStopEpoch()) !== myEpoch) return
    if (await pauseBoundary()) return
    let readStarted = Date.now()
    try {
      await sleep(ROUTINE_FINISH_SETTLE_MS)
      if ((await currentStopEpoch()) !== myEpoch) return
      if (await pauseBoundary()) return
      readStarted = Date.now()
      finalReadStartedAt = readStarted
      await refreshStats({ scope: 'full', notBefore: readStarted })
    } catch (error) {
      console.warn('Routine: final verification read failed:', error)
    }
    const state = await readRunState()
    if (state.stopEpoch !== myEpoch || !state.routine || state.batch || await pauseBoundary()) return
    const settings = await getSettings()
    const stats = await getLocal<Stats>(KEYS.lastStats)
    const plan = planRoutineRecovery(stats, readStarted, state.routine.enabledSteps || [], settings,
      state.routine.recoveryRound || 0, state.routine.recoveryProgress || {})
    if (!plan.steps.length) {
      if (plan.reason === 'limit' || plan.reason === 'no-progress' || plan.reason === 'stale-read') {
        await setLastTabAction('Routine verification stopped: ' + plan.reason + '; remaining work needs a later check', null)
      }
      break
    }
    if (!(await reserveRecoveryActions(plan.steps.length))) {
      await setLastTabAction('Routine recovery budget reached; remaining work needs a later check', null)
      break
    }
    let reserved = false
    await updateRunState(s => {
      if (s.stopEpoch !== myEpoch || !s.routine || s.batch) return
      s.routine.recoveryRound = (s.routine.recoveryRound || 0) + 1
      s.routine.recoveryProgress = plan.progress
      s.routine.pendingSteps = plan.steps.filter(id => id !== 'search')
      reserved = true
    })
    if (!reserved || (await currentStopEpoch()) !== myEpoch) return
    await setLastTabAction('Routine verification: retrying ' + plan.steps.join(', '), null)
    if ((await currentStopEpoch()) !== myEpoch) return
    if (plan.steps.includes('search')) {
      try {
        await startSearchBatch({ count: plan.searchCount })
        return // its finish hands the durable auxiliary queue back above
      } catch (error) {
        console.warn('Routine: recovery search could not start:', error)
      }
    }
    await runQueuedStartupSteps()
  }
  if ((await currentStopEpoch()) !== myEpoch) return
  if (await pauseBoundary()) return

  // Read the routine and clear it as ONE step — a stop landing between the
  // read and the clear would otherwise let a stopped routine sweep its
  // stashed tabs.
  await chrome.alarms.clear(ROUTINE_RECOVERY_ALARM)
  if ((await currentStopEpoch()) !== myEpoch || await pauseBoundary()) return
  const consumed = await consumeRoutine(myEpoch)
  if (!consumed) return

  // Only a live routine gets this far, i.e. a routine truly finished (inline
  // end or post-search-batch tail — both land here). A stopped routine never
  // does: the stop write already nulled it, so the no-op return above is what
  // a stop sees, and the day stays unmarked. The START day is what gets
  // marked, not the finish day: a routine that crosses midnight belongs to
  // the day it began, or the new day would be silently marked done without
  // ever getting its routine.
  if ((await currentStopEpoch()) !== myEpoch) return
  const finalStats = await getLocal<Stats>(KEYS.lastStats)
  if ((await currentStopEpoch()) !== myEpoch) return
  const finalSettings = await getSettings()
  if ((await currentStopEpoch()) !== myEpoch) return
  const verifiedStats = Number(finalStats?.at) >= finalReadStartedAt ? finalStats : null
  const enabledResults = remainingSteps(verifiedStats, finalSettings).filter(step => consumed.enabledSteps?.includes(step.id))
  const runOutcome = enabledResults.some(step => step.status === 'unknown') ? 'unknown' : enabledResults.some(step => step.status === 'incomplete') ? 'incomplete' : 'completed'
  await finishRunRecord(consumed.historyId, runOutcome,
    runOutcome === 'completed' ? 'Enabled work verified complete' : 'Some enabled work remains or could not be verified', finalStats)
  if ((await currentStopEpoch()) !== myEpoch) return

  const skippedQuery = routineSkippedQuery(consumed.skipped)
  const ids = consumed.pendingTabs.filter((id) => typeof id === 'number')

  // The finish screen: after the sweep below the user would be left staring at
  // whatever the routine's tabs last showed — so the dashboard opens instead,
  // its overlay saying the routine is done and listing the streaks they have
  // to finish themselves (the Bing-app check-in, usually) and the steps it
  // skipped as already done. Selected in its browser window and never auto-closed: the user is
  // the only one who takes the overlay down (Done blurs it out to their
  // board), and the Clear-tabs action exempts the dashboard's URL.
  // Hoisted out of the try below so the sweep after it can spare this tab. A
  // finish screen that failed to open leaves it null — nothing to spare, and
  // the dashboard rule would have spared it anyway.
  let finishTabId: number | null = null

  try {
    const summary = await routineSummaryQuery({ enabledSteps: consumed.enabledSteps || [], readStartedAt: finalReadStartedAt })
    if ((await currentStopEpoch()) !== myEpoch) return
    const params = new URLSearchParams()
    if (summary) params.set('q', summary)
    if (skippedQuery) params.set('s', skippedQuery)
    const finishTab = await chrome.tabs.create({
      url: `${FINISH_URL}${params.toString() ? `?${params.toString()}` : ''}`,
      active: true,
    })
    finishTabId = finishTab.id ?? null
    if ((await currentStopEpoch()) !== myEpoch) return
    // The finish screen is now the current dashboard; any dashboards left open
    // by earlier runs are stale, so close them (user request, 2026-09-26),
    // sparing the one just opened. Best-effort — never fails the finish.
    await closeOtherDashboardTabs(finishTabId, myEpoch)
  } catch (e) {
    // The summary is a nicety, never a failure of the routine itself.
    console.warn('Routine: could not open the finish screen:', e)
  }

  // The sweep's wider half (user request, 2026-10-06): the leftovers of a
  // finished routine are not only the tabs it stashed. Its search tab, a manual
  // run's tab, a Rewards page the user opened — anything still standing on Bing
  // goes, so the board the finish overlay landed on is what they are left with.
  // `ids` is spared on purpose: those tabs still have the grace period below to
  // sit through (Bing credits the visit in that window), so this pass is for
  // the strays and the two counts are reported together there. Best-effort — a
  // tab that cannot be enumerated or closed never fails the finish.
  if ((await currentStopEpoch()) !== myEpoch) return
  const swept = await closeBingRewardsTabs([finishTabId, ...ids], myEpoch).catch((e) => {
    console.warn('Routine: the Bing tab sweep failed:', e)
    return 0
  })
  if ((await currentStopEpoch()) !== myEpoch) return

  if (!ids.length) {
    if (swept) await setLastTabAction(`Closed ${swept} leftover Bing tab(s) after the routine`, true)
    return
  }

  const settings = await getSettings()
  if ((await currentStopEpoch()) !== myEpoch) return
  const graceMs = Math.max(0, Number(settings.tabCloseDelaySec) || 0) * 1000

  // Same shape as closeCapturedTabs: credit the visits, keep the worker alive.
  holdKeepAlive()
  try {
    if (graceMs) await sleep(graceMs)
    // A stop during the grace period must leave the stashed tabs open —
    // stopping is not finishing, exactly like the per-step close above.
    if ((await currentStopEpoch()) !== myEpoch) {
      console.log('Routine tab sweep skipped: stopped during the grace period.')
      return
    }
    const closed = await closeTabs(ids, settings.keepPinnedTabs, myEpoch)
    // One line for both halves of the sweep: the strays done above and the
    // routine's own tabs here. They are disjoint — the strays were spared
    // `ids` — so the sum is the count of tabs the finish actually closed.
    const total = closed + swept
    if (total) {
      console.log(`Closed ${total} tab(s) after the routine.`)
      await setLastTabAction(`Closed ${total} tab(s) after the routine`, true)
    }
  } finally {
    releaseKeepAlive()
  }
}
