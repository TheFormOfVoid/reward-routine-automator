// The query chain: pick a query, avoid recent repeats, and prefetch the next
// one so the batch's idle delay window absorbs the fetch chain's latency
// instead of the next keystroke paying it.
//
// Fetching a query is storage reads plus up to four sequential network calls,
// and it used to run ON the critical path — after the tab loaded, before the
// first keystroke, the batch paid the whole chain's latency every search, only
// to then idle through a 5-15s inter-search delay. The prefetch starts when
// the current search is done (and at batch start), fills that idle window, and
// the next tick consumes it warm. Module-level state, so an evicted worker just
// forgets it and the next tick fetches cold — the old behavior, not worse.

import { generateMeaningfulQuery, type QueryResult } from './sources.ts'

const RECENT_QUERY_MEMORY = 200

// Repeat queries don't earn points, so keep a short history and avoid them.
export async function nextQuery(): Promise<QueryResult> {
  const { recentQueries } = await chrome.storage.local.get('recentQueries')
  const recent: string[] = Array.isArray(recentQueries) ? recentQueries : []

  let chosen = await generate()
  for (let i = 0; i < 5 && recent.includes(chosen.query.toLowerCase()); i++) {
    chosen = await generate()
  }

  return chosen
}

// Preparing a query is not submitting it. Record it only after the driver has
// observed the matching results navigation, so abandoned prefetches and retries
// do not consume the recent-submission history.
export async function recordSubmittedQuery(query: string): Promise<void> {
  const key = query.trim().toLowerCase().slice(0, 90)
  if (!key) return
  const stored = await chrome.storage.local.get('recentQueries')
  const recent: string[] = Array.isArray(stored.recentQueries) ? stored.recentQueries.filter((q: unknown): q is string => typeof q === 'string') : []
  await chrome.storage.local.set({ recentQueries: [key, ...recent.filter(q => q !== key)].slice(0, RECENT_QUERY_MEMORY) })
}

let nextQueryPrefetch: Promise<QueryResult> | null = null

export function startQueryPrefetch(): void {
  if (nextQueryPrefetch) return // one in flight is all a batch can use
  const pending = nextQuery()
  // The consumer handles the real error; this only silences the "never
  // consumed" case (batch finished, worker evicted) that would otherwise
  // surface as an unhandled rejection.
  pending.catch(() => {})
  nextQueryPrefetch = pending
}

// The warm query if the prefetch produced one, the cold fetch otherwise.
export async function awaitedQuery(): Promise<QueryResult> {
  if (nextQueryPrefetch) {
    const pending = nextQueryPrefetch
    nextQueryPrefetch = null
    try {
      return await pending
    } catch (e) {
      console.warn('Prefetched query failed, fetching fresh:', e)
    }
  }
  return nextQuery()
}

// ---------- Test seam ----------
// The chain's only interesting behavior beyond nextQuery is which generator
// feeds it. Production uses sources.generateMeaningfulQuery; tests swap in a
// stub without reaching into module state. Never called by the worker.
let generate: () => Promise<QueryResult> = generateMeaningfulQuery
export function setQueryGenerator(fn: () => Promise<QueryResult>): void {
  generate = fn
}
