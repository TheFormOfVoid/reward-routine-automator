import test from 'node:test'
import assert from 'node:assert/strict'
import { inQuietHours, quietHoursEndAt, estimateRoutine, recoveryBudgetAvailable } from '../src/background/pure/run-tools.ts'
import { remainingSteps } from '../src/background/pure/remaining.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts'
import type { RunRecord, Stats } from '../src/shared/storage.ts'
import { diagnosticReport } from '../src/shared/diagnostics.ts'

test('quiet hours work across midnight and leave an equal start/end disabled', () => {
  const quiet = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' }
  assert.equal(inQuietHours(quiet, new Date(2026, 9, 28, 23)), true)
  assert.equal(inQuietHours(quiet, new Date(2026, 9, 28, 6, 59)), true)
  assert.equal(inQuietHours(quiet, new Date(2026, 9, 28, 7)), false)
  assert.equal(quietHoursEndAt(quiet, new Date(2026, 9, 28, 23)), new Date(2026, 9, 29, 7).getTime())
  assert.equal(inQuietHours({ ...quiet, quietHoursEnd: '22:00' }), false)
  assert.equal(inQuietHours({ ...quiet, quietHoursStart: 'broken' }), false)
})

test('historical estimate uses recent comparable completed runs, ignoring cancelled and other plans', () => {
  const record = (duration: number, steps = ['search'], status = 'completed'): RunRecord => ({ id: String(duration), source: 'manual', startedAt: 100, endedAt: 100 + duration, status: status as RunRecord['status'], steps, events: [] })
  const history = [...Array.from({ length: 10 }, (_, i) => record((i + 1) * 1000)), record(600_000), record(1, ['search'], 'cancelled'), record(1, ['claim'])]
  const estimate = estimateRoutine(history, ['search'])!
  assert.equal(estimate.samples, 10)
  assert.ok(estimate.maxMs <= 10_000)
  assert.equal(estimateRoutine(history, ['imageSearch']), null)
})

test('run-wide budget caps recovery actions and elapsed work', () => {
  assert.equal(recoveryBudgetAvailable(1000, 11, 2000), true)
  assert.equal(recoveryBudgetAvailable(1000, 12, 2000), false)
  assert.equal(recoveryBudgetAvailable(1000, 0, 1000 + 45 * 60_000), false)
})

test('remaining-work preview distinguishes unknown from measured incomplete and complete', () => {
  const stats = { at: Date.now(), searchPoints: '57/60', readyToClaim: '0', activities: { dailySet: '3/3', visualSearch: null }, keepEarning: null } as Stats
  const preview = remainingSteps(stats, DEFAULT_SETTINGS)
  assert.equal(preview.find(step => step.id === 'search')?.status, 'incomplete')
  assert.equal(preview.find(step => step.id === 'claim')?.status, 'complete')
  assert.equal(preview.find(step => step.id === 'dailySet')?.status, 'complete')
  assert.equal(preview.find(step => step.id === 'imageSearch')?.status, 'unknown')
  assert.ok(remainingSteps(null, DEFAULT_SETTINGS).every(step => step.status === 'unknown'))
})

test('diagnostic export omits raw details, balances, queries, order codes and URLs', () => {
  const report = diagnosticReport('6.9.10', undefined, [{ id: 'secret-id', source: 'manual', startedAt: 1, status: 'incomplete', steps: ['search', 'secret-step'], beforePoints: 500,
    events: [{ at: 2, step: 'search', outcome: 'failed', detail: 'secret-query https://private.example/ ABC-123' }], detail: 'secret-code' }])
  const text = JSON.stringify(report)
  for (const privateValue of ['secret-id', 'secret-step', 'secret-query', 'private.example', 'ABC-123', 'secret-code', 'beforePoints']) assert.equal(text.includes(privateValue), false)
  assert.equal(report.runs[0].events[0].outcome, 'failed')
})
