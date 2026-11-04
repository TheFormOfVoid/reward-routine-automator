import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { pickFinishSweep, isDashboardUrl } from '../src/background/pure/finish-sweep.ts'

function harness(stopAt?: 'query' | 'get' | 'window-query' | 'window-get') {
  let epoch = 1, created = 0
  const removed: number[][] = []
  const bing = { id: 10, windowId: 1, url: 'https://www.bing.com/search?q=fixture', pinned: false }
  const dashboard = { id: 20, windowId: 1, url: 'chrome-extension://fixture/dashboard.html' }
  const context = createContext({ console, pickFinishSweep, isDashboardUrl,
    currentStopEpoch: async () => epoch,
    getSettings: async () => ({ keepPinnedTabs: true }),
    readRunState: async () => ({ stopEpoch: epoch, batch: null }),
    chrome: {
      tabs: {
        query: async (options: any) => {
          if (stopAt === (options.windowId ? 'window-query' : 'query')) epoch++
          return options.windowId ? [bing] : [bing, dashboard]
        },
        get: async () => { if (stopAt === 'get') epoch++; return bing },
        create: async () => { created++; return { id: 30 } },
        remove: async (ids: number[]) => { removed.push(Array.from(ids)) },
      },
      windows: { get: async () => { if (stopAt === 'window-get') epoch++; return { type: 'normal' } } },
    },
  })
  const source = readFileSync(new URL('../src/background/core/tabs.ts', import.meta.url), 'utf8')
  runInContext(stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^export /gm, ''), context)
  return { removed, created: () => created, call: (code: string) => runInContext(code, context) }
}

test('Stop during dashboard enumeration suppresses tab removal', async () => {
  const h = harness('query')
  assert.equal(await h.call('closeOtherDashboardTabs(null, 1)'), 0)
  assert.deepEqual(h.removed, [])
})

test('Stop during captured-tab lookup suppresses tab removal', async () => {
  const h = harness('get')
  assert.equal(await h.call('closeTabs([10], true, 1)'), 0)
  assert.deepEqual(h.removed, [])
})

for (const when of ['window-query', 'window-get'] as const) test(`Stop during ${when} suppresses blank-tab creation and global removal`, async () => {
  const h = harness(when)
  assert.equal(await h.call('closeBingRewardsTabs([], 1)'), 0)
  assert.equal(h.created(), 0)
  assert.deepEqual(h.removed, [])
})

test('a live finish owner retains the requested global cleanup policy', async () => {
  const h = harness()
  assert.equal(await h.call('closeBingRewardsTabs([], 1)'), 1)
  assert.deepEqual(h.removed, [[10]])
  assert.equal(h.created(), 1, 'the original normal window remains open')
})
