import test from 'node:test'
import assert from 'node:assert/strict'
import { createStorageStore } from '../src/popup/hooks/storage-store.ts'
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('storage failure is visible and a retry loads without writing defaults', async () => {
  let reads = 0
  const store = createStorageStore({ get: async () => { if (++reads === 1) throw Error('unavailable'); return { settings: { theme: 'nord' } } }, listen() {} })
  store.subscribe('sync', 'settings', () => {})
  await settle()
  assert.equal(store.snapshot('sync', 'settings').loaded, false)
  assert.equal(store.snapshot('sync', 'settings').error, 'unavailable')
  store.retry('sync', 'settings')
  await settle()
  assert.deepEqual(store.snapshot('sync', 'settings'), { raw: { theme: 'nord' }, loaded: true, error: null })
})

test('subscribers share one initial read and event data wins a late response', async () => {
  let reads = 0
  let change: (changes: Record<string, { newValue?: unknown }>, area: string) => void
  let answer: (data: Record<string, unknown>) => void
  const store = createStorageStore({ get: async () => { reads++; return new Promise((resolve) => { answer = resolve }) }, listen(callback) { change = callback } })
  store.subscribe('local', 'history', () => {})
  store.subscribe('local', 'history', () => {})
  await settle()
  change!({ history: { newValue: ['fresh'] } }, 'local')
  answer!({ history: ['stale'] })
  await settle()
  assert.equal(reads, 1)
  assert.deepEqual(store.snapshot('local', 'history').raw, ['fresh'])
})

test('a hung storage read times out and can be retried', async () => {
  let reads = 0
  const store = createStorageStore({ get: async () => { reads++; return reads === 1 ? new Promise(() => {}) : { settings: {} } }, listen() {} }, 5)
  store.subscribe('sync', 'settings', () => {})
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.match(store.snapshot('sync', 'settings').error || '', /did not answer/)
  store.retry('sync', 'settings')
  await settle()
  assert.equal(store.snapshot('sync', 'settings').loaded, true)
})
