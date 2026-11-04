// The Today's streaks tile (6.8.0 rewrite): the four My-Rewards streak
// cards. Owns its stats hook.
//
// Designed steps → variants (2026-09-11 rework): the cards FILL the seat at
// every step (user: "I want them to take the whole place, not only to show
// a small square in the top left") — a 1×4 row at the regular steps, a 2×2
// quad at the narrow step, and compact 1×4 strips at the 1-tall steps (the
// "1:4" seat: user, "I should be able to make the section 1:4"). The
// variant comes from the step's own w/h, not its index (the registry's
// steps are a lattice).

import { useStats } from '../../../popup/hooks/useStats.ts'
import { WeeklyStreaks } from '../../../popup/components/WeeklyStreaks.tsx'
import { Tile } from './Tile.tsx'
import type { TileProps } from './Tile.tsx'

export function StreaksTile({ seat, ...rest }: TileProps) {
  const stats = useStats()
  return (
    <Tile id="streaks" title="Today's streaks" seat={seat} {...rest}>
      <WeeklyStreaks stats={stats} compact={seat.h === 1} />
    </Tile>
  )
}
