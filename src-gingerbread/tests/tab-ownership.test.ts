import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createContext, runInContext } from 'node:vm'

function harness() {
  const state: any = { captures: { capturing: ['dailySet', 'search'], opened: { dailySet: [10], search: [20] } } }
  let writes = 0
  const context = createContext({ console,
    updateRunState: async (change: (state: any) => void) => { writes++; change(state) },
    chrome: { tabs: { get: async (id: number) => ({ id, openerTabId: 10 }) } },
  })
  const source = readFileSync(new URL('../src/background/core/tabs.ts', import.meta.url), 'utf8')
  runInContext(stripTypeScriptTypes(source)
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '').replace(/^export /gm, ''), context)
  return { state, writes: () => writes, record: (tab: any) => runInContext(`recordOpenedTab(${JSON.stringify(tab)})`, context) }
}

test('a user-created tab without an owned opener never enters task capture', async () => {
  const h = harness()
  await h.record({ id: 30, url: 'https://example.com/' })
  assert.equal(h.writes(), 0)
  assert.deepEqual(h.state.captures.opened, { dailySet: [10], search: [20] })
})

test('child and grandchild tabs belong only to their owned task ancestry', async () => {
  const h = harness()
  await h.record({ id: 30, openerTabId: 10 })
  await h.record({ id: 31, openerTabId: 30 })
  await h.record({ id: 99, openerTabId: 999 })
  assert.deepEqual(Array.from(h.state.captures.opened.dailySet), [10, 30, 31])
  assert.deepEqual(Array.from(h.state.captures.opened.search), [20])
})

test('legacy numeric onCreated callers resolve opener metadata before capture', async () => {
  const h = harness()
  await h.record(30)
  assert.deepEqual(Array.from(h.state.captures.opened.dailySet), [10, 30])
})
