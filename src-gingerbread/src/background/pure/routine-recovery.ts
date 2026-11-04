import type { Settings, StepId } from '../../shared/settings.ts'
import { ENABLED_KEY } from '../../shared/settings.ts'
import type { Stats } from '../../shared/storage.ts'
import { POINTS_PER_SEARCH, progressPair, statsAreCurrent } from './verdicts.ts'

export const MAX_ROUTINE_RECOVERY_ROUNDS = 2

export interface RecoveryPlan {
  steps: StepId[]
  progress: Record<string, number>
  searchCount: number
  reason: 'retry' | 'complete-or-unreadable' | 'stale-read' | 'limit' | 'no-progress'
}

// Final recovery is stricter than the initial routine: unknown values do not
// authorize more work. A successful submission is not evidence of credit.
export function planRoutineRecovery(
  stats: Stats | null | undefined,
  readStartedAt: number,
  originallyEnabled: string[],
  settings: Settings,
  round: number,
  previous: Record<string, number> = {},
  now = new Date(),
): RecoveryPlan {
  const empty = (reason: RecoveryPlan['reason']): RecoveryPlan => ({ steps: [], progress: {}, searchCount: 0, reason })
  if (round >= MAX_ROUTINE_RECOVERY_ROUNDS) return empty('limit')
  if (!statsAreCurrent(stats, now) || !Number.isFinite(stats?.at) || stats!.at! < readStartedAt || stats!.at! > now.getTime()) {
    return empty('stale-read')
  }
  const incomplete = new Map<StepId, number>()
  const pair = (id: StepId, value: unknown) => {
    const p = progressPair(value)
    if (p && p[1] > 0 && p[0] < p[1]) incomplete.set(id, p[0])
  }
  pair('search', stats!.searchPoints)
  pair('dailySet', stats!.activities?.dailySet)
  pair('imageSearch', stats!.activities?.visualSearch)
  const claim = stats!.readyToClaim?.replace(/,/g, '').trim()
  if (claim && /^\d+$/.test(claim) && Number(claim) > 0) incomplete.set('claim', -Number(claim))
  const keep = stats!.keepEarning
  if (keep && Number.isFinite(keep.total) && keep.total > 0 && Number.isFinite(keep.open) && keep.open > 0) {
    incomplete.set('keepEarning', -keep.open)
  }
  const candidates = [...new Set(originallyEnabled)].filter((id): id is StepId =>
    id in ENABLED_KEY && Boolean(settings[ENABLED_KEY[id as StepId]]) && incomplete.has(id as StepId),
  )
  const steps = candidates.filter(id => round === 0 ||
    (Number.isFinite(previous[id]) && incomplete.get(id)! > previous[id]),
  )
  const search = progressPair(stats!.searchPoints)
  const configuredCount = Math.max(1, Math.floor(settings.searchesPerBatch) || 1)
  const searchCount = steps.includes('search') && search
    ? Math.min(configuredCount, Math.ceil((search[1] - search[0]) / POINTS_PER_SEARCH))
    : 0
  return {
    steps, searchCount,
    progress: Object.fromEntries(steps.map(id => [id, incomplete.get(id)!])),
    reason: steps.length ? 'retry' : candidates.length ? 'no-progress' : 'complete-or-unreadable',
  }
}
