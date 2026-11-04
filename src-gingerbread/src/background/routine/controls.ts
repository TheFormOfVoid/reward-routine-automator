import { readRunState, updateRunState, requestPause } from '../core/run-state.ts'
import { resumeSearchBatch } from './search.ts'
import { resumeRoutineRecovery, runStartupSequence, ROUTINE_RECOVERY_ALARM } from './routine.ts'
import { refreshStats } from '../readers/stats.ts'
import { getSettings } from '../../shared/settings.ts'
import { remainingSteps } from '../pure/remaining.ts'
import { recordRunEvent } from '../core/run-history.ts'
import { progressPair, rightSizedCount } from '../pure/verdicts.ts'

export { requestPause }

let resuming = false
export async function resumeActivity(): Promise<void> {
  if (resuming) return
  resuming = true
  try { await resumeOwnedActivity() } finally { resuming = false }
}

async function resumeOwnedActivity(): Promise<void> {
  const initial = await readRunState()
  if (!initial.pause) return
  if (!initial.pause.effectiveAt) {
    // The original owner is still finishing its action. Cancel only the
    // request; invoking the queue here would race that owner's JS stack.
    await updateRunState(state => { if (state.stopEpoch === initial.stopEpoch) delete state.pause })
    return
  }
  let remaining: number | undefined
  if (initial.pause.effectiveAt) {
    // The selected page is free at an acknowledged boundary. Obtain new
    // evidence before the queue resumes after an arbitrarily long pause.
    const read = await refreshStats({ scope: 'full', notBefore: Date.now() })
    if (!read.stats || Number(read.stats.at) < read.startedAt) throw new Error('Progress could not be verified. The run remains paused.')
    const settings = await getSettings()
    if (initial.batch && settings.rightSizeSearchBatch) {
      const pair = progressPair(read.stats.searchPoints)
      remaining = pair && pair[1] > 0 && pair[0] >= pair[1] ? 0 : rightSizedCount(read.stats, initial.batch.remaining).count
    }
  }
  let resumed = false
  await updateRunState(state => {
    if (state.stopEpoch !== initial.stopEpoch || !state.pause) return
    if (remaining != null && state.batch?.runId === initial.batch?.runId) state.batch!.remaining = Math.min(state.batch!.remaining, remaining)
    delete state.pause
    resumed = true
  })
  if (!resumed) return
  if (initial.routine) await chrome.alarms.create(ROUTINE_RECOVERY_ALARM, { delayInMinutes: 1, periodInMinutes: 1 })
  await recordRunEvent(initial.routine?.historyId, 'routine', 'resumed')
  await resumeSearchBatch()
  await resumeRoutineRecovery()
}

export async function previewRemaining() {
  const state = await readRunState()
  if (state.batch || state.routine || state.activity) throw new Error('Finish or stop the current activity first')
  const result = await refreshStats({ scope: 'full', notBefore: Date.now() })
  const fresh = Boolean(result.stats && Number(result.stats.at) >= result.startedAt)
  return { observedAt: fresh ? result.completedAt : null, steps: remainingSteps(fresh ? result.stats : null, await getSettings()) }
}

export async function runRemaining(selected: string[]): Promise<void> {
  const preview = await previewRemaining()
  const steps = preview.steps.filter(step => selected.includes(step.id) && step.status === 'incomplete').map(step => step.id)
  if (!steps.length) throw new Error('No selected work remains after the fresh check')
  await runStartupSequence({ manual: true, selectedSteps: steps })
}
