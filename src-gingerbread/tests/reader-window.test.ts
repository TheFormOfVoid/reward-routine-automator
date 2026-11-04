import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { mergeStats } from '../src/background/pure/merge-stats.ts'
import { parsePoints, recordDay } from '../src/background/pure/history.ts'

function harness(opts: { stopDuringLoad?: boolean; stopDuringRead?: boolean; deferDashboard?: boolean; throwList?: boolean; noNormalWindow?: boolean } = {}) {
  const created: any[] = []
  const closed: number[][] = []
  const calls: string[] = []
  const removed: string[] = []
  const deadlines: { timeout: number; label: string }[] = []
  const statsLogs: unknown[] = []
  const saved: Record<string, any> = {
    lastOrders: { at: 1, total: 1, orders: [{ orderNo: 'order-1', code: 'saved-code' }] },
    ordersSyncWinId: 999,
  }
  let epoch = 1
  let now = Date.now()
  let nextId = 10
  let releaseDashboard: (() => void) | null = null
  const statsRead = () => {}
  const couponsRead = () => {}
  const rowsRead = () => {}
  const detailRead = () => {}
  const pageStats = (mode: string) => mode === 'cards' || mode === 'search'
    ? { availablePoints: '1,000', searchPoints: '57/60' }
    : { activities: { bingSearch: '57/60', dailySet: '1/1', bingApp: '0/1', visualSearch: '1/1' } }
  const context = createContext({
    console, Date: class extends Date { static now() { return now } }, structuredClone, mergeStats, parsePoints, recordDay,
    KEYS: new Proxy({}, { get: (_object, key) => key }),
    REWARDS_DASHBOARD: 'https://rewards.bing.com/', REWARDS_EARN: 'https://rewards.bing.com/earn',
    readRewardsStats: statsRead, readCouponCount: couponsRead,
    readOrderRows: rowsRead, readOrderDetail: detailRead,
    beginActivity: async () => epoch, endActivity: async () => {}, currentStopEpoch: async () => epoch,
    holdKeepAlive: () => {}, releaseKeepAlive: () => {}, sleep: async () => {},
    getSettings: async () => ({ keepPinnedTabs: true }),
    localDayKey: () => '2026-10-27',
    getLocal: async (key: string) => saved[key],
    setLocal: async (key: string, value: unknown) => { saved[key] = value },
    setLastStatsLog: async (...args: unknown[]) => { statsLogs.push(args) }, setLastOrdersLog: async () => {},
    withDeadline: async (promise: Promise<unknown>, timeout: number, label: string) => {
      assert.ok(timeout > 0 && timeout <= 65000)
      deadlines.push({ timeout, label })
      return promise
    },
    waitForTabComplete: async () => { if (opts.stopDuringLoad) epoch++; return true },
    closeTabs: async (ids: number[]) => { closed.push(Array.from(ids)); return ids.length },
    chrome: {
      windows: {
        getLastFocused: async (options: unknown) => {
          assert.deepEqual(JSON.parse(JSON.stringify(options)), { windowTypes: ['normal'] })
          if (opts.noNormalWindow) throw Error('No normal window')
          return { id: 42, type: 'normal' }
        },
        create: () => { throw Error('Readers must not create a window') },
        update: () => { throw Error('Readers must not focus a window') },
        remove: () => { throw Error('Readers must not close a window') },
      },
      tabs: {
        create: async (options: any) => {
          calls.push('create'); created.push(options)
          return { ...options, id: nextId++ }
        },
        get: async () => ({ url: 'https://rewards.bing.com/redeem/orderhistory' }),
      },
      storage: { local: {
        get: async (key: string) => ({ [key]: saved[key] }),
        remove: async (key: string) => { removed.push(key); delete saved[key] },
      } },
      scripting: { executeScript: async (options: any) => {
        if (options.func === statsRead) {
          const mode = options.args[1]
          calls.push('read:' + mode)
          if (mode === 'cards' && opts.deferDashboard) {
            await new Promise<void>(resolve => { releaseDashboard = resolve })
          }
          if (mode === 'streaks' && opts.stopDuringRead) epoch++
          return [{ result: pageStats(mode) }]
        }
        if (options.func === couponsRead) return [{ result: 2 }]
        if (options.func === rowsRead) {
          if (opts.throwList) throw Error('Fixture list failure')
          return [{ result: { total: 1, list: [{ title: 'Reward', orderNo: 'order-1', points: '100', date: 'today' }] } }]
        }
        if (options.func === detailRead) throw Error('Existing saved order must not be reread')
        return [{ result: null }]
      } },
    },
  })
  function load(file: string) {
    const source = readFileSync(new URL(`../src/background/${file}`, import.meta.url), 'utf8')
    runInContext(stripTypeScriptTypes(source)
      .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
      .replace(/^export /gm, ''), context, { filename: file })
  }
  load('core/normal-tabs.ts')
  load('readers/stats.ts')
  // Separate source wrappers share the actual guard object but own lexical
  // declarations, just as their ES modules do in the extension.
  const orderSource = readFileSync(new URL('../src/background/readers/orders.ts', import.meta.url), 'utf8')
  runInContext(`{ ${stripTypeScriptTypes(orderSource)
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^export /gm, '')}; globalThis.syncOrders = syncOrders; globalThis.closeOrphanedOrdersWindow = closeOrphanedOrdersWindow; }`, context)
  return {
    created, closed, calls, removed, saved, deadlines, statsLogs,
    advance: (ms: number) => { now += ms },
    statsGuard: () => runInContext('READ_RUN_GUARDS.stats', context),
    release: () => { assert.ok(releaseDashboard); releaseDashboard() },
    stats: async (request: any = {}) => runInContext(`refreshStats(${JSON.stringify(request)})`, context),
    now: () => now,
    stop: () => { epoch++ },
    orders: async () => { await runInContext('syncOrders()', context) },
    orphan: async () => { await runInContext('closeOrphanedOrdersWindow()', context) },
  }
}

test('stats selects normal-window tabs sequentially without creating/focusing a window', async () => {
  const h = harness({ deferDashboard: true })
  const reading = h.stats()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.created.length, 1, 'Earn tab must not hide the dashboard reader')
  h.release()
  await reading
  assert.deepEqual(h.calls.slice(0, 4), ['create', 'read:cards', 'create', 'read:streaks'])
  assert.equal(h.created.length, 2)
  for (const tab of h.created) { assert.equal(tab.windowId, 42); assert.equal(tab.active, true) }
  assert.deepEqual(h.closed, [[10, 11]])
  assert.equal(h.saved.lastStats.searchPoints, '57/60')
})

test('concurrent compatible stats requests await one reader and share its evidence', async () => {
  const h = harness({ deferDashboard: true })
  const first = h.stats()
  await new Promise(resolve => setImmediate(resolve))
  let secondDone = false
  const second = h.stats().then(value => { secondDone = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondDone, false)
  assert.equal(h.created.length, 1)
  h.release()
  const [one, two] = await Promise.all([first, second])
  assert.equal(one, two)
  assert.equal(two.stats.searchPoints, '57/60')
  assert.equal(h.created.length, 2)
})

test('post-action stats cannot be satisfied by an older in-flight read', async () => {
  const h = harness({ deferDashboard: true })
  const first = h.stats()
  await new Promise(resolve => setImmediate(resolve))
  h.advance(100)
  const boundary = h.now()
  const second = h.stats({ notBefore: boundary })
  h.release()
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.created.length, 3, 'new dashboard read begins after the older read finishes')
  h.release()
  const evidence = await second
  assert.equal(h.created.length, 4)
  assert.ok(evidence.startedAt >= boundary)
})

test('search-only read skips Earn/coupons and does not freshen unrelated activity data', async () => {
  const h = harness()
  h.saved.lastStats = { at: 5, activities: { dailySet: '0/1' }, readyToClaim: '50' }
  const evidence = await h.stats({ scope: 'search' })
  assert.equal(h.created.length, 1)
  assert.deepEqual(h.calls, ['create', 'read:search'])
  assert.equal(h.saved.lastCoupons, undefined)
  assert.equal(h.saved.lastStats.at, 5)
  assert.equal(h.saved.lastStats.activities.dailySet, '0/1')
  assert.equal(evidence.stats.searchPoints, '57/60')
  assert.ok(evidence.stats.at > 5)
})

test('explicit recent-evidence reuse avoids a new compatible page load', async () => {
  const h = harness()
  const first = await h.stats()
  h.advance(500)
  const second = await h.stats({ scope: 'search', maxAgeMs: 1000 })
  assert.equal(first, second)
  assert.equal(h.created.length, 2)
  h.advance(1000)
  await h.stats({ scope: 'search', maxAgeMs: 1000 })
  assert.equal(h.created.length, 3)
})

test('concurrent cache requests after Stop reserve only one new reader', async () => {
  const h = harness()
  await h.stats()
  h.stop()
  const [one, two] = await Promise.all([h.stats({ maxAgeMs: 1000 }), h.stats({ maxAgeMs: 1000 })])
  assert.equal(one, two)
  assert.equal(one.stopEpoch, 2)
  assert.equal(h.created.length, 4)
})

test('Stop during a stats page load prevents reading and leaves its owned tab open', async () => {
  const h = harness({ stopDuringLoad: true })
  await h.stats()
  assert.deepEqual(h.calls, ['create'])
  assert.deepEqual(h.closed, [])
  assert.equal(h.created.length, 1)
})

test('Stop during the final stats injection prevents publishing a new stats snapshot', async () => {
  const h = harness({ stopDuringRead: true })
  await h.stats()
  assert.equal(h.created.length, 2)
  assert.equal(h.saved.lastStats, undefined)
  assert.deepEqual(h.closed, [])
})

test('a stats reply after the absolute deadline is discarded and cleanup releases the guard', async () => {
  const h = harness({ deferDashboard: true })
  const reading = h.stats()
  await new Promise(resolve => setImmediate(resolve))
  h.advance(75_001)
  h.release()
  await reading
  assert.equal(h.created.length, 1)
  assert.equal(h.saved.lastStats, undefined)
  assert.equal(h.saved.lastCoupons, undefined)
  assert.equal(h.saved.pointsHistory, undefined)
  assert.deepEqual(h.statsLogs, [])
  assert.deepEqual(h.closed, [[10]])
  assert.equal(h.statsGuard(), false)
})

test('stats load and injection deadlines shrink to the remaining run budget', async () => {
  const h = harness({ deferDashboard: true })
  const reading = h.stats()
  await new Promise(resolve => setImmediate(resolve))
  h.advance(74_000)
  h.release()
  await reading
  assert.ok(h.deadlines.some(({ timeout, label }) => label === 'Stats page load' && timeout === 1000))
  assert.ok(h.deadlines.some(({ timeout, label }) => label === 'Stats reader' && timeout === 1000))
  assert.equal(h.saved.lastStats.searchPoints, '57/60')
  assert.equal(h.statsGuard(), false)
})

test('orders uses one selected normal tab and closes only that tab', async () => {
  const h = harness()
  await h.orders()
  assert.equal(h.created.length, 1)
  assert.equal(h.created[0].windowId, 42)
  assert.equal(h.created[0].active, true)
  assert.deepEqual(h.closed, [[10]])
  assert.equal(h.saved.lastOrders.orders[0].code, 'saved-code')
  assert.equal(h.saved.ordersSyncWinId, undefined)
})

test('orders failure still closes only its tab and preserves previous saved codes', async () => {
  const h = harness({ throwList: true })
  await h.orders()
  assert.deepEqual(h.closed, [[10]])
  assert.equal(h.saved.lastOrders.orders[0].code, 'saved-code')
})

test('overlapping order requests cannot create two readers', async () => {
  const h = harness()
  await Promise.all([h.orders(), h.orders()])
  assert.equal(h.created.length, 1)
  assert.deepEqual(h.closed, [[10]])
})

test('legacy orphan-window bookkeeping is forgotten without closing its window', async () => {
  const h = harness()
  await h.orphan()
  assert.deepEqual(h.removed, ['ordersSyncWinId'])
  assert.deepEqual(h.created, [])
  assert.deepEqual(h.closed, [])
})

test('with no normal browser window, readers do not create a standalone fallback', async () => {
  const h = harness({ noNormalWindow: true })
  await h.orders()
  assert.deepEqual(h.created, [])
  assert.deepEqual(h.closed, [])
  await h.stats()
  assert.deepEqual(h.created, [])
  assert.equal(h.saved.lastStats, undefined)
})
