import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts'
import { remainingSteps } from '../src/background/pure/remaining.ts'
import { progressPair, rightSizedCount } from '../src/background/pure/verdicts.ts'

function harness(options: { effective?: boolean; missingStats?: boolean; stopDuringRead?: boolean; searchPoints?: string; fixed?: boolean } = {}) {
  let state: any = { v: 1, stopEpoch: 1, activity: null, batch: { runId: 2, remaining: 4, tabId: 5, nextRunAt: 0 }, routine: null, rightSizeRun: null,
    pause: { requestedAt: 10, ...(options.effective ? { effectiveAt: 11 } : {}) }, captures: { capturing: [], opened: {} } }
  let reads = 0, resumedSearch = 0, resumedRoutine = 0, writes = 0
  const context = createContext({
    console, Date, structuredClone, Math,
    KEYS: { runState: 'runState' },
    chrome: { storage: { local: { get: async () => ({ runState: structuredClone(state) }), set: async (obj: any) => { state = obj.runState; writes++ } } }, alarms: { create: async () => {} } },
    refreshStats: async () => {
      reads++
      if (options.stopDuringRead) { state.stopEpoch++; state.pause = undefined; state.batch = null }
      return { startedAt: Date.now() - 1, completedAt: Date.now(), stats: options.missingStats ? null : { at: Date.now(), searchPoints: options.searchPoints || '57/60', activities: {} } }
    },
    resumeSearchBatch: async () => { resumedSearch++ }, resumeRoutineRecovery: async () => { resumedRoutine++ },
    runStartupSequence: async () => {}, getSettings: async () => ({ ...DEFAULT_SETTINGS, rightSizeSearchBatch: !options.fixed }), remainingSteps, rightSizedCount, progressPair,
    recordRunEvent: async () => {}, ROUTINE_RECOVERY_ALARM: 'recovery',
  })
  for (const relative of ['core/run-state.ts', 'routine/controls.ts']) {
    const source = readFileSync(new URL(`../src/background/${relative}`, import.meta.url), 'utf8')
    const js = stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '').replace(/^export \{[^}]+\}\s*$/gm, '').replace(/^export /gm, '')
    runInContext(js, context)
  }
  return { state: () => state, clearPause: () => { delete state.pause }, reads: () => reads, resumed: () => resumedSearch + resumedRoutine, writes: () => writes,
    call: (code: string) => runInContext(code, context) }
}

test('cancelling a pending pause never invokes a second owner or reads a competing page', async () => {
  const h = harness()
  await h.call('resumeActivity()')
  assert.equal(h.state().pause, undefined)
  assert.equal(h.reads(), 0)
  assert.equal(h.resumed(), 0)
})

test('effective pause resumes only after fresh verification and duplicate resumes share one operation', async () => {
  const h = harness({ effective: true })
  await Promise.all([h.call('resumeActivity()'), h.call('resumeActivity()')])
  assert.equal(h.reads(), 1)
  assert.equal(h.state().pause, undefined)
  assert.equal(h.resumed(), 2)
  assert.equal(h.state().batch.remaining, 1)
})

test('automatic resume respects newly completed search credit while fixed-count batches retain their count', async () => {
  const automatic = harness({ effective: true, searchPoints: '60/60' })
  await automatic.call('resumeActivity()')
  assert.equal(automatic.state().batch.remaining, 0)
  const fixed = harness({ effective: true, fixed: true, searchPoints: '60/60' })
  await fixed.call('resumeActivity()')
  assert.equal(fixed.state().batch.remaining, 4)
})

test('failed resume verification leaves the durable pause intact', async () => {
  const h = harness({ effective: true, missingStats: true })
  await assert.rejects(h.call('resumeActivity()'), /remains paused/)
  assert.ok(h.state().pause.effectiveAt)
  assert.equal(h.resumed(), 0)
})

test('Stop during resume verification never resumes cleared work', async () => {
  const h = harness({ effective: true, stopDuringRead: true })
  await h.call('resumeActivity()')
  assert.equal(h.resumed(), 0)
  assert.equal(h.state().batch, null)
})

test('pause normalization survives worker wake and no-op boundaries do not write', async () => {
  const h = harness()
  await h.call('pauseBoundary()')
  assert.ok((await h.call('readRunState()')).pause.effectiveAt)
  const writes = h.writes()
  await h.call('pauseBoundary()')
  assert.equal(h.writes(), writes)
  h.clearPause()
  await h.call('pauseBoundary()')
  assert.equal(h.writes(), writes)
})

test('standalone manual activities cannot create an idle durable pause', async () => {
  const h = harness()
  h.state().batch = null
  h.state().activity = { label: 'Orders' }
  h.clearPause()
  await assert.rejects(h.call('requestPause()'), /search batch or routine/)
  assert.equal(h.state().pause, undefined)
})

test('routine-wide recovery budget is serialized and shared across concurrent reservations', async () => {
  const h = harness()
  h.state().routine = { startDay: '2026-10-28', pendingSteps: [], pendingTabs: [], skipped: [], recoveryActions: 11, startedAt: Date.now() }
  const results = await Promise.all([h.call('reserveRecoveryActions()'), h.call('reserveRecoveryActions()')])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(h.state().routine.recoveryActions, 12)
})
