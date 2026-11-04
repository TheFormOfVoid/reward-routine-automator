import test from 'node:test'
import assert from 'node:assert/strict'
import { planRoutineRecovery } from '../src/background/pure/routine-recovery.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts'
import type { Stats } from '../src/shared/storage.ts'

const now = new Date(2026, 9, 27, 12)
const readStarted = now.getTime() - 1000
const stats = (patch: Partial<Stats> = {}): Stats => ({
  at: now.getTime(), availablePoints: null, readyToClaim: '0', dailyStreak: null,
  stampBonus: null, searchPoints: '57/60',
  activities: { bingSearch: null, dailySet: '3/3', bingApp: null, visualSearch: '0/1' },
  ...patch,
})

test('final 57/60 read retries one typed search plus the incomplete image task', () => {
  const plan = planRoutineRecovery(stats(), readStarted, ['search', 'imageSearch'], DEFAULT_SETTINGS, 0, {}, now)
  assert.deepEqual(plan.steps, ['search', 'imageSearch'])
  assert.equal(plan.searchCount, 1)
  assert.deepEqual(plan.progress, { search: 57, imageSearch: 0 })
})

test('final recovery respects original enablement, current switches and configured batch limit', () => {
  const settings = { ...DEFAULT_SETTINGS, imageSearchStartupEnabled: false, searchesPerBatch: 2, rightSizeSearchBatch: false }
  const plan = planRoutineRecovery(stats({ searchPoints: '0/60', readyToClaim: '300' }), readStarted,
    ['search', 'imageSearch'], settings, 0, {}, now)
  assert.deepEqual(plan.steps, ['search'])
  assert.equal(plan.searchCount, 2)
})

test('a failed final read cannot reuse an older same-day snapshot', () => {
  assert.equal(planRoutineRecovery(stats({ at: readStarted - 1 }), readStarted,
    ['search'], DEFAULT_SETTINGS, 0, {}, now).reason, 'stale-read')
  assert.equal(planRoutineRecovery(stats({ at: now.getTime() + 1 }), readStarted,
    ['search'], DEFAULT_SETTINGS, 0, {}, now).reason, 'stale-read')
})

test('missing measurements and Bing-app check-in never authorize retries', () => {
  const unread = stats({ searchPoints: null, activities: { bingSearch: '0/1', dailySet: null, bingApp: '0/1', visualSearch: null } })
  assert.deepEqual(planRoutineRecovery(unread, readStarted, ['search', 'dailySet', 'imageSearch', 'stats'], DEFAULT_SETTINGS, 0, {}, now).steps, [])
})

test('unchanged credit stops after one final retry, even when the cap is still short', () => {
  const plan = planRoutineRecovery(stats(), readStarted, ['search', 'imageSearch'], DEFAULT_SETTINGS,
    1, { search: 57, imageSearch: 0 }, now)
  assert.equal(plan.reason, 'no-progress')
  assert.deepEqual(plan.steps, [])
})

test('only measurable improvement permits the second and final recovery round', () => {
  const plan = planRoutineRecovery(stats({ searchPoints: '57/60' }), readStarted, ['search', 'imageSearch'],
    DEFAULT_SETTINGS, 1, { search: 54, imageSearch: 0 }, now)
  assert.deepEqual(plan.steps, ['search'])
  assert.equal(plan.searchCount, 1)
  assert.equal(planRoutineRecovery(stats(), readStarted, ['search'], DEFAULT_SETTINGS, 2, { search: 54 }, now).reason, 'limit')
})

test('claim and keep-earning improvement is a decrease in outstanding work', () => {
  const plan = planRoutineRecovery(stats({ readyToClaim: '20', keepEarning: { open: 1, total: 4 } }), readStarted,
    ['claim', 'keepEarning'], DEFAULT_SETTINGS, 1, { claim: -50, keepEarning: -2 }, now)
  assert.deepEqual(plan.steps, ['claim', 'keepEarning'])
})
