// Tab lifecycle: capture bookkeeping, waiting, reuse, closing, and the popup's
// Clear-tabs sweep.
//
// ---------- Capture bookkeeping ----------
// Each feature records the tabs it opens so it can close them again when it
// finishes. Daily set is the reason this can't just remember one id: clicking
// a tile opens further tabs, so anything created while a feature is
// "capturing" is attributed only when its opener already belongs to it. This bookkeeping lives inside the
// run-state document (captures.capturing / captures.opened) rather than two
// storage keys of its own — the serialization that made the v1 writes safe is
// updateRunState's promise chain now, and a stop clears the bookkeeping as
// part of the one stop write.

import type { Settings, StepId } from '../../shared/settings.ts'
import { getSettings } from '../../shared/settings.ts'
import { currentStopEpoch, readRunState, updateRunState } from './run-state.ts'
import { holdKeepAlive, releaseKeepAlive } from './keepalive.ts'
import { sleep } from './delays.ts'
import { setLastTabAction, STEP_LABEL } from './log.ts'
import { isDashboardUrl, pickFinishSweep } from '../pure/finish-sweep.ts'
import { createNormalTab } from './normal-tabs.ts'

// The capture bookkeeping's id: a startup StepId OR a synthetic one for
// features outside the routine (src-donut used the plain string "coupons" the
// same way — the bookkeeping only needs a consistent key, not a real step).
export type CaptureId = StepId | 'coupons'

// The Clear-tabs outcome the popup renders (mapped straight into a
// MessageResponse by background/index.ts).
export interface ClearResult {
  ok: boolean
  closed?: number
  kept?: number
  error?: string
}

// Wired to chrome.tabs.onCreated in background/index.ts (the listener belongs
// to the entry point; this is just the bookkeeping). No-ops unless some step
// is capturing — a tab the user opened by hand is nobody's to close.
export async function recordOpenedTab(created: chrome.tabs.Tab | number): Promise<unknown> {
  // Direct tabs are claimed explicitly by the creator. The event listener is
  // only for child tabs opened by those pages, never every tab the user opens
  // during the same time window. Numeric input remains compatible with older
  // listeners while the entry point moves to passing the full tab object.
  const tab = typeof created === 'number' ? await chrome.tabs.get(created).catch(() => null) : created
  if (tab?.id == null || tab.openerTabId == null) return
  const tabId = tab.id
  return updateRunState((state) => {
    if (!state.captures.capturing.length) return
    for (const stepId of state.captures.capturing) {
      const ids = state.captures.opened[stepId] || []
      if (!ids.includes(tab.openerTabId!)) continue
      if (!ids.includes(tabId)) state.captures.opened[stepId] = ids.concat(tabId)
    }
  })
}

// A tab we opened ourselves, or an existing one we claimed — ensureBingTab can
// reuse a tab, and a reused tab never fires onCreated.
export function claimTab(stepId: CaptureId, tabId: number | null): Promise<unknown> {
  if (tabId == null) return Promise.resolve()
  return updateRunState((state) => {
    const ids = state.captures.opened[stepId] || []
    if (ids.includes(tabId)) return
    state.captures.opened[stepId] = ids.concat(tabId)
  })
}

export function beginTabCapture(stepId: CaptureId): Promise<unknown> {
  return updateRunState((state) => {
    if (!state.captures.capturing.includes(stepId)) {
      state.captures.capturing = state.captures.capturing.concat(stepId)
    }
    // A fresh run starts from an empty list; the previous run's tabs were
    // already dealt with, or deliberately left alone.
    state.captures.opened[stepId] = []
  })
}

// Stops capturing and hands back the tabs collected so far.
export function endTabCapture(stepId: CaptureId): Promise<number[]> {
  let ids: number[] = []
  const done = updateRunState((state) => {
    state.captures.capturing = state.captures.capturing.filter((id) => id !== stepId)
    ids = state.captures.opened[stepId] || []
    delete state.captures.opened[stepId]
  })
  return done.then(() => ids)
}

// ---------- Waiting and reuse ----------

// Resolves true once the tab reports "complete", false on timeout or if the
// tab is gone. The immediate tabs.get covers a tab that finished loading
// before we started listening; the timeout keeps a hung page from stalling the
// step.
export function waitForTabComplete(tabId: number, timeoutMs = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false

    function finish(ok: boolean): void {
      if (settled) return
      settled = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve(ok)
    }

    function listener(updatedTabId: number, info: chrome.tabs.OnUpdatedInfo): void {
      if (updatedTabId === tabId && info.status === 'complete') finish(true)
    }

    chrome.tabs.onUpdated.addListener(listener)
    const timer = setTimeout(() => finish(false), timeoutMs)

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === 'complete') finish(true)
      })
      .catch(() => finish(false))
  })
}

// Reuse the previous batch's tab if it is still open, so repeated batches don't
// pile up tabs.
// Every search tab is selected inside its normal window, including prowl. This
// does not bring the window to the OS foreground. Retain the old optional flag
// for callers, but tab selection is now the same for every search batch.
export async function ensureBingTab(existingTabId: number | null, _background = false): Promise<number> {
  if (existingTabId != null) {
    try {
      const tab = await chrome.tabs.get(existingTabId)
      // Only reclaim it if it's still a Bing tab — the user may have navigated
      // it somewhere else since the last batch.
      if (tab && String(tab.url || '').startsWith('https://www.bing.com/')) {
        await chrome.tabs.update(existingTabId, { url: 'https://www.bing.com/', active: true })
        return existingTabId
      }
    } catch {
      // Tab is gone; fall through and make a new one.
    }
  }

  const tab = await createNormalTab('https://www.bing.com/')
  return tab.id as number
}

// ---------- Closing ----------

// Removing every tab in a window closes the window too, so leave one behind.
// The window ids are handed in from closeTabs()'s own tabs.get pass —
// re-fetching every tab here would double the round trips for no new
// information.
async function keepWindowsAlive(closingIds: number[], windowIds: Iterable<number>, expectedEpoch?: number): Promise<void> {
  const closing = new Set(closingIds)

  for (const windowId of windowIds) {
    const tabs = await chrome.tabs.query({ windowId })
    if (!(await cleanupEpochMatches(expectedEpoch))) return
    if (tabs.length && tabs.every((tab) => closing.has(tab.id as number))) {
      // Only the user's own normal windows are worth keeping alive. A window
      // the extension itself created to host one read tab is allowed to close
      // with its tab — keeping it alive would leave a stray blank window
      // behind, and the keep-alive tab opens ACTIVE, stealing focus.
      try {
        const win = await chrome.windows.get(windowId)
        if (win.type !== 'normal') continue
      } catch {
        continue // the window is already going away
      }
      if (!(await cleanupEpochMatches(expectedEpoch))) return
      await chrome.tabs.create({ windowId })
    }
  }
}

async function cleanupEpochMatches(expectedEpoch?: number): Promise<boolean> {
  return expectedEpoch == null || await currentStopEpoch() === expectedEpoch
}

export async function closeTabs(ids: Array<number | null | undefined>, keepPinned: boolean, expectedEpoch?: number): Promise<number> {
  if (!(await cleanupEpochMatches(expectedEpoch))) return 0
  const unique = [...new Set(ids.filter((id): id is number => typeof id === 'number'))]
  const closable: number[] = []
  const windowIds = new Set<number>()

  for (const id of unique) {
    try {
      const tab = await chrome.tabs.get(id)
      if (!(await cleanupEpochMatches(expectedEpoch))) return 0
      // One round trip feeds both filters: pinned here, the window sweep above.
      if (keepPinned && tab.pinned) continue
      closable.push(id)
      windowIds.add(tab.windowId)
    } catch {
      // The user already closed it.
    }
  }

  if (!closable.length) return 0

  await keepWindowsAlive(closable, windowIds, expectedEpoch)
  if (!(await cleanupEpochMatches(expectedEpoch))) return 0
  try {
    await chrome.tabs.remove(closable)
  } catch (e) {
    console.warn('Closing tabs failed:', e)
    return 0
  }

  return closable.length
}

// Called when a feature finishes: stop capturing, then decide what happens to
// the tabs it opened.
//
//   perStep mode: close now iff the feature's own toggle says so (as always).
//   routine mode, routine running: stash them — one sweep at sequence end.
//   routine mode, manual run: close now iff closeTabsAfterManualRun.
//
// The epoch is captured at entry so the re-check after the grace sleep can tell
// a real stop from anything else; on the normal path it never moves.
export async function closeCapturedTabs(stepId: StepId, enabledKey: keyof Settings): Promise<number> {
  const myEpoch = await currentStopEpoch()
  const ids = await endTabCapture(stepId)
  const settings = await getSettings()
  if (!ids.length) return 0

  if (settings.tabCloseMode === 'routine') {
    const state = await readRunState()
    if (state.routine) {
      await stashRoutineTabs(ids)
      return 0
    }
    if (!settings.closeTabsAfterManualRun) return 0
  } else if (!settings[enabledKey]) {
    return 0
  }

  const graceMs = Math.max(0, Number(settings.tabCloseDelaySec) || 0) * 1000

  // The grace period is there so Bing can credit the visit — and it is long
  // enough that the worker would otherwise be evicted mid-wait.
  holdKeepAlive()
  try {
    if (graceMs) await sleep(graceMs)
    // A stop during the grace period must not close the tabs out from under
    // it: stopping is not finishing. The tabs stay open with the rest.
    if ((await currentStopEpoch()) !== myEpoch) {
      console.log(`Tab close for "${stepId}" skipped: stopped during the grace period.`)
      return 0
    }
    const closed = await closeTabs(ids, settings.keepPinnedTabs, myEpoch)
    if (closed) {
      console.log(`Closed ${closed} tab(s) opened by "${stepId}".`)
      await setLastTabAction(`Closed ${closed} tab(s) after the ${STEP_LABEL[stepId] || stepId}`, true)
    }
    return closed
  } finally {
    releaseKeepAlive()
  }
}

// Read-modify-write behind the run-state chain: steps finish concurrently with
// tabs.onCreated capture.
function stashRoutineTabs(ids: number[]): Promise<unknown> {
  return updateRunState((state) => {
    if (!state.routine) return // stopped in between — the sweep is moot
    state.routine.pendingTabs = [...new Set(state.routine.pendingTabs.concat(ids))]
  })
}

// ---------- Clear tabs (the popup's sweep) ----------

// The dashboard the routine opens at sequence end (6.8.0: the finish screen
// is the dashboard's overlay now) — its tab is exempt from the Clear-tabs
// sweep: it is the user's board the overlay landed on, never a routine tab
// to close.
const DASHBOARD_URL = 'dashboard.html'

function isDashboardTab(tab: chrome.tabs.Tab): boolean {
  return isDashboardUrl(tab.url, DASHBOARD_URL) || isDashboardUrl(tab.pendingUrl, DASHBOARD_URL)
}

// When a routine finishes it opens a fresh dashboard for the finish overlay to
// ride on. Any dashboards left open by EARLIER runs are now stale — the same
// board, an older summary — so the finish sweep closes them, leaving only the
// one the user is now looking at (user request, 2026-09-26: the finish screen
// should also close the previous runs' dashboard pages). Queried across every
// window, since a prior run's dashboard may sit in another window; the just-
// opened tab is spared by id. Best-effort: a routine never fails because a
// stale tab could not be enumerated or closed.
export async function closeOtherDashboardTabs(keepTabId: number | null, expectedEpoch?: number): Promise<number> {
  if (!(await cleanupEpochMatches(expectedEpoch))) return 0
  let tabs: chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({})
  } catch (e) {
    console.warn('Finish: could not enumerate dashboard tabs to close:', e)
    return 0
  }
  const doomed = tabs
    .filter((tab) => tab.id !== keepTabId)
    .filter(isDashboardTab)
    .map((tab) => tab.id)
    .filter((id): id is number => typeof id === 'number')
  if (!doomed.length || !(await cleanupEpochMatches(expectedEpoch))) return 0
  try {
    await chrome.tabs.remove(doomed)
  } catch (e) {
    console.warn('Finish: could not close prior dashboard tabs:', e)
    return 0
  }
  return doomed.length
}

// The finish sweep's wider half (user request, 2026-10-06): a finished
// routine's leftovers are not only the boards it opened. Its search tab, a
// manual run's tab, a Rewards page the user opened — anything still standing on
// Bing goes, so the finish screen is what the user is left looking at. Stale
// dashboards are its sibling's job above; the picking is pickFinishSweep
// (pure/finish-sweep.ts), which spares pinned tabs, dashboards and every id
// handed in here.
//
// Best-effort exactly like that sibling: a tab that cannot be enumerated or
// closed never fails the routine.
export async function closeBingRewardsTabs(keepIds: Array<number | null | undefined>, expectedEpoch?: number): Promise<number> {
  if (!(await cleanupEpochMatches(expectedEpoch))) return 0
  let tabs: chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({})
  } catch (e) {
    console.warn('Finish: could not enumerate Bing tabs to close:', e)
    return 0
  }

  const settings = await getSettings()
  // A live batch's tab is the one tab in range that is still in use — the sweep
  // must never close the page a search is typing into.
  const state = await readRunState()
  const keep = [...keepIds]
  if (state.batch && state.batch.tabId != null) keep.push(state.batch.tabId)

  const doomed = pickFinishSweep(tabs, {
    keepIds: keep,
    keepPinned: settings.keepPinnedTabs,
    dashboardMatch: DASHBOARD_URL,
  })
  if (!doomed.length || !(await cleanupEpochMatches(expectedEpoch))) return 0

  // The hazard closeTabs() already guards against, and the reason it is worth
  // guarding here: removing every tab in a window closes the window with it, so
  // a window that held nothing but Bing tabs would vanish. The window ids come
  // free from the query above rather than a second tabs.get pass, and the guard
  // itself only touches the user's own normal windows. Best-effort, like
  // everything else here.
  const closing = new Set(doomed)
  const windowIds = new Set(
    tabs.filter((tab) => tab.id != null && closing.has(tab.id)).map((tab) => tab.windowId),
  )
  try {
    await keepWindowsAlive(doomed, windowIds, expectedEpoch)
  } catch (e) {
    console.warn('Finish: the window guard failed:', e)
  }

  if (!(await cleanupEpochMatches(expectedEpoch))) return 0
  try {
    await chrome.tabs.remove(doomed)
  } catch (e) {
    console.warn('Finish: could not close Bing/Rewards tabs:', e)
    return 0
  }
  return doomed.length
}

// Opens a fresh tab first, then closes everything else in that window, so the
// window never blinks out of existence.
export async function clearAllTabs(windowId?: number | null): Promise<ClearResult> {
  const settings = await getSettings()

  let targetWindow = windowId ?? null
  if (targetWindow == null) {
    try {
      const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
      targetWindow = focused?.id ?? null
    } catch (e) {
      console.warn('Clear tabs: could not resolve a window:', e)
    }
  }

  // An unset windowId makes tabs.query match every window — which would close
  // the user's other windows too. Refuse instead of guessing.
  if (targetWindow == null) {
    const error = 'could not work out which window to clear'
    await setLastTabAction(`Clear failed — ${error}`, false)
    return { ok: false, error }
  }

  const existing = await chrome.tabs.query({ windowId: targetWindow })
  const fresh = await chrome.tabs.create({ windowId: targetWindow, active: true })

  const doomed = existing
    .filter((tab) => tab.id !== fresh.id)
    .filter((tab) => !isDashboardTab(tab))
    .filter((tab) => !(settings.keepPinnedTabs && tab.pinned))
    .map((tab) => tab.id)
    .filter((id): id is number => typeof id === 'number')

  const keptOut = existing.length - doomed.length

  if (!doomed.length) {
    await setLastTabAction('Nothing to clear — opened a fresh tab', true)
    return { ok: true, closed: 0, kept: keptOut }
  }

  try {
    await chrome.tabs.remove(doomed)
  } catch (e) {
    console.warn('Clear tabs failed:', e)
    await setLastTabAction(`Clear failed — ${e}`, false)
    return { ok: false, error: String(e) }
  }

  // Those tabs are gone; capture bookkeeping and the routine's stash would
  // close tabs that no longer exist, and a batch pointing at one of them has
  // nothing left to type in.
  await updateRunState((state) => {
    state.captures = { capturing: [], opened: {} }
    if (state.routine) state.routine.pendingTabs = []
    if (state.batch && state.batch.tabId != null && doomed.includes(state.batch.tabId)) state.batch.tabId = null
  })

  const pinnedKept = keptOut - existing.filter(isDashboardTab).length
  await setLastTabAction(
    `Cleared ${doomed.length} tab(s)${pinnedKept > 0 ? `, kept ${pinnedKept} pinned` : ''}`,
    true,
  )
  return { ok: true, closed: doomed.length, kept: keptOut }
}
