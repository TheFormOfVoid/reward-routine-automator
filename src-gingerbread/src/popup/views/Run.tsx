import { motion } from 'framer-motion'
import { RoutineTools } from '../components/RoutineTools.tsx'
import type { Settings } from '../../shared/settings.ts'
import type { RunState } from '../../shared/storage.ts'
import type { Message, MessageResponse } from '../../shared/messages.ts'
import { viewVariants } from '../fx/motion-presets.ts'
import { Card } from '../components/Card.tsx'
import { ActionButton } from '../components/ActionButton.tsx'
import { Segmented } from '../components/Segmented.tsx'
import { NumberField } from '../components/NumberField.tsx'
import { CouponsButton } from '../components/CouponsButton.tsx'
import { StepButtons } from '../components/StepButtons.tsx'

export function Run({
  settings,
  save,
  runState,
  send,
  busy,
  motionOn,
}: {
  settings: Settings
  save: (patch: Partial<Settings>) => Promise<Settings>
  runState: RunState
  send: (message: Message) => Promise<MessageResponse>
  busy: Message['type'] | null
  motionOn: boolean
}) {
  const running = runState.batch != null
  const mode: 'auto' | 'manual' = settings.rightSizeSearchBatch ? 'auto' : 'manual'

  return (
    <motion.div className="view" variants={viewVariants} initial="initial" animate="enter" exit="exit">
      <Card className="run-hero">
        <ActionButton kind="primary" onClick={() => send({ type: 'RUN_FULL_ROUTINE' })} busy={busy === 'RUN_FULL_ROUTINE'}>
          Run the routine
        </ActionButton>
        <p className="muted small center">Runs your enabled startup steps, in order, right now.</p>
      </Card>

      <Card title="Routine controls">
        <RoutineTools runState={runState} send={send} />
      </Card>
      <Card title="Web search">
        {running && (
          <div className="banner banner--run">
            Searching — {runState.batch?.remaining} left
          </div>
        )}
        <div className="field">
          <span className="field-label">Batch size</span>
          <Segmented
            ariaLabel="Batch size mode"
            value={mode}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'manual', label: 'Manual' },
            ]}
            onChange={(v) => save({ rightSizeSearchBatch: v === 'auto' })}
          />
        </div>
        {mode === 'auto' ? (
          <p className="muted small">Sized to the points still left today — usually the right call.</p>
        ) : (
          <div className="field field--row">
            <span className="field-label">Searches per batch</span>
            <NumberField
              value={settings.searchesPerBatch}
              min={1}
              max={100}
              ariaLabel="Searches per batch"
              onCommit={(n) => save({ searchesPerBatch: n })}
            />
          </div>
        )}
        <div className="field field--row">
          <span className="field-label">Delay between searches</span>
          <span className="field-inline">
            <NumberField value={settings.minDelaySec} min={1} max={settings.maxDelaySec} suffix="s" ariaLabel="Minimum delay seconds" onCommit={(n) => save({ minDelaySec: n })} />
            <span className="field-sep">to</span>
            <NumberField value={settings.maxDelaySec} min={settings.minDelaySec} max={120} suffix="s" ariaLabel="Maximum delay seconds" onCommit={(n) => save({ maxDelaySec: n })} />
          </span>
        </div>
        <div className="btn-row">
          <ActionButton kind="primary" onClick={() => send({ type: 'START_SEARCH_BATCH' })} busy={busy === 'START_SEARCH_BATCH'} disabled={running}>
            {running ? 'Running…' : 'Start searches'}
          </ActionButton>
          <ActionButton kind="danger" onClick={() => send({ type: 'STOP_BATCH' })} busy={busy === 'STOP_BATCH'} disabled={!running && !runState.routine && !runState.activity}>
            Stop
          </ActionButton>
        </div>
      </Card>

      <Card title="Run one step">
        <StepButtons send={send} busy={busy} />
        {settings.experimentalFeatures && (
          <div className="btn-row" style={{ marginTop: 8 }}>
            <CouponsButton send={send} />
          </div>
        )}
      </Card>

      <Card title="Tabs">
        <div className="btn-row">
          <ActionButton onClick={() => send({ type: 'CLEAR_ALL_TABS' })} busy={busy === 'CLEAR_ALL_TABS'}>
            Clear opened tabs
          </ActionButton>
        </div>
        <p className="muted small">Closes the tabs the routine opened; the finish page and pinned tabs are kept.</p>
      </Card>
    </motion.div>
  )
}
