import test from 'node:test'
import assert from 'node:assert/strict'
import { nextQuery, recordSubmittedQuery, setQueryGenerator } from '../src/background/queries/chain.ts'

test('query preparation leaves submitted history untouched until navigation is confirmed', async () => {
  const originalChrome = globalThis.chrome
  let saved: string[] = ['previous submission']
  let writes = 0
  globalThis.chrome = { storage: { local: {
    get: async () => ({ recentQueries: saved }),
    set: async (value: any) => { writes++; saved = value.recentQueries },
  } } } as any
  setQueryGenerator(async () => ({ query: 'Prepared search', api: 'fixture' }))
  try {
    const query = await nextQuery()
    assert.equal(query.query, 'Prepared search')
    assert.equal(writes, 0)
    assert.deepEqual(saved, ['previous submission'])
    await recordSubmittedQuery(query.query)
    assert.equal(writes, 1)
    assert.deepEqual(saved, ['prepared search', 'previous submission'])
    await recordSubmittedQuery('PREPARED SEARCH')
    assert.equal(saved.filter(value => value === 'prepared search').length, 1)
  } finally { globalThis.chrome = originalChrome }
})
