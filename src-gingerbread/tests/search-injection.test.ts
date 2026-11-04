import test from 'node:test'
import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'
import { performHumanTypedSearchOnBing } from '../src/background/injections/typed-search.ts'

// Evaluate the serialized function in a fresh page-like realm. No module
// helpers are present, exactly as with chrome.scripting.executeScript({func}).
function page(options: { missingInput?: boolean; hangStorage?: boolean } = {}) {
  let now = 1_000_000
  let serial = 0
  let clicks = 0
  let state: any = { stopEpoch: 0, batch: { runId: 2, attemptId: 1, attemptStartedAt: now } }
  const timers = new Map<number, { at: number; fire: () => void }>()
  const events: string[] = []
  const input = { value: '', focus() {}, dispatchEvent(event: any) { events.push(event.type) } }
  const form = { querySelector: () => null }
  const button = { click() { clicks++ } }
  const context = createContext({
    console,
    Date: class extends Date { static now() { return now } },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    setTimeout: (fire: () => void, ms: number) => { const id = ++serial; timers.set(id, { at: now + ms, fire }); return id },
    clearTimeout: (id: number) => { timers.delete(id) },
    document: { querySelector: (selector: string) => selector === '#sb_form_q' ? (options.missingInput ? null : input)
      : selector === '#sb_form' ? form : selector === '#sb_form_go' ? button : null },
    KeyboardEvent: class { type: string; constructor(type: string) { this.type = type } },
    InputEvent: class { type: string; constructor(type: string) { this.type = type } },
    chrome: { storage: { local: { get: async () => options.hangStorage ? new Promise(() => {}) : { runState: structuredClone(state) } } } },
  })
  runInContext(`var typeSearch = ${performHumanTypedSearchOnBing.toString()}`, context)
  return {
    input, events, clicks: () => clicks,
    stop() { state = { stopEpoch: 1, batch: null } },
    start(query = 'cats') {
      return runInContext(`typeSearch(${JSON.stringify(query)}, {runId:2, attemptId:1, stopEpoch:0, expiresAt:${now + 60000}})`, context) as Promise<any>
    },
    async drain() {
      await new Promise(resolve => setImmediate(resolve))
      for (let budget = 0; timers.size && budget < 1000; budget++) {
        const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        timers.delete(id)
        now = timer.at
        timer.fire()
        await new Promise(resolve => setImmediate(resolve))
      }
      assert.equal(timers.size, 0, 'page timers must settle')
    },
  }
}

test('serialized typed search emits character events and schedules one submission', async () => {
  const h = page()
  const result = h.start()
  await h.drain()
  assert.equal((await result).ok, true)
  assert.equal(h.input.value, 'cats')
  assert.equal(h.events.filter(type => type === 'input').length, 4)
  assert.equal(h.clicks(), 1)
})

test('missing input is an explicit failure, never a successful zero-duration search', async () => {
  const h = page({ missingInput: true })
  const result = await h.start()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing-input')
  assert.equal(h.clicks(), 0)
})

test('Stop before the pre-submit checkpoint cancels the page-side search', async () => {
  const h = page()
  const result = h.start()
  await new Promise(resolve => setImmediate(resolve))
  h.stop()
  await h.drain()
  assert.equal((await result).ok, false)
  assert.equal(h.clicks(), 0)
})

test('a newer page invocation supersedes old timers before they can submit', async () => {
  const h = page()
  const old = h.start('old query')
  const current = h.start('new query')
  await h.drain()
  assert.equal((await old).ok, false)
  assert.equal((await current).ok, true)
  assert.equal(h.clicks(), 1)
  assert.equal(h.input.value, 'new query')
})

test('page lease expires even if the storage checkpoint never answers', async () => {
  const h = page({ hangStorage: true })
  const result = h.start()
  await h.drain()
  assert.equal((await result).ok, false)
  assert.equal((await result).reason, 'typing-deadline')
  assert.equal(h.clicks(), 0)
})

test('Stop after the reply but before the queued click still prevents submission', async () => {
  const h = page()
  const result = h.start()
  result.then(() => h.stop())
  await h.drain()
  assert.equal((await result).ok, true) // the worker still requires a navigation receipt
  assert.equal(h.clicks(), 0)
})
