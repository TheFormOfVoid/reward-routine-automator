// The board (6.8.0 rewrite, user request 2026-09-11: "I do not like the
// current layout. And layout handling I want you to start again from
// scratch"): react-grid-layout drives the dashboard now — the ~500 lines of
// hand-rolled grid machinery (flowSeats, dropSpot, the grip pointer math,
// the ghost overlay, the tier measurement) are gone, replaced by this one
// wrapper plus the pure snap/migrate modules.
//
// What the wrapper adds ON TOP of RGL:
// - the registry's DESIGNED STEPS: a constraint funnels every free resize
//   proposal through snapToStep, so a tile only ever lands on a size it was
//   designed for (every reachable size is a designed size);
// - persistence: the board settles → dashLayout {v:2, items} (migrate.ts
//   sanitizes what comes back);
// - edit mode: the Edit layout toggle flips RGL's drag/resize on and shows
//   the grips; Default layout DROPS the stored key (a future default board
//   re-seats itself);
// - the animations setting: RGL's CSS transitions, on or off.
//
// Drag by the tile's HEAD (the Windows/Android idiom), resize by the corner
// grip, vertical compaction keeps the board packed (the 6.7.1 "no blank
// strips" requirement, for free).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GridLayout, useContainerWidth } from 'react-grid-layout'
import type { Layout } from 'react-grid-layout'
import { gridBounds, minMaxSize } from 'react-grid-layout/core'
import type { LayoutConstraint } from 'react-grid-layout/core'
import 'react-grid-layout/css/styles.css'
import { useStorageValue } from '../../../popup/hooks/useStorageValue.ts'
import { KEYS } from '../../../shared/storage.ts'
import type { StoredDashLayout } from '../../../shared/storage.ts'
import { GRID_COLS, GRID_CONTAINER_PADDING, GRID_MARGIN, GRID_ROW_HEIGHT, PANEL_IDS, metaOf } from '../tiles/registry.ts'
import { BalanceTile } from '../tiles/BalanceTile.tsx'
import { HistoryTile } from '../tiles/HistoryTile.tsx'
import { LogTile } from '../tiles/LogTile.tsx'
import { StreaksTile } from '../tiles/StreaksTile.tsx'
import { ControlsTile } from '../tiles/ControlsTile.tsx'
import { NextRoutineTile } from '../tiles/NextRoutineTile.tsx'
import { CatalogTile } from '../tiles/CatalogTile.tsx'
import { OrdersTile } from '../tiles/OrdersTile.tsx'
import { NewsTile } from '../tiles/NewsTile.tsx'
import { GridCtx } from '../ctx.tsx'
import { migrate, toDoc } from './migrate.ts'
import type { RGLItem } from './migrate.ts'
import { snapToStep } from './snap.ts'
import { WidgetChooser } from '../../../popup/components/WidgetChooser.tsx'
import { NotificationCard } from '../../../popup/components/NotificationCard.tsx'
import { DASH_HIDDEN_KEY, mergeVisibleGeometry, normalizeHidden } from './visibility.ts'

// The tile components, keyed by registry id — the board renders straight
// from this map, so adding a tile is a registry entry + a component.
const TILE_COMPONENTS = {
  balance: BalanceTile,
  history: HistoryTile,
  log: LogTile,
  streaks: StreaksTile,
  controls: ControlsTile,
  next: NextRoutineTile,
  catalog: CatalogTile,
  orders: OrdersTile,
  news: NewsTile,
} as const

// The designed-steps constraint — the heart of the "optimized, not crushed"
// ask: react-grid-layout proposes FREE (w, h) while the grip moves; this
// snaps the proposal to the tile's nearest designed PAIR (distance in
// pixels — one column ≈ 112px is not one 160px row, and the snap should
// feel that way under the cursor), so nothing between steps is reachable
// and the content variant always matches a size it was built for.
const DESIGNED_STEPS: LayoutConstraint = {
  name: 'dash-designed-steps',
  constrainSize(item, w, h, _handle, context) {
    const meta = metaOf(item.i)
    if (!meta) return { w, h }
    const colPx = (context.containerWidth - context.margin[0] * (context.cols - 1)) / context.cols
    const s = snapToStep(meta.steps, w, h, colPx, context.rowHeight)
    return { w: s.w, h: s.h }
  },
}

// The RGL geometry is fully static (every value is a module constant) and the
// constraint stack never changes, so both live at module scope — rebuilding
// them each render would hand <GridLayout> new prop identities for nothing.
const GRID_CONFIG = {
  cols: GRID_COLS,
  rowHeight: GRID_ROW_HEIGHT,
  margin: GRID_MARGIN,
  containerPadding: GRID_CONTAINER_PADDING,
}
const CONSTRAINTS = [gridBounds, minMaxSize, DESIGNED_STEPS]

// Board equality for the storage → state sync: same ids, same seats, same
// sizes (deep-equal on the five fields that matter).
function sameBoard(a: RGLItem[], b: RGLItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].i !== b[i].i || a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].w !== b[i].w || a[i].h !== b[i].h) return false
  }
  return true
}

export const DashboardGrid = memo(function DashboardGrid({ animate }: { animate: boolean }) {
  const { value: stored, loaded } = useStorageValue<StoredDashLayout | null>('local', KEYS.dashLayout, null)
  const storedItems = useMemo(() => migrate(stored), [stored])
  // The board is a DRAFT over the stored doc, not a copy of it: `items`
  // holds the in-flight board once RGL settles one (a drag, a resize, its
  // own compaction of a sloppy doc), and stays null until then. The
  // fallback-derived board must NEVER reach RGL — chrome.storage answers
  // asynchronously, and a grid mounted from the null fallback would echo
  // its default board back through onLayoutChange and CLOBBER the stored
  // doc before the read resolves (found live: every reload rendered the
  // default board no matter what was stored).
  const [items, setItems] = useState<RGLItem[] | null>(null)
  const board = items ?? storedItems
  const visibility = useStorageValue<unknown>('local', DASH_HIDDEN_KEY, [])
  const hidden = useMemo(() => new Set(normalizeHidden(visibility.value)), [visibility.value])
  const visibleBoard = board.filter(item => !hidden.has(item.i))
  const boardRef = useRef(board)
  boardRef.current = board
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  const visibilityWrites = useRef<Promise<unknown>>(Promise.resolve())
  const [layoutError, setLayoutError] = useState<string | null>(null)
  function changeVisibility(id: string, visible: boolean) {
    visibilityWrites.current = visibilityWrites.current.then(async () => {
      const saved = await chrome.storage.local.get(DASH_HIDDEN_KEY)
      const next = new Set(normalizeHidden(saved[DASH_HIDDEN_KEY]))
      if (visible) next.delete(id); else if (PANEL_IDS.includes(id as typeof PANEL_IDS[number])) next.add(id)
      await chrome.storage.local.set({ [DASH_HIDDEN_KEY]: [...next] })
    }).catch(() => setLayoutError('Could not save widget visibility. Try again.'))
  }
  function resizeWidget(id: string, w: number, h: number) {
    const meta = metaOf(id)
    if (!meta?.steps.some(step => step.w === w && step.h === h)) return
    const next = boardRef.current.map(item => item.i === id ? { ...item, w, h } : item)
    setItems(next)
    void chrome.storage.local.set({ [KEYS.dashLayout]: toDoc(next) }).catch(() => setLayoutError('Could not save widget size. Try again.'))
  }
  const [editing, setEditing] = useState(false)
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
  // What storage currently says — the persist guard's reference point (a
  // ref so onLayoutChange always compares against the latest read).
  const storedRef = useRef(storedItems)
  storedRef.current = storedItems

  // The stored doc is the source of truth for OTHER writers (the Default
  // layout button's key removal, a future options page); our own writes
  // round-trip through here too. Any change drops the draft — the stored
  // doc rules again.
  useEffect(() => {
    setItems(null)
  }, [storedItems])

  // A settled board (drag stop, resize stop, RGL's own load-time
  // compaction of a sloppy stored doc) — sanitize, hold, persist. RGL also
  // ECHOES the layout on every mount (its internal copy carries extra
  // fields its own deepEqual guard can't see past), so the write is
  // guarded: a board that matches what storage already says writes
  // nothing. The worker never touches this key; it's a pure UI preference.
  const onLayoutChange = useCallback((layout: Layout): void => {
    const incoming = layout.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })) as RGLItem[]
    const clean = migrate(toDoc(mergeVisibleGeometry(boardRef.current, incoming, hiddenRef.current)))
    setItems((prev) => (prev && sameBoard(prev, clean) ? prev : clean))
    if (!sameBoard(clean, storedRef.current)) {
      void chrome.storage.local.set({ [KEYS.dashLayout]: toDoc(clean) }).catch(() => setLayoutError('Could not save widget positions. Try again.'))
    }
  }, [])

  return (
    <>
      {layoutError && <NotificationCard className="dash-layout-error" onDismiss={() => setLayoutError(null)} dismissLabel="Dismiss layout message">{layoutError}</NotificationCard>}
      {/* Edit layout (the 6.7.0 toggle, kept verbatim in spirit): flips
       * RGL's drag/resize on — heads drag, corner grips resize, steps snap.
       * While on, a Default layout button sits beside it: it DROPS the
       * stored key (not overwrites), so the registry's board returns and a
       * future default re-seats the board too. */}
      <div className="dash-edit-bar">
        <WidgetChooser name="Dashboard widgets" disabled={!visibility.loaded || Boolean(visibility.error)}
          items={PANEL_IDS.map(id => ({ id, title: metaOf(id)!.title, visible: !hidden.has(id) }))} onToggle={changeVisibility} />
        <button
          className={`btn btn--sm dash-edit-toggle${editing ? ' btn--primary' : ''}`}
          aria-pressed={editing}
          title="Drag a tile by its header anywhere on the board; drag its corner grip to resize it (it snaps to its designed sizes)"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? 'Done' : 'Edit layout'}
        </button>
        {editing && (
          <button
            className="btn btn--sm dash-reset-toggle"
            title="Restore the default arrangement and sizes"
            onClick={() => {
              visibilityWrites.current = visibilityWrites.current.then(() => chrome.storage.local.remove([KEYS.dashLayout, DASH_HIDDEN_KEY]))
                .catch(() => setLayoutError('Could not reset the layout. Try again.'))
            }}
          >
            Default layout
          </button>
        )}
      </div>

      {/* The board's page chrome lives on .dash-board (the 72px top clearance
       * for the fixed edit bar and gear, the side/bottom air); .dash-grid is
       * the MEASURED element and carries no padding of its own — RGL's
       * column math divides the width it is handed, so a padded measurement
       * would push every tile off the board's right edge. */}
      <div className={`dash-board${editing ? ' dash-board--editing' : ''}`}>
        <div className={`dash-grid${editing ? ' dash-grid--editing' : ''}`} ref={containerRef}>
        {/* `loaded`: chrome.storage answers async — the grid mounts only
         * once the stored doc (or its absence) has actually been read, so
         * the first RGL render is already the real board. */}
        {loaded && visibility.loaded && mounted && (
          <GridCtx.Provider value={{ editing, hide: id => changeVisibility(id, false), resize: resizeWidget }}>
            <GridLayout
              className={`dash-rgl${animate ? '' : ' dash-rgl--still'}`}
              width={width}
              layout={visibleBoard}
              gridConfig={GRID_CONFIG}
              dragConfig={{
                enabled: editing,
                handle: '.dash-panel-head',
              }}
              resizeConfig={{
                enabled: editing,
                handles: ['se'],
                handleComponent: <span className="dash-resize-handle" aria-hidden />,
              }}
              constraints={CONSTRAINTS}
              onLayoutChange={onLayoutChange}
            >
              {/* Each tile sits in its own plain DOM wrapper div. RGL clones
               * the direct child to stamp geometry and react-resizable
               * APPENDS the resize grip to that child's children — a DOM
               * div renders [tile, grip] as siblings, so the grip pins to
               * the RGL item's corner while the tile keeps its natural
               * content-as-children API (a function-component tile would
               * silently eat the grip: its own JSX children override the
               * cloned ones — found live, handles simply never rendered). */}
              {visibleBoard.map((item) => {
                const TileComponent = TILE_COMPONENTS[item.i as keyof typeof TILE_COMPONENTS]
                if (!TileComponent) return null
                return (
                  <div key={item.i}>
                    <TileComponent seat={{ w: item.w, h: item.h }} />
                  </div>
                )
              })}
            </GridLayout>
          </GridCtx.Provider>
        )}
        {loaded && visibility.loaded && visibleBoard.length === 0 && <div className="widgets-empty"><h2>Your board is clear</h2><p>Add widgets to build your dashboard.</p></div>}
        </div>
      </div>
    </>
  )
})

// The registry's full id list, re-exported for the diag gates' vocabulary.
export { PANEL_IDS }
