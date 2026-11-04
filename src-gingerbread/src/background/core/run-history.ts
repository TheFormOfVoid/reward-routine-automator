import { KEYS, getLocal } from '../../shared/storage.ts'
import type { RunEvent, RunOutcome, RunRecord, RunState, Stats } from '../../shared/storage.ts'
import { parsePoints } from '../pure/history.ts'
import { updateRunState } from './run-state.ts'

let writes: Promise<unknown> = Promise.resolve()
let healthy = true
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  if (!healthy) return Promise.reject(new Error('Run history is unavailable for this worker session'))
  const next = writes.then(fn)
  // Keep the underlying chain ordered if an issued storage call later settles,
  // while returning control to the routine after a bounded diagnostic wait.
  writes = next.catch(() => {})
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([next, new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => { healthy = false; reject(new Error('Run history storage timed out')) }, 2000)
  })]).finally(() => clearTimeout(timer))
}

export function startRunRecord(source: string, steps: string[], stats?: Stats): Promise<string> {
  if (!healthy) return Promise.resolve('')
  return serialized(async () => {
    if (!healthy) return ''
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9)
    const beforePoints = parsePoints(stats?.availablePoints)
    const record: RunRecord = { id, source, startedAt: Date.now(), status: 'running', steps, events: [],
      ...(beforePoints != null ? { beforePoints } : {}) }
    await chrome.storage.local.set({ [KEYS.activeRun]: record })
    return id
  }).catch(error => { console.warn('Could not start run history:', error); return '' })
}

export function recordRunEvent(id: string | undefined, step: string, outcome: string, detail = '', durationMs?: number): Promise<void> {
  if (!id || !healthy) return Promise.resolve()
  return serialized(async () => {
    const current = await getLocal<RunRecord>(KEYS.activeRun)
    if (!healthy || current?.id !== id) return
    const event: RunEvent = { at: Date.now(), step: step.slice(0, 40), outcome: outcome.slice(0, 40), detail: detail.slice(0, 240),
      ...(Number.isFinite(durationMs) ? { durationMs } : {}) }
    await chrome.storage.local.set({ [KEYS.activeRun]: { ...current, events: [...current.events, event].slice(-100) } })
  }).catch(error => { console.warn('Could not record run event:', error) })
}

export function finishRunRecord(id: string | undefined, status: Exclude<RunOutcome, 'running'>, detail: string, stats?: Stats): Promise<void> {
  if (!id || !healthy) return Promise.resolve()
  return serialized(async () => {
    const current = await getLocal<RunRecord>(KEYS.activeRun)
    if (!healthy || current?.id !== id) return
    const previous = await getLocal<RunRecord[]>(KEYS.runHistory)
    if (!healthy) return
    const afterPoints = parsePoints(stats?.availablePoints)
    const finished: RunRecord = { ...current, endedAt: Date.now(), status, detail: detail.slice(0, 240),
      ...(afterPoints != null ? { afterPoints } : {}) }
    await chrome.storage.local.set({ [KEYS.runHistory]: [finished, ...(Array.isArray(previous) ? previous : []).filter(run => run?.id !== id)].slice(0, 30) })
    if (!healthy) return
    await chrome.storage.local.remove(KEYS.activeRun)
  }).catch(error => { console.warn('Could not save run history:', error) })
}

export async function cancelActiveRun(id?: string): Promise<void> {
  if (!healthy || !id) return
  await finishRunRecord(id, 'cancelled', 'Stopped by the user')
}

export async function reconcileRunRecord(state: RunState): Promise<void> {
  if (state.activity?.label === 'Finishing routine' && !state.routine && !state.batch) {
    await updateRunState(current => {
      if (current.stopEpoch === state.stopEpoch && current.activity?.label === 'Finishing routine' && !current.routine && !current.batch) current.activity = null
    })
    state = { ...state, activity: null }
  }
  if (!healthy) return
  const active = await serialized(() => getLocal<RunRecord>(KEYS.activeRun)).catch(() => undefined)
  if (!active || state.routine?.historyId === active.id) return
  // Eviction may occur between creating the trace and persisting the owner,
  // or between consuming the owner and saving its final trace. Neither case
  // should leave a permanent active marker that blocks backup/restore.
  if (!state.routine && !state.batch && !state.activity) {
    await finishRunRecord(active.id, 'unknown', 'The worker restarted before the final outcome was recorded')
  }
}
