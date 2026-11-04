import { useCallback, useSyncExternalStore } from 'react'
import { createStorageStore } from './storage-store.ts'

const store = createStorageStore({
  get: (area, key) => chrome.storage[area].get(key),
  listen: (callback) => chrome.storage.onChanged.addListener(callback),
})

// One listener and one initial read per key for the whole page. An unread
// setting remains unread on error: the UI can retry without overwriting it.
export function useStorageValue<T>(area: 'local' | 'sync', key: string, fallback: T): {
  value: T; loaded: boolean; error: string | null; retry: () => void
} {
  const subscribe = useCallback((notify: () => void) => store.subscribe(area, key, notify), [area, key])
  const snapshot = useSyncExternalStore(subscribe, () => store.snapshot(area, key))
  const retry = useCallback(() => store.retry(area, key), [area, key])
  return { value: snapshot.raw === undefined ? fallback : snapshot.raw as T, loaded: snapshot.loaded, error: snapshot.error, retry }
}
