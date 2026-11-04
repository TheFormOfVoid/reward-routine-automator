import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getSettings } from '../../shared/settings.ts'
import type { BackgroundStyle } from '../../shared/settings.ts'
import { sendMessage } from '../../shared/messages.ts'
import { applyTheme } from '../../theme/apply.ts'
import { Background } from '../../popup/fx/Background.tsx'
import { BrandMark } from '../../popup/components/BrandMark.tsx'
import '../../theme/tokens.css'
import '../../theme/backgrounds.css'
import '../pages.css'

// The worker opens this window when "ask before running" is on and a scheduled
// or auto routine is about to start. Answering posts routineConfirmAnswer back
// to the worker, then closes the window. The worker treats the window closing
// without an answer as Cancel (only its own 15s timeout proceeds on its own),
// so the answer must go out before the close — hence sending first, then
// closing in .finally.
function answer(proceed: boolean): void {
  sendMessage({ type: 'routineConfirmAnswer', proceed }).finally(() => window.close())
}

function ConfirmPage({ background, animate }: { background: BackgroundStyle; animate: boolean }) {
  return (
    <>
      <Background style={background} animate={animate} />
      <div className="page-card">
        <BrandMark size={44} className="page-glyph" />
        <h1 className="page-title">Start the daily routine?</h1>
        <p className="page-sub">
          Reward Routine Automator is about to run your searches and daily set. It starts on its own in a few
          seconds — choose “Not now” to skip this run.
        </p>
        <div className="page-actions">
          <button className="btn btn--primary btn-lg" onClick={() => answer(true)} autoFocus>
            Start now
          </button>
          <button className="btn btn-lg" onClick={() => answer(false)}>
            Not now
          </button>
        </div>
      </div>
    </>
  )
}

const root = document.getElementById('root')

function mount(background: BackgroundStyle, animate: boolean): void {
  if (!root) return
  createRoot(root).render(
    <StrictMode>
      <ConfirmPage background={background} animate={animate} />
    </StrictMode>,
  )
}

// The backdrop (and theme) come from settings, so the first paint waits for
// the read — a few ms — and falls back to a bare card if storage fails.
getSettings()
  .then((s) => {
    applyTheme(s)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    mount(s.background, s.animationsEnabled && !s.lowPowerMode && !reduce)
  })
  .catch(() => mount('none', false))
