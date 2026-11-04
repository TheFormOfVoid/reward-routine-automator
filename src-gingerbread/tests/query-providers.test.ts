import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithTimeout, parseTrendTitles, generateMeaningfulQuery, QUERY_SOURCES } from '../src/background/queries/sources.ts'

test('Trends RSS titles parse in a worker without DOMParser', () => {
  const xml = '<rss><channel><title>Feed title</title><item><title>Space &amp; science &#x1f680;</title></item>' +
    '<item><title><![CDATA[Research & development]]></title></item><item><title>Space &amp; science &#x1f680;</title></item></channel></rss>'
  assert.deepEqual(parseTrendTitles(xml), ['Space & science 🚀', 'Research & development'])
  assert.deepEqual(parseTrendTitles('<rss><item><title>&quot;Cats&quot; &apos;dogs&apos; &#65;</title></item></rss>'), ['"Cats" \'dogs\' A'])
  assert.deepEqual(parseTrendTitles('<rss><item><title>&#x110000;&#xD800;&#0;</title></item></rss>'), [])
})

test('Trends parser rejects entity declarations and bounds unsupported input', () => {
  assert.throws(() => parseTrendTitles('<!DOCTYPE rss [<!ENTITY external SYSTEM "file:///secret">]><rss/>'), /Unsupported/)
  assert.throws(() => parseTrendTitles('x'.repeat(2 * 1024 * 1024 + 1)), /Unsupported/)
})

test('response deadline includes a stalled body after successful headers', async () => {
  const original = globalThis.fetch
  let signal: AbortSignal | undefined
  globalThis.fetch = (async (_url, options) => {
    signal = options?.signal as AbortSignal
    return { arrayBuffer: () => new Promise(() => {}) } as unknown as Response
  }) as typeof fetch
  try {
    await assert.rejects(fetchWithTimeout('https://example.com/', 15), /deadline/)
    assert.equal(signal?.aborted, true)
  } finally { globalThis.fetch = original }
})

test('buffered fetch preserves JSON, content type and final URL', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    const response = new Response('{"answer":42}', { headers: { 'content-type': 'application/json' } })
    Object.defineProperty(response, 'url', { value: 'https://example.com/final' })
    return response
  }) as typeof fetch
  try {
    const response = await fetchWithTimeout('https://example.com/')
    assert.equal(response.url, 'https://example.com/final')
    assert.equal(response.headers.get('content-type'), 'application/json')
    assert.deepEqual(await response.json(), { answer: 42 })
  } finally { globalThis.fetch = original }
})

test('failed providers cool down while the local fallback remains immediately available', async () => {
  const originalChrome = globalThis.chrome
  const originalNow = Date.now
  const originalBing = QUERY_SOURCES.bingAutosuggest.get
  const originalLocal = QUERY_SOURCES.local.get
  let now = Date.now()
  let attempts = 0
  globalThis.chrome = { storage: { sync: { get: async () => ({ settings: {
    querySourceOrder: ['bingAutosuggest', 'local', 'googleTrends', 'wikipedia', 'uselessFacts'],
  } }) } } } as any
  Date.now = () => now
  QUERY_SOURCES.bingAutosuggest.get = async () => { attempts++; throw new Error('offline') }
  QUERY_SOURCES.local.get = async () => ({ query: 'available fallback', api: 'local' })
  try {
    assert.equal((await generateMeaningfulQuery()).query, 'available fallback')
    await generateMeaningfulQuery()
    assert.equal(attempts, 1)
    now += 30_001
    await generateMeaningfulQuery()
    assert.equal(attempts, 2)
  } finally {
    globalThis.chrome = originalChrome
    Date.now = originalNow
    QUERY_SOURCES.bingAutosuggest.get = originalBing
    QUERY_SOURCES.local.get = originalLocal
  }
})
