import type { Settings } from '../../shared/settings.ts'
import type { RunRecord } from '../../shared/storage.ts'

export function timeMinutes(time: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(String(time))
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export function inQuietHours(settings: Pick<Settings, 'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd'>, now = new Date()): boolean {
  if (!settings.quietHoursEnabled) return false
  const start = timeMinutes(settings.quietHoursStart)
  const end = timeMinutes(settings.quietHoursEnd)
  if (start == null || end == null || start === end) return false
  const minute = now.getHours() * 60 + now.getMinutes()
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

export function quietHoursEndAt(settings: Pick<Settings, 'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd'>, now = new Date()): number | null {
  if (!inQuietHours(settings, now)) return null
  const end = timeMinutes(settings.quietHoursEnd)!
  const next = new Date(now)
  next.setHours(Math.floor(end / 60), end % 60, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime()
}

// Historical ranges only compare the same enabled step set. Failed/cancelled
// runs and implausible durations cannot promise an unrealistically quick run.
export function estimateRoutine(history: RunRecord[] | undefined, steps: string[]): { minMs: number; maxMs: number; samples: number } | null {
  const key = [...steps].sort().join(',')
  const durations = (Array.isArray(history) ? history : []).filter(run =>
    run && run.status === 'completed' && [...(run.steps || [])].sort().join(',') === key &&
    Number.isFinite(run.endedAt) && run.endedAt! > run.startedAt,
  ).map(run => run.endedAt! - run.startedAt).filter(ms => ms < 2 * 60 * 60_000).slice(0, 10).sort((a, b) => a - b)
  if (durations.length < 3) return null
  return { minMs: durations[Math.floor((durations.length - 1) * .2)], maxMs: durations[Math.ceil((durations.length - 1) * .8)], samples: durations.length }
}

export function recoveryBudgetAvailable(startedAt: number | undefined, actions: number | undefined, now = Date.now()): boolean {
  // This is an additional run-wide ceiling, alongside per-query and
  // no-progress limits. Legacy runs without a start time retain old behavior.
  return (actions || 0) < 12 && (!startedAt || now - startedAt < 45 * 60_000)
}
