// The query sources — where search text comes from, tried in order. Each
// fetcher either returns { query, api } or throws, so a dead host only costs
// one console.warn before the next source takes over. The local generator can
// never fail, so it rounds off the chain as a source like the others rather
// than a special case after the loop.

import { localDayKey } from '../core/day.ts'
import { getSettings } from '../../shared/settings.ts'
import { slotMissingDefaults } from '../pure/orders.ts'
import { QUERY_SOURCE_LABELS, DEFAULT_QUERY_SOURCE_ORDER } from './metadata.ts'
export { DEFAULT_QUERY_SOURCE_ORDER } from './metadata.ts'

export interface QueryResult {
  query: string
  api: string
}

interface QuerySource {
  name: string
  get: () => Promise<QueryResult>
}

const MAX_QUERY_LEN = 90
const TRENDS_CACHE = 'trendsCache'

// Topic pool for the search queries. Doubles as the seed pool for Bing
// autosuggest, so it lives at module scope instead of inside one function.
const QUERY_SEED_TOPICS = [
  'machine learning',
  'react typescript',
  'node js backend',
  'virtual reality games',
  'linux customization',
  'anime recommendations',
  'competitive gaming strategies',
  'cloud hosting tutorials',
  'saudi arabia technology',
  'data structures algorithms',
  'kubernetes networking',
  'rust programming',
  'home coffee brewing',
  'electric vehicle batteries',
  'astrophotography setup',
  'mechanical keyboards',
  'indoor plant care',
  'personal finance budgeting',
  'photography composition',
  'docker compose',
  'postgres performance tuning',
  '3d printing materials',
  'language learning methods',
  'desert hiking trails',
]

function randomSeedWord(): string {
  return QUERY_SEED_TOPICS[Math.floor(Math.random() * QUERY_SEED_TOPICS.length)]
}

function generateFallbackQuery(): string {
  const verbs = [
    'guide',
    'tips',
    'best practices',
    'tutorial',
    'examples',
    'resources',
    'introduction',
    'advanced concepts',
    'common mistakes',
    'comparison',
    'checklist',
    'walkthrough',
  ]

  const extras = [
    '2026',
    'for beginners',
    'step by step',
    'for professionals',
    'free course',
    'documentation',
    'full explanation',
    'explained simply',
    'with examples',
    'cheat sheet',
    'from scratch',
    'real world cases',
  ]

  const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)]
  return `${pick(QUERY_SEED_TOPICS)} ${pick(verbs)} ${pick(extras)}`
}

// Bing does not credit very long queries reliably, and typing them out is slow.
export function trimQuery(text: string | null | undefined): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= MAX_QUERY_LEN) return clean

  const cut = clean.slice(0, MAX_QUERY_LEN)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()
}

export async function fetchWithTimeout(url: string, timeoutMs = 6000): Promise<Response> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Response deadline exceeded')) }, timeoutMs)
  })
  try {
    // fetch() resolves at headers. Buffering while the abort/deadline is still
    // armed covers a body that stalls forever after an otherwise quick reply.
    // Every caller consumes the body exactly once; image callers retain blob's
    // content type and query callers retain json/text behavior.
    return await Promise.race([deadline, (async () => {
      const response = await fetch(url, { signal: controller.signal })
      const body = await response.arrayBuffer()
      if (body.byteLength > 10 * 1024 * 1024) throw new Error('Response is too large')
      const buffered = new Response([204, 205, 304].includes(response.status) ? null : body,
        { status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperty(buffered, 'url', { value: response.url })
      return buffered
    })()])
  } finally {
    clearTimeout(timer!)
  }
}

// RSS title extraction is intentionally DOM-free: extension workers do not
// expose DOMParser. We accept only literal item/title content and XML's five
// predefined/numeric entities; declarations/custom entities are never expanded.
export function parseTrendTitles(xml: string): string[] {
  if (xml.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported RSS document')
  const decode = (text: string): string => text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, name: string) => {
    if (name[0] === '#') {
      const value = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ''
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()] || all
  })
  const titles: string[] = []
  for (const item of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(item[1])?.[1]
    if (!title) continue
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(title)
    const value = trimQuery(cdata ? cdata[1] : decode(title.replace(/<[^>]*>/g, '')))
    if (value) titles.push(value)
  }
  return [...new Set(titles)]
}

async function fetchBingAutosuggestQuery(): Promise<QueryResult> {
  const res = await fetchWithTimeout(
    `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(randomSeedWord())}`,
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  // Payload is ["seed", ["suggestion", ...]] — grab a random suggestion.
  const data = await res.json()
  const suggestions = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : []
  const query = trimQuery(suggestions[Math.floor(Math.random() * suggestions.length)] || '')
  if (!query) throw new Error('no suggestions')
  return { query, api: 'Bing autosuggest' }
}

// Trending searches as RSS, two geos a day (rotated by day parity) so the
// endpoint isn't hit per query. Titles are cached for the local day; a failed
// fetch throws before anything is stored, leaving the cache absent so the next
// query retries.
async function fetchGoogleTrendsQuery(): Promise<QueryResult> {
  const today = localDayKey()
  // storage.local.get types its values loosely under this @types/chrome, so the
  // cache shape is asserted at this boundary — the same reader-boundary cast
  // the page-derived reads use.
  const stored = await chrome.storage.local.get(TRENDS_CACHE)
  const cached = stored[TRENDS_CACHE] as { day?: string; titles?: string[] } | undefined

  let titles: string[] = cached && Array.isArray(cached.titles) ? cached.titles : []
  if (cached?.day !== today || !titles.length) {
    const geos = Number(today.slice(8)) % 2 === 0 ? ['US', 'GB'] : ['GB', 'CA']

    // Both geos at once: these are independent endpoints, so the cache-miss day
    // pays one round trip, not two. Promise.all preserves geo order, and any
    // failure still throws before anything is stored — the cache stays absent
    // and the next query retries.
    const docs = await Promise.all(
      geos.map(async (geo) => {
        const res = await fetchWithTimeout(`https://trends.google.com/trending/rss?geo=${geo}`)
        if (!res.ok) throw new Error(`HTTP ${res.status} for geo ${geo}`)
        return parseTrendTitles(await res.text())
      }),
    )

    titles = []
    for (const doc of docs) titles.push(...doc)

    titles = [...new Set(titles.filter(Boolean))]
    if (!titles.length) throw new Error('no trending titles')

    await chrome.storage.local.set({ [TRENDS_CACHE]: { day: today, titles } })
  }

  return {
    query: titles[Math.floor(Math.random() * titles.length)],
    api: 'Google Trends',
  }
}

async function fetchWikipediaQuery(): Promise<QueryResult> {
  const res = await fetchWithTimeout('https://en.wikipedia.org/api/rest_v1/page/random/summary')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  // The whole extract is a paragraph; only the first sentence reads as a search
  // query. (The 303 redirect to the page is followed by fetch itself.)
  const data = await res.json()
  const query = trimQuery(String(data.extract || '').split('. ')[0])
  if (!query) throw new Error('no extract')
  return { query, api: 'Wikipedia' }
}

async function fetchUselessFactsQuery(): Promise<QueryResult> {
  const res = await fetchWithTimeout('https://uselessfacts.jsph.pl/random.json?language=en')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const data = await res.json()
  const query = trimQuery(data.text || '')
  if (!query) throw new Error('no fact text')
  return { query, api: 'UselessFacts' }
}

// The local generator can never fail, so it rounds off the chain as a source
// like the others rather than a special case after the loop.
async function generateLocalFallbackQuery(): Promise<QueryResult> {
  return { query: generateFallbackQuery(), api: 'local-fallback' }
}

// The query sources, keyed by the ids stored in settings.querySourceOrder. The
// popup mirrors these ids in each row's data-source attribute.
export const QUERY_SOURCES: Record<string, QuerySource> = {
  bingAutosuggest: { ...QUERY_SOURCE_LABELS.bingAutosuggest, get: fetchBingAutosuggestQuery },
  googleTrends: { ...QUERY_SOURCE_LABELS.googleTrends, get: fetchGoogleTrendsQuery },
  wikipedia: { ...QUERY_SOURCE_LABELS.wikipedia, get: fetchWikipediaQuery },
  uselessFacts: { ...QUERY_SOURCE_LABELS.uselessFacts, get: fetchUselessFactsQuery },
  local: { ...QUERY_SOURCE_LABELS.local, get: generateLocalFallbackQuery },
}

const providerCooldown = new Map<string, { failures: number; until: number }>()

// Same tolerance as the startup order: unknown ids and duplicates go, and
// anything missing is slotted into its default position. Mirrored in the popup.
export function normalizeQuerySourceOrder(order: unknown): string[] {
  return slotMissingDefaults(order as string[] | null | undefined, DEFAULT_QUERY_SOURCE_ORDER)
}

export async function generateMeaningfulQuery(): Promise<QueryResult> {
  const settings = await getSettings()

  for (const id of normalizeQuerySourceOrder(settings.querySourceOrder)) {
    const source = QUERY_SOURCES[id]
    if (!source) continue
    if ((providerCooldown.get(id)?.until || 0) > Date.now()) continue
    try {
      const result = await source.get()
      if (result && result.query) { providerCooldown.delete(id); return result }
      throw new Error('Provider returned no usable query')
    } catch (e) {
      const failures = (providerCooldown.get(id)?.failures || 0) + 1
      providerCooldown.set(id, { failures, until: Date.now() + Math.min(5 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 4)) })
      console.warn(`Query source ${source.name} failed:`, e)
    }
  }

  // Unreachable in practice — "local" is always in the order and never fails —
  // but the caller's contract is { query, api }, not undefined.
  return generateLocalFallbackQuery()
}
