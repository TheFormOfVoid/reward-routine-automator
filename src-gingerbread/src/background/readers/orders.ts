// The Orders sync: reads the user's redeem order history off
// rewards.bing.com/redeem/orderhistory into lastOrders — the whole list, plus
// the detail dialog (redemption code, expiration, status) for the most recent
// few, opened and closed one at a time by the page's own "View detail"
// buttons. On demand from the dashboard's Orders panel; a convenience read,
// never a step that can fail a sequence.
//
// Built from the live captures of 2026-09-09 (.claude/html-references/
// Orders.html and Orderdetail.html — real account data, never to be
// committed). The reader
// follows the redeem watch's shape: READ_RUN_GUARDS against a double-up, a
// keep-alive hold (one page load plus every unsaved order's dialog round
// trip), stop checkpoints between the dialogs, an own-tab close tail
// that ALWAYS cleans up, and the dump contract (ADR-010) through
// lastOrdersLog when the page surprises the injections.

import { beginActivity, endActivity, currentStopEpoch } from '../core/run-state.ts'
import { sleep } from '../core/delays.ts'
import { closeTabs, waitForTabComplete } from '../core/tabs.ts'
import { createNormalTab } from '../core/normal-tabs.ts'
import { withDeadline } from '../pure/search-recovery.ts'
import { holdKeepAlive, releaseKeepAlive } from '../core/keepalive.ts'
import { setLastOrdersLog } from '../core/log.ts'
import { KEYS, setLocal, getLocal } from '../../shared/storage.ts'
import type { OrderRow, OrdersDoc } from '../../shared/storage.ts'
import { readOrderRows, readOrderDetail } from '../injections/orders-read.ts'
import { READ_RUN_GUARDS } from './stats.ts'

// The page the sync reads (user-confirmed address, 2026-09-09).
const ORDER_HISTORY_URL = 'https://rewards.bing.com/redeem/orderhistory'
// The list renders after "complete", so the row reader polls past it — same
// hydration budget as the redeem watch, plus headroom: this page carries the
// whole history (15 rows in the capture), heavier than the redeem search.
const ORDERS_HYDRATION_MS = 20000
// One detail dialog's whole budget (press → the slow open → the code
// streaming in → close). The list's 20s was never enough live (user
// report, 2026-09-10: "you are still not giving it enough time") — the
// dialog can take its time mounting AND its details load after it, so the
// read gets a minute before it calls the row unanswered.
const DETAIL_DIALOG_MS = 60000

function executeOrdersScript<Args extends unknown[], Result>(
  injection: chrome.scripting.ScriptInjection<Args, Result>,
) {
  return withDeadline(chrome.scripting.executeScript(injection), DETAIL_DIALOG_MS + 5000, 'Orders reader')
}
// The list itself holds every order (15 in the capture); the detail dialogs
// are the slow part (one open-expand-read-close round trip each). Only NEW
// orders get a dialog read (user spec, 2026-09-10: "if the item is already
// there, you do not need to sync it again. Only sync for new items") — a
// row already stored with its code keeps it untouched; a row stored WITHOUT
// one (its dialog never answered) stays a candidate, so a re-sync retries
// what failed. Whatever the page shows is what we keep.
const DETAIL_ROWS = Number.POSITIVE_INFINITY
// Old builds stored a dedicated reader window's ID. Forget it without closing
// a window: it may now contain the user's tabs or its numeric ID may be reused.
const ORDERS_WINDOW_KEY = 'ordersSyncWinId'

export async function closeOrphanedOrdersWindow(): Promise<void> {
  if (READ_RUN_GUARDS.orders) return
  await chrome.storage.local.remove(ORDERS_WINDOW_KEY)
}

// Where the tab ACTUALLY settled — on an origin the extension can inject
// into. The subtlety this waits out (reproduced live by
// scripts/diag-orders-pipeline.js, 2026-09-09): rewards.bing.com routes the
// first visit through login.live.com's oauth — even signed in, the session
// turns the hop into a fast bounce, but the tab's URL does touch
// login.live.com mid-flight. The old check grabbed the FIRST committed URL
// and failed the whole sync on the hop. Now the wait only ends on a
// Rewards/Bing origin; a live session resolves the bounce on its own, and
// only a URL that never arrives within the budget is a real failure (named
// in the log — a sign-in wall or a redirect parks it somewhere else).
async function settledUrl(tabId: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let url = ''
    try {
      url = String((await chrome.tabs.get(tabId)).url || '')
    } catch {
      return '' // the tab is gone
    }
    if (url.startsWith('https://rewards.bing.com/') || url.startsWith('https://www.bing.com/')) return url
    if (Date.now() >= deadline) return url
    await sleep(300)
  }
}

// A snapshot of where the tab is RIGHT NOW — for naming the scene of an
// injection failure after the fact (the auth hop included, which is exactly
// what usually killed it).
async function landedUrl(tabId: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const tab = await chrome.tabs.get(tabId)
      const url = String(tab.url || '')
      if (url && url !== 'about:blank' && !url.startsWith('chrome://')) return url
    } catch {
      return '' // the tab is gone
    }
    if (Date.now() >= deadline) {
      try {
        return String((await chrome.tabs.get(tabId)).url || '')
      } catch {
        return ''
      }
    }
    await sleep(300)
  }
}

// The row reader's answer: the page's own count, the parsed rows, and the
// ADR-010 evidence slice when nothing was found.
type OrderRowsRead = { total?: number; list?: OrderRow[]; dump?: string }

export async function syncOrders(opts: { forceAll?: boolean } = {}): Promise<void> {
  if (READ_RUN_GUARDS.orders) {
    console.log('Orders sync: already running; skipping.')
    return
  }
  // Claim the guard before any await: two quick Sync requests must not both
  // pass an idle check and create parallel readers.
  READ_RUN_GUARDS.orders = true

  // The run outlives the idle window (a page load, a hydration poll and
  // every unsaved order's dialog round trip), so the worker needs holding
  // like a stats read.
  holdKeepAlive()

  const myEpoch = await beginActivity('Order history')
  const stopped = (): Promise<boolean> => currentStopEpoch().then((v) => v !== myEpoch)

  // Only this run's normal tab is eligible for cleanup, never its window.
  let ordersTabId: number | null = null

  try {
    // Retire the old key directly: the public orphan helper correctly refuses
    // to touch bookkeeping while this guard is held.
    await chrome.storage.local.remove(ORDERS_WINDOW_KEY)
    const tab = await createNormalTab(ORDER_HISTORY_URL)
    if (tab.id == null) throw new Error('the order history tab opened without an id')
    ordersTabId = tab.id

    if (await stopped()) {
      console.log('Orders sync: stopped while opening the page.')
      return
    }

    const loaded = await waitForTabComplete(tab.id!, 15000)
    if (!loaded) console.warn('Orders sync: the page did not finish loading in time.')

    if (await stopped()) {
      console.log('Orders sync: stopped before the list could be read.')
      return
    }

    // Where the tab settled, named in every failure below (ADR-010's "state
    // the evidence" made literal — a redirect is the one failure a dump of
    // body text cannot show when the body never rendered). The 15s budget
    // rides out the login.live.com oauth bounce (above); only a URL that
    // never makes it back to Rewards fails here.
    const url = await settledUrl(tab.id!, 15000)
    if (!url.startsWith('https://rewards.bing.com/') && !url.startsWith('https://www.bing.com/')) {
      await setLastOrdersLog(`The order history page went to ${url || 'nowhere'}.`, false, url)
      return
    }

    // Phase 1 — the list. The injection resolves { total, list, dump }; an
    // empty list is more likely a page problem than an empty account, so the
    // last good read is kept (same reasoning as the redeem watch's options).
    // One attempt of the list read. Never caught here — a throw means the
    // extension could not inject at all, which the caller reports with the
    // landed URL.
    const readRowsOnce = async (): Promise<OrderRowsRead | null> => {
      const [listInjection] = await executeOrdersScript({
        target: { tabId: tab.id! },
        func: readOrderRows,
        args: [ORDERS_HYDRATION_MS],
      })
      return ((listInjection && listInjection.result) || null) as OrderRowsRead | null
    }

    let read: OrderRowsRead | null = null
    try {
      read = await readRowsOnce()
      // The retry (6.6.4). The prime suspect for the long-standing no-rows
      // failure (user report, 2026-09-09: the read said "no rows" while the
      // LEFT-OPEN tab showed all 15 orders): the Rewards frontend navigates
      // again AFTER its first URL commits — the injected poll dies with its
      // document, executeScript resolves null, and the tab then settles on
      // the real order history the dead reader never saw. So an empty or
      // missing answer gets exactly one more attempt, on whatever page the
      // tab has settled on by then.
      if (!(read && read.list && read.list.length) && !(await stopped())) {
        console.log('Orders sync: the first list read came back empty — retrying once on the settled page.')
        await waitForTabComplete(tab.id!, 15000)
        if (!(await stopped())) {
          read = await readRowsOnce()
        }
      }
    } catch (e) {
      // The classic cause is the URL above having moved somewhere the
      // extension cannot inject into — name both halves.
      const nowAt = await landedUrl(tab.id!, 1000)
      await setLastOrdersLog(
        `The order history read failed on ${nowAt || url}: ${e instanceof Error ? e.message : String(e)}.`,
        false,
        `${nowAt || url}\n${e instanceof Error ? e.message : String(e)}`,
      )
      return
    }
    const rows = (read && read.list) || []

    if (!rows.length) {
      console.warn('Orders sync: no rows found after two reads; keeping the last read.')
      await setLastOrdersLog(
        'The order history showed no rows (read twice, ~40s) — kept the last read.',
        false,
        (read && read.dump) || '',
      )
      return
    }

    // Phase 2 — the detail dialogs, newest first (the page lists them that
    // way): one open-expand-read-close round trip per row, a stop checkpoint
    // before each. A dialog that never answered leaves that row's detail
    // null — "not read", never a failure of the whole sync.
    // A settle first: the list read resolves the moment the buttons exist,
    // while hydration may still be swapping the page's nodes — exactly the
    // window in which the FIRST row's press got lost (user report,
    // 2026-09-09). The injection also re-presses on its own; this just
    // narrows the race before it starts.
    await sleep(1200)
    // The previous doc's rows, keyed by order number. Read BEFORE the
    // detail phase: an order that is already stored with its code is NOT
    // re-read (user spec, 2026-09-10: "if the item is already there, you
    // do not need to sync it again. Only sync for new items") — only the
    // list refreshes for it. A row stored WITHOUT a code (its dialog never
    // answered) stays a candidate, so a re-sync retries what failed.
    // The key is CANONICAL: syncs before 6.7.5 stored order numbers with
    // the page's glued "View detail" button label on the end, so their rows
    // would never match a clean number and their codes would be orphaned
    // (the second half of the 2026-09-10 reports).
    const canonicalOrderNo = (v: string) => v.replace(/\s*view details?\s*$/i, '').trim()
    const prevRows = new Map<string, OrderRow>()
    const prevDoc = await getLocal<OrdersDoc | null>(KEYS.lastOrders)
    if (prevDoc && Array.isArray(prevDoc.orders)) {
      for (const r of prevDoc.orders) if (r.orderNo) prevRows.set(canonicalOrderNo(r.orderNo), r)
    }
    let details = 0
    let kept = 0
    // Evidence for a detail phase that answered nothing (user report,
    // 2026-09-10: "you are not getting the data from view details"): a
    // dialog that OPENED but read nothing keeps its text as the dump; a
    // dialog that never appeared counts as unanswered. The activity line
    // names which happened, and the dump carries the dialog's own text so
    // the next failure is diagnosable from the log alone.
    let firstEmptyDump = ''
    let unanswered = 0
    for (let i = 0; i < Math.min(DETAIL_ROWS, rows.length); i++) {
      if (await stopped()) {
        console.log('Orders sync: stopped mid-details; saving what was read.')
        break
      }
      const orderNo = rows[i].orderNo
      // The incremental skip (6.7.7) — unless the panel's Rescan-all button
      // forced a full pass (forceAll): then every dialog is re-read even for
      // orders already stored with their codes, so a page that changed its
      // codes, or an old parse that stored something wrong, gets corrected
      // from the live page (user request, 2026-09-10: "add a button that
      // will rescan them all").
      const prevSaved =
        opts.forceAll || !orderNo ? undefined : prevRows.get(canonicalOrderNo(orderNo))
      if (prevSaved && (prevSaved.code != null || prevSaved.status != null)) {
        kept++
        continue
      }
      try {
        const [detailInjection] = await executeOrdersScript({
          target: { tabId: tab.id! },
          func: readOrderDetail,
          args: [i, DETAIL_DIALOG_MS],
        })
        const detail = (detailInjection && detailInjection.result) as
          | { code?: string | null; expires?: string | null; status?: string | null; dump?: string; reason?: string }
          | null
        if (detail && (detail.code != null || detail.status != null)) {
          rows[i] = { ...rows[i], code: detail.code ?? null, expires: detail.expires ?? null, status: detail.status ?? null }
          details++
        } else if (detail && detail.dump) {
          if (!firstEmptyDump) firstEmptyDump = detail.dump
        } else if (detail && detail.reason) {
          unanswered++
        }
        // The close click resolves before react-aria unmounts the dialog;
        // the settle keeps the next injection from seeing the old overlay.
        await sleep(800)
      } catch (e) {
        console.warn(`Orders sync: the detail read for row ${i} failed early:`, e)
      }
    }

    // The merge: whatever the NEW dialog answers wins; a row whose dialog
    // answered nothing keeps the old code, status and expiry (a re-read
    // must never WIPE a code an earlier sync already read — user report,
    // 2026-09-09: "why did you remove the code from the order items?").
    const merged = rows.map((row) => {
      const prev = row.orderNo ? prevRows.get(canonicalOrderNo(row.orderNo)) : undefined
      return {
        ...row,
        code: row.code ?? prev?.code ?? null,
        expires: row.expires ?? prev?.expires ?? null,
        status: row.status ?? prev?.status ?? null,
      }
    })

    await setLocal(KEYS.lastOrders, {
      at: Date.now(),
      total: (read && read.total) || rows.length,
      orders: merged,
    } satisfies OrdersDoc)
    console.log(
      `Orders sync: read ${rows.length} order(s), details for ${details}, ${kept} already saved.`,
    )
    const noDetailsNote =
      details === 0 && kept === 0
        ? unanswered > 0 && !firstEmptyDump
          ? ` — no dialog ever opened (${unanswered} unanswered)`
          : firstEmptyDump
            ? ' — the dialogs opened but read nothing'
            : ''
        : ''
    const keptNote = kept > 0 ? `, ${kept} already saved` : ''
    await setLastOrdersLog(
      `${opts.forceAll ? 'Full rescan: ' : ''}Read ${rows.length} order(s) — details for ${details}${keptNote}${noDetailsNote}.`,
      true,
      firstEmptyDump || undefined,
    )
  } catch (e) {
    console.warn('Orders sync: failed:', e)
    await setLastOrdersLog(
      `The order history read failed: ${e instanceof Error ? e.message : String(e)}.`,
      false,
      e instanceof Error ? e.message : String(e),
    )
  } finally {
    // Close only the tab we opened. A user-added sibling tab is unrelated and
    // must survive success, failure, cancellation, and legacy-window cleanup.
    if (ordersTabId != null) {
      await closeTabs([ordersTabId], false).catch((e) => console.warn('Orders sync: could not close its tab:', e))
    }
    await chrome.storage.local.remove(ORDERS_WINDOW_KEY)
    await endActivity('Order history')
    READ_RUN_GUARDS.orders = false
    releaseKeepAlive()
  }
}
