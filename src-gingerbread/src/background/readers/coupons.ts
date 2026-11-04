import { beginActivity, endActivity, currentStopEpoch } from '../core/run-state.ts'
import { beginTabCapture, claimTab, endTabCapture, waitForTabComplete } from '../core/tabs.ts'
import { createNormalTab } from '../core/normal-tabs.ts'
import { holdKeepAlive, releaseKeepAlive } from '../core/keepalive.ts'
import { withDeadline } from '../pure/search-recovery.ts'
import { setLastTabAction } from '../core/log.ts'
import { setLocal, KEYS } from '../../shared/storage.ts'
import type { CouponActionRow } from '../../shared/storage.ts'
import { claimDashboardCoupons } from '../injections/coupons.ts'
import { REWARDS_DASHBOARD } from './rewards-section.ts'

interface CouponResult {
  status: 'applied' | 'none' | 'unverified' | 'failed' | 'cancelled'
  reason: string
  claimed: number
  attempted: number
  available: number | null
}

// User-initiated, coupon-only application. The tab stays open for inspection.
// A click is not a receipt: only page-confirmed results change lastCoupons.
export async function claimCoupons(): Promise<void> {
  holdKeepAlive()
  let epoch: number | undefined
  const expiresAt = Date.now() + 70000
  const sameOwner = async () => epoch != null && await withDeadline(currentStopEpoch(), 3000, 'Coupon cancellation read') === epoch
  const live = async () => Date.now() < expiresAt && await sameOwner()
  async function report(status: CouponActionRow['status'], detail: string, claimed = 0, attempted = 0) {
    if (!await live()) return
    await withDeadline(setLocal(KEYS.lastCouponAction, { at: Date.now(), status, detail, claimed, attempted }), 3000, 'Coupon outcome write')
    if (status !== 'checking' && await live()) await withDeadline(setLastTabAction(`Coupons — ${detail}`, status === 'applied' || status === 'none'), 3000, 'Coupon activity write')
  }
  try {
    epoch = await withDeadline(beginActivity('Coupons'), 5000, 'Coupon activity start')
    if (!await live()) return
    await report('checking', 'Checking the current coupon panel')
    await withDeadline(beginTabCapture('coupons'), 5000, 'Coupon tab capture')
    if (!await live()) return
    const tab = await withDeadline(createNormalTab(REWARDS_DASHBOARD, true), 10000, 'Coupon tab opening')
    if (!await live() || tab.id == null) return
    await withDeadline(claimTab('coupons', tab.id), 5000, 'Coupon tab ownership')
    await withDeadline(waitForTabComplete(tab.id, 15000), 17000, 'Coupon page readiness')
    if (!await live()) return
    const pageExpiresAt = Math.min(expiresAt, Date.now() + 45000)
    const [injection] = await withDeadline(chrome.scripting.executeScript({ target: { tabId: tab.id },
      func: claimDashboardCoupons, args: [45000, { stopEpoch: epoch, expiresAt: pageExpiresAt }] }),
      Math.max(1000, pageExpiresAt - Date.now()) + 2000, 'Coupon page action')
    if (!await live()) return
    const result = injection?.result as CouponResult | undefined
    if (!result || !['applied', 'none', 'unverified', 'failed', 'cancelled'].includes(result.status)) {
      await report('unverified', 'The coupon page returned no verified result')
      return
    }
    if ((result.status === 'applied' || result.status === 'none') && Number.isInteger(result.available) && result.available! >= 0) {
      if (!await live()) return
      await withDeadline(setLocal(KEYS.lastCoupons, { at: Date.now(), available: result.available }), 3000, 'Coupon count write')
    }
    await report(result.status === 'cancelled' ? 'unverified' : result.status, result.reason, result.claimed, result.attempted)
  } catch (error) {
    console.warn('Coupon check failed:', error instanceof Error ? error.message : 'Unknown error')
    try { await report('failed', 'Coupon check failed or timed out. The last known count was kept.') } catch { /* Status storage may also be unavailable. */ }
  } finally {
    // Stop invalidates ownership; do not clear a newer owner's state.
    if (await sameOwner().catch(() => false)) {
      try { await withDeadline(endTabCapture('coupons'), 3000, 'Coupon capture cleanup') } catch {}
      if (await sameOwner().catch(() => false)) try { await withDeadline(endActivity('Coupons'), 3000, 'Coupon activity cleanup') } catch {}
    }
    releaseKeepAlive()
  }
}
