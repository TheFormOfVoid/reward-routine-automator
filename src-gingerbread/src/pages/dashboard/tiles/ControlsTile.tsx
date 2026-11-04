// The Run controls tile (6.8.0 rewrite): the popup's Run view, composed into
// a tile (user request, 2026-09-09: "add the controls for the search and all
// the other features in the dashboard"). Same components, same messages,
// same settings keys — one source of truth, so the dashboard and the popup
// can never disagree about what a press does.
//
// Designed steps → variants (2026-09-11 rework): the form ADJUSTS to the
// seat (user: "There should be no scroll in… run control sections. They
// should adjust to the section size") — the compact 4×3 seat gets a denser
// stack that fits whole, 6+ wide spreads the single-step buttons four
// across, and the 4-row seats add air. The variant comes from the step's
// own w/h, not its index (the registry's steps are a lattice).

import { ActionButton } from '../../../popup/components/ActionButton.tsx'
import { Segmented } from '../../../popup/components/Segmented.tsx'
import { NumberField } from '../../../popup/components/NumberField.tsx'
import { CouponsButton } from '../../../popup/components/CouponsButton.tsx'
import { StepButtons } from '../../../popup/components/StepButtons.tsx'
import { useDash } from '../ctx.tsx'
import { Tile } from './Tile.tsx'
import type { TileProps } from './Tile.tsx'
import { CompactRoutineTools } from '../../../popup/components/RoutineTools.tsx'

export function ControlsTile({ seat, ...rest }: TileProps) {
  const { settings, save, runState, send, busy } = useDash()
  const running = runState.batch != null
  const mode: 'auto' | 'manual' = settings.rightSizeSearchBatch ? 'auto' : 'manual'

  return (
    <Tile
      id="controls"
      title="Run controls"
      action={<CompactRoutineTools runState={runState} send={send} />}
      seat={seat}
      className={
        [seat.w >= 6 ? 'dash-controls-spread' : '', seat.h >= 4 ? 'dash-controls-airy' : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
      {...rest}
    >
      <div className="dash-controls">
        <ActionButton kind="primary" onClick={() => send({ type: 'RUN_FULL_ROUTINE' })} busy={busy === 'RUN_FULL_ROUTINE'}>
          Run the routine
        </ActionButton>
        {running && <div className="banner banner--run">Searching — {runState.batch?.remaining} left</div>}
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
        {mode === 'manual' && (
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
        <StepButtons send={send} busy={busy} />
        {settings.experimentalFeatures && (
          <div className="btn-row">
            <CouponsButton send={send} />
          </div>
        )}
        <div className="btn-row">
          <ActionButton onClick={() => send({ type: 'CLEAR_ALL_TABS' })} busy={busy === 'CLEAR_ALL_TABS'}>
            Clear opened tabs
          </ActionButton>
        </div>
      </div>
    </Tile>
  )
}
