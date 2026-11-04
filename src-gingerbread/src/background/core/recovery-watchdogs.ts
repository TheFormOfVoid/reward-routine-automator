import type { RunState } from '../../shared/storage.ts'

// Arm recovery before taking the activity lock. A simultaneous restore or UI
// command may win that lock on worker startup; durable work still needs a
// future wake if its alarms were lost across a browser restart.
export async function ensureRecoveryWatchdogs(state: RunState, names: { search: string; routine: string }): Promise<void> {
  if (state.pause) return
  const required = [state.batch ? names.search : null, state.routine ? names.routine : null]
    .filter((name): name is string => name != null)
  await Promise.all(required.map(async name => {
    if (!(await chrome.alarms.get(name))) {
      await chrome.alarms.create(name, { delayInMinutes: 1, periodInMinutes: 1 })
    }
  }))
}
