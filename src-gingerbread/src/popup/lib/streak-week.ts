import { parseStreak } from '../../background/pure/streaks.ts'
import { localDayKey } from '../../background/core/day.ts'

export type StreakDayState = 'completed' | 'pending' | 'future' | 'unknown'
export interface StreakDay { label: string; state: StreakDayState; current: boolean }
export interface StreakWeek { days: StreakDay[]; current: StreakDayState; cycle: boolean; fresh: boolean }

/** A daily cap cannot establish a week's earlier activity completions. */
export function streakWeek(value: string | null | undefined, at: number | undefined, now = new Date()): StreakWeek {
  const info = parseStreak(value)
  const fresh = Number.isFinite(at) && localDayKey(new Date(at!)) === localDayKey(now)
  const validPair = info?.done != null && info.total != null && info.total > 0 && info.done >= 0 && info.done <= info.total
  const current: StreakDayState = fresh && validPair ? info!.done! >= info!.total! ? 'completed' : 'pending' : 'unknown'
  // Earn's "Day N of 7 streak completed" is a completed-day COUNT. With
  // today's task pending, the next slot is N+1; after completion it is N.
  const cycle = Boolean(fresh && info?.of === 7 && Number.isInteger(info.day) && info.day! >= 0 && info.day! <= 7
    && (current === 'completed' ? info.day! > 0 : info.day! < 7))
  const today = cycle ? current === 'completed' ? info!.day! - 1 : info!.day! : (now.getDay() + 6) % 7
  const labels = cycle ? Array.from({ length: 7 }, (_, i) => `Day ${i + 1}`) : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return {
    current, cycle, fresh,
    days: labels.map((label, index) => ({ label, current: index === today,
      state: index === today ? current : index > today ? 'future' : cycle ? 'completed' : 'unknown' })),
  }
}
