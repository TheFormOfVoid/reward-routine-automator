import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWidgets, resizeWidget, moveWidget } from '../src/popup/lib/widget-layout.ts'
import { streakWeek } from '../src/popup/lib/streak-week.ts'
import { mergeVisibleGeometry, normalizeHidden } from '../src/pages/dashboard/layout/visibility.ts'
import { migrate } from '../src/pages/dashboard/layout/migrate.ts'

const today = new Date(2026, 9, 29, 12)

test('dashboard visibility accepts known IDs and preserves a hidden saved seat during movement', () => {
  assert.deepEqual(normalizeHidden(['history', 'history', 'unknown', 9]), ['history'])
  const defaults = migrate(null)
  const hidden = { ...defaults.find(item => item.i === 'history')!, x: 4, y: 2, w: 4, h: 2 }
  const balance = { ...defaults.find(item => item.i === 'balance')!, x: 0, y: 0, w: 4, h: 2 }
  const result = mergeVisibleGeometry([balance, hidden], [{ ...balance, y: 5 }], new Set(['history']))
  assert.deepEqual(result.find(item => item.i === 'history'), hidden)
  assert.equal(result.find(item => item.i === 'balance')?.y, 5)
})

test('reported seven-day cycle distinguishes past, current incomplete and future segments', () => {
  const week = streakWeek('Day 4 of 7 · 0/3', today.getTime(), today)
  assert.equal(week.cycle, true)
  assert.deepEqual(week.days.map(day => day.state), ['completed', 'completed', 'completed', 'completed', 'pending', 'future', 'future'])
  assert.equal(streakWeek('Day 4 of 7 · 3/3', today.getTime(), today).days[3].state, 'completed')
  assert.deepEqual(streakWeek('Day 0 of 7 · 0/1', today.getTime(), today).days.map(day => day.state), ['pending', 'future', 'future', 'future', 'future', 'future', 'future'])
  assert.deepEqual(streakWeek('Day 4 of 7', today.getTime(), today).days.map(day => day.state), ['completed', 'completed', 'completed', 'completed', 'unknown', 'future', 'future'])
})

test('bare cap values and stale readings never invent completed past days', () => {
  const week = streakWeek('1/1', today.getTime(), today)
  assert.equal(week.cycle, false)
  assert.deepEqual(week.days.map(day => day.state), ['unknown', 'unknown', 'unknown', 'completed', 'future', 'future', 'future'])
  assert.equal(streakWeek('Day 4 of 7 · 1/1', today.getTime() - 86400000, today).current, 'unknown')
  for (const input of [null, '—', 'Day 9 of 7 · 9/1', 'earned 30/30 pts']) assert.equal(streakWeek(input, today.getTime(), today).current, 'unknown')
})

test('widget sanitation preserves intentional empty boards and valid preferences', () => {
  assert.deepEqual(normalizeWidgets({ v: 1, items: [] }), [])
  assert.deepEqual(normalizeWidgets({ v: 1, items: [{ id: 'history', size: 'compact' }, { id: 'history', size: 'wide' }, { id: 'other', size: 'wide' }, { id: 'balance', size: 'invalid' }] }), [{ id: 'history', size: 'compact' }, { id: 'balance', size: 'wide' }])
  assert.ok(normalizeWidgets(null, true).some(widget => widget.id === 'goal'))
})

test('widget move and resize preserve hidden widgets and unrelated preferences', () => {
  const items = normalizeWidgets({ v: 1, items: [{ id: 'history', size: 'compact' }, { id: 'balance', size: 'wide' }] })
  assert.deepEqual(moveWidget(resizeWidget(items, 'history', 'detailed'), 'history', 1), [{ id: 'balance', size: 'wide' }, { id: 'history', size: 'detailed' }])
  assert.deepEqual(items, [{ id: 'history', size: 'compact' }, { id: 'balance', size: 'wide' }])
})
