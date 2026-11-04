import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackup, mergedBackupData, parseBackup, restoreBackup, RESTORE_BACKUP_KEY, validateBackupSettings } from '../src/shared/backup.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts'
import { normalizeSettings } from '../src/shared/settings-validation.ts'

const history = [{ day: '2026-10-28', first: 100, last: 200, at: 20 }]
const run = { id: 'one', source: 'manual', startedAt: 10, endedAt: 20, status: 'completed', steps: ['search'], events: [{ at: 11, step: 'search', outcome: 'started', detail: '' }] }

test('backup contains durable user choices and optional sensitive orders, never run state or caches', () => {
  const local = { pointsHistory: history, dashLayout: { v: 2, items: [{ i: 'balance', x: 0, y: 0, w: 4, h: 2 }] }, runHistory: [run], recentQueries: ['cat'], runState: { batch: {} }, activeRun: run, lastStats: { availablePoints: '100' }, lastOrders: { at: 1, total: 1, orders: [{ title: 'coins', code: 'secret' }] } }
  const backup = createBackup({ ...DEFAULT_SETTINGS, redeemGoalPts: 12345 }, local, '6.9.11')
  assert.equal(backup.settings.redeemGoalPts, 12345)
  assert.deepEqual(Object.keys(backup.data).sort(), ['dashLayout', 'pointsHistory', 'recentQueries', 'runHistory'])
  assert.deepEqual(createBackup(DEFAULT_SETTINGS, local, '6.9.11', true).data.lastOrders, local.lastOrders)
  assert.deepEqual(parseBackup(JSON.stringify(backup)), backup)
})

test('backup rejects unsupported schemas, transient data, invalid settings and malformed history', () => {
  const base = createBackup(DEFAULT_SETTINGS, {}, '6.9.11')
  for (const patch of [{ schemaVersion: 2 }, { data: { runState: {} } }, { settings: { searchesPerBatch: -1 } }, { settings: { quietHoursStart: '99:90' } }, { data: { runHistory: [{ ...run, events: [null] }] } }, { data: { runHistory: [{ ...run, events: [{ at: 1, step: 'secret@email', outcome: 'started', detail: '' }] }] } }]) {
    assert.throws(() => parseBackup(JSON.stringify({ ...base, ...patch })))
  }
  assert.throws(() => parseBackup(JSON.stringify({ ...base, data: JSON.parse('{"dashLayout":{"v":2,"items":[],"__proto__":{}}}') })), /unsupported object/)
  assert.throws(() => validateBackupSettings({ minDelaySec: 20, maxDelaySec: 10 }), /maximum search delay/)
})

test('backups preserve navigation backgrounds while older backups remain readable', () => {
  const backup = createBackup({ ...DEFAULT_SETTINGS, topBarBackground: true, bottomBarBackground: true }, {}, '6.11.0')
  const parsed = parseBackup(JSON.stringify(backup))
  assert.equal(parsed.settings.topBarBackground, true)
  assert.equal(parsed.settings.bottomBarBackground, true)
  const legacySettings = { ...backup.settings }
  delete legacySettings.topBarBackground
  delete legacySettings.bottomBarBackground
  const legacy = parseBackup(JSON.stringify({ ...backup, settings: legacySettings }))
  assert.equal(Object.hasOwn(legacy.settings, 'topBarBackground'), false)
  assert.equal(Object.hasOwn(legacy.settings, 'bottomBarBackground'), false)
  const normalized = normalizeSettings(legacy.settings, DEFAULT_SETTINGS)
  assert.equal(normalized.topBarBackground, false)
  assert.equal(normalized.bottomBarBackground, false)
  for (const key of ['topBarBackground', 'bottomBarBackground']) {
    for (const value of ['false', 0, null]) {
      assert.throws(() => parseBackup(JSON.stringify({ ...backup, settings: { ...backup.settings, [key]: value } })), new RegExp(`Invalid setting: ${key}`))
    }
  }
})

test('backup roundtrips editable widget choices and validates their shared schemas', () => {
  const layout = { v: 1, items: [{ id: 'history', size: 'compact' }, { id: 'balance', size: 'detailed' }] }
  const local = { popupWidgetLayout: layout, dashHiddenWidgets: ['catalog', 'orders'], popupWidgetEditing: true }
  const backup = createBackup(DEFAULT_SETTINGS, local, '6.11.0')
  assert.deepEqual(backup.data, { popupWidgetLayout: layout, dashHiddenWidgets: ['catalog', 'orders'] })
  assert.deepEqual(parseBackup(JSON.stringify(backup)), backup)
  assert.deepEqual(createBackup(DEFAULT_SETTINGS, { popupWidgetLayout: { v: 1, items: [] }, dashHiddenWidgets: [] }, '6.11.0').data,
    { popupWidgetLayout: { v: 1, items: [] }, dashHiddenWidgets: [] })
  const invalid = [
    { popupWidgetLayout: { v: 2, items: [] } },
    { popupWidgetLayout: { v: 1, items: [{ id: 'unknown', size: 'wide' }] } },
    { popupWidgetLayout: { v: 1, items: [{ id: 'balance', size: 'huge' }] } },
    { popupWidgetLayout: { v: 1, items: [{ id: 'balance', size: 'wide' }, { id: 'balance', size: 'compact' }] } },
    { popupWidgetLayout: { v: 1, items: [], editorOpen: true } },
    { popupWidgetLayout: { v: 1, items: [{ id: 'balance', size: 'wide', private: 'ignored' }] } },
    { dashHiddenWidgets: ['unknown'] },
    { dashHiddenWidgets: ['history', 'history'] },
    { dashHiddenWidgets: null },
  ]
  for (const data of invalid) assert.throws(() => parseBackup(JSON.stringify({ ...backup, data })))
})

test('imported widget layouts and visibility replace their complete choices in merge or replace', () => {
  const current = { popupWidgetLayout: { v: 1, items: [{ id: 'balance', size: 'wide' }] }, dashHiddenWidgets: ['history', 'catalog'], pointsHistory: history }
  const incoming = { popupWidgetLayout: { v: 1, items: [] }, dashHiddenWidgets: [] }
  assert.deepEqual(mergedBackupData(current, incoming, false), incoming)
  assert.deepEqual(mergedBackupData(current, incoming, true), incoming)
  assert.deepEqual(mergedBackupData(current, { pointsHistory: [] }, false), { pointsHistory: history })
})

test('merge preserves current same-day snapshots and order codes; replace imports requested sections', () => {
  const current = { pointsHistory: history, lastOrders: { at: 20, total: 2, orders: [{ orderNo: 'one', title: 'coins', code: 'current' }, { orderNo: 'two', title: 'coins', code: null }] } }
  const incoming = { pointsHistory: [{ day: '2026-10-27', first: 1, last: 2, at: 1 }, { day: '2026-10-28', first: 0, last: 5, at: 1 }], lastOrders: { at: 5, total: 2, orders: [{ orderNo: 'one', title: 'coins', code: 'old' }, { orderNo: 'two', title: 'coins', code: 'fill' }] } }
  const merged = mergedBackupData(current, incoming, false)
  assert.deepEqual((merged.pointsHistory as typeof history)[1], history[0])
  assert.deepEqual((merged.lastOrders as typeof current.lastOrders).orders.map((row) => row.code), ['current', 'fill'])
  assert.deepEqual(mergedBackupData(current, incoming, true), incoming)
})

test('merged run history is newest first, capped and keeps current matching record', () => {
  const current = { runHistory: [{ ...run, id: 'same', startedAt: 100 }] }
  const imported = { runHistory: [{ ...run, id: 'same', startedAt: 1 }, ...Array.from({ length: 35 }, (_, i) => ({ ...run, id: String(i), startedAt: i + 101 }))] }
  const merged = mergedBackupData(current, imported, false).runHistory as typeof run[]
  assert.equal(merged.length, 30)
  assert.equal(merged[0].startedAt, 135)
  const matching = mergedBackupData(current, { runHistory: [{ ...run, id: 'same', startedAt: 1 }] }, false).runHistory as typeof run[]
  assert.equal(matching[0].startedAt, 100)
})

test('restore stores recovery first, excludes unchecked orders and rolls back partial writes', async () => {
  const before = { pointsHistory: history }
  let local: Record<string, unknown> = structuredClone(before)
  let settings: unknown = { ...DEFAULT_SETTINGS, redeemGoalPts: 123 }
  const writes: string[] = []
  let fail = true
  const previousChrome = globalThis.chrome
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request: async (_: string, optionsOrWork: unknown, work?: (lock: object) => Promise<void>) =>
      typeof optionsOrWork === 'function' ? optionsOrWork() : work!({ name: _ }),
  } } })
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '6.9.11' }) },
    storage: {
      sync: { get: async () => ({ settings }), set: async (value: { settings: unknown }) => { writes.push('settings'); settings = value.settings } },
      local: { get: async () => structuredClone(local), set: async (value: Record<string, unknown>) => { writes.push(Object.keys(value).join(',')); Object.assign(local, value); if (fail && 'recentQueries' in value) { fail = false; throw new Error('write failed') } }, remove: async (keys: string[]) => { for (const key of keys) delete local[key] } },
    },
  } as unknown as typeof chrome
  try {
    const incoming = createBackup({ ...DEFAULT_SETTINGS, redeemGoalPts: 456 }, { recentQueries: ['new'], popupWidgetLayout: { v: 1, items: [] }, dashHiddenWidgets: ['history'], lastOrders: { at: 1, total: 0, orders: [] } }, '6.9.11', true)
    await assert.rejects(restoreBackup(incoming, false, false), /write failed/)
    assert.equal(writes[0], RESTORE_BACKUP_KEY)
    assert.deepEqual(local.pointsHistory, before.pointsHistory)
    assert.equal(local.recentQueries, undefined)
    assert.equal(local.lastOrders, undefined)
    assert.equal(local.popupWidgetLayout, undefined)
    assert.equal(local.dashHiddenWidgets, undefined)
    assert.equal((settings as typeof DEFAULT_SETTINGS).redeemGoalPts, 123)
    assert.ok(local[RESTORE_BACKUP_KEY])
    local.runState = { batch: { remaining: 2 } }
    await assert.rejects(restoreBackup(incoming, false, false), /Stop the current/)
  } finally {
    globalThis.chrome = previousChrome
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})
