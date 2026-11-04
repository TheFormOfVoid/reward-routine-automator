// The Balance tile (6.8.0 rewrite): the stats hero — the available-points
// value with its count-up, the membership medal, the search ring, the four
// stat tiles and the pressable Stamp-bonus star drawer. Owns its own data
// hooks (one source of truth with the popup); the Refresh action lives in
// the head, as it has since the header bar was dropped (2026-09-09).
//
// The measured body width chooses two or four stat columns; never three,
// which used to leave Coupons below the default 4×2 seat. The compact step
// scales the ring, while freshness/live status use their own full-width row.
// Tall steps add air and space for the inline stamp drawer. The variant
// comes from the step's own w/h, not its position in the registry lattice.

import { useState } from 'react'
import { useStats } from '../../../popup/hooks/useStats.ts'
import { usePointsHistory } from '../../../popup/hooks/useStats.ts'
import { useLastCoupons } from '../../../popup/hooks/useRedeem.ts'
import { PointsRing } from '../../../popup/components/PointsRing.tsx'
import { useCountUp } from '../../../popup/lib/useCountUp.ts'
import { formatNumber, signed, displayPoints } from '../../../popup/lib/format.ts'
import { progressPair, statsAreCurrent } from '../../../background/pure/verdicts.ts'
import { earnedToday, parsePoints } from '../../../background/pure/history.ts'
import { parseStarCount } from '../../../background/pure/streaks.ts'
import { localDayKey } from '../../../background/core/day.ts'
import { sendMessage } from '../../../shared/messages.ts'
import { liveStatus } from '../../../shared/run-status.ts'
import { useDash } from '../ctx.tsx'
import { membershipTone, timeAgo } from './shared.tsx'
import { StatTile, Tile } from './Tile.tsx'
import type { TileProps } from './Tile.tsx'

export function BalanceTile({ seat, ...rest }: TileProps) {
  const { animate, runState } = useDash()
  const stats = useStats()
  const history = usePointsHistory()
  const coupons = useLastCoupons()
  const [refreshing, setRefreshing] = useState(false)
  // The Stamp-bonus tile's star drawer (user request, 2026-09-09: press the
  // tile, more detail shows).
  const [starOpen, setStarOpen] = useState(false)

  const available = parsePoints(stats?.availablePoints)
  const shown = useCountUp(available, animate)
  const balanceText = shown == null ? '—' : formatNumber(shown)
  const pair = progressPair(stats?.searchPoints)
  const fresh = statsAreCurrent(stats)
  const delta = earnedToday(history, localDayKey())

  // The Stamp-bonus star count ("3/12") and this month's own points, summed
  // from the history (the exact "earned last month: 30 of 2,100" numbers live
  // in the card's expanded flyout, which no capture holds yet — this is the
  // honest approximation until one does).
  const stars = parseStarCount(stats?.stampBonus)
  const monthKey = localDayKey().slice(0, 7)
  const monthEarned = history
    .filter((e) => e.day.startsWith(monthKey))
    .reduce((sum, e) => sum + Math.max(0, e.last - e.first), 0)

  const runText = liveStatus(runState).text

  return (
    <Tile
      id="balance"
      title="Balance"
      seat={seat}
      className={
        [
          seat.w <= 3 ? 'dash-balance--compact' : '',
          seat.w >= 6 ? 'dash-balance--wide' : '',
          seat.h >= 3 ? 'dash-balance--tall' : '',
        ]
          .filter(Boolean)
          .join(' ') || undefined
      }
      action={
        <button
          className="btn btn--primary btn--sm"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true)
            // One burst, both reads — the same pair the popup's Refresh fires.
            sendMessage({ type: 'REFRESH_STATS' }).then(() =>
              sendMessage({ type: 'REFRESH_REDEEM' }).then(() => setRefreshing(false)),
            )
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      }
      {...rest}
    >
      <div className="dash-hero">
        <div className="dash-hero-left">
          <div className="dash-hero-tags">
            <span className="dash-tile-label">Available points</span>
            {stats?.membership && (
              <span
                className={`dash-medal dash-medal--${membershipTone(stats.membership)}`}
                title="Your Microsoft Rewards membership tier"
              >
                ◆ {stats.membership}
              </span>
            )}
          </div>
          <span className={`dash-hero-value${balanceText.length > 9 ? ' dash-hero-value--long' : ''}`}>
            {balanceText}
          </span>
          {delta != null && (
            <span className={`delta${delta > 0 ? ' delta--up' : delta < 0 ? ' delta--down' : ''}`}>{signed(delta)} today</span>
          )}
        </div>
        <PointsRing done={pair ? pair[0] : null} total={pair ? pair[1] : null} label="search points" animate={animate} />
      </div>
      <div className="dash-status">
        <span>{fresh ? 'Updated today' : 'Refresh to update'}</span>
        <span>{runText}</span>
      </div>
      <div className="dash-tiles">
        <StatTile label="Ready to claim" value={displayPoints(stats?.readyToClaim, '—')} />
        <StatTile label="Daily streak" value={stats?.dailyStreak || '—'} />
        <button
          className={`dash-tile dash-tile--press${starOpen ? ' dash-tile--open' : ''}`}
          type="button"
          aria-expanded={starOpen}
          aria-controls="balance-stamp-detail"
          onClick={() => setStarOpen((v) => !v)}
        >
          <span className="dash-tile-label">Stamp bonus</span>
          <span className="dash-tile-value">{stats?.stampBonus || '—'}</span>
          <span className="dash-tile-sub">{starOpen ? 'Hide details' : stars ? 'Show stars' : 'Show details'}</span>
        </button>
        <StatTile
          label="Coupons"
          value={coupons ? String(coupons.available) : '—'}
          sub={coupons ? timeAgo(coupons.at) : undefined}
        />
      </div>
      {starOpen && (
        <div className="star-detail" id="balance-stamp-detail">
          {stars ? (
            <>
              <div className="star-grid" aria-label={`${stars.lit} of ${stars.total} stamps lit`}>
                {Array.from({ length: stars.total }, (_, i) => (
                  <span key={i} className={`star${i < stars.lit ? ' star--lit' : ''}`}>
                    ★
                  </span>
                ))}
              </div>
              <p className="dash-muted">
                {stars.lit} of {stars.total} stamps lit · ~{formatNumber(monthEarned)} pts earned this month (summed from
                the daily history)
              </p>
            </>
          ) : (
            <p className="dash-muted">
              No star count in the last read — the card answered “{stats?.stampBonus || '—'}”. Refresh to read the
              redesigned stamp-bonus card.
            </p>
          )}
        </div>
      )}
    </Tile>
  )
}
