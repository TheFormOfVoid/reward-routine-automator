import { useState } from 'react'
import { ActionButton } from './ActionButton.tsx'
import { useLastCoupons } from '../hooks/useRedeem.ts'
import type { Message, MessageResponse } from '../../shared/messages.ts'
import type { CouponActionRow } from '../../shared/storage.ts'
import { KEYS } from '../../shared/storage.ts'
import { useStorageValue } from '../hooks/useStorageValue.ts'
import { useRunState } from '../hooks/useRunState.ts'

// The experimental "apply every coupon" button (Settings → Experimental
// features): the background opens the Rewards dashboard in the foreground and
// checks the actual coupon panel. A cached zero never prevents a fresh check.
// Shared by the popup's Run view and the dashboard's controls tile.
export function CouponsButton({ send }: { send: (message: Message) => Promise<MessageResponse> }) {
  const coupons = useLastCoupons()
  const [applying, setApplying] = useState(false)
  const action = useStorageValue<CouponActionRow | null>('local', KEYS.lastCouponAction, null).value
  const runState = useRunState()
  const running = applying || runState.activity?.label === 'Coupons'
  const interrupted = action?.status === 'checking' && !running
  const suffix = action?.status === 'applied' ? ` · ${action.claimed} applied` : action?.status === 'none' ? ' · none to apply' : action?.status === 'failed' || action?.status === 'unverified' ? ' · check needed' : coupons && coupons.available > 0 ? ` (${coupons.available})` : ''
  return (
    <ActionButton
      className={coupons && coupons.available > 0 ? 'btn--good' : undefined}
      disabled={running}
      title={interrupted ? 'The last coupon check was interrupted. Check again.' : action?.detail || 'Check the Rewards coupon panel and apply available coupons (experimental).'}
      onClick={() => {
        setApplying(true)
        void send({ type: 'CLAIM_COUPONS' }).finally(() => setApplying(false))
      }}
    >
      {running ? 'Checking coupons…' : `Coupons${suffix}`}
    </ActionButton>
  )
}
