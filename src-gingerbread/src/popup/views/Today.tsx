import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import type { Settings, StepId } from '../../shared/settings.ts'
import { STEP_LABEL } from '../../shared/settings.ts'
import type { HistoryEntry, Stats } from '../../shared/storage.ts'
import { progressPair, statsAreCurrent } from '../../background/pure/verdicts.ts'
import { enabledRoutinePlan } from '../../background/pure/plan.ts'
import { earnedToday, goalDaysRemaining, parsePoints, trendPerDay } from '../../background/pure/history.ts'
import { localDayKey } from '../../background/core/day.ts'
import { HistoryChart } from '../../pages/dashboard/HistoryChart.tsx'
import { viewVariants } from '../fx/motion-presets.ts'
import { PointsRing } from '../components/PointsRing.tsx'
import { GoalBar } from '../components/GoalBar.tsx'
import { WeeklyStreaks } from '../components/WeeklyStreaks.tsx'
import { PopupWidget } from '../components/PopupWidget.tsx'
import { WidgetChooser } from '../components/WidgetChooser.tsx'
import { displayPoints, formatNumber, signed } from '../lib/format.ts'
import { useCountUp } from '../lib/useCountUp.ts'
import { usePopupWidgets } from '../hooks/usePopupWidgets.ts'
import { moveWidget, resizeWidget, WIDGETS } from '../lib/widget-layout.ts'
import type { WidgetId, WidgetSize } from '../lib/widget-layout.ts'

export function Today({ settings, stats, history, motionOn, editing, onEditingChange }: {
  settings: Settings; stats: Stats | null; history: HistoryEntry[]; motionOn: boolean
  editing: boolean; onEditingChange: (editing: boolean) => void
}) {
  const layout = usePopupWidgets(settings.redeemGoalPts > 0)
  const available = parsePoints(stats?.availablePoints)
  const shown = useCountUp(available, motionOn)
  const pair = progressPair(stats?.searchPoints)
  const fresh = statsAreCurrent(stats)
  const delta = earnedToday(history, localDayKey())
  const goal = settings.redeemGoalPts
  const perDay = trendPerDay(history)
  const daysLeft = goalDaysRemaining(available == null ? NaN : available, goal, perDay)
  const plan = enabledRoutinePlan(settings, stats)

  const toggle = (id: string, visible: boolean) => {
    void layout.save(visible ? [...layout.items, { id: id as WidgetId, size: 'wide' }] : layout.items.filter(widget => widget.id !== id))
  }
  const chooser = <WidgetChooser name="Today widgets" disabled={!layout.writable}
    items={WIDGETS.map(widget => ({ ...widget, visible: layout.items.some(item => item.id === widget.id) }))} onToggle={toggle} />

  function content(id: WidgetId, size: WidgetSize): ReactNode {
    const compact = size === 'compact'
    if (id === 'balance') return <>
      <div className="hero"><div className="hero-left">
        <span className="hero-label">Available points</span>
        <span className="hero-value">{shown == null ? '—' : formatNumber(shown)}</span>
        <div className="hero-meta">{delta != null && <span className={`delta${delta > 0 ? ' delta--up' : delta < 0 ? ' delta--down' : ''}`}>{signed(delta)} today</span>}
          <span className="hero-fresh">{fresh ? 'Updated today' : 'Refresh to update'}</span></div>
      </div>{!compact && <PointsRing done={pair ? pair[0] : null} total={pair ? pair[1] : null} label="search points" animate={motionOn} />}</div>
      {compact && <p className="widget-footnote">Search points {stats?.searchPoints || '—'}</p>}
      {size === 'detailed' && <div className="balance-details"><span>Ready to claim<strong>{displayPoints(stats?.readyToClaim, '—')}</strong></span><span>Daily streak<strong>{stats?.dailyStreak || '—'}</strong></span><span>Stamp bonus<strong>{stats?.stampBonus || '—'}</strong></span></div>}
    </>
    if (id === 'streaks') return <WeeklyStreaks stats={stats} compact={compact} />
    if (id === 'history') return <>
      <div className="popup-history-chart"><HistoryChart history={history} days={size === 'detailed' ? 90 : compact ? 7 : 30} /></div>
      <div className="history-summary"><span>{size === 'detailed' ? '90' : compact ? '7' : '30'} days</span><strong>{perDay != null ? `~${formatNumber(Math.round(perDay))} pts/day` : 'Building your trend'}</strong></div>
      {size === 'detailed' && <p className="widget-footnote">Each bar shows the recorded change in balance for that day.</p>}
    </>
    if (id === 'goal') return goal > 0
      ? <GoalBar balance={available} target={goal} daysRemaining={daysLeft} animate={motionOn} />
      : <p className="muted small">Choose a points goal in Settings to track your progress here.</p>
    return <>
      {!settings.startupEnabled && <p className="widget-footnote">Auto-start is off.</p>}
      {!plan.length ? <p className="muted small">No startup steps are enabled.</p> : <ul className="plan">{plan.map(entry => <li key={entry.id} className={`plan-row${entry.willRun ? '' : ' plan-row--skip'}`}>
        <span className={`plan-dot${entry.willRun ? ' run' : ' skip'}`} /><span className="plan-label">{STEP_LABEL[entry.id as StepId] ?? entry.id}</span><span className="plan-note">{entry.willRun ? 'Ready' : entry.reason}</span>
      </li>)}</ul>}
    </>
  }

  return <motion.div className="view today-view" variants={viewVariants} initial="initial" animate="enter" exit="exit">
    {editing && <div className="today-toolbar"><h1>Edit widgets</h1>
      <div className="today-tools"><button type="button" className="btn btn--sm btn--primary" onClick={() => onEditingChange(false)}>Done editing</button>{chooser}</div>
    </div>}
    {layout.error && <div className="widget-layout-error" role="status">{layout.error}<button className="activity-action" onClick={layout.retry}>Retry layout</button></div>}
    {editing && <div className="widget-edit-note"><span>Choose a size. Move or hide any widget.</span><button type="button" className="activity-action" disabled={!layout.writable} onClick={() => void layout.reset()}>Reset layout</button></div>}
    {!layout.loaded && !layout.error ? <p className="muted small" role="status">Loading widgets…</p> : <div className="today-widget-grid">
      {layout.items.map((widget, index) => <PopupWidget key={widget.id} widget={widget} editing={editing && layout.writable} first={index === 0} last={index === layout.items.length - 1}
        resize={size => void layout.save(resizeWidget(layout.items, widget.id, size))}
        move={direction => void layout.save(moveWidget(layout.items, widget.id, direction))}
        remove={() => toggle(widget.id, false)}>{content(widget.id, widget.size)}</PopupWidget>)}
    </div>}
    {layout.loaded && layout.items.length === 0 && <div className="widgets-empty"><h2>Make room for what matters</h2><p>{editing ? 'Use Add widgets to start your own view of the day.' : 'Choose Customize widgets in the toolbar to start your own view of the day.'}</p></div>}
  </motion.div>
}
