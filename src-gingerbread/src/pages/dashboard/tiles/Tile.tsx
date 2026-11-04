// The shared tile shell (6.8.0 rewrite). Every board tile renders through
// this ONE component — the React reuse the rewrite asked for: the panel
// chrome (the head that doubles as the drag handle, the body that scrolls
// and carries the container queries) lives here once.
//
// RGL never touches this element — the grid wraps each tile in its own DOM
// div (the element it clones geometry onto and appends the resize grip
// to; see GridLayout.tsx) — but the props/ref passthrough stays so a tile
// remains a plain, reusable <section> component in any other context.
//
// A tile reads its own SEAT (its grid w×h) to pick its content variant — the
// registry's designed steps are a lattice, ordered small → large, and each
// tile renders the layout built for its size, never squeezed below one it was
// designed for. This shell only stamps data-step (the seat's index in the
// tile's step list) for the diagnostics' "every tile sits on a designed step"
// gate.

import { useContext } from 'react'
import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react'
import { removeLocal } from '../../../shared/storage.ts'
import { GridCtx, useDash } from '../ctx.tsx'
import { stepIndexOf } from '../layout/snap.ts'
import { metaOf } from './registry.ts'
import { SECTION_LOCAL_KEYS } from './section-storage.ts'
import { CloseIcon } from '../../../popup/components/icons.tsx'
import type { TileStep } from './registry.ts'

export interface TileProps extends ComponentPropsWithoutRef<'section'> {
  seat: TileStep
  ref?: Ref<HTMLElement>
}

export function Tile({
  id,
  title,
  action,
  children,
  seat,
  className,
  style,
  ref,
  ...rest
}: TileProps & { id: string; title: string; action?: ReactNode }) {
  const { editing, hide, resize } = useContext(GridCtx)
  const { settings } = useDash()
  // data-step is the seat's index in this tile's designed-step list — the
  // diag's "every tile sits on a designed step" gate reads it. The content
  // variant itself is each tile's own concern (it reads seat.w / seat.h).
  const meta = metaOf(id)
  const step = meta ? stepIndexOf(meta.steps, seat.w, seat.h) : -1
  // The per-section storage reset (developer options only): sections with
  // their OWN local keys get the button; the click removes just those keys
  // and the tiles' live storage subscriptions re-render them empty.
  const resetKeys = SECTION_LOCAL_KEYS[id]
  return (
    <section
      ref={ref}
      className={'dash-panel' + (editing ? ' dash-panel--editing' : '') + (className ? ' ' + className : '')}
      data-panel-id={id}
      data-step={step}
      style={style}
      {...rest}
    >
      {/* The head is the DRAG HANDLE (draggableHandle '.dash-panel-head' in
       * the grid config — the Windows/Android idiom the rewrite chose):
       * title left, the tile's action (Refresh, Sync) right, the ⠿ hint
       * only while editing. */}
      <div className="dash-panel-head">
        {editing && (
          <span className="dash-drag-handle" aria-hidden>
            ⠿
          </span>
        )}
        <h2 className="dash-panel-title">{title}</h2>
        {!editing && resetKeys && settings.developerOptionsEnabled && (
          <button
            type="button"
            className="btn btn--sm dash-section-reset"
            title={`Clear this section's stored data (${resetKeys.length} key${resetKeys.length === 1 ? '' : 's'}) — developer tool`}
            onClick={() => {
              for (const key of resetKeys) void removeLocal(key)
            }}
          >
            Reset
          </button>
        )}
        {!editing && action}
        {editing && meta && resize && <select className="dash-widget-size" aria-label={`Size of ${title}`} value={`${seat.w}x${seat.h}`}
          onPointerDown={event => event.stopPropagation()} onChange={event => { const [w, h] = event.target.value.split('x').map(Number); resize(id, w, h) }}>
          {meta.steps.map(size => <option key={`${size.w}x${size.h}`} value={`${size.w}x${size.h}`}>{size.w} × {size.h}</option>)}
        </select>}
        {editing && hide && <button className="icon-btn widget-remove" type="button" aria-label={`Remove ${title}`} title={`Remove ${title}`}
          onPointerDown={event => event.stopPropagation()} onClick={() => hide(id)}><CloseIcon aria-hidden="true" /></button>}
      </div>
      <div className="dash-panel-body">{children}</div>
    </section>
  )
}

// A small stat card (the Balance tile's row of Ready to claim / Daily
// streak / Stamp bonus / Coupons).
export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="dash-tile">
      <span className="dash-tile-label">{label}</span>
      <span className="dash-tile-value">{value}</span>
      {sub && <span className="dash-tile-sub">{sub}</span>}
    </div>
  )
}
