import { defineManifest } from '@crxjs/vite-plugin'

// The fifth build's identity (ADR-021). A new name and a cyan tile set it apart
// from the blue bolt (src-cupcake), amber bolt (src-donut), mauve cat
// (src-eclair — Eclair) and rose paw (src-froyo — Froyo) so the toolbar can
// hold all five at once. Same permissions and host list as Froyo — this build
// adds no new capability, only a new UI and a rebuilt engine.
export default defineManifest({
  manifest_version: 3,
  name: 'Reward Routine Automator — Gingerbread',
  // 6.6.7: the Order history moved directly underneath the Activity log
  // (the log is a plain row-1 panel again — no more full-height column), and
  // the orders sync opens its page in the extension's OWN unfocused window
  // instead of navigating the user's tab — the page renders as visible
  // there (the no-rows fix: a background TAB stays hidden and never paints
  // its rows) without stealing focus, and the window is ALWAYS closed when
  // the sync finishes, success or failure.
  // 6.6.6: the orders sync opens its tab in the FOREGROUND (the no-rows
  // failure's surviving suspect: the page defers rendering its rows until
  // the tab is actually looked at, so a background tab never renders them),
  // the dashboard's panels go back to equal heights that fill their row
  // with bodies that stretch inside, the streak cards return to 1×4 (2×2
  // only when the window is thin), the points history becomes a histogram
  // (one bar per day of earned points, honest zero baseline, last day
  // accented), and the run controls + the next-routine plan join the
  // dashboard as panels ported from the popup's Run/Today views.
  // 6.6.5: the user's three-column dashboard layout — Balance, Points
  // history and a full-height Activity log across the top; below them the
  // streaks-over-catalog stack on the left, the Order history in the middle,
  // the Stock news at the bottom. The streak cards go 2×2 in the narrower
  // left column.
  // 6.6.4: the orders read retries once on the settled page (the suspected
  // no-rows cause: the page's own post-commit navigation killed the injected
  // poll while the tab went on to render the real list); the dashboard's
  // panels hug their content (no stretched empty space), the streak cards'
  // width ends at their last day-dot, the progress bars paint a visible
  // recessed track (the old track was the card's own background, so the bar
  // read as one color), the coin cards compact to the streak tiles' scale,
  // the Orders panel stands two grid rows tall with six rows, and the chart's
  // min/max labels sit inside its strip.
  // 6.6.3: the orders sync verifies where its tab landed (naming a redirect
  // in the log) and leaves the tab open on a failed read; the chart plots
  // points EARNED per day at strip size; the coin-card bar note reads in
  // points ("7,000 / 10,000 pts"); unlabeled/sold-out cards get their amount
  // from their variant; the catalog no longer spans the full row, the streak
  // cards compact to one row, the Orders panel sits on the right, and a gear
  // swaps the dashboard for its own settings surface.
  // 6.6.2: the coin-card press actually navigates now (the live reader
  // stores sku hrefs relative — the handler resolves them against the
  // Rewards origin instead of refusing); card titles show the bare amount
  // ("500 coins"); the ring's pair sits inside the circle and the stat tiles
  // center their contents; the chart shrinks to a strip; a failed orders
  // sync spells its evidence dump out in the panel (URL + title + body
  // text) instead of a hover-only tooltip.
  // 6.6.1: dashboard polish (user feedback pass) — compact sizes (hero,
  // chart, streak cards, star drawer), coin-card titles wrap instead of
  // truncating, the availability timeline and the keep-earning tile are gone,
  // and every coin card is a button that opens that amount's redeem page
  // (OPEN_REDEEM_PAGE: navigation only). The Orders Sync button now holds
  // "Syncing…" until the outcome lands and shows it as a line in the panel.
  // 6.6.0: the dashboard's visual rework (membership medal, big streak cards
  // with day-dot tracks, interactive Stamp-bonus star drawer, coin balance-vs-
  // price bars) + the order-history sync (reads rewards.bing.com/redeem/
  // orderhistory into the dashboard, with each recent order's redemption
  // code). 6.5.0: the prowl (random 15–45-minute background mini-batches of
  // 2–5 searches, on by default, toggleable) + the dashboard's full-width
  // rework (no header bar, HTML chart labels). 6.4.0: src-donut parity (redeem
  // watch + redeem button, coupons, stock-news banners, layout editor,
  // drag-reorder settings) + the full-screen dashboard. 6.6.8: the orders
  // sync FIXED (the injection's module-scope helpers died under
  // executeScript's serialization — every read since 6.6.0 returned no rows;
  // now self-contained like stats-read, plus the settledUrl wait that rides
  // out the login.live.com oauth hop) + the dashboard's scroll-capped
  // activity log and the controls/news re-seat. 6.6.9: every order's detail
  // dialog read (the 5-row cap left older records codeless; the first row's
  // press could be lost to a hydration re-render — now settled + re-pressed),
  // the code's Copy button (expiry display dropped), the orders list
  // scrollable with no scrollbar like the log, and the catalog + Stock news
  // back in the left column stuck under the streaks. 6.6.10: the user's
  // stack, verbatim — Today's streaks, the Overwatch catalog and the Stock
  // news as ONE VERTICAL stack in the left column, with the Run controls
  // spanning the stack's rows beside it (next routine row 2 right, Order
  // history rows 3–4) — plus the orders list capped at ~7 rows (scroll
  // inside, no scrollbar), and a re-sync never wipes codes an earlier sync
  // already read (a failed detail dialog keeps the previous code instead of
  // blanking it). 6.7.0: the dashboard's layout belongs to the USER now — an
  // Edit layout button makes every panel draggable (drop one on another to
  // reorder; CSS `order` drives the grid), each gains ↔ (width, 4/6/8/12
  // columns) and ↕ (height, 1–3 grid rows) size buttons, and the whole
  // arrangement persists in dashLayout. Since the user places the panels,
  // they hug their content — no more equal-height stretch.
  // 6.7.1: free placement and no blank strips — the dashboard's panels live
  // in three masonry COLUMNS now, each stacked directly under the one above
  // it (the shared-row grid stretched its rows for tall panels, leaving
  // empty space above the shorter ones), and a drop lands wherever the
  // cursor points: any column, any slot — on a panel, between two, or under
  // the last one (user requests: "there should be no space above a section"
  // and "I can't move the sections freely").
  // 6.7.2: the order rows mirror the PAGE's own card layout (user request:
  // "reread the layout of the items") — the title on its own line, wrapping
  // to a second like the page's line-clamp-2 instead of being ellipsized
  // away, and the points | date row left-aligned under it (the old
  // space-between head jammed the date into the right edge).
  // 6.7.3: the order card completed — the product thumbnail on the left
  // (the page's own bing.com art, cropped 16:9, self-hiding if the URL
  // rots) with the text body beside it, and the code + Copy shown DIRECTLY
  // (user spec: no View-detail press; the code is the point of the row).
  // 6.7.4: the order id appears exactly once and the date survives — the
  // live page renders a hidden "Order no." twin per card, and the old card
  // parse excluded only the FIRST order-no line, so a surviving twin was
  // adopted as the title or the date (user: "I see that you repeated the
  // order id twice" — and the date never showed, the same bug); the parse
  // now strips every order-no line and bare uuid line before picking the
  // title and date. The code's expiration date (the dialog's own
  // "Expiration Date" line, read all along) now rides beside the code.
  // 6.7.5: the View-detail button's label no longer rides into the order
  // number — the live page glues it onto the END of the order-no line for
  // some cards (user paste: the row showed "Order no. <uuid>View detail"),
  // and the old extraction took everything after "Order no. " verbatim; a
  // trailing "View detail(s)" is now trimmed off every card line before
  // anything parses it.
  // 6.7.6: the detail dialogs actually read again (user: "you are not
  // getting the data from view details") — the dialog read no longer
  // depends on the "Rewards details" label matching exactly (a renamed
  // disclosure made it fire on an EMPTY still-streaming dialog and close
  // it, losing every code; any collapsed details-labeled button expands
  // now, and the read waits until the dialog carries the code, the
  // expiration or the status), the close falls back to Escape when the
  // labeled Close button is gone, the read happens BEFORE the close (a
  // synchronous unmount used to leave nothing to read), the prev-doc
  // merge matches order numbers canonically so codes stored under
  // pre-6.7.5 polluted numbers are recovered instead of orphaned, and a
  // detail phase that answers nothing names why in the Activity log (no
  // dialog ever opened vs. dialogs that opened but read nothing, with the
  // first dialog's text as the dump).
  // 6.7.7: the detail read follows the user's live spec — "before pressing
  // the view detail button, take the main information from the order item
  // (title, price, date, order number). After that, press the view detail
  // button. The detail will not show directly — you have to wait. After the
  // details load, you will see the code": the wait for the dialog is
  // patient now (one rescue press after 6s instead of four impatient
  // re-presses at 2.5s that fought a slow-opening dialog), and the sync is
  // INCREMENTAL — "if the item is already there, you do not need to sync it
  // again. Only sync for new items": an order already stored with its code
  // is never re-read (only the list refreshes for it); a row stored without
  // a code stays a candidate so a re-sync retries what failed, and the
  // activity line reports "N already saved".
  // 6.7.8: a Rescan-all button beside Sync (user request, 2026-09-10: "add
  // a button that will rescan them all") — the forced run re-opens every
  // order's detail dialog, even the ones already stored with codes, so a
  // page that changed its codes (or an old parse that stored something
  // wrong) gets corrected from the live page; the activity line names it a
  // "Full rescan".
  // 6.7.9: the order history opens as an ACTIVE TAB in the user's CURRENT
  // window instead of the extension's own unfocused window (user request,
  // 2026-09-10: "open the history tab in the same window not in a new one")
  // — active because the page only renders its rows on a visible tab (the
  // old no-rows failure), and the tab is removed when the sync ends.
  // 6.7.10: the detail read gets the time it needs (user report,
  // 2026-09-10: "you are still not giving it enough time") — the read now
  // fires on the CODE itself, not on the status line that renders long
  // before it (the old trigger closed dialogs while their codes were still
  // streaming in); a dialog with no code is read only after 10s of
  // settled text; the per-dialog budget is a full minute, with a second
  // rescue press at 24s for a page that slow.
  // 6.7.11: the history opens in the extension's OWN unfocused window
  // again (user request, 2026-09-10: "revert that and run the tab in a new
  // window", after the background-tab attempt — the page never renders its
  // list on a hidden tab, measured 0 rows in the pipeline harness); the
  // window is ALWAYS closed when the sync ends.
  // 6.7.12: no more orphaned sync windows (user report, 2026-09-10: "you
  // are opening two windows and nothing is being done" — a reload while a
  // slow rescan was mid-run killed its worker, orphaning the window; the
  // next press opened a second beside it): the sync remembers its window
  // id in storage, and the next sync — or the next worker wake — closes
  // whatever window a dead run left behind.
  // 6.7.13: the order row's green status line is gone (user request,
  // 2026-09-10: "I don't want to see this green text… just remove it"),
  // and the date under the code is the ORDER date from the card, not the
  // dialog's expiration date ("the date I want is not the expiration
  // date, but the order date. Put it under the code in place of the green
  // text") — the expiration chip is gone too.
  // 6.7.15: the order number moved BELOW the code (user request,
  // 2026-09-10: "put the order number below the code") — the row reads
  // title, meta, code + Copy + order date, then "Order no. …".
  // 6.7.16: the dashboard is a real GRID again with per-panel RESIZE
  // (user request, 2026-09-10: "the dashboard should be mapped on a grid
  // layout, so if I want to increase the size of a tile, it will take, for
  // example, one more row. The resize should allow for width change and
  // height change. On doing a section getting longer or its width getting
  // wider, the content also should change alongside that"): twelve columns
  // a panel can span (↔ cycles a third → half → two thirds → full row)
  // and FIXED 320px rows it can stack (↕ cycles 1–3, so "one more row" is
  // exactly one more track); the panels stretch to fill their cells, so
  // the scrollable lists and the chart grow with the tile. The masonry
  // columns of 6.7.1 are gone; a stored columns doc is transposed into the
  // grid's flow order so the user's arrangement survives.
  // 6.7.17: the resize is a DRAG now, not buttons (user request,
  // 2026-09-10: "I did not like how you implemented the height and width
  // adjustment buttons. I would rather drag them myself, like in Windows.
  // Also, the width and height steps are too big. Make them smaller") —
  // every panel grows a corner grip in edit mode (sideways for width, down
  // for height, diagonally for both), the width steps one column at a time
  // (1–12 instead of the 4/6/8/12 jumps), and the row track halved to
  // 160px so a height step is half the old one (up to six tracks). The
  // board also gained top clearance so the fixed Edit layout button and
  // the gear stop colliding with the first row (user request, 2026-09-10).
  // 6.9.4: the shipped DEFAULT_SETTINGS are recaptured from the maintainer's
  // own live configuration (user request, 2026-09-23: "set the default
  // settings to my current settings"). Read library-free out of Brave's
  // "Sync Extension Settings" LevelDB (settings hold only preferences — no
  // account data). Ten values change from the old baked-in defaults:
  // startup now runs on launch (startupEnabled true; order stats → dailySet
  // → keepEarning → imageSearch → search → claim), tabCloseDelaySec 8 → 4,
  // scheduledRunTime 09:00 → 00:20, the mouse-escape troll off, theme tokyo,
  // backdrop cursor glow, accent #8b5cf6, refreshStatsOnPopupOpen off, and
  // popupHeight pinned to 600. Only fresh installs / never-set keys are
  // affected — getSettings() still merges a stored blob key-by-key over
  // these, so an existing user's saved value always wins.
  // 6.9.3: the scheduled run is rebuilt on a periodic HEARTBEAT instead of a
  // ~24h one-shot alarm (user report, 2026-09-22: "the schedule feature does
  // not work" — the 6.9.2 catch-up patch, still built on the one-shot, did not
  // fix the real Brave). The root cause was the delivery assumption itself: a
  // one-shot `when` alarm armed a day out is the exact fragile case the search
  // watchdog already abandoned for a periodic alarm (core/alarms.ts). Now a
  // periodic alarm (every 5 min) plus a punctual one-shot for on-time firing
  // plus every worker wake all funnel through ONE pure check — scheduledDue()
  // in pure/schedule.ts — which fires the moment the wall clock is at/past
  // today's time and today has not run yet. Delivery reliability stops
  // mattering: a dropped heartbeat only delays the round to the next tick, and
  // a browser reopened after the moment runs the owed round on wake, WITHOUT
  // any past-due alarm ever being delivered. A synchronous re-entrancy guard
  // closes the punctual/heartbeat race, the day latches before the run (a
  // crash can't double-run it) but NOT when busy (so a busy round retries on
  // the next tick). The debt/arm-moment bookkeeping of 6.9.2 (scheduledArm-
  // Moment, scheduledDebtDay, catchUpDecision, scheduledFire, scheduledCatchUp)
  // is all gone. Proven with the rewritten scripts/probe-scheduled.js and a new
  // heartbeat catch-up probe (no 24h wait — the next-day miss is simulated by
  // seeding a just-past time with the day unhandled and no punctual alarm).
  // 6.9.2: the scheduled run catches up after a missed fire (user report,
  // 2026-09-15: "when I leave it for a day and the specific time comes, it
  // does not work" — a close-time test fired, a next-day leave never did).
  // Chrome NEVER delivers a past-due alarm: if the browser is closed or the
  // PC asleep at the moment, the fire is dropped, not deferred — and the old
  // wake path re-armed straight to tomorrow, silently losing the day. Now
  // every arm records the moment it armed FOR, a re-arm preserves a passed
  // unhandled moment as a debt day (pure catchUpDecision in pure/schedule.ts,
  // unit-tested), and the worker wake runs the owed round late — visibly:
  // "Scheduled — the browser was closed at HH:MM, running it late" — right
  // after the arming pass (serialized; a race let the catch-up read the debt
  // before the arming preserved it). Proven live end-to-end with
  // scripts/probe-scheduled-missed.js (arm → close the browser → moment
  // passes → relaunch → the round runs). Disabling the schedule clears any
  // pending debt.
  // 6.9.1: the search-cap read can no longer answer a promo tile (user
  // report, 2026-09-13: "the extention read 2 out of 7 insted of 15 out of
  // 15" on a second account). That account's dashboard carries NO
  // Today's-points card — a current design, not the old one the document-wide
  // fallback was for — so the read hunted the whole page body and matched the
  // "Win big when you Bing search… seven days" promo's 2/7 progress ring
  // (label "Progress for the: Search for 7 days" passes the search and
  // max>=4 gates). The fallback is gone: no card, or a closed flyout, reads
  // null — and the real pair ("15/15") comes from the Earn page's flyout,
  // which the merge already prefers when the dashboard has nothing. Verified
  // against live captures with scripts/probe-stats-capture.js (new: runs the
  // real reader over a saved HTML capture).
  // 6.9.0: the scheduled daily run + a user-settable prowl window (user
  // requests, 2026-09-12): "add an option that will allowe it to run
  // automaticly on a schedule… the user spicifies the time… disbled by
  // defualt" — a chrome.alarms `when` alarm fires the startup routine once a
  // day at the user's HH:MM, surviving evictions and restarts (its own
  // toggle, default OFF; the master startup switch does not gate it). The
  // 15s confirm is bypassed for scheduled rounds — a time the user set IS
  // the intent, and an unattended window would auto-cancel every round —
  // while once-per-day still applies and now says so in the Activity row
  // when it skips ("the schedule did not run the routine" was that silent
  // skip plus the confirm eating the first tries). The time edits on a
  // 12-hour face (hour : minute NumberFields + an AM/PM segmented toggle)
  // but is stored 24-hour "HH:MM". The prowl's interval window is
  // user-settable too (min/max minutes, 15–45 default, junk-sanitized in
  // pure prowlWindowMs). Live coverage: scripts/probe-scheduled.js makes
  // the real alarm fire and watches the routine run (the diag only ever
  // armed/cleared it), alongside the existing probe-prowl.js.
  // 6.8.0: the dashboard layout is REBUILT from scratch on
  // react-grid-layout (user request, 2026-09-11: "I do not like the current
  // layout. And layout handling I want you to start again from scratch") —
  // the ~500 lines of hand-rolled grid machinery (flowSeats, dropSpot, the
  // grip pointer math, the ghost overlay, the 6.7.x masonry/columns/tier
  // systems) are gone, replaced by the engine plus three small pure modules.
  // PER-TILE DESIGNED SIZES are the heart of the "optimized, not crushed"
  // ask: every tile declares the sizes it was designed for in a registry
  // (e.g. orders 2×1 mini · 4×3 regular · 6×4 roomy; catalog 2×1 one-row
  // lines · 4×2 · 6×2 cards), and the resize grip SNAPS to those — nothing
  // between steps is reachable, and each step carries its own content
  // variant (its own JSX, not a squeezed card). Drag by the tile's header,
  // resize by the Windows-style corner grip, vertical compaction keeps the
  // board packed, and the board persists as dashLayout {v:2} — the user's
  // saved arrangement (6.6 masonry and 6.7 grid docs) migrates through the
  // old flow first. Tiles are one shared React shell + nine components; the
  // Default layout button drops the stored key so the registry's board
  // returns.
  // 6.7.18: the grid's polish pass (all user requests, 2026-09-10): the
  // order row shows its date ONCE (the dim chip beside the Copy button is
  // gone — "why does the date show twice?"), the defaults return to the old
  // size tiers (the Run controls rejoin the Order history at the 656px
  // height — four 160px tracks — "set the default to be the old settings"),
  // the catalog can't shrink below two tracks (a coin card never fit one —
  // "the tiles inside it do not show fully"), the sold-out coin card
  // resolves its amount through the sku PATH (the option hrefs are stored
  // absolute while the variants' come relative out of the RSC payload; the
  // raw string match missed and the card fell back to the raw product title
  // — "why does it show the title, which is Overwatch Coin Digital
  // Code?"), a drop lands by the CURSOR's grid address instead of the panel
  // under it (free movement anywhere on the board, empty space included —
  // the browser's sparse auto-placement is simulated to answer it), a GHOST
  // cell highlights the exact seat a hovering drag would take, size and
  // reseat changes ANIMATE (framer-motion layout springs, honoring the
  // animations setting), the content re-seats itself on the panel's own
  // width via container queries (the coin cards compact to one column and
  // slim down, the streak cards go 2×2, the stat tiles flow — "no hidden
  // items because of the change in width"), the height ceiling rises to
  // eight tracks ("you can increase the width and height of the grid if
  // needed"), and a Default layout button beside Edit layout restores the
  // shipped board (the stored key is dropped, not overwritten).
  // 6.9.7: the finish clears Bing, and the first search skips the box. The
  // routine's end now sweeps every bing.com / rewards.microsoft.com tab it can
  // find instead of only the tabs it captured — the boards and pinned tabs
  // survive — and the first search of a regular batch loads Bing's results URL
  // directly rather than typing into the search box. That is the closest an
  // extension can come to an omnibox search: Chrome exposes no API for the
  // omnibox and none for the default search engine, so no browser setting is
  // read or changed (ADR-023).
  // 6.9.8: updating stops being manual. A PowerShell updater ships INSIDE the
  // extension folder (updater/, copied into dist by a small Vite plugin), and
  // targets its own parent directory — the folder Chrome loads unpacked is the
  // folder it was unzipped into, so there is nothing to configure. Run it, and
  // it finds the newest Gingerbread release, downloads it, copies it over the
  // old files and deletes the previous version's hashed bundles. A reload click
  // still remains, and always will: the files land on disk but Chrome holds the
  // extension in memory and never re-reads the folder, and no API lets anything
  // press Reload. So the popup's banner area and the routine's finish screen
  // grow a Restart control that appears only when the folder's manifest.json
  // version stops matching the loaded one (ADR-024).
  // 6.9.9: bounded search recovery, final credited-progress retries, and normal
  // selected browser tabs throughout. Existing permissions are unchanged.
  // 6.9.10: reward/routine icon and clean completion heading.
  version: '6.11.0',
  description:
    'Automatically perform Bing searches with realistic typing and dynamic intervals, and open daily sets on the Rewards dashboard.',
  // "downloads" is the one permission the fifth build adds (6.3.2): the
  // Developer-Option Rewards-API probe saves its capture report as a JSON
  // file in the Downloads folder. Nothing else uses it — document it in
  // docs/extension/manifest.md with the rest of the deferred 6.x paperwork.
  permissions: ['tabs', 'storage', 'scripting', 'alarms', 'notifications', 'downloads'],
  // The probe's fetch/XHR hook: a MAIN-world script at document_start, the
  // only way to wrap fetch before the Rewards app makes its initial
  // authenticated API calls. Dormant on every page whose URL lacks
  // ?meowprobe=1 (one regex test) — the routine's own rewards tabs are
  // untouched.
  content_scripts: [
    {
      matches: ['https://rewards.bing.com/*'],
      js: ['src/content/api-logger.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    },
  ],
  host_permissions: [
    'https://*.bing.com/*',
    'https://uselessfacts.jsph.pl/*',
    'https://trends.google.com/*',
    'https://en.wikipedia.org/*',
    'https://picsum.photos/*',
    'https://*.picsum.photos/*',
    'https://*.thecatapi.com/*',
  ],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  action: {
    default_title: 'Reward Routine Automator — Gingerbread',
    default_popup: 'index.html',
  },
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  // The confirm dialog and the full-screen dashboard (6.4.0) are opened as
  // their own tabs by the worker, so they must be reachable as resources. The
  // dashboard also carries the routine's finish overlay (6.8.0), which
  // replaced the old routine-done.html.
  web_accessible_resources: [
    {
      resources: ['confirm.html', 'dashboard.html'],
      matches: ['<all_urls>'],
    },
  ],
})
