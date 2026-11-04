import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts'

function harness(file: 'scheduled' | 'restock') {
  const data: Record<string, any> = {}
  const alarms = new Map<string, any>()
  const settings = { ...DEFAULT_SETTINGS, restockWatcherEnabled: true }
  const state: any = { batch: null, routine: null, activity: null, stopEpoch: 0 }
  const calls = { starts: 0, reads: 0, notifications: 0 }
  let quiet = false, scan: () => void = () => {}
  const context = createContext({ console, Date, Math,
    getSettings: async () => settings, readRunState: async () => state,
    setLastTabAction: async () => {}, scheduledDue: () => ({ due: false }), nextScheduledAt: () => null,
    runStartupSequence: async () => { calls.starts++; return 'ran' },
    getLocal: async (key: string) => data[key], setLocal: async (key: string, value: unknown) => { data[key] = value },
    KEYS: { postponedRoutine: 'postponedRoutine', lastScheduledDay: 'lastScheduledDay', lastRedeem: 'lastRedeem', redeemRestockNews: 'redeemRestockNews', restockNotifiedAt: 'restockNotifiedAt' },
    localDayKey: () => '2026-10-28', inQuietHours: () => quiet,
    READ_RUN_GUARDS: { stats: false, redeem: false, orders: false },
    checkRedeemAvailability: async () => { calls.reads++; scan() },
    chrome: {
      alarms: { get: async (key: string) => alarms.get(key), create: async (key: string, value: unknown) => { alarms.set(key, value) }, clear: async (key: string) => alarms.delete(key) },
      storage: { local: { set: async (values: any) => Object.assign(data, values), remove: async (key: string) => { delete data[key] } } },
      notifications: { create: async () => { calls.notifications++ } },
    },
  })
  const source = readFileSync(new URL(`../src/background/routine/${file}.ts`, import.meta.url), 'utf8')
  runInContext(stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '').replace(/^export /gm, ''), context)
  return { data, alarms, settings, state, calls, quiet: (value: boolean) => { quiet = value }, scan: (fn: () => void) => { scan = fn }, call: (js: string) => runInContext(js, context) }
}

test('postponement survives wake, waits while busy/quiet and starts once the deferred round is eligible', async () => {
  const h = harness('scheduled')
  await h.call('postponeRoutine(60)')
  const until = h.data.postponedRoutine.until
  h.alarms.clear()
  await h.call('runPostponedIfDue()')
  assert.equal(h.alarms.get('postponedRoutine').when, until)
  assert.equal(h.calls.starts, 0)
  h.data.postponedRoutine.until = Date.now() - 1
  h.state.batch = {}
  await h.call('runPostponedIfDue()')
  assert.equal(h.alarms.get('postponedRoutine').delayInMinutes, 5)
  assert.ok(h.data.postponedRoutine)
  h.state.batch = null
  h.quiet(true)
  await h.call('runPostponedIfDue()')
  assert.equal(h.calls.starts, 0)
  h.quiet(false)
  await h.call('runPostponedIfDue()')
  assert.equal(h.calls.starts, 1)
  assert.equal(h.data.postponedRoutine, undefined)
  await h.call('runPostponedIfDue()')
  assert.equal(h.calls.starts, 1)
})

test('restock watcher bounds its schedule and skips busy or quiet periods', async () => {
  const h = harness('restock')
  h.settings.restockIntervalMin = 1
  await h.call('ensureRestockScheduled()')
  assert.equal(h.alarms.get('restockWatch').periodInMinutes, 30)
  h.state.activity = { label: 'Stats' }
  await h.call('restockFire()')
  h.state.activity = null
  h.quiet(true)
  await h.call('restockFire()')
  assert.equal(h.calls.reads, 0)
  h.settings.restockWatcherEnabled = false
  await h.call('ensureRestockScheduled()')
  assert.equal(h.alarms.has('restockWatch'), false)
})

test('restock notifications require a fresh scan and are deduplicated; Stop suppresses late notifications', async () => {
  const h = harness('restock')
  h.data.redeemRestockNews = { at: 1, labels: ['stale'] }
  h.data.lastRedeem = { at: 1 }
  await h.call('restockFire()')
  assert.equal(h.calls.notifications, 0)
  h.scan(() => { const at = Date.now(); h.data.lastRedeem = { at }; h.data.redeemRestockNews = { at, labels: ['500 coins'] } })
  await h.call('restockFire()')
  assert.equal(h.calls.notifications, 1)
  h.scan(() => { h.data.lastRedeem = { at: Date.now() } })
  await h.call('restockFire()')
  assert.equal(h.calls.notifications, 1)
  h.scan(() => { const at = Date.now() + 1; h.data.lastRedeem = { at }; h.data.redeemRestockNews = { at, labels: ['1000 coins'] }; h.state.stopEpoch++ })
  await h.call('restockFire()')
  assert.equal(h.calls.notifications, 1)
})
