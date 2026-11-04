import { ENABLED_KEY, STEP_LABEL } from '../../shared/settings.ts'
import type { Settings, StepId } from '../../shared/settings.ts'
import type { Stats } from '../../shared/storage.ts'
import { progressPair, statsAreCurrent, stepSkipReason } from './verdicts.ts'

export interface RemainingStep { id: StepId; label: string; status: 'complete' | 'incomplete' | 'unknown'; detail: string }
export function remainingSteps(stats: Stats | null | undefined, settings: Settings): RemainingStep[] {
  return (['dailySet', 'keepEarning', 'imageSearch', 'search', 'claim'] as StepId[]).filter(id => settings[ENABLED_KEY[id]]).map(id => {
    const reason = statsAreCurrent(stats) ? stepSkipReason(id, stats!) : null
    const observed = statsAreCurrent(stats) && Boolean(id === 'claim'
      ? /^\d+$/.test(String(stats?.readyToClaim || '').replace(/,/g, '').trim())
      : id === 'keepEarning' ? stats?.keepEarning && Number.isFinite(stats.keepEarning.open) && Number.isFinite(stats.keepEarning.total)
      : progressPair(id === 'search' ? stats?.searchPoints : id === 'dailySet' ? stats?.activities?.dailySet : stats?.activities?.visualSearch))
    return { id, label: STEP_LABEL[id], status: reason ? 'complete' : observed ? 'incomplete' : 'unknown',
      detail: reason || (observed ? 'Progress remains' : 'Could not verify; open Rewards to check') }
  })
}
