import { STREAKS } from '../../shared/settings.ts'
import type { Stats } from '../../shared/storage.ts'
import { streakWeek } from '../lib/streak-week.ts'

const STATUS = { completed: 'Completed', pending: 'Needs completion', future: 'Upcoming', unknown: 'Not verified' } as const

export function WeeklyStreaks({ stats, compact = false }: { stats: Stats | null; compact?: boolean }) {
  return <div className={`weekly-streaks${compact ? ' weekly-streaks--compact' : ''}`}>
    {STREAKS.map(({ key, label }) => {
      const value = stats?.activities?.[key]
      const week = streakWeek(value, stats?.at)
      return <div className="streak-week-row" key={key}>
        <div className="streak-week-head"><span>{label}</span><span className={`streak-week-status streak-week-status--${week.current}`}>{STATUS[week.current]}</span></div>
        <div className="streak-week" role="list" aria-label={`${label}: seven days`} title={value || 'Refresh to read this activity'}>
          {week.days.map(day => <span key={day.label} role="listitem" className={`streak-week-segment${day.current ? ' streak-week-segment--current' : ''}`}
            data-state={day.state} aria-current={day.current ? 'date' : undefined} aria-label={`${day.label}: ${STATUS[day.state]}`} title={`${day.label}: ${STATUS[day.state]}`}>
            <span className="streak-week-mark" aria-hidden="true">{day.state === 'pending' ? '•' : day.state === 'unknown' ? '–' : ''}</span>
          </span>)}
        </div>
      </div>
    })}
  </div>
}
