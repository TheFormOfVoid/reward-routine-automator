// Reads the Rewards stats into lastStats: the four top cards plus today's
// progress on four activity streaks. The 2026-09 redesign split the values
// across pages (the dashboard keeps the top cards and the stamp bonus card,
// the streak cards live only on the Earn page), so this reads BOTH pages and
// merges them (pure/merge-stats) — the dashboard with waitMode "cards", the
// Earn page with "streaks", each returning as soon as its own half hydrates.
//
// Runs as the first action of the startup routine and on demand from the
// popup's Refresh button. Never throws — a stats read is a convenience, not a
// routine step that can fail the sequence, so a page that won't load costs
// one console.warn and leaves the last stats untouched.
//
// The tab handling closes only the tabs THIS run opened: there is no per-step
// close toggle for a read (nothing is being earned, so there is nothing to
// give a grace period to), and the tabs were opened for this one read. The one
// exception is a stop — a stopped run leaves them open, because stopping is
// not finishing.

import { beginActivity, endActivity, currentStopEpoch } from '../core/run-state.ts'
import { localDayKey } from '../core/day.ts'
import { closeTabs, waitForTabComplete } from '../core/tabs.ts'
import { createNormalTab } from '../core/normal-tabs.ts'
import { withDeadline } from '../pure/search-recovery.ts'
import { holdKeepAlive, releaseKeepAlive } from '../core/keepalive.ts'
import { setLastStatsLog } from '../core/log.ts'
import { recordRunEvent } from '../core/run-history.ts'
import { getSettings } from '../../shared/settings.ts'
import { KEYS, getLocal, setLocal } from '../../shared/storage.ts'
import type { HistoryEntry, RawStats, Stats } from '../../shared/storage.ts'
import { mergeStats } from '../pure/merge-stats.ts'
import { parsePoints, recordDay } from '../pure/history.ts'
import { readRewardsStats } from '../injections/stats-read.ts'
import { readCouponCount } from '../injections/coupons.ts'
import { REWARDS_DASHBOARD, REWARDS_EARN } from './rewards-section.ts'

// How long the page-side stats reader waits for the React app to hydrate
// before reporting whatever it could find. The cards render first, the
// activity tiles slightly later, so the poll outlives "complete" alone.
const STATS_HYDRATION_MS = 12000
// The coupon count rides on a dashboard tab the stats reader has already
// waited out (STATS_HYDRATION_MS above), so its own poll only needs to
// cover the trigger's late render — not a full hydration.
const COUPON_READ_MS = 5000
// Leave room inside callers' 90s deadline for tab cleanup and guard release.
const STATS_RUN_BUDGET_MS = 75000

// In-flight guards, shared with the redeem watch (readers/redeem.ts): a
// burst (Refresh button, popup-open refresh, the routine's stats step) fires
// both reads together, and nothing stops a SECOND burst from starting while
// the first still reads — the popup's pending guard covers one popup session
// only. Two overlapping runs used to sweep each other's read tabs through the
// shared capture lists, so each runner refuses to double up and closes
// only the tab(s) it opened itself.
export const READ_RUN_GUARDS: { stats: boolean; redeem: boolean; orders: boolean } = {
  stats: false,
  redeem: false,
  orders: false,
}

// One page of the two-page read, returned so the merge and the dumps can reach
// its tab. Escalation-probe and evidence shapes are page-derived, so they are
// read back as loose objects and cast at this boundary.
interface PageRead {
  tabId: number
  stats: RawStats | null
}

export interface StatsReadRequest {
  scope?: 'full' | 'search'
  /** The read must have begun after the action being verified. */
  notBefore?: number
  minStartedAt?: number
  /** Reuse only explicitly requested, recent evidence; default is a fresh read. */
  maxAgeMs?: number
}

export interface StatsReadResult {
  scope: 'full' | 'search'
  startedAt: number
  completedAt: number
  stats: Stats | null
  observed: string[]
  stopEpoch: number | null
}

let statsInFlight: { scope: 'full' | 'search'; promise: Promise<StatsReadResult> } | null = null
let lastEvidence: StatsReadResult | null = null
let evidenceRevision = 0

export function invalidateStatsEvidence(): void { lastEvidence = null; evidenceRevision++ }

function observedFields(stats: Stats | null): string[] {
  if (!stats) return []
  return Object.entries(stats).flatMap(([key, value]) => key === 'at' || value == null ? []
    : key === 'activities' ? Object.entries(value).filter(([, v]) => v != null).map(([k]) => 'activities.' + k)
      : [key])
}

// Share the actual result, not a boolean guard. A caller checking work performed
// after an older reader began waits for that reader, then starts a new one.
export async function refreshStats(request: StatsReadRequest = {}): Promise<StatsReadResult> {
  // Resolve the request's owner before inspecting/reserving the shared reader.
  // There are no awaits between the acquisition check and setting statsInFlight.
  const requestEpoch = await currentStopEpoch()
  const scope = request.scope || 'full'
  const minimum = Math.max(0, Number(request.notBefore || request.minStartedAt) || 0)
  const maxAge = Math.max(0, Number(request.maxAgeMs) || 0)
  const accepts = (result: StatsReadResult) => (result.scope === 'full' || scope === 'search') &&
    result.startedAt >= minimum && (scope !== 'search' || result.observed.includes('searchPoints'))
  if (statsInFlight) {
    const result = await statsInFlight.promise
    if (result.stopEpoch === requestEpoch && accepts(result)) return result
    if (requestEpoch !== await currentStopEpoch()) return { ...result, stats: null, observed: [] }
    return refreshStats(request)
  }
  if (maxAge && lastEvidence && accepts(lastEvidence) && Date.now() - lastEvidence.startedAt <= maxAge &&
      lastEvidence.stopEpoch === requestEpoch) return lastEvidence

  const startedAt = Date.now()
  const revision = evidenceRevision
  let stats: Stats | null = null
  const pending = collectStats(scope, (value, epoch) => { if (epoch === requestEpoch) stats = value })
    .then(async (): Promise<StatsReadResult> => {
      if (requestEpoch !== await currentStopEpoch()) stats = null
      return { scope, startedAt, completedAt: Date.now(), stats,
        observed: observedFields(stats), stopEpoch: requestEpoch }
    })
  statsInFlight = { scope, promise: pending }
  try {
    const result = await pending
    if (result.stats && revision === evidenceRevision) lastEvidence = result
    return result
  } finally {
    if (statsInFlight?.promise === pending) statsInFlight = null
  }
}

async function collectStats(scope: 'full' | 'search', publish: (stats: Stats, epoch: number | null) => void): Promise<void> {
  READ_RUN_GUARDS.stats = true
  const startedAt = Date.now()
  let historyId: string | undefined
  let readFound = false
  const readDeadline = Date.now() + STATS_RUN_BUDGET_MS
  const expired = (): boolean => Date.now() >= readDeadline
  const availableMs = (maximum: number): number => {
    const remaining = readDeadline - Date.now()
    if (remaining <= 0) throw new Error('Stats run timed out')
    return Math.min(maximum, remaining)
  }

  // The read outlives the idle window: a 15s load wait plus a 12s hydration
  // poll per page, mostly silent (a tab listener and a page-side loop), so an
  // unheld worker could be evicted mid-read — killing the finally's tab sweep
  // (the read tabs stay open) and the lastStats write. Hold the keep-alive for
  // the whole read, like closeCapturedTabs does.
  holdKeepAlive()

  // Marks this run as the current activity so the popup's Stop button covers
  // it too; the returned epoch tells this run when it has been stopped.
  let myEpoch: number | null = null
  const stopped = (): Promise<boolean> => myEpoch == null ? Promise.resolve(false)
    : withDeadline(currentStopEpoch(), 3000, 'Stats stop check').then((v) => v !== myEpoch)
  // Check both sides of the async stop read: it too can outlive our budget.
  const unavailable = async (): Promise<boolean> => expired() || await stopped() || expired()
  const saveReadValue = (key: string, value: unknown): Promise<void> => {
    const timeout = availableMs(5000)
    return withDeadline(setLocal(key, value), timeout, 'Stats storage write')
  }
  const reportRead = (detail: string, ok: boolean, dump?: string): Promise<void> => {
    const timeout = availableMs(3000)
    return withDeadline(setLastStatsLog(detail, ok, dump), timeout, 'Stats log write')
  }

  // The tabs this run opened (closed in the finally). The shared capture list
  // is reset by every new run, so two overlapping bursts used to sweep each
  // other's tabs.
  const ownTabIds: number[] = []

  async function executeStatsScript<Args extends unknown[], Result>(
    injection: chrome.scripting.ScriptInjection<Args, Result>,
  ) {
    const timeout = availableMs(STATS_HYDRATION_MS + 5000)
    const result = await withDeadline(chrome.scripting.executeScript(injection), timeout, 'Stats reader')
    // A reply that arrived after suspension/timeout is not a fresh snapshot.
    if (expired()) throw new Error('Stats run timed out')
    return result
  }

  // Returns { tabId, stats } — stats may be null when the page never answered
  // — or null outright when the run was stopped (the merge and the dump both
  // treat that as "no page").
  async function readPage(url: string, waitMode: string, label: string): Promise<PageRead | null> {
    // React hydration needs a selected tab. Stay inside the user's existing
    // normal window without bringing that window to the OS foreground.
    const timeout = availableMs(10000)
    const tab = await withDeadline(createNormalTab(url), timeout, 'Stats tab opening')
    const tabId = tab.id
    if (tabId == null) {
      console.warn(`Stats: the ${label} tab opened without an id.`)
      return null
    }
    ownTabIds.push(tabId)

    // A stop that landed while the tab was opening. Stopping is not finishing:
    // the tab stays open and the injection never runs.
    if (await unavailable()) {
      console.log(`Stats: stopped while opening the ${label} tab.`)
      return null
    }

    const loadTimeout = availableMs(15000)
    const loaded = await withDeadline(waitForTabComplete(tabId, loadTimeout), loadTimeout, 'Stats page load')
    if (!loaded) console.warn(`Stats: ${label} page did not finish loading in time.`)

    // Stop checkpoint after the load wait: the injection is the part a stop is
    // meant to prevent.
    if (await unavailable()) {
      console.log(`Stats: stopped before the ${label} reader could run.`)
      return null
    }

    try {
      const [injection] = await executeStatsScript({
        target: { tabId },
        func: readRewardsStats,
        args: [STATS_HYDRATION_MS, waitMode],
      })
      return { tabId, stats: ((injection && injection.result) || null) as RawStats | null }
    } catch (e) {
      console.warn(`Stats: ${label} injection ended early:`, e)
      return { tabId, stats: null }
    }
  }

  // The dump contract, same as the other readers: when the Earn page answers
  // none of the four streaks, warn the markup the reader was staring at — the
  // live page drifts under a passing suite, and this is the only channel that
  // shows what it actually looked like. The evidence is also RETURNED — the
  // Activity row (setLastStatsLog) carries it as hover text.
  async function dumpEarnEvidence(tabId: number): Promise<{ url: string; streaksMarkup: string } | null> {
    if (readDeadline - Date.now() < 2000) return null
    try {
      const [injection] = await executeStatsScript({
        target: { tabId },
        func: () => {
          const section =
            document.getElementById('streaks') ||
            document.querySelector('.react-aria-DisclosurePanel') ||
            document.body
          return {
            url: location.href,
            streaksMarkup: section.outerHTML.slice(0, 1500),
          }
        },
      })
      if (injection && injection.result) {
        console.warn('Stats: the Earn page answered no streaks. Markup (report to dev):', injection.result)
      }
      return (injection && injection.result) || null
    } catch (e) {
      console.warn('Stats: could not dump the Earn page markup:', e)
      return null
    }
  }

  // The search-points breakdown refinement loop: a miss (merged.searchPoints ==
  // null) dumps the Today's points card — expanded by the read's own click —
  // from every read tab that still carries one, so the next matcher revision
  // gets written against that markup.
  async function dumpPointsEvidence(tabId: number): Promise<Record<string, unknown> | null> {
    if (readDeadline - Date.now() < 2000) return null
    try {
      const [injection] = await executeStatsScript({
        target: { tabId },
        func: () => {
          const labels = Array.from(document.querySelectorAll('p.text-labelControl'))
          const label = labels.find((el) =>
            /^today.?s points$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()),
          )
          const card = label ? label.closest('a, button') : null
          if (!card) return null
          const controlled = card.getAttribute('aria-controls')
          const panel = controlled ? document.getElementById(controlled) : null
          // The read's own press record plus the tab's visibility — the facts
          // that split "the press never registered" from "the flyout opened and
          // closed again" from "hidden tab" on the next live miss.
          const press = (
            window as {
              __meowPointsPress?: {
                presses: number
                everExpanded?: boolean
                everControlled?: boolean
                visibility?: string
              }
            }
          ).__meowPointsPress
          return {
            url: location.href,
            expanded: card.getAttribute('aria-expanded'),
            visibility: document.visibilityState,
            presses: press ? press.presses : 0,
            everExpanded: press ? !!press.everExpanded : false,
            everControlled: press ? !!press.everControlled : false,
            pressVisibility: press ? press.visibility || '' : '',
            cardMarkup: card.outerHTML.slice(0, 2000),
            panelMarkup: panel ? panel.outerHTML.slice(0, 2000) : null,
          }
        },
      })
      if (injection && injection.result) {
        console.warn(
          'Stats: the search-points breakdown did not answer. Markup (report to dev):',
          injection.result,
        )
      }
      return (injection && injection.result) || null
    } catch (e) {
      // A tab that already closed (the read's own sweep, a stop) is not a
      // refinement lead worth a warning of its own.
      console.warn('Stats: could not dump the points card markup:', e)
      return null
    }
  }

  try {
    myEpoch = await withDeadline(beginActivity('Stats'), availableMs(5000), 'Stats start')
    historyId = (await getLocal<{ routine?: { historyId?: string } }>(KEYS.runState).catch(() => undefined))?.routine?.historyId
    // Read selected tabs in sequence: two parallel readers would immediately
    // hide each other's page and reproduce the hydration stall. A tab selection
    // never calls windows.update({ focused: true }) or creates a taskbar window.
    const dashboardRead = await readPage(REWARDS_DASHBOARD, scope === 'search' ? 'search' : 'cards', 'dashboard')
    if (await unavailable()) return
    // A search decision only needs the points flyout. Earn remains a fallback
    // when the dashboard did not answer, and a full read still visits both.
    const earnRead = scope === 'full' || dashboardRead?.stats?.searchPoints == null
      ? await readPage(REWARDS_EARN, scope === 'search' ? 'search' : 'streaks', 'Earn') : null
    if (await unavailable()) return

    // The coupon trigger ("Coupon (N)") lives on the dashboard tab this read
    // has already waited out, so its own poll only needs to cover the
    // trigger's late render — not a full hydration. A null result (nothing
    // recognized) keeps the last good count.
    if (scope === 'full' && dashboardRead) try {
      const [couponInjection] = await executeStatsScript({
        target: { tabId: dashboardRead!.tabId },
        func: readCouponCount,
        args: [COUPON_READ_MS],
      })
      const couponCount = (couponInjection && couponInjection.result) as number | null
      if (typeof couponCount === 'number' && !(await unavailable())) {
        await saveReadValue(KEYS.lastCoupons, { at: Date.now(), available: couponCount })
      } else {
        console.warn('Coupons: the count read returned nothing; keeping the last count.')
      }
    } catch (e) {
      console.warn('Stats: the coupon count read ended early:', e)
    }

    if (await unavailable()) return

    const dashboardStats = dashboardRead && dashboardRead.stats
    const earnStats = earnRead && earnRead.stats

    // The Activity row's evidence: every miss reports WHY, not just that, and
    // carries the markup its reader stared at as the row's hover text.
    const problems: string[] = []
    const dumps: string[] = []
    if (dashboardStats == null) problems.push('the dashboard page did not answer')
    if (scope === 'full' && earnStats == null) problems.push('the Earn page did not answer')

    if (scope === 'full' && earnRead && Object.values((earnStats && earnStats.activities) || {}).every((v) => v == null)) {
      const evidence = await dumpEarnEvidence(earnRead.tabId)
      if (evidence) dumps.push(evidence.streaksMarkup || '')
      // Only when the page answered at all — a null read already reported
      // itself above as "did not answer".
      if (earnStats) problems.push('the Earn page answered no streaks')
    }

    const merged = mergeStats(dashboardStats, earnStats)

    // The breakdown refinement loop: only when neither page's panel answered,
    // and only on tabs still alive — the dump returns null on a page without
    // the card. The PROBLEM is only named when a page actually answered.
    if (merged.searchPoints == null) {
      for (const read of [dashboardRead, earnRead]) {
        if (!read) continue
        const evidence = await dumpPointsEvidence(read.tabId)
        if (evidence) {
          dumps.push(
            'expanded=' +
              evidence.expanded +
              ' ' +
              'visibility=' +
              evidence.visibility +
              ' ' +
              'presses=' +
              (evidence.presses || 0) +
              ' ' +
              'everExpanded=' +
              !!evidence.everExpanded +
              ' ' +
              'everControlled=' +
              !!evidence.everControlled +
              ' ' +
              (evidence.pressVisibility ? 'pressVisibility=' + evidence.pressVisibility + ' ' : '') +
              ((evidence.panelMarkup as string) || (evidence.cardMarkup as string) || ''),
          )
        }
      }
      if (dashboardStats != null || earnStats != null) {
        problems.push('the search-points breakdown did not answer')
      }
    }

    // An all-null merge is two pages that never answered, not a Rewards account
    // with nothing to show — store nothing rather than overwriting the last
    // good stats with empties and a fresh timestamp.
    const found = scope === 'search' ? merged.searchPoints != null :
      merged.availablePoints != null ||
      merged.readyToClaim != null ||
      merged.dailyStreak != null ||
      merged.stampBonus != null ||
      merged.searchPoints != null ||
      Object.values(merged.activities || {}).some((v) => v != null)

    if (await unavailable()) return
    if (found) {
      const collected: Stats = { ...merged, at: Date.now() }
      if (scope === 'full') {
        await saveReadValue(KEYS.lastStats, collected)
      } else {
        // Updating one field must not give stale activity/claim evidence a new
        // account-wide timestamp. Search callers receive fresh narrow evidence
        // directly; full-routine verdicts still require a full read.
        const previous = await withDeadline(getLocal<Stats>(KEYS.lastStats), availableMs(5000), 'Stats previous snapshot')
        await saveReadValue(KEYS.lastStats, { ...(previous || { ...merged, at: 0 }), searchPoints: merged.searchPoints })
      }
      publish(collected, myEpoch)
      readFound = true
      console.log(scope === 'full' ? 'Stats: read the dashboard and the Earn page.' : 'Stats: read search progress.')

      // The points history (ADR-020): one balance snapshot per local day — the
      // day's first and its latest — so the popup can show earned-today and a
      // trend line. Pure math in pure/history; this is the only write. A read
      // without a balance records nothing, keeping the last good snapshot.
      const points = scope === 'full' ? parsePoints(merged.availablePoints) : null
      if (points != null) {
        const history = await withDeadline(getLocal<HistoryEntry[]>(KEYS.pointsHistory), availableMs(5000), 'Stats history')
        if (!(await unavailable())) {
          await saveReadValue(KEYS.pointsHistory, recordDay(history, localDayKey(), points))
        }
      }
    } else {
      console.warn('Stats: the readers found nothing; keeping the last stats.')
    }

    // The row itself — but stopping is not failing: a stopped run reports
    // nothing (the user cancelled it; there is no outcome to log).
    if (!(await unavailable())) {
      await reportRead(
        problems.length
          ? 'Stats — ' + problems.join('; ') + '.'
          : found
            ? 'Stats — read the dashboard and the Earn page.'
            : 'Stats — the readers found nothing; kept the last stats.',
        problems.length === 0 && found,
        dumps.join('\n'),
      )
    }
  } catch (e) {
    console.warn('Stats: read failed; keeping the last stats:', e)
    if (!(await unavailable())) {
      await reportRead('Stats — read failed; kept the last stats.', false).catch((error) => console.warn('Stats: failure log write failed:', error))
    }
  } finally {
    // Closes only the tabs THIS run opened. A stopped run leaves them open —
    // stopping is not finishing.
    try {
      if (ownTabIds.length && !(await stopped())) {
        const settings = await withDeadline(getSettings(), 2000, 'Stats cleanup settings')
        const closed = await withDeadline(closeTabs(ownTabIds, settings.keepPinnedTabs, myEpoch ?? undefined), 5000, 'Stats tab cleanup')
        if (closed) console.log(`Closed ${closed} tab(s) opened by "stats".`)
      }
    } catch (e) {
      console.warn('Stats: tab cleanup failed:', e)
    } finally {
      await withDeadline(endActivity('Stats'), 2000, 'Stats activity cleanup').catch((e) => console.warn('Stats: activity cleanup failed:', e))
      releaseKeepAlive()
      READ_RUN_GUARDS.stats = false
      if (historyId) await withDeadline(recordRunEvent(historyId, 'stats/' + scope, readFound ? 'observed' : 'unknown',
        scope === 'full' ? 'Full account read' : 'Search-progress read', Date.now() - startedAt), 2000, 'Stats trace write').catch(console.warn)
    }
  }
}
