import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

test('shared UI sender exposes admission errors and clears them on the next action', async () => {
  const values: unknown[] = []
  let response = { ok: false, error: 'Another task is running.' }
  const hook = runInNewContext(stripTypeScriptTypes(readFileSync(new URL('../src/popup/hooks/useMessage.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/^export /gm, '') + '; useMessage', {
    useState: (initial: unknown) => { const index = values.push(initial) - 1; return [initial, (next: unknown) => { values[index] = next }] },
    useCallback: (callback: unknown) => callback,
    sendMessage: async () => response,
  })()
  await hook.send({ type: 'RUN_DAILY_SET' })
  assert.equal(values[0], null)
  assert.equal(values[1], 'Another task is running.')
  response = { ok: true, error: '' }
  await hook.send({ type: 'STOP_BATCH' })
  assert.equal(values[1], null)
})
