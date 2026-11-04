import { PANEL_IDS } from '../tiles/registry.ts'
import type { RGLItem } from './migrate.ts'

export const DASH_HIDDEN_KEY = 'dashHiddenWidgets'
export function normalizeHidden(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && PANEL_IDS.includes(id as typeof PANEL_IDS[number])))] : []
}
/** Removing a widget preserves its saved seat while visible widgets can move. */
export function mergeVisibleGeometry(current: RGLItem[], visible: RGLItem[], hidden: ReadonlySet<string>): RGLItem[] {
  return [...visible.filter(item => !hidden.has(item.i)), ...current.filter(item => hidden.has(item.i))]
}
