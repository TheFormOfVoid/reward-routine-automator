import { useCallback, useMemo } from 'react'
import { DEFAULT_SETTINGS, saveSettings } from '../../shared/settings.ts'
import type { Settings } from '../../shared/settings.ts'
import { useStorageValue } from './useStorageValue.ts'
import { normalizeSettings } from '../../shared/settings-validation.ts'

// A stable empty fallback: useStorageValue hands the fallback straight back
// while the key is absent, so a fresh {} each render would defeat the memo
// below. One module-level object keeps the reference steady.
const NO_STORED: Partial<Settings> = {}

// The live settings, merged over the defaults exactly as getSettings does on
// the worker side — so a key an update added falls back to its default and a
// value the user set survives. `save` round-trips through saveSettings
// (read-merge-write), and the write comes back through the same storage
// subscription, so there is one source of truth and no optimistic local copy
// to drift. `loaded` is false until the stored blob actually arrives; App
// withholds the whole UI until then so nothing renders from the defaults
// first (the glass tint, theme and frame height would all flash otherwise).
export function useSettings(): {
  settings: Settings
  save: (patch: Partial<Settings>) => Promise<Settings>
  loaded: boolean
  error: string | null
  retry: () => void
} {
  const { value: stored, loaded, error, retry } = useStorageValue<Partial<Settings>>('sync', 'settings', NO_STORED)
  // Merge over the defaults once per stored change, not once per render: a
  // fresh object every render would churn every downstream memo and context
  // value that rides on `settings` (the dashboard's whole wiring does).
  const settings = useMemo<Settings>(() => normalizeSettings(stored, DEFAULT_SETTINGS), [stored])
  const save = useCallback((patch: Partial<Settings>) => {
    if (!loaded || error) return Promise.reject(new Error('Read your saved settings before changing them.'))
    return saveSettings(patch)
  }, [loaded, error])
  return { settings, save, loaded, error, retry }
}
