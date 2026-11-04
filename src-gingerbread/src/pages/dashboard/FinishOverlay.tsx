// The routine's finish screen, as an overlay ON the dashboard (user request,
// 2026-09-11: "why not put the finish screen on top of the dashboard? When
// the user clicks the button in the finish screen, it will just blur out, and
// he will see the dashboard"). The worker opens dashboard.html carrying the
// same ?q=/?s= summary the old routine-done page read; the board mounts
// underneath and this overlay covers it — a full-viewport backdrop plus the
// summary card. Done starts the blur-out (opacity + blur, honoring the motion
// setting / low power mode); when it lands the overlay unmounts and the
// summary query is stripped from the URL, so a reload lands on the plain
// board. A reload BEFORE Done re-reads the query and shows the overlay again
// — the summary survives until the user has actually acknowledged it.

import { useEffect, useRef, useState } from 'react'
import { sendMessage } from '../../shared/messages.ts'
import { STEP_LABEL } from '../../shared/settings.ts'
import type { BackgroundStyle, StepId } from '../../shared/settings.ts'
import { Background } from '../../popup/fx/Background.tsx'
import { Confetti } from '../../popup/fx/Confetti.tsx'
import { RestartIcon } from '../../popup/components/icons.tsx'
import { RewardsLink } from '../../popup/components/RewardsLink.tsx'
import { usePendingUpdate } from '../../popup/hooks/usePendingUpdate.ts'

// The ?q= summary is keyed by Activities keys (the streaks the user finishes),
// ?s= by StepId (the routine steps skipped as already done). Two maps, one per
// query, with the raw key as the fallback label.
const STREAK_LABEL: Record<string, string> = {
  bingSearch: 'Bing searches',
  dailySet: 'Daily set',
  bingApp: 'Bing app check-in',
  visualSearch: 'Image search',
  claim: 'Claim points',
  keepEarning: 'Keep earning',
}

export type FinishPair = { key: string; value: string }

// Split on the FIRST ':' only: a display value can itself contain a colon, but
// the key never does (and the worker keeps ?s= reasons ':'-free), so slicing at
// the first colon reconstructs both halves cleanly.
function splitPairs(raw: string): FinishPair[] {
  if (!raw) return []
  return raw
    .split(';')
    .map((part): FinishPair | null => {
      const i = part.indexOf(':')
      if (i < 0) return null
      const key = part.slice(0, i).trim()
      const value = part.slice(i + 1).trim()
      return key ? { key, value } : null
    })
    .filter((p): p is FinishPair => p !== null)
}

export interface FinishSummary {
  todo: FinishPair[]
  skipped: FinishPair[]
  dev: boolean
}

// What the worker's finish URL carries, or null on a plain dashboard open —
// the dashboard's gate for showing this overlay at all.
export function readFinishSummary(): FinishSummary | null {
  const params = new URLSearchParams(window.location.search)
  const q = params.get('q')
  const s = params.get('s')
  const dev = params.get('dev') === '1'
  if (!q && !s && !dev) return null
  return { todo: splitPairs(q || ''), skipped: splitPairs(s || ''), dev }
}

// How long the blur-out runs before the overlay unmounts (matches the CSS
// transition in dashboard.css).
const BLUR_OUT_MS = 450

export function FinishOverlay({
  summary,
  background,
  animate,
  onClose,
}: {
  summary: FinishSummary
  background: BackgroundStyle
  animate: boolean
  onClose: () => void
}) {
  const [closing, setClosing] = useState(false)
  const pending = usePendingUpdate()
  const allDone = summary.todo.length === 0
  const dialog = useRef<HTMLDivElement>(null)
  const doneButton = useRef<HTMLButtonElement>(null)
  const closingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    doneButton.current?.focus()
    return () => { if (closingTimer.current !== null) clearTimeout(closingTimer.current) }
  }, [])

  const done = () => {
    if (closingTimer.current !== null || closing) return
    // Still mode (animations off, low power, reduced motion) skips the
    // transition and the wait together.
    if (!animate) {
      onClose()
      return
    }
    setClosing(true)
    closingTimer.current = setTimeout(onClose, BLUR_OUT_MS)
  }

  return (
    <div
      ref={dialog}
      className={`finish-overlay${closing ? ' finish-overlay--closing' : ''}${animate ? '' : ' finish-overlay--still'}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="finish-heading"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); done(); return }
        if (event.key !== 'Tab') return
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') || [])
        const first = controls[0]
        const last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}
    >
      <Background style={background} animate={animate} />
      <div className="finish-card">
        <Confetti fire={animate} />
        {summary.dev && <div className="finish-dev">Preview · dev</div>}
        <h1 id="finish-heading" className="finish-title">Daily routine complete</h1>
        <p className="finish-sub">
          Reward Routine Automator finished its run.{' '}
          {allDone
            ? 'Every streak it can reach is done.'
            : 'Some tasks need attention or could not be verified.'}
        </p>

        {allDone && (
          <div className="finish-all-done">
            <span className="finish-dot finish-dot--done" />
            <span>All caught up — nothing left to do today. 🎉</span>
          </div>
        )}

        {summary.todo.length > 0 && (
          <section className="finish-section">
            <h2 className="finish-section-title">Needs attention</h2>
            <ul className="finish-list">
              {summary.todo.map(({ key, value }) => (
                <li className="finish-row" key={key}>
                  <span className="finish-dot finish-dot--todo" />
                  <span className="finish-name">{STREAK_LABEL[key] || key}</span>
                  <span className="finish-val">{value}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {summary.skipped.length > 0 && (
          <section className="finish-section">
            <h2 className="finish-section-title">Skipped — already done</h2>
            <ul className="finish-list">
              {summary.skipped.map(({ key, value }) => (
                <li className="finish-row finish-row--skip" key={key}>
                  <span className="finish-dot finish-dot--done" />
                  <span className="finish-name">{STEP_LABEL[key as StepId] || key}</span>
                  <span className="finish-val">{value}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="finish-actions">
          <RewardsLink label className="finish-rewards" />
          {/* The Restart control (6.9.8), the only thing on this screen that is
           * about the extension rather than the run. It appears only while an
           * update is sitting on disk unloaded — see usePendingUpdate — and
           * sits to the LEFT of Done so the screen's own verb stays last and
           * keeps the primary weight. Both buttons use the popup's .btn set,
           * which dashboard.html already loads. */}
          {pending && (
            <button
              type="button"
              className="btn finish-restart"
              title="Reload the extension so Chrome runs the updated files."
              onClick={() => sendMessage({ type: 'RELOAD_EXTENSION' })}
            >
              <RestartIcon />
              Restart
            </button>
          )}
          <button ref={doneButton} className="btn btn--primary finish-done" onClick={done}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
