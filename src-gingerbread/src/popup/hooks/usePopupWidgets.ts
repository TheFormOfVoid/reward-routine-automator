import { useEffect, useMemo, useState } from 'react'
import { useStorageValue } from './useStorageValue.ts'
import { normalizeWidgets, POPUP_WIDGET_KEY } from '../lib/widget-layout.ts'
import type { PopupWidget } from '../lib/widget-layout.ts'

export function usePopupWidgets(hasGoal: boolean) {
  const stored = useStorageValue<unknown>('local', POPUP_WIDGET_KEY, null)
  const saved = useMemo(() => normalizeWidgets(stored.value, hasGoal), [stored.value, hasGoal])
  const [draft, setDraft] = useState<PopupWidget[] | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  useEffect(() => { setDraft(null) }, [stored.value])
  async function save(items: PopupWidget[]) {
    if (!stored.loaded || stored.error) return
    setDraft(items)
    setSaveError(null)
    try { await chrome.storage.local.set({ [POPUP_WIDGET_KEY]: { v: 1, items } }) }
    catch { setSaveError('Could not save this layout. Your account data is unchanged.') }
  }
  async function reset() {
    if (!stored.loaded || stored.error) return
    try { await chrome.storage.local.remove(POPUP_WIDGET_KEY); setDraft(null); setSaveError(null) }
    catch { setSaveError('Could not reset this layout. Try again.') }
  }
  const retry = () => { if (saveError) { if (draft !== null) void save(draft); else void reset() } else stored.retry() }
  return { items: draft || saved, loaded: stored.loaded, error: saveError || stored.error, retry, writable: stored.loaded && !stored.error, save, reset }
}
