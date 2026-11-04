import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskAdmission } from '../src/background/core/task-admission.ts'
import type { RunState } from '../src/shared/storage.ts'

test('concurrent commands reserve before asynchronous ownership reads and do not overlap effects', async () => {
  let finish!: () => void
  let started = 0
  const idle = { routine: null, batch: null, activity: null } as RunState
  const launch = createTaskAdmission(async () => idle, async () => {})
  const first = launch(() => { started++; return new Promise<void>(resolve => { finish = resolve }) })
  const second = launch(async () => { started++ })
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, false)
  assert.equal(started, 1)
  finish()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await launch(async () => { started++ })).ok, true)
})

test('durable ownership blocks new commands and failed commands release their admission reservation', async () => {
  let busy = true, failures = 0, effects = 0
  const launch = createTaskAdmission(async () => ({ routine: busy ? {} : null, batch: null, activity: null }) as RunState, async () => { failures++ })
  assert.equal((await launch(async () => { effects++ })).ok, false)
  busy = false
  assert.equal((await launch(async () => { throw new Error('fixture failure') })).ok, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(failures, 1)
  assert.equal((await launch(async () => { effects++ })).ok, true)
  assert.equal(effects, 1)
})
