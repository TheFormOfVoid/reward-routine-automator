import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { withDeadline } from '../src/background/pure/search-recovery.ts'

function harness(options: { hangSearch?: boolean; deferOptions?: boolean; failBegin?: boolean } = {}) {
  const saved: Record<string, any> = { lastRedeem: { at: 1, options: [{ title: 'previous' }], variants: [] } }
  const closed: number[][] = []
  let epoch = 1, now = 1_000_000, holds = 0, creates = 0
  let release: (() => void) | undefined
  const search = () => {}, cards = () => {}, variants = () => {}
  const guards = { redeem: false }
  const context = createContext({ console, URL,
    Date: class extends Date { static now() { return now } },
    KEYS: new Proxy({}, { get: (_target, key) => key }), READ_RUN_GUARDS: guards,
    searchRedeemFor: search, readRedeemOptions: cards, readRedeemVariants: variants,
    beginActivity: async () => { if (options.failBegin) throw new Error('storage unavailable'); return epoch },
    endActivity: async () => {}, currentStopEpoch: async () => epoch,
    holdKeepAlive: () => { holds++ }, releaseKeepAlive: () => { holds-- },
    getSettings: async () => ({ keepPinnedTabs: true }),
    withDeadline: (work: Promise<any>, ms: number, label: string) => withDeadline(work, Math.min(30, ms), label),
    createNormalTab: async () => { creates++; return { id: 10 } }, waitForTabComplete: async () => true,
    sleep: async () => {}, closeTabs: async (ids: number[]) => { closed.push(ids); return ids.length },
    getLocal: async (key: string) => saved[key], setLocal: async (key: string, value: unknown) => { saved[key] = value },
    removeLocal: async (key: string) => { delete saved[key] },
    setLastRedeemLog: async () => {},
    chrome: { tabs: { update: async () => undefined }, scripting: { executeScript: async (args: any) => {
      if (args.func === search) return options.hangSearch ? new Promise(() => {}) : [{ result: true }]
      if (args.func === cards && options.deferOptions) {
        await new Promise<void>(resolve => { release = resolve })
        return [{ result: { list: [{ title: 'new', href: '/redeem/sku/test', points: '100' }] } }]
      }
      return [{ result: { list: [] } }]
    } } },
  })
  const source = readFileSync(new URL('../src/background/readers/redeem.ts', import.meta.url), 'utf8')
  runInContext(stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^export /gm, ''), context)
  return { saved, closed, guards, holds: () => holds, creates: () => creates,
    check: () => runInContext('checkRedeemAvailability()', context) as Promise<void>,
    release: () => { assert.ok(release); release() }, stop: () => { epoch++ }, expire: () => { now += 100_001 },
  }
}

test('catalog requests share one in-flight promise and owned tab', async () => {
  const h = harness({ deferOptions: true })
  const one = h.check(), two = h.check()
  assert.equal(one, two)
  await new Promise(resolve => setImmediate(resolve))
  h.release()
  await Promise.all([one, two])
  assert.equal(h.creates(), 1)
  assert.equal(h.holds(), 0)
  assert.equal(h.guards.redeem, false)
})

test('hung catalog injection is bounded and releases its activity/keepalive', async () => {
  const h = harness({ hangSearch: true })
  await h.check()
  assert.equal(h.holds(), 0)
  assert.equal(h.guards.redeem, false)
  assert.deepEqual(h.closed.map(ids => Array.from(ids)), [[10]])
})

for (const reason of ['stop', 'deadline'] as const) test(`late catalog response after ${reason} cannot publish new stock`, async () => {
  const h = harness({ deferOptions: true })
  const original = h.saved.lastRedeem
  const reading = h.check()
  await new Promise(resolve => setImmediate(resolve))
  if (reason === 'stop') h.stop(); else h.expire()
  h.release()
  await reading
  assert.equal(h.saved.lastRedeem, original)
  assert.equal(h.holds(), 0)
  assert.equal(h.guards.redeem, false)
  assert.equal(h.closed.length, reason === 'stop' ? 0 : 1)
})

test('catalog startup failure still releases the guard and worker hold', async () => {
  const h = harness({ failBegin: true })
  await h.check()
  assert.equal(h.holds(), 0)
  assert.equal(h.guards.redeem, false)
  assert.equal(h.creates(), 0)
})
