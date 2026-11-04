import type { MessageResponse } from '../../shared/messages.ts'
import type { RunState } from '../../shared/storage.ts'

// Reserve before the first asynchronous read, so two UI commands cannot both
// observe an idle worker and begin competing selected-tab work.
export function createTaskAdmission(readState: () => Promise<RunState>, reportFailure: (error: unknown) => Promise<unknown>,
  exclusive: <T>(work: () => Promise<T>) => Promise<T> = work => work()) {
  let starting = false
  return async (task: () => Promise<unknown>): Promise<MessageResponse> => {
    if (starting) return { ok: false, error: 'Another task is starting or running' }
    starting = true
    let acknowledge!: (result: MessageResponse) => void
    let accepted = false
    const response = new Promise<MessageResponse>(resolve => { acknowledge = resolve })
    void exclusive(async () => {
      const state = await readState()
      if (state.batch || state.routine || state.activity) {
        starting = false
        acknowledge({ ok: false, error: 'Finish or stop the current activity first' })
        return
      }
      accepted = true
      acknowledge({ ok: true })
      await task()
    }).catch(async error => {
      if (!accepted) {
        starting = false
        acknowledge({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      else await reportFailure(error)
    }).catch(error => console.warn('Could not report task failure:', error)).finally(() => { starting = false })
    return response
  }
}
