import './HistoryChart.css'
import { useMemo } from 'react'
import type { HistoryEntry } from '../../shared/storage.ts'

// The dashboard's points chart: one BAR per day, its height that day's
// EARNED points (last − first) — a histogram, not a line (user request,
// 2026-09-09: "add some points, not only a continuous line… use something
// like a histogram or anything to identify the difference between each
// day"). A line over steadily-earning days reads as one ramp; bars make each
// day its own mark, directly comparable. The baseline is an honest zero and
// the bars scale against the best day. Hand-rolled SVG, no new deps; below
// two days it says so — one bar is not a trend.
export function HistoryChart({
  history,
  days = 90,
}: {
  history: HistoryEntry[]
  days?: number
}) {
  const recent = useMemo(() => history.slice(-days), [history, days])

  if (recent.length < 2) {
    return <div className="chart-empty">A trend appears after a couple of days.</div>
  }

  const W = 860
  const H = 240
  const padX = 8
  const padTop = 12
  const padBottom = 22
  const values = recent.map((e) => Math.max(0, e.last - e.first))
  // Always ≥1 so a flat history doesn't divide by zero.
  const max = Math.max(...values, 1)
  const plotH = H - padTop - padBottom
  // One slot per day; the bar fills most of its slot but caps fat so a
  // short history doesn't render handful of slabs.
  const step = (W - padX * 2) / values.length
  const barW = Math.min(step * 0.72, 26)
  const yFor = (v: number): number => H - padBottom - (v / max) * plotH

  return (
    <div className="history-chart-wrap">
      {/* The max label and the zero baseline label are HTML, not SVG text:
       * the SVG stretches to fill (preserveAspectRatio="none"), which would
       * render SVG glyphs ~2x wide. Fixed slots inside the strip — max at
       * the top edge, zero at the bottom. */}
      <span className="chart-label chart-label--max">{max.toLocaleString('en-US')}</span>
      <span className="chart-label chart-label--min">0</span>
      <svg
        className="history-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Points earned per day over the last ${recent.length} days — one bar per day`}
      >
        {/* The best day's gridline + the zero baseline. */}
        <line x1={padX} x2={W - padX} y1={yFor(max)} y2={yFor(max)} className="chart-grid" />
        <line x1={padX} x2={W - padX} y1={H - padBottom} y2={H - padBottom} className="chart-grid" />
        {values.map((v, i) => {
          const h = (v / max) * plotH
          // A day that earned nothing gets no bar — absence IS the datum.
          if (h <= 0) return null
          const x = padX + i * step + (step - barW) / 2
          const isLast = i === values.length - 1
          return (
            <rect
              key={i}
              x={x.toFixed(1)}
              y={yFor(v).toFixed(1)}
              width={barW.toFixed(1)}
              height={Math.max(h, 1.5).toFixed(1)}
              className={isLast ? 'chart-bar chart-bar--last' : 'chart-bar'}
            />
          )
        })}
      </svg>
    </div>
  )
}
