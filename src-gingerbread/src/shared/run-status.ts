// The live "what is running right now" line, shared by the popup's Activity
// Now card and the dashboard's Balance status line (user request,
// 2026-09-11: "the stats should show more info like instead of showing only
// routine show routine-stats" — while a routine runs, the current step's
// label rides along, so the line says WHICH step the routine is on, not just
// that it is on one). A search batch still wins the line outright: its
// countdown is the more urgent fact even mid-routine.

import type { RunState } from './storage.ts'

export interface LiveStatus {
  text: string
  live: boolean
}

export function liveStatus(runState: RunState): LiveStatus {
  if (runState.pause) return { text: runState.pause.effectiveAt ? 'Paused — ready to resume' : 'Pausing after the current action', live: true }
  if (runState.batch) return { text: `Searching — ${runState.batch.remaining} left`, live: true }
  if (runState.routine) {
    const step = runState.activity?.label
    return { text: step ? `Routine — ${step}` : 'Routine in progress', live: true }
  }
  if (runState.activity) return { text: runState.activity.label, live: true }
  return { text: 'Idle — nothing running', live: false }
}
