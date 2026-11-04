// The web-search batch: start, tick, finish, and the right-sizing
// verification loop (ADR-016). All run-state lives in the one document
// (core/run-state.ts); the verdicts are pure (pure/verdicts.ts) and this
// module is their driver — it performs the effects the verdicts describe.

import { readRunState, updateRunState, currentStopEpoch, isStaleBatch, pauseBoundary, reserveRecoveryActions } from '../core/run-state.ts'
import { getSettings } from '../../shared/settings.ts'
import { startKeepAlive, holdKeepAlive, releaseKeepAlive } from '../core/keepalive.ts'
import { scheduleBeat, cancelBeats } from '../core/alarms.ts'
import { randomDelayMillis, sleep } from '../core/delays.ts'
import {
  beginTabCapture,
  endTabCapture,
  claimTab,
  ensureBingTab,
  waitForTabComplete,
  closeCapturedTabs,
} from '../core/tabs.ts'
import { setLastTabAction } from '../core/log.ts'
import { recordRunEvent } from '../core/run-history.ts'
import { rightSizedCount, judgeSettlement, progressPair, POINTS_PER_SEARCH } from '../pure/verdicts.ts'
import type { SizedBatch } from '../pure/verdicts.ts'
import { tickShouldRun } from '../pure/tick-guard.ts'
import { withDeadline, SEARCH_MAX_ATTEMPTS, SEARCH_ATTEMPT_MS, SEARCH_PAGE_LEASE_MS, nextSearchRunId } from '../pure/search-recovery.ts'
import { createNormalTab } from '../core/normal-tabs.ts'
import { awaitedQuery, startQueryPrefetch, recordSubmittedQuery } from '../queries/chain.ts'
import { performHumanTypedSearchOnBing } from '../injections/typed-search.ts'
import { KEYS, getLocal, setLocal } from '../../shared/storage.ts'
import type { Stats } from '../../shared/storage.ts'
import { refreshStats } from './reads.ts'
import { runPendingStartupSteps } from './routine.ts'

// The verification loop's bounds: at most this many batches per loop, and a
// settle wait before the post-batch read — Bing credits a search within
// seconds, and reading immediately would misjudge the last one as not
// counted.
const RIGHT_SIZE_MAX_ROUNDS = 3
const RIGHT_SIZE_SETTLE_MS = 10000
// A read this old is not 'the read that started this loop' — round 2+ skips
// the pre-batch read only while its own starting read is seconds fresh.
const FRESH_AT_WINDOW_MS = 120000

// Start a new batch of web searches. The optional overrides serve the prowl
// (routine/prowl.ts): a random 2–5 count instead of searchesPerBatch, and the
// prowl flag — no verification rounds and no startup-steps
// tail on finish (a random midday batch must not trigger the routine).
let startingBatch: Promise<void> | null = null
let finishingBatch = false

async function pauseSearchSetup(epoch: number): Promise<boolean> {
  if (!(await pauseBoundary())) return false
  // A routine may already have shifted search out of its queue when the
  // request arrives. Before acknowledging setup, put the unstarted step back
  // durably so Resume has work to hand off rather than waiting for a lease.
  await updateRunState(state => {
    if (state.stopEpoch !== epoch || !state.pause || !state.routine || state.batch) return
    state.routine.pendingSteps = ['search', ...state.routine.pendingSteps.filter(step => step !== 'search')]
    state.routine.recovering = true
  })
  return true
}

export function startSearchBatch(opts: { count?: number; prowl?: boolean; continuation?: boolean } = {}): Promise<void> {
  if (finishingBatch && !opts.continuation) return Promise.resolve()
  if (startingBatch) return startingBatch
  startingBatch = startBatch(opts).finally(() => { startingBatch = null })
  return startingBatch
}

async function startBatch(opts: { count?: number; prowl?: boolean; continuation?: boolean }): Promise<void> {
  const running = await readRunState()
  const myEpoch = running.stopEpoch
  if (finishingBatch && !opts.continuation) return
  if (running.batch && !opts.continuation) return
  if (await currentStopEpoch() !== myEpoch) return
  if (!opts.continuation && await pauseSearchSetup(running.stopEpoch)) return
  cancelBeats()

  // Stop checkpoint, covering both callers: a stop landing between the
  // routine's own checkpoint (or the popup's click) and the batch write below
  // would otherwise resurrect a batch the user just stopped. The epoch is
  // stable across the setup awaits unless a stop actually happened.
  const settings = await getSettings()
  const previous = await readRunState()
  if (previous.stopEpoch !== myEpoch) return
  const perBatch = Math.max(1, opts.count ?? (Math.floor(settings.searchesPerBatch) || 1))

  // Right-sizing: a FRESH read first — the user's spec is 'check how many
  // points there are before it starts the batch', not 'trust whatever the
  // last read happened to leave'. Rounds 2+ of the verification loop skip
  // it: the read that started them is seconds old (freshAt).
  const priorRun = previous.rightSizeRun
  const continuingRun =
    priorRun && Number.isFinite(priorRun.freshAt) && Date.now() - (priorRun.freshAt as number) < FRESH_AT_WINDOW_MS
      ? priorRun
      : null

  let sized: SizedBatch = { count: perBatch, pair: null, trimmed: false }
  if (settings.rightSizeSearchBatch) {
    let freshStats: Stats | null = null
    if (!continuingRun) {
      const read = await withDeadline(refreshStats({ scope: 'search', notBefore: Date.now() }), 90000, 'Pre-search stats read')
      freshStats = read.stats
      // A stop during the read must not go on to open a batch.
      if ((await currentStopEpoch()) !== myEpoch) {
        console.log('Search batch: stopped during the pre-batch read.')
        return
      }
    } else {
      // This continuation's pair came from its immediately preceding read.
      // Preserve that collection time instead of relabeling an older full
      // account snapshot as fresh merely to size the next batch.
      freshStats = { ...(await getLocal<Stats>(KEYS.lastStats)),
        at: continuingRun.freshAt, searchPoints: continuingRun.pair.join('/') } as Stats
    }
    sized = rightSizedCount(freshStats, perBatch)
  }

  const { count: batchCount, pair, trimmed } = sized
  if (!opts.continuation && await pauseSearchSetup(myEpoch)) return
  if (trimmed && pair) {
    // The search step owns no Activity row, so its news rides the Tabs row —
    // the same row its skip note lands in.
    await setLastTabAction(
      `Search — right-sized to ${batchCount} of ${perBatch} searches (${pair[0]}/${pair[1]} points)`,
      null,
    )
  }

  await beginTabCapture('search')
  // Activate the normal tab for rendering, without focusing its browser window.
  const tabId = await ensureBingTab(previous.batch ? previous.batch.tabId : null, false)
  await claimTab('search', tabId)

  if ((await currentStopEpoch()) !== myEpoch) {
    // Stopped during the setup awaits. Release the capture but leave the tabs
    // open — stopping is not finishing — and never mark the batch running.
    await endTabCapture('search')
    console.log('Search batch: stopped while starting; no searches will run.')
    return
  }

  // The loop's state: written whenever the batch started from a readable
  // partial pair (trimmed or not — 'some searches do not count' needs
  // verifying either way), cleared when sizing is off, the read couldn't
  // produce a pair, or the batch is a prowl (a random 2–5-search background
  // batch must not spin the verification loop, whose round 2+ would run the
  // day's whole remaining cap). The batch field IS the 'running' marker —
  // batch != null. Writing it also clears any manual activity: the batch owns
  // the document now, exactly the v1 'label: null' marker, made structural.
  await updateRunState((state) => {
    if (state.stopEpoch !== myEpoch) return
    state.batchSequence = nextSearchRunId(state.batchSequence, state.batch?.runId)
    state.activity = null
    state.rightSizeRun =
      settings.rightSizeSearchBatch && pair && !opts.prowl
        ? { round: continuingRun ? continuingRun.round : 1, pair }
        : null
    state.batch = {
      runId: state.batchSequence,
      remaining: batchCount,
      tabId,
      nextRunAt: Date.now(),
      ...(opts.prowl ? { prowl: true } : {}),
    }
  })

  startKeepAlive()
  // Arm the durable backstop BEFORE the first await inside a search tick.
  scheduleBeat(0, () => { void tick().catch(console.warn) })
  startQueryPrefetch() // the first search types without waiting on the chain
  void tick().catch((error) => console.warn('Search tick failed:', error))
}

export async function resumeSearchBatch(): Promise<void> {
  if (!(await readRunState()).batch) return
  startKeepAlive()
  scheduleBeat(SEARCH_ATTEMPT_MS, () => { void tick().catch(console.warn) })
  await tick()
}

// One beat of the loop: run one search, schedule the next.
//
// Re-entrancy guard (tickShouldRun, pure/tick-guard.ts): normally a beat that
// arrives while one is still running is skipped — the in-flight tick's tail
// calls scheduleBeat, so the batch keeps its next beat. But the guard is
// time-boxed rather than a bare boolean: if an await here never settles (a hung
// executeScript against a navigating tab) while the keep-alive holds the worker
// up, a boolean would wedge the whole batch — every watchdog beat no-ops and
// the batch stalls mid-way (user report: "sometimes the search stuck at half
// the searches"). Past the stall ceiling the next beat takes over; the wedged
// tick, if it ever un-hangs, finds its token stale (so it clears nothing) and
// its state writes are runId-guarded either way.
let tickToken = 0
let tickStartedAt = 0 // 0 = no tick in flight; otherwise Date.now() at its start

// A confirmed URL transition is a submission receipt, never a points claim.
async function waitForSearchNavigation(tabId: number, query: string): Promise<void> {
  const until = Date.now() + 10000
  while (Date.now() < until) {
    const tab = await withDeadline(chrome.tabs.get(tabId), 5000, 'Search navigation read')
    try {
      const url = new URL(tab.url || '')
      if ((url.hostname === 'bing.com' || url.hostname.endsWith('.bing.com')) &&
          url.pathname === '/search' && url.searchParams.get('q') === query) return
    } catch { /* The page has not committed a URL yet. */ }
    await sleep(250)
  }
  throw new Error('Search did not navigate to its results')
}

async function failSearchAttempt(runId: number, attemptId: number, reason: string): Promise<void> {
  let exhausted = false
  let accepted = false
  let prowl = false
  let tabId: number | null = null
  let historyId: string | undefined
  const epoch = await currentStopEpoch()
  await updateRunState((state) => {
    const batch = state.batch
    if (!batch || batch.runId !== runId || batch.attemptId !== attemptId) return
    accepted = true
    historyId = state.routine?.historyId
    batch.retryCount = (batch.retryCount || 0) + 1
    batch.attemptStartedAt = 0
    batch.nextRunAt = Date.now() + 5000
    exhausted = batch.retryCount >= SEARCH_MAX_ATTEMPTS
    prowl = batch.prowl === true
    tabId = batch.tabId
    if (exhausted) {
      state.rightSizeRun = null
    }
  })
  if (!accepted) return
  if (historyId) await withDeadline(recordRunEvent(historyId, 'search', 'retry', reason), 2000, 'Search retry trace').catch(console.warn)
  if (!exhausted && !(await reserveRecoveryActions())) {
    exhausted = true
    reason = 'routine recovery budget reached'
    await updateRunState(state => {
      if (state.batch?.runId === runId) {
        state.batch.retryCount = SEARCH_MAX_ATTEMPTS
        state.rightSizeRun = null
      }
    })
  }
  if (!exhausted && await pauseBoundary()) { cancelBeats(); return }
  // Replace an unusable page with Bing's home page before retrying. This also
  // destroys any old page timers if executeScript rejected mid-navigation.
  if (!exhausted && tabId != null && !(await isStaleBatch(runId))) {
    await withDeadline(chrome.tabs.update(tabId, { url: 'https://www.bing.com/', active: true }), 5000, 'Search retry reset')
      .catch((error) => console.warn('Search page reset failed:', error))
  }
  await setLastTabAction(exhausted
    ? `Search failed after ${SEARCH_MAX_ATTEMPTS} attempts; unfinished searches were not counted: ${reason}`
    : `Search retry scheduled; unfinished search was not counted: ${reason}`, false)
  if ((await currentStopEpoch()) !== epoch || await isStaleBatch(runId)) return
  if (!exhausted) { scheduleBeat(5000, () => { void tick().catch(console.warn) }); return }
  finishingBatch = true
  try {
    if (await isStaleBatch(runId)) return
    cancelBeats()
    await withDeadline(closeCapturedTabs('search', 'closeTabsAfterSearch'), 45000, 'Failed search tab cleanup')
      .catch((error) => console.warn('Failed search tab cleanup:', error))
    await updateRunState((state) => {
      if (state.batch?.runId === runId && state.stopEpoch === epoch) state.batch = null
    })
    await setLastTabAction(`Search failed after ${SEARCH_MAX_ATTEMPTS} attempts; unfinished searches were not counted: ${reason}`, false)
  } finally { finishingBatch = false }
  if (!prowl && (await currentStopEpoch()) === epoch) await runPendingStartupSteps()
}

export async function tick(): Promise<void> {
  const now = Date.now()
  if (!tickShouldRun(tickStartedAt, now)) return
  const myToken = ++tickToken
  tickStartedAt = now
  let runId: number | null = null
  let attemptId = 0
  try {
    const state = await readRunState()
    const batch = state.batch
    if (!batch) { cancelBeats(); return }
    if (!batch.attemptStartedAt && await pauseBoundary()) { cancelBeats(); return }
    runId = batch.runId
    if (batch.remaining <= 0) { await finishBatch(batch.prowl === true, runId); return }
    if ((batch.retryCount || 0) >= SEARCH_MAX_ATTEMPTS) {
      await failSearchAttempt(runId, batch.attemptId || 0, 'retry limit reached before interruption')
      return
    }
    const remainingWait = (batch.nextRunAt || 0) - Date.now()
    if (remainingWait > 500) { scheduleBeat(remainingWait, () => { void tick().catch(console.warn) }); return }
    startKeepAlive()
    // After worker eviction, the old page-side injection may still be alive.
    // Wait out its lease instead of starting a second typing loop on that page.
    if (batch.attemptStartedAt) {
      const wait = batch.attemptStartedAt + SEARCH_ATTEMPT_MS - Date.now()
      if (wait > 0) { scheduleBeat(wait, () => { void tick().catch(console.warn) }); return }
      await failSearchAttempt(runId, batch.attemptId || 0, 'interrupted attempt expired')
      return
    }
    const attemptStartedAt = Date.now()
    let claimed = false
    await updateRunState((s) => {
      if (!s.batch || s.batch.runId !== runId || s.batch.attemptStartedAt) return
      attemptId = (s.batch.attemptId || 0) + 1
      s.batch.attemptId = attemptId
      s.batch.attemptStartedAt = attemptStartedAt
      claimed = true
    })
    if (!claimed) return
    scheduleBeat(SEARCH_ATTEMPT_MS, () => { void tick().catch(console.warn) })
    const stale = async () => {
      if (myToken !== tickToken) return true
      const latest = await readRunState()
      return !latest.batch || latest.batch.runId !== runId || latest.batch.attemptId !== attemptId ||
        latest.batch.attemptStartedAt !== attemptStartedAt
    }
    const perform = async (): Promise<number> => {
      let tabId = batch.tabId
      try {
        if (tabId == null) throw new Error('missing search tab')
        const tab = await chrome.tabs.get(tabId)
        // tabs.create can reply before its navigation commits, with an empty
        // url and a valid pendingUrl. Prefer pendingUrl so an intentional
        // navigation away is also detected before touching the user's page.
        const destination = new URL(tab.pendingUrl || tab.url || '')
        if (destination.protocol !== 'https:' ||
            !(destination.hostname === 'bing.com' || destination.hostname.endsWith('.bing.com'))) {
          throw new Error('search tab navigated away')
        }
      } catch {
        if (await stale()) throw new Error('stopped')
        const tab = await createNormalTab('https://www.bing.com/', true)
        tabId = tab.id ?? null
        if (tabId == null) throw new Error('No search tab was created')
        await claimTab('search', tabId)
        const replacementId = tabId
        await updateRunState((s) => {
          if (s.batch?.runId === runId && s.batch.attemptId === attemptId && s.batch.attemptStartedAt === attemptStartedAt) s.batch.tabId = replacementId
        })
      }
      if (await stale()) throw new Error('stopped')
      await chrome.tabs.update(tabId!, { active: true })
      if (!(await waitForTabComplete(tabId!))) throw new Error('Search page did not finish loading')
      if (await stale()) throw new Error('stopped')
      const selected = batch.pendingQuery || await withDeadline(awaitedQuery(), 30000, 'Search query')
      if (!selected.query || typeof selected.query !== 'string') throw new Error('No usable search query')
      const query = selected.query.slice(0, 90)
      await updateRunState((s) => {
        if (s.batch?.runId === runId && s.batch.attemptId === attemptId && s.batch.attemptStartedAt === attemptStartedAt) s.batch.pendingQuery = { query, api: selected.api }
      })
      if (await stale()) throw new Error('stopped')
      await setLocal(KEYS.lastQuery, { api: selected.api, text: query })
      const expiresAt = Math.min(Date.now() + SEARCH_PAGE_LEASE_MS, attemptStartedAt + SEARCH_ATTEMPT_MS - 10000)
      if (expiresAt <= Date.now()) throw new Error('Search typing lease expired')
      const [injection] = await withDeadline(chrome.scripting.executeScript({
        target: { tabId: tabId! },
        func: performHumanTypedSearchOnBing,
        args: [query, { runId: runId!, attemptId, stopEpoch: state.stopEpoch, expiresAt }],
      }), SEARCH_PAGE_LEASE_MS + 5000, 'Search typing')
      if (!injection?.result?.ok) throw new Error(injection?.result?.reason || 'Search input or submission unavailable')
      if (await stale()) throw new Error('stopped')
      await waitForSearchNavigation(tabId!, query)
      await withDeadline(recordSubmittedQuery(query), 2000, 'Query history write').catch(error => console.warn('Search history write failed:', error))
      return Number(injection.result.busyMs) || 0
    }
    const busyMs = await withDeadline(perform(), SEARCH_ATTEMPT_MS, 'Search attempt')
    if (await stale()) return
    const settings = await getSettings()
    const delay = busyMs + randomDelayMillis(settings.minDelaySec, settings.maxDelaySec)
    let remaining = -1
    await updateRunState((s) => {
      if (s.batch?.runId !== runId || s.batch.attemptId !== attemptId) return
      remaining = s.batch.remaining = Math.max(0, s.batch.remaining - 1)
      s.batch.retryCount = 0
      s.batch.attemptStartedAt = 0
      delete s.batch.pendingQuery
      s.batch.nextRunAt = Date.now() + delay
    })
    if (remaining < 0) return
    if (state.routine?.historyId) await withDeadline(recordRunEvent(state.routine.historyId, 'search', 'submitted',
      `Results navigation confirmed; ${remaining} submissions remaining`, Date.now() - attemptStartedAt), 2000, 'Search submission trace').catch(console.warn)
    // The current effect is committed now. A pause need not sit through the
    // inter-search delay before it can acknowledge this safe boundary.
    if (await pauseBoundary()) { cancelBeats(); return }
    startQueryPrefetch()
    if (remaining === 0) { await finishBatch(batch.prowl === true, runId!); return }
    scheduleBeat(delay, () => { void tick().catch(console.warn) })
  } catch (error) {
    if (runId != null && attemptId && myToken === tickToken) {
      await failSearchAttempt(runId, attemptId, error instanceof Error ? error.message : String(error))
    } else {
      console.warn('Search beat failed; watchdog will retry:', error)
    }
  } finally {
    if (tickToken === myToken) tickStartedAt = 0
  }
}

// The post-batch half of right-sizing: re-read the points the batch actually
// reached and, if the cap is still short but the points MOVED, start another
// right-sized batch (some searches not counting is exactly the case the
// pre-batch arithmetic can't see). Returns 'continue' when it started one —
// the caller must then not run the normal batch-end path, because that
// batch's own finishBatch owns it now.
//
// The loop ends at the cap, at no movement between reads, or at
// RIGHT_SIZE_MAX_ROUNDS; every ending clears rightSizeRun so a later batch
// starts a loop of its own. The judgment itself is judgeSettlement
// (pure/verdicts.ts); this is its effectful driver.
async function settleRightSizedRun(runId: number): Promise<'done' | 'stopped' | 'continue'> {
  const settings = await getSettings()
  if (!settings.rightSizeSearchBatch) return 'done'

  const state = await readRunState()
  const run = state.rightSizeRun
  if (!run || !Array.isArray(run.pair)) return 'done'

  const myEpoch = await currentStopEpoch()

  await sleep(RIGHT_SIZE_SETTLE_MS)
  if ((await currentStopEpoch()) !== myEpoch || await isStaleBatch(runId)) return 'stopped'

  const read = await withDeadline(refreshStats({ scope: 'search', notBefore: Date.now() }), 90000, 'Post-search stats read')
  if ((await currentStopEpoch()) !== myEpoch || await isStaleBatch(runId)) return 'stopped'

  const stats = read.stats
  const nowPair = stats ? progressPair(stats.searchPoints) : null
  // The loop state is consumed here whatever the verdict — the rounds below
  // write their own, and a 'done' leaves the field clear for a later batch.
  await updateRunState((s) => {
    if (s.batch?.runId === runId) s.rightSizeRun = null
  })

  const decision = judgeSettlement(run, nowPair, RIGHT_SIZE_MAX_ROUNDS, POINTS_PER_SEARCH)
  if (decision.note) await setLastTabAction(decision.note, decision.ok ?? null)
  if (decision.verdict !== 'continue') return 'done'
  if (!(await reserveRecoveryActions())) {
    await setLastTabAction('Search verification stopped: routine recovery budget reached', false)
    return 'done'
  }

  // Short of the cap, but the points moved: run what's still needed. The
  // round-N tabs are dealt with exactly as any finished search step's are
  // (perStep closes them; routine mode stashes them for the end sweep), and
  // freshAt tells startSearchBatch its read is seconds old. A 'continue'
  // verdict is only returned by judgeSettlement when nowPair moved, so it is
  // non-null here — the assertion is that contract.
  await withDeadline(closeCapturedTabs('search', 'closeTabsAfterSearch'), 45000, 'Search round tab cleanup')
  if ((await currentStopEpoch()) !== myEpoch || await isStaleBatch(runId)) return 'stopped'
  await updateRunState((s) => {
    if (s.batch?.runId === runId) s.rightSizeRun = { round: run.round + 1, pair: nowPair as [number, number], freshAt: Date.now() }
  })
  await startSearchBatch({ continuation: true })
  return 'continue'
}

async function finishBatch(prowl: boolean, runId: number): Promise<void> {
  if (await isStaleBatch(runId)) return
  const myEpoch = await currentStopEpoch()
  scheduleBeat(180000, () => { void tick().catch(console.warn) })

  // Keep both the watchdog and a hold until verification has completed. The
  // persisted remaining=0 lets a revived worker finish rather than search again.
  holdKeepAlive()
  finishingBatch = true
  try {
    // The verification loop: a right-sized batch re-reads what it reached and
    // may start another. On 'continue' this finishBatch is done — the new
    // batch's own finishBatch runs the normal end path.
    const verdict = await settleRightSizedRun(runId).catch((e) => {
      console.warn('Search verification failed:', e)
      return 'done' as const
    })
    if (verdict === 'continue' || verdict === 'stopped' || await isStaleBatch(runId)) return

    let cleared = false
    await updateRunState((state) => {
      if (state.batch?.runId !== runId || state.stopEpoch !== myEpoch) return
      state.batch = null
      state.rightSizeRun = null
      state.activity = null
      cleared = true
    })
    if (!cleared) return
    cancelBeats()

    // The remaining startup steps run long enough that the worker could be
    // evicted mid-flight. A prowl batch skips the tail — a random midday
    // mini-batch must not run the routine's pending steps as a side effect.
    await withDeadline(closeCapturedTabs('search', 'closeTabsAfterSearch'), 45000, 'Search finish tab cleanup')
      .catch((error) => console.warn('Search finish tab cleanup:', error))
    finishingBatch = false
    if (!prowl && (await currentStopEpoch()) === myEpoch) await runPendingStartupSteps()
  } finally {
    finishingBatch = false
    releaseKeepAlive()
  }
}
