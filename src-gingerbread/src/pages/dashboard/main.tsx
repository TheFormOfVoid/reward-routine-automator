import { lazy, StrictMode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Background } from '../../popup/fx/Background.tsx'
import { useSettings } from '../../popup/hooks/useSettings.ts'
import { useRunState } from '../../popup/hooks/useRunState.ts'
import { useMessage } from '../../popup/hooks/useMessage.ts'
import { useTheme } from '../../popup/hooks/useTheme.ts'
import { useMotionEnabled } from '../../popup/fx/motion-presets.ts'
import { StorageGate } from '../../popup/components/StorageGate.tsx'
import { ViewBoundary } from '../../popup/components/ViewBoundary.tsx'
import { GearIcon } from '../../popup/components/icons.tsx'
import { RewardsLink } from '../../popup/components/RewardsLink.tsx'
import { NotificationCard } from '../../popup/components/NotificationCard.tsx'
import { DashboardCtx } from './ctx.tsx'
import type { DashboardWiring } from './ctx.tsx'
import { FinishOverlay, readFinishSummary } from './FinishOverlay.tsx'
import '../../theme/tokens.css'
import '../../theme/backgrounds.css'
// The settings view reuses the popup's Settings component wholesale, so its
// sheet rides along (class-based; the one popup-scoped rule, .app's fixed
// 440px frame, is a class this page never renders).
import '../../popup/popup.css'
import './dashboard.css'

// The full-screen dashboard (user request, 2026-09-08): everything the
// extension knows, at full size. Same hooks and pure modules as the popup
// (one source of truth), its own stylesheet, and NO useMouseEscape (a
// full-screen surface doesn't dodge).
//
// No header bar (user request, 2026-09-09): the grid runs edge to edge; the
// Refresh button lives in the Balance tile's head, the Edit layout bar and
// the gear float over the board. pages.css is deliberately NOT imported:
// that sheet centers the worker-opened dialog pages (body flex + padding
// 24px), which fought this page's full viewport rules.
//
// 6.8.0 rewrite (user request, 2026-09-11: "I do not like the current
// layout. And layout handling I want you to start again from scratch… you
// are working in React. Reusable components take advantage of that"): the
// page is now a slim SHELL — the wiring (settings, run state, the message
// sender) plus the gear's settings surface and the board. Every tile is a
// self-contained component that owns its data hooks (tiles/), the board is
// react-grid-layout with per-tile designed steps (layout/), and the
// registry (tiles/registry.ts) is the single data source for sizes and the
// default board.

const loadGrid = () => import('./layout/GridLayout.tsx').then((module) => ({ default: module.DashboardGrid }))
const DashboardGrid = lazy(loadGrid)
const SettingsView = lazy(() => import('../../popup/views/Settings.tsx').then((module) => ({ default: module.Settings })))

function DashboardPage() {
  const { settings, save, loaded, error, retry } = useSettings()
  useTheme(settings)
  const animate = useMotionEnabled(settings.animationsEnabled && !settings.lowPowerMode)
  const runState = useRunState()
  // The routine's finish screen (6.8.0): the worker opens the dashboard with
  // the summary in the query (?q=/?s=, ?dev for the Developer-Option preview).
  // Captured ONCE at mount — the state decides whether the overlay shows, so
  // it must not flicker with re-renders. A reload before Done re-reads the
  // query and shows it again; Done strips the query, so a reload after lands
  // on the plain board.
  const [finish, setFinish] = useState(readFinishSummary)
  const gear = useRef<HTMLButtonElement>(null)
  const focusAfterFinish = useRef(false)
  useEffect(() => {
    if (!finish || !loaded) return
    // Load code after the finish card paints. The covered grid's hooks and
    // effects start only after Done, so it consumes no background work.
    const timer = window.setTimeout(() => { void loadGrid().catch(() => {}) }, 500)
    return () => window.clearTimeout(timer)
  }, [finish, loaded])
  const closeFinish = useCallback(() => {
    focusAfterFinish.current = true
    setFinish(null)
    history.replaceState(null, '', window.location.pathname)
  }, [])
  useEffect(() => {
    if (!finish && focusAfterFinish.current) {
      gear.current?.focus()
      focusAfterFinish.current = false
    }
  }, [finish])
  // The gear's settings surface (user request, 2026-09-09): the dashboard's
  // content swaps for the same settings the popup edits, distributed across
  // the full width.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The run controls' in-flight marker (the popup's Run view's `busy`): one
  // message at a time, so each button disables itself while its action runs.
  const { send, busy, error: commandError, clearError } = useMessage()

  // One stable context value: rebuilt only when a field the tiles actually
  // read moves (busy per action, runState per tick, settings on save) — not on
  // every DashboardPage render (the gear toggle, any parent re-render). Without
  // it every consumer — Controls, Balance, History, Next — would reconcile on
  // each unrelated render.
  const wiring = useMemo<DashboardWiring>(
    () => ({ settings, save, runState, send, busy, animate }),
    [settings, save, runState, send, busy, animate],
  )

  if (!loaded) return <StorageGate error={error} retry={retry} />

  return (
    <div className="dash" data-low-power={settings.lowPowerMode || undefined}>
      {!finish && <Background style={settings.background} animate={animate} />}
      {commandError && !finish && <NotificationCard className="action-feedback action-feedback--dashboard" urgent onDismiss={clearError} dismissLabel="Dismiss action message">{commandError}</NotificationCard>}
      {!finish && <RewardsLink className="dash-rewards" />}

      {/* The gear, pinned top-right over whatever content is showing — the
       * dashboard's own way into its settings surface. */}
      {!finish && <button
        ref={gear}
        className="icon-btn dash-gear"
        aria-label="Settings"
        title="Settings"
        aria-pressed={settingsOpen}
        onClick={() => setSettingsOpen((v) => !v)}
      >
        <GearIcon />
      </button>}

      {!finish && <ViewBoundary><Suspense fallback={<div className="view-loading" role="status">Opening dashboard…</div>}>{settingsOpen ? (
        <div className="dash-settings">
          <SettingsView settings={settings} save={save} motionOn={animate} />
        </div>
      ) : (
        <DashboardCtx.Provider value={wiring}>
          <DashboardGrid animate={animate} />
        </DashboardCtx.Provider>
      )}</Suspense></ViewBoundary>}

      {/* The finish overlay last and topmost: it covers the gear, the
       * settings surface and the board alike until the user presses Done. */}
      {finish && (
        <FinishOverlay
          summary={finish}
          background={settings.background}
          animate={animate}
          onClose={closeFinish}
        />
      )}
    </div>
  )
}

const root = document.getElementById('root')

if (root) createRoot(root).render(<StrictMode><DashboardPage /></StrictMode>)
