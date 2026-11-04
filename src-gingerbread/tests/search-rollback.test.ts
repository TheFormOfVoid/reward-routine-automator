import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { withDeadline, nextSearchRunId, SEARCH_MAX_ATTEMPTS, SEARCH_ATTEMPT_MS, SEARCH_PAGE_LEASE_MS } from '../src/background/pure/search-recovery.ts'
import { tickShouldRun } from '../src/background/pure/tick-guard.ts'

// Execute the real driver and storage boundary together, with only browser,
// network and scheduling effects replaced. This catches flags that are written
// by the driver but silently discarded when readRunState normalizes storage.
function harness(batchExtras: any = {}, stopAtLoad = false, options: any = {}) {
  let time = 1_000_000
  let stored: any = {
    v: 1, stopEpoch: 0, activity: null, routine: null, rightSizeRun: null,
    captures: { capturing: [], opened: {} },
    batch: options.noBatch ? null : { runId: 1, remaining: 4, tabId: 7, nextRunAt: 0, ...batchExtras },
    ...(options.routine ? { routine: { startDay: '1970-01-01', pendingSteps: ['claim'], pendingTabs: [], skipped: [], enabledSteps: ['search', 'claim'] } } : {}),
    ...(options.pauseBeforeStart ? { pause: { requestedAt: time } } : {}),
  }
  const injections: any[] = []
  const navigations: any[] = []
  const delays: number[] = []
  const typedSearch = () => {}
  const logs: any[] = []
  let url = 'https://www.bing.com/'
  let tailRuns = 0
  let created = 0
  let completeInjection: (() => void) | undefined
  const hOptions = options
  const context = createContext({
    console, structuredClone, Date: class extends Date { static now() { return time } }, tickShouldRun,
    SEARCH_MAX_ATTEMPTS, SEARCH_ATTEMPT_MS, SEARCH_PAGE_LEASE_MS, nextSearchRunId,
    withDeadline: (work: Promise<any>, ms: number, label: string) => options.timeoutAt === label
      ? (work.catch(() => {}), Promise.reject(new Error(`${label} timed out`))) : withDeadline(work, ms, label),
    URL,
    sleep: async (ms: number) => { time += ms },
    createNormalTab: async () => { created++; url = 'https://www.bing.com/'; return { id: 7 } },
    ensureBingTab: async () => { created++; return 7 },
    beginTabCapture: async () => {}, endTabCapture: async () => {}, claimTab: async () => {},
    closeCapturedTabs: async () => {}, holdKeepAlive: () => {}, releaseKeepAlive: () => {},
    runPendingStartupSteps: async () => { tailRuns++; if (options.tailStarts) await runInContext('startSearchBatch({count:2})', context) },
    setLastTabAction: async (...args: any[]) => { logs.push(args) },
    KEYS: { runState: 'runState', lastQuery: 'lastQuery' },
    chrome: {
      storage: { local: {
        get: async () => ({ runState: structuredClone(stored) }),
        set: async (value: any) => { stored = structuredClone(value.runState) },
      } },
      tabs: {
        get: async () => { if (options.tabClosed && !created) throw new Error('closed'); return {
          id: 7, status: 'complete', url: options.pendingUrl && !injections.length && !created ? '' : url,
          ...(options.pendingUrl && !injections.length && !created ? { pendingUrl: options.pendingUrl } : {}),
        } },
        update: async (...args: any[]) => { navigations.push(args) },
      },
      scripting: { executeScript: async (options: any) => {
        injections.push(options)
        if (hOptions.deferInjection && injections.length === 1) {
          return new Promise(resolve => { completeInjection = () => resolve([{ result: { ok: true, busyMs: 650 } }]) })
        }
        if (hOptions.throwInjection) throw new Error('injection failed')
        if (hOptions.neverInjection) return new Promise(() => {})
        if (!hOptions.noNavigation) url = `https://www.bing.com/search?q=${encodeURIComponent(options.args[0])}`
        return [{ result: hOptions.missingInput ? { ok: false, reason: 'missing-input' } : { ok: true, busyMs: 650 } }]
      } },
    },
    performHumanTypedSearchOnBing: typedSearch,
    waitForTabComplete: async () => {
      if (stopAtLoad) { stored.stopEpoch++; stored.batch = null }
      return true
    },
    awaitedQuery: async () => { if (options.stopAtQuery) { stored.stopEpoch++; stored.batch = null }; return { query: 'a meaningful query', api: 'fixture' } },
    setLocal: async () => {}, startKeepAlive: () => {}, startQueryPrefetch: () => {}, recordSubmittedQuery: async () => {},
    getSettings: async () => {
      if (options.stopAtSettings) { stored.stopEpoch++; stored.batch = null }
      return { minDelaySec: 5, maxDelaySec: 15, searchesPerBatch: 4, rightSizeSearchBatch: false }
    },
    randomDelayMillis: () => 5000,
    scheduleBeat: (delay: number) => { delays.push(delay) },
    cancelBeats: () => {},
  })
  for (const file of ['core/run-state.ts', 'routine/search.ts']) {
    const source = readFileSync(new URL(`../src/background/${file}`, import.meta.url), 'utf8')
    const script = stripTypeScriptTypes(source)
      .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
      .replace(/^export /gm, '')
    runInContext(script, context, { filename: file })
  }
  return {
    injections, navigations, delays, typedSearch, logs,
    created: () => created, tailRuns: () => tailRuns,
    completeInjection: () => completeInjection!(),
    advance: (ms: number) => { time += ms },
    async start() { await runInContext('startSearchBatch()', context); await new Promise(resolve => setImmediate(resolve)) },
    async stop() { await runInContext('stopAllActivity()', context) },
    async pause() { await runInContext('requestPause()', context) },
    async unpause() { await runInContext('clearPause()', context) },
    async resume() { await runInContext('resumeSearchBatch()', context) },
    state: () => stored,
    async tick() { await runInContext('tick()', context) },
    due() { stored.batch.nextRunAt = 0 },
  }
}

test('regular batches type the first and subsequent searches across storage reads', async () => {
  const h = harness()
  await h.tick()
  h.due()
  await h.tick()
  assert.equal(h.injections.length, 2)
  for (const injection of h.injections) {
    assert.equal(injection.target.tabId, 7)
    assert.equal(injection.func, h.typedSearch)
    assert.equal(injection.args[0], 'a meaningful query')
    assert.equal(injection.args[1].runId, 1)
    assert.ok(injection.args[1].expiresAt > 1_000_000)
  }
  assert.ok(h.navigations.every(([, patch]) => patch.active === true && !('url' in patch)))
  assert.equal(h.state().batch.remaining, 2)
  assert.deepEqual(h.delays, [SEARCH_ATTEMPT_MS, 5650, SEARCH_ATTEMPT_MS, 5650])
})

test('a batch left by the newer version still uses typing', async () => {
  const h = harness({ firstSearchDone: true })
  await h.tick()
  assert.equal(h.injections.length, 1)
  assert.ok(h.navigations.every(([, patch]) => patch.active === true && !('url' in patch)))
})

test('prowl batches retain typed searches', async () => {
  const h = harness({ prowl: true })
  await h.tick()
  assert.equal(h.injections.length, 1)
  assert.ok(h.navigations.every(([, patch]) => patch.active === true && !('url' in patch)))
  assert.equal(h.state().batch.prowl, true)
})

test('pause preserves remaining work at a safe boundary and resume continues it', async () => {
  const h = harness()
  await h.pause()
  await h.tick()
  assert.equal(h.injections.length, 0)
  assert.equal(h.state().batch.remaining, 4)
  assert.ok(h.state().pause.effectiveAt)
  assert.deepEqual(h.delays, [])
  await h.unpause()
  await h.resume()
  assert.equal(h.injections.length, 1)
  assert.equal(h.state().batch.remaining, 3)
  assert.equal(h.state().pause, undefined)
})

test('pause while a routine hands off search durably requeues its unstarted step', async () => {
  const h = harness({}, false, { noBatch: true, routine: true, pauseBeforeStart: true })
  await h.start()
  assert.equal(h.state().batch, null)
  assert.equal(h.created(), 0)
  assert.equal(h.state().routine.recovering, true)
  assert.deepEqual(Array.from(h.state().routine.pendingSteps), ['search', 'claim'])
  assert.ok(h.state().pause.effectiveAt)
})

test('Stop during initial batch settings read prevents opening or resurrecting a batch', async () => {
  const h = harness({}, false, { noBatch: true, stopAtSettings: true })
  await h.start()
  assert.equal(h.created(), 0)
  assert.equal(h.state().batch, null)
})

test('stopping while the page loads prevents typing and rescheduling', async () => {
  const h = harness({}, true)
  await h.tick()
  assert.equal(h.injections.length, 0)
  assert.ok(h.navigations.every(([, patch]) => patch.active === true && !('url' in patch)))
  assert.deepEqual(h.delays, [SEARCH_ATTEMPT_MS]) // only the pre-armed watchdog, no retry
  assert.equal(h.state().batch, null)
})

for (const options of [{ throwInjection: true }, { missingInput: true }, { noNavigation: true }, { neverInjection: true, timeoutAt: 'Search typing' }]) {
  test(`failed search retains remaining and persists bounded retries ${JSON.stringify(options)}`, async () => {
    const h = harness({}, false, options)
    for (let attempt = 1; attempt <= 3; attempt++) {
      h.due()
      await h.tick()
      if (attempt < 3) {
        assert.equal(h.state().batch.remaining, 4)
        assert.equal(h.state().batch.retryCount, attempt)
        assert.equal(h.state().batch.attemptStartedAt, 0)
        assert.equal(h.state().batch.pendingQuery.query, 'a meaningful query')
      }
    }
    assert.equal(h.state().batch, null)
    assert.equal(h.tailRuns(), 1)
    assert.match(h.logs.at(-1)[0], /failed after 3 attempts/)
    assert.equal(h.logs.at(-1)[1], false)
  })
}

test('query generation timeout retries without injecting or counting', async () => {
  const h = harness({}, false, { timeoutAt: 'Search query' })
  await h.tick()
  assert.equal(h.injections.length, 0)
  assert.equal(h.state().batch.remaining, 4)
  assert.equal(h.state().batch.retryCount, 1)
})

test('Stop while awaiting a query blocks the next injection', async () => {
  const h = harness({}, false, { stopAtQuery: true })
  await h.tick()
  assert.equal(h.injections.length, 0)
  assert.equal(h.state().batch, null)
  assert.equal(h.tailRuns(), 0)
})

test('closed search tab is replaced in a normal active tab and still types', async () => {
  const h = harness({}, false, { tabClosed: true })
  await h.tick()
  assert.equal(h.created(), 1)
  assert.equal(h.injections.length, 1)
  assert.equal(h.state().batch.remaining, 3)
})

test('a newly created Bing tab with only pendingUrl is reused without an extra tab', async () => {
  const h = harness({}, false, { pendingUrl: 'https://www.bing.com/' })
  await h.tick()
  assert.equal(h.created(), 0)
  assert.equal(h.injections.length, 1)
  assert.equal(h.state().batch.remaining, 3)
})

test('a pending manual navigation away is replaced before typing', async () => {
  const h = harness({}, false, { pendingUrl: 'https://example.com/' })
  await h.tick()
  assert.equal(h.created(), 1)
  assert.equal(h.injections.length, 1)
})

test('worker wake waits for persisted typing lease before retrying an interrupted attempt', async () => {
  const h = harness({ attemptId: 2, attemptStartedAt: 990000 })
  await h.resume()
  assert.equal(h.injections.length, 0)
  h.advance(SEARCH_ATTEMPT_MS)
  await h.tick()
  assert.equal(h.state().batch.retryCount, 1)
  assert.equal(h.state().batch.remaining, 4)
  h.due()
  await h.tick()
  assert.equal(h.injections.length, 1)
  assert.equal(h.state().batch.attemptId, 3)
})

test('duplicate Start shares setup and does not replace an active batch', async () => {
  const h = harness()
  await Promise.all([h.start(), h.start()])
  assert.equal(h.created(), 0)
  assert.equal(h.state().batch.runId, 1)
})

test('a fresh batch arms a watchdog and Stop/restart never reuses its run id', async () => {
  const h = harness({}, false, { noBatch: true })
  await Promise.all([h.start(), h.start()])
  const firstId = h.state().batch.runId
  assert.equal(h.created(), 1)
  assert.ok(h.delays.includes(SEARCH_ATTEMPT_MS))
  await h.stop()
  await h.start()
  assert.ok(h.state().batch.runId > firstId)
})

test('deadline helper rejects a never-resolving effect without waiting forever', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 5, 'fixture'), /fixture timed out/)
  assert.equal(await withDeadline(Promise.resolve(7), 5, 'fixture'), 7)
})

test('Stop fences a late old injection and new batch uses a distinct legacy run id', async () => {
  const h = harness({ runId: 17 }, false, { deferInjection: true })
  const oldTick = h.tick()
  await new Promise(resolve => setImmediate(resolve))
  await h.stop()
  await h.start()
  const newId = h.state().batch.runId
  assert.ok(newId > 17)
  h.completeInjection()
  await oldTick
  assert.equal(h.state().batch.runId, newId)
  assert.equal(h.state().batch.remaining, 4)
  await h.tick()
  assert.equal(h.state().batch.remaining, 3)
})

test('finished search releases its ownership before final routine retries start a new batch', async () => {
  const h = harness({ remaining: 1 }, false, { tailStarts: true })
  await h.tick()
  assert.equal(h.tailRuns(), 1)
  assert.equal(h.state().batch.runId, 2)
  assert.equal(h.state().batch.remaining, 2)
  assert.equal(h.delays.at(-1), 0, 'next-task beat survives the old tick reentrancy guard')
  await h.tick()
  assert.equal(h.injections.length, 2)
  assert.equal(h.state().batch.remaining, 1)
})
