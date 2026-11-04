import { useEffect, useState } from 'react'

// Is an update sitting on disk that Chrome has not picked up yet? (6.9.8)
//
// The updater replaces files in the folder Chrome loads unpacked, but Chrome
// holds the extension in memory and never re-reads that folder — so after a
// run, the new files are in place and the OLD code keeps running until
// something presses Reload. Nothing can press it but the user, which is why
// the Restart control this feeds exists at all.
//
// The signal needs no bookkeeping: manifest.json on disk already carries the
// new version, and chrome.runtime.getManifest() carries the loaded one. When
// they differ, the folder has moved on. That also means this fires however the
// files were replaced — via the updater, or by unzipping by hand over the
// folder — and clears itself: once the extension reloads, the two agree again
// and the control disappears.
//
// cache: 'no-store' is what makes it trustworthy. Chrome caches extension
// resources, so a plain fetch can serve the PRE-update bytes, the versions
// match, and the banner never appears at all.
//
// Check again while the dashboard stays open, and when the user returns from
// running the updater. Failed reads leave the last confirmed result alone.
export function usePendingUpdate(): string | null {
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let checking = false
    const loaded = chrome.runtime.getManifest().version

    const check = async () => {
      if (!alive || checking || document.visibilityState === 'hidden') return
      checking = true
      try {
        const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })
        if (!res.ok) return
        const disk: unknown = await res.json()
        if (!alive || !disk || typeof disk !== 'object') return
        const version = (disk as { version?: unknown }).version
        if (typeof version === 'string' && version) setPending(version !== loaded ? version : null)
      } catch {
        // The updater may briefly be replacing files. Retry on the next check.
      } finally {
        checking = false
      }
    }
    void check()
    const timer = window.setInterval(check, 30_000)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)

    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  return pending
}
