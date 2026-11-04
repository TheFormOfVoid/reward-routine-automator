// The Next routine tile (6.8.0 rewrite): the popup's Today card's plan — the
// SAME verdicts the routine runs, over the enabled steps in their saved
// order, so it can't disagree with what actually skips (user request,
// 2026-09-09: "add the next routine in the dashboard").
//
// Designed steps → variants: both seats show the FULL plan rows — the 2×2
// step's body (~268px) fits the whole list, and the one-line brief it used
// to fold into wasted the space (user, 2026-09-11: "when I set the next
// routine to 2x2, it only shows a brief, not the full detail, although
// there is enough space for it"). The 4×2 seat simply spreads the same rows.

import { enabledRoutinePlan } from '../../../background/pure/plan.ts'
import { STEP_LABEL } from '../../../shared/settings.ts'
import { useStats } from '../../../popup/hooks/useStats.ts'
import { useDash } from '../ctx.tsx'
import { Tile } from './Tile.tsx'
import type { TileProps } from './Tile.tsx'
import { estimateRoutine } from '../../../background/pure/run-tools.ts'
import { useStorageValue } from '../../../popup/hooks/useStorageValue.ts'
import { KEYS } from '../../../shared/storage.ts'
import type { RunRecord } from '../../../shared/storage.ts'

export function NextRoutineTile({ seat, ...rest }: TileProps) {
  const { settings } = useDash()
  const stats = useStats()

  const plan = enabledRoutinePlan(settings, stats)
  const history = useStorageValue<RunRecord[]>('local', KEYS.runHistory, []).value
  const estimate = estimateRoutine(history, plan.map(entry => entry.id))

  return (
    <Tile id="next" title="Next routine" seat={seat} {...rest}>
      {estimate && <p className="dash-muted">Usually {Math.max(1, Math.floor(estimate.minMs / 60_000))}–{Math.max(1, Math.ceil(estimate.maxMs / 60_000))} min · based on {estimate.samples} comparable runs</p>}
      {!settings.startupEnabled && (
        <p className="dash-muted">Auto-start is off — this is what “Run the routine” would do now.</p>
      )}
      {plan.length === 0 ? (
        <p className="dash-muted">No startup steps are enabled.</p>
      ) : (
        <ul className="plan">
          {plan.map((entry) => (
            <li key={entry.id} className={`plan-row${entry.willRun ? '' : ' plan-row--skip'}`}>
              <span className={`plan-dot${entry.willRun ? ' run' : ' skip'}`} />
              <span className="plan-label">{STEP_LABEL[entry.id as keyof typeof STEP_LABEL] ?? entry.id}</span>
              <span className="plan-note">{entry.willRun ? 'will run' : entry.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </Tile>
  )
}
