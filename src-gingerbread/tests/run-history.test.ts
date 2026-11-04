import test from 'node:test'
import assert from 'node:assert/strict'
import { startRunRecord, recordRunEvent, finishRunRecord, reconcileRunRecord } from '../src/background/core/run-history.ts'
import type { RunState } from '../src/shared/storage.ts'

test('run history fences stale writers, caps events and retains completed outcomes', async () => {
  const data: Record<string, any> = {}
  ;(globalThis as any).chrome = { storage: { local: {
    get: async (key: string) => ({ [key]: data[key] }), set: async (value: any) => Object.assign(data, value), remove: async (key: string) => { delete data[key] },
  } } }
  const first = await startRunRecord('manual', ['search'])
  const second = await startRunRecord('manual', ['claim'])
  await recordRunEvent(first, 'search', 'failed', 'Stale')
  assert.equal(data.activeRun.events.length, 0)
  await Promise.all(Array.from({ length: 110 }, (_, i) => recordRunEvent(second, 'claim', 'started', String(i))))
  assert.equal(data.activeRun.events.length, 100)
  await finishRunRecord(first, 'cancelled', 'Stale')
  assert.equal(data.activeRun.id, second)
  await finishRunRecord(second, 'completed', 'Verified')
  assert.equal(data.activeRun, undefined)
  assert.equal(data.runHistory[0].status, 'completed')
  assert.equal(data.runHistory[0].events.length, 100)
  await startRunRecord('startup', ['imageSearch'])
  await reconcileRunRecord({ routine: null, batch: null, activity: null } as RunState)
  assert.equal(data.activeRun, undefined)
  assert.equal(data.runHistory[0].status, 'unknown')
})

test('optional history times out and a late read cannot publish stale events', async () => {
  const previous = globalThis.chrome
  let release!: (value: unknown) => void
  let writes = 0
  globalThis.chrome = { storage: { local: {
    get: () => new Promise(resolve => { release = resolve }),
    set: async () => { writes++ },
  } } } as unknown as typeof chrome
  try {
    await recordRunEvent('late', 'search', 'submitted')
    release({ activeRun: { id: 'late', events: [] } })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(writes, 0)
    assert.equal(await startRunRecord('manual', ['search']), '')
  } finally { globalThis.chrome = previous }
})
