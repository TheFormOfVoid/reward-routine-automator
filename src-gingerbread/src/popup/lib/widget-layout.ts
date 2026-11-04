export const POPUP_WIDGET_KEY = 'popupWidgetLayout'
export const WIDGETS = [
  { id: 'balance', title: 'Balance' },
  { id: 'streaks', title: "Today's streaks" },
  { id: 'history', title: 'Points history' },
  { id: 'goal', title: 'Points goal' },
  { id: 'plan', title: 'Next routine' },
] as const
export type WidgetId = typeof WIDGETS[number]['id']
export type WidgetSize = 'compact' | 'wide' | 'detailed'
export interface PopupWidget { id: WidgetId; size: WidgetSize }
export interface PopupWidgetLayout { v: 1; items: PopupWidget[] }

export function defaultWidgets(hasGoal = false): PopupWidget[] {
  return (['balance', 'streaks', 'history', ...(hasGoal ? ['goal'] : []), 'plan'] as WidgetId[])
    .map(id => ({ id, size: 'wide' }))
}

/** An explicit empty board stays empty; malformed documents use safe defaults. */
export function normalizeWidgets(raw: unknown, hasGoal = false): PopupWidget[] {
  if (!raw || typeof raw !== 'object' || (raw as PopupWidgetLayout).v !== 1 || !Array.isArray((raw as PopupWidgetLayout).items)) return defaultWidgets(hasGoal)
  const result: PopupWidget[] = []
  for (const item of (raw as PopupWidgetLayout).items) {
    if (!item || !WIDGETS.some(widget => widget.id === item.id) || result.some(widget => widget.id === item.id)) continue
    result.push({ id: item.id, size: ['compact', 'wide', 'detailed'].includes(item.size) ? item.size : 'wide' })
  }
  return result
}

export function resizeWidget(items: PopupWidget[], id: WidgetId, size: WidgetSize): PopupWidget[] {
  return items.map(item => item.id === id ? { ...item, size } : item)
}

export function moveWidget(items: PopupWidget[], id: WidgetId, direction: -1 | 1): PopupWidget[] {
  const index = items.findIndex(item => item.id === id)
  const next = index + direction
  if (index < 0 || next < 0 || next >= items.length) return items
  const result = [...items]
  ;[result[index], result[next]] = [result[next], result[index]]
  return result
}
