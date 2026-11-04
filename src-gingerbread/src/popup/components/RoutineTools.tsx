import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Message, MessageResponse } from '../../shared/messages.ts'
import type { RunRecord, RunState } from '../../shared/storage.ts'
import { KEYS } from '../../shared/storage.ts'
import type { RemainingStep } from '../../background/pure/remaining.ts'
import { useStorageValue } from '../hooks/useStorageValue.ts'
import { ActionButton } from './ActionButton.tsx'

/** The tile keeps its full control stack within its smallest designed seat. */
export function CompactRoutineTools({ runState, send }: { runState: RunState; send: (message: Message) => Promise<MessageResponse> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const [pending, setPending] = useState(false)
  const resumable = Boolean(runState.batch || runState.routine)
  useEffect(() => { if (resumable) dialog.current?.close() }, [resumable])
  async function togglePause() {
    setPending(true)
    try { await send({ type: runState.pause ? 'RESUME_ACTIVITY' : 'PAUSE_ACTIVITY' }) }
    finally { setPending(false) }
  }
  return <>
    {resumable ? <ActionButton busy={pending} onClick={togglePause}
      title={runState.pause ? runState.pause.effectiveAt ? 'Paused at a safe boundary' : 'Finishing the current action before pausing' : 'Pause at the next safe action boundary'}>
      {runState.pause ? runState.pause.effectiveAt ? 'Resume' : 'Cancel pause' : 'Pause'}
    </ActionButton> : <ActionButton disabled={Boolean(runState.activity)} onClick={() => dialog.current?.showModal()}>More controls</ActionButton>}
    {createPortal(<dialog ref={dialog} className="routine-tools-dialog" aria-labelledby={heading}>
      <div className="routine-tools-dialog-head"><h2 id={heading}>Routine controls</h2>
        <button className="btn btn--ghost" type="button" autoFocus onClick={() => dialog.current?.close()}>Close</button>
      </div>
      <RoutineTools runState={runState} send={send} />
    </dialog>, document.body)}
  </>
}

export function RoutineTools({ runState, send }: { runState: RunState; send: (message: Message) => Promise<MessageResponse> }) {
  const [preview, setPreview] = useState<RemainingStep[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const deferred = useStorageValue<{ until: number } | null>('local', KEYS.postponedRoutine, null).value
  const resumable = Boolean(runState.batch || runState.routine)
  const active = Boolean(resumable || runState.activity)

  async function action(message: Message) {
    if (pending) return
    setPending(true)
    setFeedback('')
    try {
      const result = await send(message)
      if (!result.ok) setFeedback(result.error || 'The action could not start')
      if (message.type === 'PREVIEW_REMAINING' && result.ok) {
        const steps = result.steps as RemainingStep[]
        setPreview(steps)
        setSelected(steps.filter(step => step.status === 'incomplete').map(step => step.id))
        if (!result.observedAt) setFeedback('The latest progress could not be read. No tasks were selected.')
      }
      if (message.type === 'RUN_REMAINING' && result.ok) setPreview(null)
    } finally { setPending(false) }
  }

  return <div className="routine-tools">
    {resumable ? <div className="btn-row">
      <ActionButton disabled={pending} onClick={() => action({ type: runState.pause ? 'RESUME_ACTIVITY' : 'PAUSE_ACTIVITY' })}>
        {runState.pause ? runState.pause.effectiveAt ? 'Resume' : 'Cancel pause' : 'Pause'}
      </ActionButton>
      <span className="muted small" role="status">{runState.pause ? runState.pause.effectiveAt ? 'Paused at a safe boundary.' : 'Finishing the current action before pausing.' : 'Pause keeps the remaining work.'}</span>
    </div> : <>
      <div className="btn-row">
        <ActionButton disabled={active || pending} busy={pending} onClick={() => action({ type: 'PREVIEW_REMAINING' })}>Review remaining work</ActionButton>
        <ActionButton disabled={pending} onClick={() => action({ type: 'POSTPONE_ROUTINE', minutes: 60 })}>Postpone 1 hour</ActionButton>
      </div>
      {deferred && <p className="muted small">Postponed until {new Date(deferred.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.{' '}
        <button className="activity-action" onClick={() => action({ type: 'CANCEL_POSTPONE' })}>Cancel</button></p>}
    </>}
    {preview && !active && <div className="remaining-preview">
      <p className="muted small">Checked just now. Only measured incomplete work can be selected.</p>
      {preview.map(step => <label className="field field--row" key={step.id}>
        <span><input type="checkbox" checked={selected.includes(step.id)} disabled={step.status !== 'incomplete' || pending}
          onChange={event => setSelected(current => event.target.checked ? [...current, step.id] : current.filter(id => id !== step.id))} /> {step.label}</span>
        <span className="muted small">{step.status === 'incomplete' ? 'Remaining' : step.status === 'complete' ? 'Complete' : 'Not verified'}</span>
      </label>)}
      <ActionButton kind="primary" disabled={!selected.length || pending} onClick={() => action({ type: 'RUN_REMAINING', steps: selected })}>Run selected work</ActionButton>
    </div>}
    {feedback && <p className="muted small" role="status">{feedback}</p>}
  </div>
}

export function RunHistoryPanel() {
  const history = useStorageValue<RunRecord[]>('local', KEYS.runHistory, []).value
  const active = useStorageValue<RunRecord | null>('local', KEYS.activeRun, null).value
  const entries = [...(active ? [active] : []), ...history].slice(0, 6)
  if (!entries.length) return <p className="muted small">Completed and stopped routines will appear here with their timing and outcome.</p>
  return <div className="run-history">{entries.map(run => <details key={run.id}>
    <summary>{new Date(run.startedAt).toLocaleString()} · {run.status}{run.endedAt ? ` · ${Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))}s` : ''}</summary>
    {run.detail && <p className="muted small">{run.detail}</p>}
    {run.beforePoints != null && run.afterPoints != null && <p className="muted small">Balance: {run.beforePoints.toLocaleString()} → {run.afterPoints.toLocaleString()} points</p>}
    <ul className="log">{run.events.slice(-20).map((event, index) => <li className="log-row" key={index}>
      <div className="log-body"><span className="log-label">{event.step} · {event.outcome}{event.durationMs != null ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ''}</span>
        {event.detail && <span className="log-detail">{event.detail}</span>}</div>
    </li>)}</ul>
  </details>)}</div>
}
