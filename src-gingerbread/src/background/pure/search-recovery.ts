// Deadlines bound awaited work; they do not cancel the underlying browser API.
// Page-side search separately enforces its own shorter lease before submitting.
export function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export const SEARCH_MAX_ATTEMPTS = 3
export const SEARCH_ATTEMPT_MS = 120000
export const SEARCH_PAGE_LEASE_MS = 60000

export function nextSearchRunId(sequence: number | undefined, priorId: number | undefined): number {
  return Math.max(0, Number(sequence) || 0, Number(priorId) || 0) + 1
}
