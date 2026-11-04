import test from 'node:test'
import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { claimDashboardCoupons, readCouponCount } from '../src/background/injections/coupons.ts'
import { withDeadline } from '../src/background/pure/search-recovery.ts'

function page(options: { count?: number; cards?: number; noConfirm?: boolean; panelName?: string; stopOnOpen?: boolean; stopOnApply?: boolean; pathname?: string } = {}) {
  let now = 1_000_000, epoch = 1, serial = 0, opened = false, outsiderClicks = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const button = (label: string, press: () => void = () => {}) => ({
    tagName: 'BUTTON', textContent: label, disabled: false, clicks: 0, events: [] as string[],
    getAttribute: () => '', getClientRects: () => [1],
    getBoundingClientRect: () => ({ left: 1, top: 1, width: 100, height: 30 }),
    dispatchEvent(event: { type: string }) { this.events.push(event.type) },
    click() { this.clicks++; press() },
  })
  const coupons = Array.from({ length: options.cards ?? options.count ?? 1 }, () => {
    const coupon = button('Apply coupon', () => {
      if (options.stopOnApply) epoch++
      if (!options.noConfirm) { coupon.textContent = 'Applied'; coupon.disabled = true }
    })
    return coupon
  })
  const trigger = button(`Coupon (${options.count ?? 1})`, () => {
    assert.deepEqual(trigger.events, ['pointerdown', 'pointerup'])
    opened = true
    if (options.stopOnOpen) epoch++
  })
  const outsider = button('Apply coupon', () => { outsiderClicks++ })
  const buy = button('Redeem 200 points', () => { outsiderClicks++ })
  const dialog = {
    textContent: '200 Points Redemption discount coupon Expires next week',
    getAttribute: (name: string) => name === 'aria-label' ? options.panelName ?? 'Coupons' : '',
    getClientRects: () => [1],
    querySelectorAll: (selector: string) => selector.includes('heading') ? [] : [...coupons, buy],
  }
  const document = {
    body: { textContent: '' }, getElementById: () => null,
    querySelectorAll: (selector: string) => selector.includes('dialog') ? opened ? [dialog] : [] : [trigger, outsider, buy],
  }
  const context = createContext({ document, console, window: {},
    location: { hostname: 'rewards.bing.com', pathname: options.pathname ?? '/dashboard' },
    PointerEvent: class { type: string; constructor(type: string) { this.type = type } },
    Date: class extends Date { static now() { return now } },
    setTimeout: (run: () => void, ms: number) => { const id = ++serial; timers.set(id, { at: now + ms, run }); return id },
    clearTimeout: (id: number) => timers.delete(id),
    chrome: { storage: { local: { get: async () => ({ runState: { stopEpoch: epoch } }) } } },
  })
  runInContext(`var claim = ${claimDashboardCoupons.toString()}; var count = ${readCouponCount.toString()}`, context)
  return { context, trigger, coupons, outsiderClicks: () => outsiderClicks,
    run: (lease = '{stopEpoch:1,expiresAt:1045000}') => runInContext(`claim(45000, ${lease})`, context),
    async drain() {
      await new Promise(resolve => setImmediate(resolve))
      for (let budget = 0; timers.size && budget < 250; budget++) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        timers.delete(id); now = timer.at; timer.run()
        await new Promise(resolve => setImmediate(resolve))
      }
    },
  }
}

test('coupon application scopes to the named Coupons dialog and verifies each result', async () => {
  const h = page({ count: 2 })
  const pending = h.run(); await h.drain()
  const result = await pending
  assert.equal(result.status, 'applied')
  assert.equal(result.claimed, 2)
  assert.equal(result.attempted, 2)
  assert.equal(result.available, 0)
  assert.deepEqual(h.coupons.map(coupon => coupon.clicks), [1, 1])
  assert.equal(h.outsiderClicks(), 0)
})

test('unchanged Apply coupon is clicked only once and remains unverified', async () => {
  const h = page({ noConfirm: true })
  const pending = h.run(); await h.drain()
  assert.equal((await pending).status, 'unverified')
  assert.equal((await pending).claimed, 0)
  assert.equal(h.coupons[0].clicks, 1)
})

test('a partly rendered coupon list cannot be reported as completely applied', async () => {
  const h = page({ count: 2, cards: 1 })
  const pending = h.run(); await h.drain()
  assert.equal((await pending).status, 'unverified')
  assert.equal((await pending).claimed, 1)
  assert.notEqual((await pending).available, 0)
})

for (const phase of ['stopOnOpen', 'stopOnApply'] as const) test(`coupon Stop is checked after ${phase}`, async () => {
  const h = page({ count: 2, [phase]: true })
  const pending = h.run(); await h.drain()
  assert.equal((await pending).status, 'cancelled')
  assert.equal(h.coupons[1].clicks, 0)
  assert.equal(h.coupons[0].clicks, phase === 'stopOnApply' ? 1 : 0)
})

test('foreign dialogs and point-redemption pages cannot receive coupon clicks', async () => {
  for (const options of [{ panelName: 'Redeem reward' }, { pathname: '/redeem/sku/paid' }]) {
    const h = page(options)
    const pending = h.run(); await h.drain()
    assert.notEqual((await pending).status, 'applied')
    assert.equal(h.coupons[0].clicks, 0)
    assert.equal(h.outsiderClicks(), 0)
  }
})

test('zero and expired coupon checks perform no application', async () => {
  const zero = page({ count: 0 })
  const pending = zero.run(); await zero.drain()
  assert.equal((await pending).status, 'none')
  assert.equal(zero.trigger.clicks, 0)
  const expired = page()
  const ended = expired.run('{stopEpoch:1,expiresAt:999999}'); await expired.drain()
  assert.notEqual((await ended).status, 'applied')
  assert.equal(expired.trigger.clicks, 0)
})

test('coupon-count read supports plural labels without pressing anything', async () => {
  const h = page({ count: 2 })
  h.trigger.textContent = 'Coupons (2)'
  assert.equal(await runInContext('count(1000)', h.context), 2)
  assert.equal(h.trigger.clicks, 0)
})

function driver(options: { result?: unknown; hang?: boolean; late?: boolean } = {}) {
  let epoch = 1, held = 0, ended = 0, capturesEnded = 0, creates = 0
  let release: (() => void) | undefined
  const saved: Record<string, any> = { lastCoupons: { at: 1, available: 5 } }
  const context = createContext({ console, Date,
    KEYS: new Proxy({}, { get: (_target, key) => key }), REWARDS_DASHBOARD: 'https://rewards.bing.com/dashboard',
    claimDashboardCoupons: () => {},
    holdKeepAlive: () => { held++ }, releaseKeepAlive: () => { held-- },
    beginActivity: async () => epoch, endActivity: async () => { ended++ }, currentStopEpoch: async () => epoch,
    beginTabCapture: async () => {}, claimTab: async () => {}, endTabCapture: async () => { capturesEnded++ },
    createNormalTab: async () => { creates++; return { id: 7 } }, waitForTabComplete: async () => true,
    withDeadline: (work: Promise<any>, ms: number, label: string) => withDeadline(work, Math.min(ms, 40), label),
    setLocal: async (key: string, value: unknown) => { saved[key] = value }, setLastTabAction: async () => {},
    chrome: { scripting: { executeScript: async () => {
      if (options.hang) return new Promise(() => {})
      if (options.late) await new Promise<void>(resolve => { release = resolve })
      return [{ result: options.result }]
    } } },
  })
  const source = readFileSync(new URL('../src/background/readers/coupons.ts', import.meta.url), 'utf8')
  runInContext(stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '').replace(/^export /gm, ''), context)
  return { saved, held: () => held, ended: () => ended, capturesEnded: () => capturesEnded, creates: () => creates,
    run: () => runInContext('claimCoupons()', context) as Promise<void>, stop: () => { epoch++ },
    release: () => { assert.ok(release); release() },
  }
}

test('unverified coupon action preserves last known availability and exposes an honest result', async () => {
  const h = driver({ result: { status: 'unverified', reason: 'Not confirmed', claimed: 0, attempted: 1, available: 1 } })
  await h.run()
  assert.equal(h.saved.lastCoupons.available, 5)
  assert.equal(h.saved.lastCouponAction.status, 'unverified')
  assert.equal(h.held(), 0)
  assert.equal(h.ended(), 1)
  assert.equal(h.capturesEnded(), 1)
  assert.equal(h.creates(), 1)
})

test('hung coupon API is bounded and releases ownership and keepalive', async () => {
  const h = driver({ hang: true })
  await h.run()
  assert.equal(h.saved.lastCouponAction.status, 'failed')
  assert.equal(h.saved.lastCoupons.available, 5)
  assert.equal(h.held(), 0)
  assert.equal(h.ended(), 1)
})

test('late coupon result after Stop cannot publish success or clear new ownership', async () => {
  const h = driver({ late: true, result: { status: 'applied', reason: 'Applied 1 coupon', claimed: 1, attempted: 1, available: 0 } })
  const pending = h.run(); await new Promise(resolve => setImmediate(resolve))
  h.stop(); h.release(); await pending
  assert.equal(h.saved.lastCoupons.available, 5)
  assert.equal(h.saved.lastCouponAction.status, 'checking')
  assert.equal(h.ended(), 0)
  assert.equal(h.capturesEnded(), 0)
  assert.equal(h.held(), 0)
})
