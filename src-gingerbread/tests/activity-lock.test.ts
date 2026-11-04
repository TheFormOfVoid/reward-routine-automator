import test from 'node:test'
import assert from 'node:assert/strict'
import { withActivityLock } from '../src/shared/activity-lock.ts'
import { createTaskAdmission } from '../src/background/core/task-admission.ts'
import type { RunState } from '../src/shared/storage.ts'

test('restore and worker admission exclude each other and release after failure', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const held = new Set<string>()
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    async request(name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) {
      if (held.has(name)) return work(null)
      held.add(name)
      try { return await work({ name }) } finally { held.delete(name) }
    },
  } } })
  try {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const restoring = withActivityLock(async () => {
      entered()
      await new Promise<void>(resolve => { release = resolve })
    })
    await started
    let effects = 0
    const launch = createTaskAdmission(async () => ({ routine: null, batch: null, activity: null }) as RunState,
      async () => {}, withActivityLock)
    const blocked = await launch(async () => { effects++ })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error!, /backup restore/)
    assert.equal(effects, 0)
    release()
    await restoring
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal((await launch(async () => { effects++ })).ok, true)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(effects, 1)
    await assert.rejects(withActivityLock(async () => { throw new Error('restore failed') }), /restore failed/)
    await withActivityLock(async () => { effects++ })
    assert.equal(effects, 2)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})
