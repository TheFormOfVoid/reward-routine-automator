// The message contract between the popup and the worker. One discriminated
// union of everything the popup can ask for (Phase 1's set — the deferred
// features add their own variants later), so a `switch (message.type)` in the
// worker is exhaustively checkable and the popup cannot send a typo.

export type Message =
  | { type: 'START_SEARCH_BATCH' }
  | { type: 'STOP_BATCH' }
  | { type: 'PAUSE_ACTIVITY' }
  | { type: 'RESUME_ACTIVITY' }
  | { type: 'PREVIEW_REMAINING' }
  | { type: 'RUN_REMAINING'; steps: string[] }
  | { type: 'POSTPONE_ROUTINE'; minutes: number }
  | { type: 'CANCEL_POSTPONE' }
  | { type: 'RUN_DAILY_SET' }
  | { type: 'RUN_KEEP_EARNING' }
  | { type: 'RUN_CLAIM' }
  | { type: 'RUN_IMAGE_SEARCH' }
  | { type: 'REFRESH_STATS' }
  | { type: 'REFRESH_REDEEM' }
  | { type: 'SYNC_ORDERS'; forceAll?: boolean }
  | { type: 'REDEEM_OVERWATCH'; url: string; label: string }
  | { type: 'OPEN_REDEEM_PAGE'; url: string }
  | { type: 'CLAIM_COUPONS' }
  | { type: 'RUN_FULL_ROUTINE' }
  | { type: 'OPEN_ROUTINE_DONE' }
  | { type: 'OPEN_DASHBOARD' }
  | { type: 'CLEAR_ALL_TABS'; windowId?: number }
  | { type: 'RESET_ROUTINE_DAY' }
  | { type: 'PROBE_REWARDS_API' }
  | { type: 'RELOAD_EXTENSION' }
  | { type: 'routineConfirmAnswer'; proceed: boolean }

export type MessageType = Message['type']

// Every handler replies with at least { ok }. clearAllTabs adds closed/kept;
// the error path adds a message. Kept open-ended so a handler can return extra
// fields without widening the union at every call site.
export interface MessageResponse {
  ok: boolean
  error?: string
  closed?: number
  kept?: number
  [key: string]: unknown
}

// The popup's one door to the worker. Rejections from a missing worker are
// swallowed into a shaped failure so a caller always gets a MessageResponse.
export async function sendMessage(message: Message): Promise<MessageResponse> {
  try {
    const response: unknown = await chrome.runtime.sendMessage(message)
    if (!response || typeof response !== 'object' || !('ok' in response) || typeof response.ok !== 'boolean') {
      return { ok: false, error: 'The extension did not respond. Try again.' }
    }
    return response as MessageResponse
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}
