import test from 'node:test'
import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'
import { openRewardsSectionTiles, claimDashboardPoints } from '../src/background/injections/rewards-tiles.ts'
import { readRewardsStats } from '../src/background/injections/stats-read.ts'

function page(document: any, onRead?: () => void) {
  let now = 1_000_000, serial = 0, epoch = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const context = createContext({ console, document, window: {},
    Date: class extends Date { static now() { return now } },
    setTimeout: (run: () => void, ms: number) => { const id = ++serial; timers.set(id, { at: now + ms, run }); return id },
    clearTimeout: (id: number) => timers.delete(id),
    chrome: { storage: { local: { get: async () => { onRead?.(); return { runState: { stopEpoch: epoch } } } } } },
  })
  runInContext(`var tiles = ${openRewardsSectionTiles.toString()}; var claim = ${claimDashboardPoints.toString()}; var stats = ${readRewardsStats.toString()}`, context)
  return { context, stop: () => { epoch++ }, timers,
    async drain(until?: () => boolean) {
      await new Promise(resolve => setImmediate(resolve))
      for (let budget = 0; timers.size && budget < 100 && !until?.(); budget++) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        timers.delete(id); now = timer.at; timer.run()
        await new Promise(resolve => setImmediate(resolve))
      }
    },
  }
}

test('serialized tile task stops its remaining delayed clicks after Stop', async () => {
  let clicks = 0
  const tiles = [1, 2, 3].map(i => ({ textContent: 'Daily reward ' + i, tagName: 'A',
    getAttribute: () => '', hasAttribute: () => false, contains: () => false, click: () => { clicks++ } }))
  const panel = { id: 'panel', querySelectorAll: () => tiles }
  const disclosure = { querySelector: () => panel }
  const heading = { textContent: 'Daily set', closest: () => disclosure, contains: () => false }
  const h = page({ querySelectorAll: () => [heading] })
  const result = runInContext('tiles(["daily set"], 3, "Daily set", false, {stopEpoch:1,expiresAt:1040000})', h.context)
  await h.drain(() => clicks === 1)
  assert.equal(clicks, 1)
  h.stop()
  await h.drain()
  assert.equal(await result, -1)
  assert.equal(clicks, 1)
})

test('serialized claim checks Stop again between opening the panel and claiming', async () => {
  let tileClicks = 0, claimClicks = 0
  let h: ReturnType<typeof page>
  const base = { getAttribute: () => '', hasAttribute: () => false, querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }) }
  const claimButton = { ...base, textContent: '50 Pending Claim points', click: () => { claimClicks++ } }
  const dialog = { textContent: 'Claim points', querySelectorAll: () => [claimButton] }
  const tile = { ...base, textContent: 'Ready to claim', click: () => { tileClicks++; h.stop() } }
  h = page({ querySelectorAll: (selector: string) => selector.includes('dialog') ? (tileClicks ? [dialog] : []) : [tile] })
  const result = runInContext('claim(15000, {stopEpoch:1,expiresAt:1040000})', h.context)
  await h.drain()
  assert.equal((await result).outcome, 'cancelled')
  assert.equal(tileClicks, 1)
  assert.equal(claimClicks, 0)
})

test('expired tile/claim leases cannot inspect or click page content', async () => {
  const h = page({ querySelectorAll: () => { throw new Error('Expired task touched DOM') } })
  const tiles = runInContext('tiles([], 3, "Daily set", false, {stopEpoch:1,expiresAt:999999})', h.context)
  const claim = runInContext('claim(15000, {stopEpoch:1,expiresAt:999999})', h.context)
  await h.drain()
  assert.equal(await tiles, -1)
  assert.equal((await claim).outcome, 'unknown')
})

test('search-progress injection resolves immediately without unrelated cards or disclosure clicks', async () => {
  const pair = { textContent: '57/60', previousElementSibling: { textContent: 'Bing search' } }
  const card = { tagName: 'BUTTON', getAttribute: (name: string) => name === 'aria-controls' ? 'points' : 'true' }
  const label = { textContent: "Today's points", closest: () => card }
  const h = page({ visibilityState: 'visible', querySelectorAll: (selector: string) => selector === 'p.text-labelControl' ? [label] : [],
    getElementById: () => ({ querySelectorAll: () => [pair] }) })
  const result = await runInContext('stats(12000, "search")', h.context)
  assert.equal(result.searchPoints, '57/60')
  assert.equal(result.availablePoints, null)
  assert.equal(result.dailyStreak, null)
  assert.equal(h.timers.size, 0)
})
