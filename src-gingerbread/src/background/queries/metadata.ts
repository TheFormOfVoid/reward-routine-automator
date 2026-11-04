// UI-safe provider names/order. Importing settings labels must not pull the
// worker's network providers and parsing implementation into extension pages.
export const QUERY_SOURCE_LABELS: Record<string, { name: string }> = {
  bingAutosuggest: { name: 'Bing autosuggest' },
  googleTrends: { name: 'Google Trends' },
  wikipedia: { name: 'Wikipedia' },
  uselessFacts: { name: 'UselessFacts' },
  local: { name: 'local-fallback' },
}
export const DEFAULT_QUERY_SOURCE_ORDER = Object.keys(QUERY_SOURCE_LABELS)
