type Area = 'local' | 'sync'
export interface StorageSnapshot { raw: unknown; loaded: boolean; error: string | null }
interface Entry { snapshot: StorageSnapshot; subscribers: Set<() => void>; reading: boolean; request: number }
export interface StorageSource {
  get(area: Area, key: string): Promise<Record<string, unknown>>
  listen(callback: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void
}

// One store per page. Changes win over older reads; failed reads remain
// retryable and never get mistaken for an absent key.
export function createStorageStore(source: StorageSource, timeoutMs = 5000) {
  const entries = new Map<string, Entry>()
  let listening = false
  const entryOf = (area: Area, key: string): Entry => {
    const id = `${area}:${key}`
    let entry = entries.get(id)
    if (!entry) {
      entry = { snapshot: { raw: undefined, loaded: false, error: null }, subscribers: new Set(), reading: false, request: 0 }
      entries.set(id, entry)
    }
    return entry
  }
  const publish = (entry: Entry, raw: unknown, loaded: boolean, error: string | null) => {
    if (entry.snapshot.raw === raw && entry.snapshot.loaded === loaded && entry.snapshot.error === error) return
    entry.snapshot = { raw, loaded, error }
    for (const notify of entry.subscribers) notify()
  }
  const read = (area: Area, key: string, entry: Entry) => {
    if (entry.reading || entry.snapshot.loaded) return
    entry.reading = true
    const request = ++entry.request
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Storage did not answer. Try again.')), timeoutMs)
    })
    Promise.race([Promise.resolve().then(() => source.get(area, key)), deadline])
      .then((obj) => {
        if (entry.request !== request || entry.snapshot.loaded) return
        publish(entry, obj[key], true, null)
      })
      .catch((error: unknown) => {
        if (entry.request !== request || entry.snapshot.loaded) return
        publish(entry, entry.snapshot.raw, false, error instanceof Error ? error.message : 'Storage could not be read.')
      })
      .finally(() => {
        clearTimeout(timer)
        if (entry.request === request) entry.reading = false
      })
  }
  return {
    snapshot(area: Area, key: string) { return entryOf(area, key).snapshot },
    subscribe(area: Area, key: string, notify: () => void) {
      if (!listening) {
        listening = true
        source.listen((changes, areaName) => {
          if (areaName !== 'local' && areaName !== 'sync') return
          for (const [key, change] of Object.entries(changes)) {
            const entry = entries.get(`${areaName}:${key}`)
            if (entry) publish(entry, change.newValue, true, null)
          }
        })
      }
      const entry = entryOf(area, key)
      entry.subscribers.add(notify)
      read(area, key, entry)
      return () => { entry.subscribers.delete(notify) }
    },
    retry(area: Area, key: string) {
      const entry = entryOf(area, key)
      if (entry.reading) return
      publish(entry, entry.snapshot.raw, false, null)
      read(area, key, entry)
    },
  }
}
