// Reads which Overwatch-coins digital codes the Rewards catalog currently
// offers into lastRedeem: opens /redeem, drives the page's own search box
// with REDEEM_QUERY, then reads the matching catalog cards' title, price and
// stock state. On demand from Refresh or the optional restock watcher, kept
// separate from the daily routine's critical path. Ported from src-donut's readers/redeem.js
// (2026-09-08) — the three phases, guards, stop checkpoints, and own-tab
// close tail carry over; the ONE addition is the redeemHistory series the
// full-screen dashboard charts (one entry per variant per read).
//
// Availability is a heuristic: the unauthenticated page carries no stock
// markup at all (a card is a plain anchor), so the reader marks a card sold
// out only on explicit disabled/out-of-stock markers — and then the RSC
// payload's isDisabled overrides when it knows the sku. Never throws — same
// reasoning as refreshStats(): a convenience read, not a step that can fail
// the sequence.
//
// The injection is three-phase because the search and the tile-click are both
// navigations, which would kill an in-page wait: phase 1 searches and resolves
// as soon as the query is submitted, the load wait between the phases absorbs
// the navigation, and phase 2 reads whatever the tab ended up showing. Phase 3
// then navigates the same tab to the first matching card's sku page and reads
// the variant select there (readRedeemVariants), storing the list as
// `variants` alongside the catalog `options` in lastRedeem. Both halves keep
// their last good read when the new one comes back empty.
//
// Tab handling: the run closes only the tab it opened itself, and refuses to
// start while another redeem read is in flight (READ_RUN_GUARDS). Nothing is
// being earned, so there is nothing to give a grace period to, and a stopped
// run leaves the tab open — stopping is not finishing.

import { beginActivity, endActivity, currentStopEpoch } from '../core/run-state.ts'
import { localDayKey } from '../core/day.ts'
import { sleep } from '../core/delays.ts'
import { closeTabs, waitForTabComplete } from '../core/tabs.ts'
import { holdKeepAlive, releaseKeepAlive } from '../core/keepalive.ts'
import { setLastRedeemLog, setLastTabAction } from '../core/log.ts'
import { getSettings } from '../../shared/settings.ts'
import { KEYS, getLocal, setLocal, removeLocal } from '../../shared/storage.ts'
import type { RedeemHistoryEntry, RedeemOption, RedeemRead, RedeemVariant, StockNews } from '../../shared/storage.ts'
import { diffStock, redeemRefusalDetail } from '../pure/redeem-news.ts'
import {
  searchRedeemFor,
  readRedeemOptions,
  readRedeemVariants,
  redeemOnDetailPage,
} from '../injections/redeem-read.ts'
import { READ_RUN_GUARDS } from './stats.ts'
import { withDeadline } from '../pure/search-recovery.ts'
import { createNormalTab } from '../core/normal-tabs.ts'

// The catalog page the Overwatch-coins watch reads. The page's own search box
// narrows it down to the digital-code cards; without one, the whole catalog is
// scanned for matching titles instead.
const REDEEM_URL = 'https://rewards.bing.com/redeem'
// What the watch searches for. Phrased product-first on purpose:
// readRedeemOptions matches cards on the query's first word, which has to
// survive translation verbatim ("Overwatch" does; "digital code" would
// false-positive on every gift card in the catalog).
const REDEEM_QUERY = 'overwatch coins digital code'
// How long each injected half of the redeem watch waits: the search box and
// the result cards both render after "complete", and a search-triggered
// navigation adds a full page load on top of the hydration wait.
const REDEEM_HYDRATION_MS = 12000
// The redeemHistory cap: one entry per variant per read, trimmed oldest-first
// so the series (and storage) stays bounded. 500 entries is ~a year of
// daily-ish reads across the three denominations.
const REDEEM_HISTORY_CAP = 500

let redeemInFlight: Promise<void> | null = null
export function checkRedeemAvailability(): Promise<void> {
  if (redeemInFlight) return redeemInFlight
  const reading = collectRedeemAvailability()
  redeemInFlight = reading.finally(() => { if (redeemInFlight === pending) redeemInFlight = null })
  const pending = redeemInFlight
  return pending
}

async function collectRedeemAvailability(): Promise<void> {
  READ_RUN_GUARDS.redeem = true

  // The run outlives the idle window (three page loads, three hydration
  // waits — ~45s), so the worker needs holding like a stats read.
  holdKeepAlive()

  // Marks this run as the current activity so the popup's Stop button covers
  // it too; the returned epoch tells this run when it has been stopped.
  const deadline = Date.now() + 100000
  let myEpoch: number | null = null
  const available = (maximum: number): number => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Catalog read deadline exceeded')
    return Math.min(maximum, remaining)
  }
  const bounded = <T>(work: Promise<T>, maximum: number, label: string): Promise<T> =>
    withDeadline(work, available(maximum), label)
  const stopped = (): Promise<boolean> => myEpoch == null ? Promise.resolve(false)
    : withDeadline(currentStopEpoch(), 2000, 'Catalog Stop check').then(v => v !== myEpoch)
  const unavailable = async (): Promise<boolean> => Date.now() >= deadline || await stopped() || Date.now() >= deadline
  const live = async (): Promise<void> => { if (await unavailable()) throw new Error('Catalog read stopped or expired') }
  const readValue = <T>(key: string): Promise<T | undefined> => bounded(getLocal<T>(key), 5000, 'Catalog storage read')
  const writeValue = async (key: string, value: unknown): Promise<void> => {
    await live(); await bounded(setLocal(key, value), 5000, 'Catalog storage write')
  }
  const removeValue = async (key: string): Promise<void> => {
    await live(); await bounded(removeLocal(key), 5000, 'Catalog storage removal')
  }
  const report = async (detail: string, ok: boolean | null, dump?: string): Promise<void> => {
    await live(); await bounded(setLastRedeemLog(detail, ok, dump), 3000, 'Catalog log')
  }
  const executeCatalogScript = async <Args extends unknown[], Result>(injection: chrome.scripting.ScriptInjection<Args, Result>) => {
    await live()
    const reply = await bounded(chrome.scripting.executeScript(injection), REDEEM_HYDRATION_MS + 5000, 'Catalog page reader')
    await live()
    return reply
  }
  const loadPage = (tabId: number, maximum = 15000): Promise<boolean> =>
    bounded(waitForTabComplete(tabId, available(maximum)), maximum, 'Catalog page load')
  const settle = (ms: number): Promise<void> => bounded(sleep(Math.min(ms, available(ms))), ms, 'Catalog navigation settle')
  const navigateTab = async (tabId: number, properties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined> => {
    await live(); return bounded(chrome.tabs.update(tabId, properties), 10000, 'Catalog navigation')
  }

  // The only tab this run owns (closed in the finally). Kept in a variable
  // the finally can see even if the create throws.
  let redeemTabId: number | null = null

  try {
    myEpoch = await bounded(beginActivity('Redeem watch'), 5000, 'Catalog start')
    // Select a normal tab for hydration without requesting OS-window focus.
    const redeemTab = await bounded(createNormalTab(REDEEM_URL), 10000, 'Catalog tab opening')
    redeemTabId = redeemTab.id ?? null

    // A stop that landed while the tab was opening. Stopping is not finishing:
    // the tab stays open and the injections never run.
    if (await unavailable()) {
      console.log('Redeem watch: stopped while opening the redeem tab.')
      return
    }

    const loaded = await loadPage(redeemTab.id!, 15000)
    if (!loaded) console.warn('Redeem watch: page did not finish loading in time.')

    // Stop checkpoint after the load wait: the injections are the part a stop
    // is meant to prevent.
    if (await unavailable()) {
      console.log('Redeem watch: stopped before the search could run.')
      return
    }

    // Phase 1 — search. Resolves false when the page shows no search box,
    // which is fine: the reader then scans the catalog page as-is. A rejection
    // means the page navigated mid-script (the search trigger does a full
    // navigation), which the load wait below absorbs the same way.
    try {
      const [injection] = await executeCatalogScript({
        target: { tabId: redeemTab.id! },
        func: searchRedeemFor,
        args: [REDEEM_QUERY, REDEEM_HYDRATION_MS],
      })
      if (!(injection && injection.result === true)) {
        console.log('Redeem watch: no search box on the page; reading the catalog as-is.')
      }
    } catch (e) {
      console.warn('Redeem search injection ended early:', e)
    }

    if (await unavailable()) {
      console.log('Redeem watch: stopped before the reader could run.')
      return
    }

    // Let a search-triggered navigation start before waiting it out; a
    // same-document re-render just costs this settle.
    await settle(1500)
    const resultsLoaded = await loadPage(redeemTab.id!, 15000)
    if (!resultsLoaded) {
      console.warn('Redeem watch: results page did not finish loading in time.')
    }

    // Stop checkpoint after the results load: the reader is the part a stop is
    // meant to prevent.
    if (await unavailable()) {
      console.log('Redeem watch: stopped before the reader could run.')
      return
    }

    // Phase 2 — read. The result outlives its try block: phase 3 needs it to
    // know which card to visit. The reader resolves { list, dump } — the dump
    // is the ADR-010 markup slice it stared at when the list came back empty.
    let options: RedeemOption[] | null = null
    let optionsDump = ''
    try {
      const [injection] = await executeCatalogScript({
        target: { tabId: redeemTab.id! },
        func: readRedeemOptions,
        args: [REDEEM_QUERY, REDEEM_HYDRATION_MS],
      })
      const read = (injection && injection.result) as { list?: RedeemOption[]; dump?: string } | null
      options = (read && read.list) || null
      optionsDump = (read && read.dump) || ''

      // An empty list means the page never showed a matching card — more
      // likely a page problem than a delisted catalog, so keep the last good
      // read rather than storing a fresh nothing (same reasoning as the
      // all-null stats case in refreshStats). The variants and detail-page
      // URL from the previous read ride along for the same reason: phase 3
      // replaces them only when it actually reads a new list.
      if (Array.isArray(options) && options.length) {
        const prev = (await readValue<RedeemRead>(KEYS.lastRedeem)) || { variants: [], variantUrl: '' }
        await writeValue(KEYS.lastRedeem, {
          at: Date.now(),
          query: REDEEM_QUERY,
          options,
          variants: Array.isArray(prev.variants) ? prev.variants : [],
          variantUrl: typeof prev.variantUrl === 'string' ? prev.variantUrl : '',
        })
        console.log(`Redeem watch: read ${options.length} option(s).`)
      } else {
        console.warn('Redeem watch: no Overwatch cards found; keeping the last read.')
        await report('No Overwatch cards in the catalog — kept the last read.', false, optionsDump)
      }
    } catch (e) {
      console.warn('Redeem read injection ended early:', e)
      await report(`The catalog read failed early: ${e instanceof Error ? e.message : String(e)}`, false)
    }

    // Phase 3 — the detail page: the tile's destination, where the variant
    // select lives. Navigating the already-captured tab to the card's sku URL
    // is the deterministic equivalent of pressing the tile (a synthesized
    // click could open a new tab or land mid-hydration), and the tab id never
    // changes, so the closeTabs tail below covers the detail visit too.
    // The family's tiles are sibling skus, so WHICH one gets opened matters:
    // prefer the first that actually shows a price and isn't marked sold out
    // — the unpriced carousel duplicate of the same sku would otherwise win
    // by DOM order. The available flag now comes from the RSC payload when
    // it knows the sku (verbatim capture 2026-09-03: …004 at 4,800 pts is
    // SOLD OUT — isDisabled in the payload, restocking note on its detail
    // page — while …005 at 9,800 is in stock), so this preference skips the
    // restocking sku and its payload-less fallback (any priced card) only
    // kicks in when nothing better is known.
    const target =
      (Array.isArray(options) &&
        options.find(
          (opt) => opt && typeof opt.href === 'string' && opt.href && opt.points && opt.available !== false,
        )) ||
      (Array.isArray(options) &&
        options.find((opt) => opt && typeof opt.href === 'string' && opt.href))
    if (target) {
      try {
        const detailUrl = new URL(target.href!, REDEEM_URL).toString()
        await navigateTab(redeemTab.id!, { url: detailUrl })

        if (await unavailable()) {
          console.log('Redeem watch: stopped before the detail page could be read.')
          return
        }

        // Same settle-then-wait as between the search and the catalog read:
        // tabs.update resolves before the navigation starts, so an immediate
        // waitForTabComplete could see the OLD page still "complete".
        await settle(1500)
        const detailLoaded = await loadPage(redeemTab.id!, 15000)
        if (!detailLoaded) {
          console.warn('Redeem watch: detail page did not finish loading in time.')
        }

        if (await unavailable()) {
          console.log('Redeem watch: stopped before the variants reader could run.')
          return
        }

        const [injection] = await executeCatalogScript({
          target: { tabId: redeemTab.id! },
          func: readRedeemVariants,
          args: [REDEEM_HYDRATION_MS],
        })
        const read = (injection && injection.result) as { list?: RedeemVariant[]; dump?: string } | null
        const variants = (read && read.list) || null

        // Same last-good rule as the options above: an empty variant list is
        // more likely a markup surprise than a product with no variants, so
        // it keeps the previous read (and the dump tells us why).
        if (Array.isArray(variants) && variants.length) {
          const record = await readValue<RedeemRead>(KEYS.lastRedeem)
          if (record) {
            // Stock-change news: the pure diff in pure/redeem-news.ts (extracted
            // from src-donut's inline logic so it is unit-tested).
            const diff = diffStock(
              record.variants || [],
              variants,
              (await readValue(KEYS.redeemRestockNews)) || null,
              (await readValue(KEYS.redeemSoldOutNews)) || null,
            )
            if (diff.restockNews) {
              await writeValue(KEYS.redeemRestockNews, diff.restockNews)
            } else {
              await removeValue(KEYS.redeemRestockNews)
            }
            if (diff.soldOutNews) {
              await writeValue(KEYS.redeemSoldOutNews, diff.soldOutNews)
            } else {
              await removeValue(KEYS.redeemSoldOutNews)
            }
            if (diff.restocked.length) {
              console.log(`Redeem watch: restocked — ${diff.restocked.join(', ')}.`)
            }
            if (diff.soldOut.length) {
              console.log(`Redeem watch: sold out — ${diff.soldOut.join(', ')}.`)
            }

            // The dashboard's series: one entry per variant per read (the one
            // capability src-donut never had). Appended then trimmed oldest-first.
            await live(); await bounded(appendRedeemHistory(variants, live), 5000, 'Catalog history write')

            await writeValue(KEYS.lastRedeem, { ...record, variants, variantUrl: detailUrl })
            console.log(`Redeem watch: read ${variants.length} variant(s) on the detail page.`)
            await report(
              `Read ${options?.length ?? 0} option(s) and ${variants.length} amount(s).`,
              true,
            )
          }
        } else {
          console.warn('Redeem watch: no variants found on the detail page; keeping the last read.')
          await report(
            'The product page showed no coin amounts — kept the last read.',
            false,
            (read && read.dump) || '',
          )
        }
      } catch (e) {
        console.warn('Redeem variants injection ended early:', e)
        await report(`The amounts read failed early: ${e instanceof Error ? e.message : String(e)}`, false)
      }
    }
  } catch (error) {
    console.warn('Redeem watch: read stopped or failed:', error)
  } finally {
    // Closes only the tab THIS run opened. A stopped run still leaves its
    // tab open: stopping is not finishing.
    try {
      if (redeemTabId != null && !(await stopped())) {
        const settings = await withDeadline(getSettings(), 2000, 'Catalog cleanup settings')
        const closed = await withDeadline(closeTabs([redeemTabId], settings.keepPinnedTabs, myEpoch ?? undefined), 5000, 'Catalog tab cleanup')
        if (closed) console.log('Closed the tab opened by "redeem".')
      }
    } catch (error) { console.warn('Catalog cleanup failed:', error) }
    finally {
      await withDeadline(endActivity('Redeem watch'), 2000, 'Catalog activity cleanup').catch(console.warn)
      READ_RUN_GUARDS.redeem = false
      releaseKeepAlive()
    }
  }
}

// Appends this read's per-variant availability to the redeemHistory series
// and trims it to the cap. The day key collapses same-day re-reads for the
// dashboard's grouping without dropping the finer timestamps (`at`).
async function appendRedeemHistory(variants: RedeemVariant[], beforeWrite?: () => Promise<void>): Promise<void> {
  const now = Date.now()
  const day = localDayKey()
  const entries: RedeemHistoryEntry[] = variants.map((variant) => ({
    at: now,
    day,
    label: variant.label,
    available: variant.available !== false,
  }))

  const history = (await getLocal<RedeemHistoryEntry[]>(KEYS.redeemHistory)) || []
  const next = [...history, ...entries].slice(-REDEEM_HISTORY_CAP)
  await beforeWrite?.()
  await setLocal(KEYS.redeemHistory, next)
}

// The popup's Redeem button: opens the chosen amount's sku page in the
// FOREGROUND and, once it settles, presses the page's own Redeem Now — but
// ONLY when the page enables the button. A disabled Redeem Now (the balance
// can't cover it, or the amount is sold out) resolves without a press; the
// page stays open for the user and the outcome lands in the Activity view
// (the user has no console to read — same reasoning as the watch readers).
// Each denomination of the family is its own sku (…004 = 500 coins, …005 =
// 1000 coins in the capture), so the variant's payload href lands the page
// with that amount already selected; without a payload the fallback is the
// detail page the watch last read (lastRedeem.variantUrl) and the picker
// does the selecting there.
//
// Deliberately no activity epoch and no tab capture: there is nothing to
// stop mid-run that matters — a stray press can't happen because the picker
// refuses disabled buttons — and the tab is the user's from the moment it
// appears, never closed by us in any outcome.
export async function redeemOverwatchCoins(url: string, label: string): Promise<void> {
  if (typeof url !== 'string' || !url || !String(label || '').trim()) {
    console.warn('Redeem: no page to open — run the stats read first.')
    await setLastRedeemLog('The redeem press did not run — no page was read yet.', false)
    return
  }

  // Prefer the chosen variant's own sku href from the last read: opening the
  // family page would show whatever amount the watch happened to read on.
  let target = url
  try {
    const record = await getLocal<RedeemRead>(KEYS.lastRedeem)
    const variants = (record && record.variants) || []
    const match = variants.find(
      (v: RedeemVariant) => v && typeof v.label === 'string' && v.label.toLowerCase() === String(label).toLowerCase(),
    )
    if (match && typeof match.href === 'string' && match.href) {
      target = new URL(match.href, REDEEM_URL).toString()
    }
  } catch {
    // A storage miss only means the fallback page opens; never fatal.
  }

  // active: true on purpose — the opposite reasoning of the watch's read
  // tab. This is a user action on their own points, and whatever the page
  // shows next (the Redeem press, a confirmation, the code) is theirs.
  const tab = await chrome.tabs.create({ url: target, pinned: false, active: true })
  console.log(`Redeem: opened ${target} for "${label}".`)

  try {
    const loaded = await waitForTabComplete(tab.id!, 15000)
    if (!loaded) console.warn('Redeem: the page did not finish loading in time.')

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: redeemOnDetailPage,
      args: [label, REDEEM_HYDRATION_MS],
    })
    const result = (injection && injection.result) as { clicked?: boolean; reason?: string } | null

    if (result && result.clicked) {
      console.log(`Redeem: pressed Redeem Now for "${label}".`)
      await setLastRedeemLog(
        `"${label}": Redeem Now was pressed — the page takes it from there.`,
        true,
      )
      return
    }

    // A refusal, never an error: the page is open, the user can see why.
    // The friendly text comes from pure/redeem-news.ts's mapping, matched on
    // the reason's stable parts so a label tweak in the injection doesn't
    // silence this.
    const reason = (result && result.reason) || 'no result from the page'
    console.warn('Redeem: nothing pressed —', reason)
    await setLastRedeemLog(`${redeemRefusalDetail(label, reason)} The page stayed open.`, false)
  } catch (e) {
    console.warn('Redeem: the press failed:', e)
    await setLastRedeemLog(
      `The redeem press failed early: ${e instanceof Error ? e.message : String(e)}. The page stayed open.`,
      false,
    )
  }
}
