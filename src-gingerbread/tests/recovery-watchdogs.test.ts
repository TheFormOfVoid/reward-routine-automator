import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureRecoveryWatchdogs } from '../src/background/core/recovery-watchdogs.ts'
import type { RunState } from '../src/shared/storage.ts'

test('worker wake rearms lost recovery alarms without resetting existing schedules', async () => {
  const original = globalThis.chrome
  const alarms = new Map<string, unknown>([['search', { when: 123 }]])
  const created: string[] = []
  globalThis.chrome = { alarms: {
    get: async (name: string) => alarms.get(name),
    create: async (name: string, value: unknown) => { created.push(name); alarms.set(name, value) },
  } } as unknown as typeof chrome
  try {
    const state = { batch: {}, routine: {} } as RunState
    await ensureRecoveryWatchdogs(state, { search: 'search', routine: 'routine' })
    assert.deepEqual(created, ['routine'])
    assert.deepEqual(alarms.get('search'), { when: 123 })
    await ensureRecoveryWatchdogs(state, { search: 'search', routine: 'routine' })
    assert.deepEqual(created, ['routine'])
    alarms.clear()
    await ensureRecoveryWatchdogs({ ...state, pause: { requestedAt: 1, effectiveAt: 2 } }, { search: 'search', routine: 'routine' })
    assert.equal(alarms.size, 0, 'paused work needs no periodic wake')
  } finally { globalThis.chrome = original }
})
