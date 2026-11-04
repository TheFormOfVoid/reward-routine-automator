// The run state — ONE storage.local document instead of the twelve keys the
// v1 worker grew (status, pendingStartupSteps, routineActive, routineDay,
// routinePendingTabs, routineSkipped, searchRightSizeRun, activityToken,
// openedTabs, capturingSteps, …). Every one of those keys needed its own line
// in stopAllActivity's and onInstalled's cleanup lists, and a missed line was
// a real bug class (ADR-017). Here a stop is ONE write — null the document —
// and a fresh install is ONE remove.
//
// What deliberately does NOT live here: anything that must SURVIVE a stop, an
// update, or an eviction — lastRoutineDay (the once-per-day mark), lastStats
// (the read the verdicts judge), the activity-log rows, the query history.
// Those keep their own keys (shared/storage.ts KEYS); this document is exactly
// "what is running RIGHT NOW".
//
// The batch-owned-status marker is structural: v1 used status.label === null
// to mean "the batch owns the status"; here it is simply batch != null.

import type { Captures, RightSizeRun, RoutineState, RunState, SkippedStep } from '../../shared/storage.ts'
import { KEYS } from '../../shared/storage.ts'
import { localDayKey } from './day.ts'

// The parsing boundary reads an untrusted, possibly half-written blob, so it
// works in `any` and hands back a fully-typed RunState — every field below is
// re-narrowed before it escapes this module.
type AnyRec = Record<string, any>

const EMPTY_RUN_STATE: RunState = {
  v: 1,
  stopEpoch: 0,
  activity: null,
  batch: null,
  rightSizeRun: null,
  routine: null,
  captures: { capturing: [], opened: {} },
}

function isPlainObject(value: unknown): value is AnyRec {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeCaptures(captures: unknown): Captures {
  if (!isPlainObject(captures)) return { capturing: [], opened: {} }
  const opened: Record<string, number[]> = {}
  const source = isPlainObject(captures.opened) ? captures.opened : {}
  for (const [stepId, ids] of Object.entries(source)) {
    if (Array.isArray(ids)) opened[stepId] = ids.filter((id): id is number => typeof id === 'number')
  }
  return {
    capturing: Array.isArray(captures.capturing)
      ? captures.capturing.filter((id: unknown): id is string => typeof id === 'string')
      : [],
    opened,
  }
}

// Tolerant of a corrupt or half-written document: every field falls back to
// its empty shape rather than poisoning the callers with garbage.
export async function readRunState(): Promise<RunState> {
  const { [KEYS.runState]: stored } = await chrome.storage.local.get(KEYS.runState)
  if (!isPlainObject(stored)) return structuredClone(EMPTY_RUN_STATE)

  const batch: RunState['batch'] = isPlainObject(stored.batch)
    ? {
        runId: Number(stored.batch.runId) || 0,
        remaining: Number(stored.batch.remaining) || 0,
        tabId: typeof stored.batch.tabId === 'number' ? stored.batch.tabId : null,
        nextRunAt: Number.isFinite(stored.batch.nextRunAt) ? stored.batch.nextRunAt : null,
        retryCount: Math.max(0, Math.min(3, Math.floor(Number(stored.batch.retryCount) || 0))),
        attemptId: Math.max(0, Math.floor(Number(stored.batch.attemptId) || 0)),
        attemptStartedAt: Number.isFinite(stored.batch.attemptStartedAt) ? stored.batch.attemptStartedAt : 0,
        ...(isPlainObject(stored.batch.pendingQuery) && typeof stored.batch.pendingQuery.query === 'string'
          ? { pendingQuery: { query: stored.batch.pendingQuery.query.slice(0, 90), api: String(stored.batch.pendingQuery.api || 'retry') } }
          : {}),
        ...(stored.batch.prowl === true ? { prowl: true } : {}),
      }
    : null

  const rightSizeRun: RightSizeRun | null =
    isPlainObject(stored.rightSizeRun) && Array.isArray(stored.rightSizeRun.pair)
      ? {
          round: Number(stored.rightSizeRun.round) || 0,
          pair: [Number(stored.rightSizeRun.pair[0]) || 0, Number(stored.rightSizeRun.pair[1]) || 0],
          ...(Number.isFinite(stored.rightSizeRun.freshAt) ? { freshAt: stored.rightSizeRun.freshAt } : {}),
        }
      : null

  const routine: RoutineState | null = isPlainObject(stored.routine)
    ? {
        startDay: String(stored.routine.startDay || ''),
        pendingSteps: Array.isArray(stored.routine.pendingSteps)
          ? stored.routine.pendingSteps.filter((id: unknown): id is string => typeof id === 'string')
          : [],
        pendingTabs: Array.isArray(stored.routine.pendingTabs)
          ? stored.routine.pendingTabs.filter((id: unknown): id is number => typeof id === 'number')
          : [],
        skipped: Array.isArray(stored.routine.skipped) ? ([...stored.routine.skipped] as SkippedStep[]) : [],
        ...(Array.isArray(stored.routine.enabledSteps) ? { enabledSteps: stored.routine.enabledSteps.filter((id: unknown): id is string => typeof id === 'string') } : {}),
        ...(Number.isFinite(stored.routine.recoveryRound) ? { recoveryRound: Math.max(0, Math.min(2, Math.floor(stored.routine.recoveryRound))) } : {}),
        ...(isPlainObject(stored.routine.recoveryProgress) ? { recoveryProgress: Object.fromEntries(Object.entries(stored.routine.recoveryProgress).filter(([, value]) => Number.isFinite(value))) as Record<string, number> } : {}),
        ...(stored.routine.recovering === true ? { recovering: true } : {}),
        ...(Number.isFinite(stored.routine.ownerUntilAt) ? { ownerUntilAt: Math.max(0, stored.routine.ownerUntilAt) } : {}),
        ...(Number.isFinite(stored.routine.startedAt) ? { startedAt: Math.max(0, stored.routine.startedAt) } : {}),
        ...(typeof stored.routine.historyId === 'string' ? { historyId: stored.routine.historyId.slice(0, 100) } : {}),
        ...(Number.isFinite(stored.routine.recoveryActions) ? { recoveryActions: Math.max(0, Math.floor(stored.routine.recoveryActions)) } : {}),
      }
    : null

  return {
    v: 1,
    batchSequence: Math.max(0, ...[stored.batchSequence, batch?.runId].filter((id): id is number => Number.isSafeInteger(id))),
    stopEpoch: Number(stored.stopEpoch) || 0,
    ...(isPlainObject(stored.pause) && Number.isFinite(stored.pause.requestedAt)
      ? { pause: { requestedAt: stored.pause.requestedAt, ...(Number.isFinite(stored.pause.effectiveAt) ? { effectiveAt: stored.pause.effectiveAt } : {}) } } : {}),
    activity: isPlainObject(stored.activity) ? { label: String(stored.activity.label ?? '') } : null,
    batch,
    rightSizeRun,
    routine,
    captures: normalizeCaptures(stored.captures),
  }
}

// Read-modify-write on a shared document, so the writes queue instead of
// racing (the v1 tabBookkeeping pattern, generalized to the whole document —
// tabs.onCreated capture fires concurrently with step runners mutating their
// own fields). The mutator edits a private draft; a rejection downstream of
// one task must not break the chain for the next.
let writeChain: Promise<unknown> = Promise.resolve()

export function updateRunState(mutate: (draft: RunState) => void | Promise<void>): Promise<RunState> {
  const run = writeChain.then(async () => {
    const draft = await readRunState()
    await mutate(draft)
    await chrome.storage.local.set({ [KEYS.runState]: draft })
    return draft
  })
  writeChain = run.catch(() => {})
  return run
}

// ---------- Stop machinery ----------
//
// Runners capture the epoch when they start; stopAllActivity() bumps it, so an
// epoch that no longer matches means "you were stopped". Reading the epoch is
// the checkpoint; comparing is the runner's business.

export async function currentStopEpoch(): Promise<number> {
  return (await readRunState()).stopEpoch
}

// Stop whatever is running: the search batch, a manual run, or the startup
// routine. ONE write takes down the batch, the routine, the verification loop,
// and the tab-capture bookkeeping together — there is no fifth key someone
// could forget. The epoch bump comes first so every runner abandons at its
// next checkpoint. Stopping is not finishing: the tabs stay open (nothing here
// touches them), and lastRoutineDay is never written by a stop, so the next
// launch retries the routine.
export function stopAllActivity(): Promise<RunState> {
  return updateRunState((state) => {
    state.stopEpoch++
    state.activity = null
    state.batch = null
    state.rightSizeRun = null
    state.routine = null
    delete state.pause
    state.captures = { capturing: [], opened: {} }
  })
}

// Pause is a durable request, acknowledged only between effects. It never
// invalidates an in-flight receipt or loses the remaining queue.
export async function requestPause(): Promise<void> {
  await updateRunState(state => {
    if (!state.batch && !state.routine) throw new Error('Pause is available for a search batch or routine')
    state.pause ||= { requestedAt: Date.now() }
  })
}

export async function pauseBoundary(): Promise<boolean> {
  const current = await readRunState()
  if (!current.pause) return false
  if (current.pause.effectiveAt) return true
  let paused = false
  await updateRunState(state => {
    if (!state.pause) return
    state.pause.effectiveAt ||= Date.now()
    paused = true
  })
  return paused
}

export async function clearPause(): Promise<void> {
  await updateRunState(state => { delete state.pause })
}

export async function reserveRecoveryActions(count = 1): Promise<boolean> {
  if (!(await readRunState()).routine) return true
  let allowed = true
  await updateRunState(state => {
    if (!state.routine) return
    const routine = state.routine
    const amount = Math.max(1, Math.floor(count))
    allowed = (routine.recoveryActions || 0) + amount <= 12 &&
      (!routine.startedAt || Date.now() - routine.startedAt < 45 * 60_000)
    if (allowed) routine.recoveryActions = (routine.recoveryActions || 0) + amount
  })
  return allowed
}

// A batch that was stopped or superseded must not keep running.
export async function isStaleBatch(runId: number): Promise<boolean> {
  const state = await readRunState()
  return !state.batch || state.batch.runId !== runId
}

// ---------- Manual (non-batch) activities ----------
//
// The popup's Stop button covers manual runs too. A running search batch owns
// the document's batch field, so a concurrent manual activity must neither
// clobber it on the way in nor clear it on the way out.

export async function beginActivity(label: string): Promise<number> {
  let epoch = 0
  await updateRunState((state) => {
    if (state.activity && state.activity.label !== label) throw new Error(`Busy: ${state.activity.label}`)
    if (!state.batch) state.activity = { label }
    epoch = state.stopEpoch
  })
  return epoch
}

export async function endActivity(label: string): Promise<void> {
  // Strict label match: a null activity means the batch owns the document, and
  // clearing it on a manual run's way out would kill the batch's tick().
  await updateRunState((state) => {
    if (state.activity && state.activity.label === label) state.activity = null
  })
}

// ---------- The routine's consume-and-clear seam ----------
//
// endRoutine needs "read the routine, clear it, keep going with what you read"
// as ONE step — a stop landing between the read and the clear would otherwise
// let a stopped routine sweep its stashed tabs. Returns the consumed routine,
// or null when none is live (the no-op every caller wants after a stop:
// stopAllActivity already nulled it).
export function consumeRoutine(expectedEpoch?: number): Promise<RoutineState | null> {
  const run = writeChain.then(async () => {
    const state = await readRunState()
    if (!state.routine || state.pause || (expectedEpoch != null && state.stopEpoch !== expectedEpoch)) return null
    const consumed = state.routine
    state.routine = null
    if (expectedEpoch != null) state.activity = { label: 'Finishing routine' }
    // Clearing ownership and marking the completed day form one commit.
    // A Stop queued before this operation prevents both; one queued after it
    // cancels presentation/cleanup but does not erase a completed routine.
    await chrome.storage.local.set({ [KEYS.runState]: state,
      ...(expectedEpoch != null ? { [KEYS.lastRoutineDay]: consumed.startDay || localDayKey() } : {}) })
    return consumed
  })
  writeChain = run.catch(() => {})
  return run
}
