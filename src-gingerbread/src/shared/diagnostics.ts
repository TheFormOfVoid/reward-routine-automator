import { KEYS } from './storage.ts'
import type { RunRecord, RunState } from './storage.ts'

// Export only an allowlist. Raw queries, DOM dumps, URLs, order codes and
// account balances never enter this report, even if old stored logs hold them.
export function diagnosticReport(version: string, state: RunState | undefined, history: RunRecord[] | undefined) {
  const stepIds = ['stats', 'stats/full', 'stats/search', 'claim', 'dailySet', 'keepEarning', 'search', 'imageSearch', 'routine']
  const outcomes = ['started', 'action-finished', 'failed', 'skipped', 'paused', 'resumed', 'submitted', 'retry', 'observed', 'completed', 'incomplete', 'unknown', 'cancelled']
  return {
    format: 'gingerbread-diagnostics', schemaVersion: 1, version, createdAt: new Date().toISOString(),
    running: { batch: Boolean(state?.batch), routine: Boolean(state?.routine), paused: Boolean(state?.pause),
      remainingSearches: Number(state?.batch?.remaining) || 0 },
    runs: (Array.isArray(history) ? history : []).slice(0, 30).map(run => ({
      startedAt: run.startedAt, endedAt: run.endedAt, status: run.status,
      steps: (run.steps || []).filter(step => ['stats', 'claim', 'dailySet', 'keepEarning', 'search', 'imageSearch'].includes(step)),
      events: (run.events || []).slice(-100).map(event => ({ at: event.at, step: stepIds.includes(event.step) ? event.step : 'other', outcome: outcomes.includes(event.outcome) ? event.outcome : 'other', durationMs: event.durationMs })),
    })),
  }
}

export async function downloadDiagnostics(): Promise<void> {
  const stored = await chrome.storage.local.get([KEYS.runState, KEYS.runHistory])
  const report = diagnosticReport(chrome.runtime.getManifest().version, stored[KEYS.runState] as RunState | undefined, stored[KEYS.runHistory] as RunRecord[] | undefined)
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `Gingerbread-diagnostics-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
