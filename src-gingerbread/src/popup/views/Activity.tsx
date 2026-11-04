import { motion } from 'framer-motion'
import { useState } from 'react'
import type { RunState } from '../../shared/storage.ts'
import { liveStatus } from '../../shared/run-status.ts'
import { viewVariants } from '../fx/motion-presets.ts'
import { Card } from '../components/Card.tsx'
import { LogLine } from '../components/LogLine.tsx'
import { useActivityLog } from '../hooks/useActivityLog.ts'
import { RunHistoryPanel } from '../components/RoutineTools.tsx'
import { downloadDiagnostics } from '../../shared/diagnostics.ts'

export function Activity({ runState }: { runState: RunState }) {
  const { tabAction, rewards, statsLog, redeemLog, ordersLog, imageLog, lastQuery, hasLogs } = useActivityLog()
  const live = liveStatus(runState)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const rows = [
    { label: 'Tabs', row: tabAction },
    { label: 'Rewards', row: rewards },
    { label: 'Stats', row: statsLog },
    { label: 'Redeem', row: redeemLog },
    { label: 'Orders', row: ordersLog },
    { label: 'Image search', row: imageLog },
  ].filter(({ row }) => row?.detail)
  const failures = rows.filter(({ row }) => row?.ok === false)
  const visible = errorsOnly ? failures : rows
  const showQuery = !errorsOnly && Boolean(lastQuery?.text)

  async function copyActivity() {
    const lines = visible.map(({ label, row }) => `${label} [${row?.ok === false ? 'Failed' : row?.ok === true ? 'Success' : 'Info'}]: ${row?.detail}`)
    if (showQuery) lines.unshift(`Last query: ${lastQuery!.text}`)
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopyStatus('Activity copied.')
    } catch {
      setCopyStatus('Could not copy. Select the activity text to copy it manually.')
    }
  }

  return (
    <motion.div className="view" variants={viewVariants} initial="initial" animate="enter" exit="exit">
      <Card title="Now">
        <div className={`runstate${live.live ? ' runstate--live' : ''}`} role="status">
          <span className="runstate-dot" />
          <span className="runstate-text">{live.text}</span>
        </div>
      </Card>

      <Card title="Recent activity" action={
        <button type="button" className="activity-action" disabled={!visible.length && !showQuery} onClick={copyActivity}>Copy</button>
      }>
        <div className="activity-toolbar">
          <button type="button" className="activity-filter" aria-pressed={errorsOnly} onClick={() => { setErrorsOnly(!errorsOnly); setCopyStatus('') }}>
            Failures <span>{failures.length}</span>
          </button>
          <span className="muted small">{visible.length + (showQuery ? 1 : 0)} entries</span>
        </div>
        <p className="activity-feedback muted small" role="status">{copyStatus}</p>
        {hasLogs ? (
          !visible.length && !showQuery ? <p className="muted small">No failures in recent activity.</p> :
          <ul className="log">
            {showQuery && lastQuery && (
              <li className="log-row">
                <span className="log-dot neutral" />
                <div className="log-body">
                  <span className="log-label">Last query</span>
                  <span className="log-detail">
                    {lastQuery.text}
                    {lastQuery.api ? ` · ${lastQuery.api}` : ''}
                  </span>
                </div>
              </li>
            )}
            {visible.map(({ label, row }) => <LogLine key={label} label={label} row={row} dot />)}
          </ul>
        ) : (
          <p className="muted small">No activity yet — run a step or the routine to see it here.</p>
        )}
      </Card>
      <Card title="Run history" action={<button className="activity-action" onClick={() => downloadDiagnostics().catch(() => setCopyStatus('Could not export diagnostics.'))}>Export diagnostics</button>}>
        <p className="muted small">Diagnostics contain timing and outcomes, with queries, account balances and redemption codes omitted.</p>
        <RunHistoryPanel />
      </Card>
    </motion.div>
  )
}
