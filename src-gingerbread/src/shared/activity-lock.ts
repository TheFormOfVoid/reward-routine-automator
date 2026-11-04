// All external worker entrypoints and backup restore share this lock. The
// worker holds it until work has either finished or handed off to a durable
// batch/routine owner. Internal step calls do not reacquire it.
export async function withActivityLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return work()
  return navigator.locks.request('gingerbread-activity', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another activity or backup restore is in progress. Try again shortly.')
    return work()
  })
}
