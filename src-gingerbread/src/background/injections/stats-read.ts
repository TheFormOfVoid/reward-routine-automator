// @ts-nocheck
// The Rewards stats reader — the page-side half of refreshStats. VERBATIM
// page-side port from src-froyo/injections/stats-read.js. Injected via
// chrome.scripting.executeScript({func}), serialized with .toString(), so it
// must be fully self-contained: no imports, no closures over module state (see
// ADR-017). @ts-nocheck because it runs against the live page (not the
// worker's lib.dom view) and is validated by browser/live runs, not the
// type-checker; the typed signature below is still exported for callers.

// waitMode: "cards" (the dashboard — the top cards matter), "streaks" (the
// Earn page — the streak cards matter), "search" (points breakdown only), or omitted.
export function readRewardsStats(timeoutMs: number, waitMode?: string) {
  return new Promise(resolve => {
    const POLL_INTERVAL_MS = 500;

    const waitMs = Math.max(1000, Number(timeoutMs) || 12000);
    const startedAt = Date.now();
    const deadline = startedAt + waitMs;

    const textOf = el =>
      (el.textContent || "").replace(/\s+/g, " ").trim();

    function emptyStats() {
      return {
        availablePoints: null,
        readyToClaim: null,
        dailyStreak: null,
        stampBonus: null,
        membership: null,
        searchPoints: null,
        activities: {
          bingSearch: null,
          dailySet: null,
          bingApp: null,
          visualSearch: null
        },
        keepEarning: null
      };
    }

    // The top cards each carry their label in a p.text-labelControl — the same
    // hook the claim finder matches the "Ready to claim" tile by. The label's
    // nearest a/button ancestor is the card, and the value is the card's
    // p.text-pageHeader ("4,509", "456", "6 days").
    function findCard(labelText) {
      const labels = Array.from(
        document.querySelectorAll("p.text-labelControl")
      );
      const hit = labels.find(el => textOf(el).toLowerCase() === labelText);
      return hit ? hit.closest("a, button") : null;
    }

    function cardValue(labelText) {
      const card = findCard(labelText);
      if (!card) return null;
      const para = card.querySelector("p.text-pageHeader");
      return para ? textOf(para) : null;
    }

    // The 2026-09-05 dashboard redesign (the user's dash.html capture, in
    // .claude/html-references/) removed
    // the Available points card — the balance now lives in the page header, a
    // bare comma-grouped number sitting immediately before the membership
    // medal's img ("Gold Member"). The medal adjacency is the row test: the
    // same page carries other bare numbers (the flyout's History table —
    // "This month 997") that must never answer. Old-design pages keep the
    // card read; this is the fallback.
    function headerPointsBalance() {
      const medals = Array.from(
        document.querySelectorAll("img[alt]")
      ).filter(el => /member/i.test(el.getAttribute("alt") || ""));
      for (const medal of medals) {
        const sibling = medal.previousElementSibling;
        if (sibling && /^\s*\d{1,3}(,\d{3})+\s*$|^\s*\d{3,6}\s*$/.test(textOf(sibling))) {
          return textOf(sibling).trim();
        }
      }
      return null;
    }

    // The membership medal: the header's img whose alt names the tier ("Gold
    // Member") — the same nodes headerPointsBalance walks for the balance.
    // The alt text IS the tier display; never waited for (the medal is a
    // header extra, not a card, and its absence is a miss to report, not to
    // block on).
    function membershipValue() {
      const medals = Array.from(
        document.querySelectorAll("img[alt]")
      ).filter(el => /member/i.test(el.getAttribute("alt") || ""));
      for (const medal of medals) {
        const alt = (medal.getAttribute("alt") || "").trim();
        if (alt) return alt;
      }
      return null;
    }

    // Stamp bonus is the one card whose value is not a pageHeader: it sits in
    // the label's own header row, gradient-clipped ("1,000 pts"). Take the <p>
    // next to the label in that row — the one that is not the label.
    function stampBonusValue() {
      const card = findCard("stamp bonus");
      if (!card) return null;
      const labels = Array.from(card.querySelectorAll("p.text-labelControl"));
      const label = labels.find(el => textOf(el).toLowerCase() === "stamp bonus");
      if (!label || !label.parentElement) return null;

      const paras = Array.from(label.parentElement.querySelectorAll("p"));
      const value = paras.find(p => p !== label && textOf(p));
      return value ? textOf(value) : null;
    }

    // The redesigned stamp bonus card (Earn page, live capture 2026-09-03)
    // counts progress in a grid of twelve star cells: a lit cell sits on the
    // brand background (bg-bgCtrlBrandRest), an unlit one is merely outlined
    // (border-strokeDividerBrand). The user asked for the lit count ("out of
    // 12, how many stars are light"), so it wins over the older "1,000 pts"
    // card read, which stays as the fallback. The cell count is read from the
    // grid rather than hardcoded to 12, in case the card ever grows.
    function stampBonusStars() {
      const paras = Array.from(document.querySelectorAll("p"));
      const callout = paras.find(el => /earn \d+ stamps/i.test(textOf(el)));
      if (!callout) return null;

      const card =
        callout.closest("button, div.cursor-pointer") ||
        callout.parentElement;
      if (!card) return null;

      const grid = Array.from(card.querySelectorAll("div")).find(el =>
        String(el.className).includes("grid-cols-6")
      );
      if (!grid) return null;

      const cells = Array.from(grid.children);
      if (!cells.length) return null;
      const lit = cells.filter(el =>
        String(el.className).includes("bg-bgCtrlBrandRest")
      ).length;
      return lit + "/" + cells.length;
    }

    // The Bing-search "out of 60" — the Today's points card's breakdown
    // (the user's pointer, 2026-09-04; the expanded panel captured verbatim
    // 2026-09-05, html2.html in .claude/html-references/). The card is a
    // react-aria DialogTrigger button:
    // collapsed it carries no aria-controls at all — the attribute and the
    // flyout appear together once it opens — so the read clicks it open once
    // (expandPointsBreakdownIfCollapsed below) and then hunts the panel for
    // the search row. The live panel is a side drawer (a section[role=dialog]
    // holding a table), so the matcher stays shape-based:
    //   - a bare "X/Y" text whose max is >= 4 (the streak footers answer /1
    //     and /3, dates and "Earned last month: 420/420" never render as a
    //     bare pair) in a row labeled "search" — the live table splits the
    //     value across two sibling spans ("60" + "/60", so the pair only
    //     exists at their parent div) and lays each row out as label-div
    //     then value-div siblings, or
    //   - a role="progressbar" labeled with "search" and a max >= 4 (the
    //     streak bar carries "Search: 1/1" — max 1, kept out).
    function findPointsCard() {
      const labels = Array.from(
        document.querySelectorAll("p.text-labelControl")
      );
      // Apostrophe tolerant: the capture uses the straight form, the live
      // page could typographically curl it.
      const label = labels.find(el => /^today.?s points$/i.test(textOf(el)));
      return label ? label.closest("a, button") : null;
    }

    function searchPointsValue() {
      // The breakdown lives ONLY inside the flyout: the expanded button's
      // aria-controls -> #id (absent while collapsed — the DialogTrigger
      // adds it on open). When the card exists but its flyout is not open,
      // the answer is null, NOT a document-wide hunt: the live dashboard's
      // page body carries other "X/Y" progress numbers near search-labeled
      // things, and that fallback answered a wrong "100" on the user's first
      // live run (2026-09-05). The second account (2026-09-13,
      // account2-dashboard.html) killed the fallback for good: its dashboard
      // carries NO Today's-points card at all (a current design — "no card"
      // is no longer evidence of the old one), the document hunt matched the
      // "Win big when you Bing search… seven days" promo tile, and the read
      // answered its 2/7 progress ring as the search cap — while the real
      // 15/15 lives in the Earn page's flyout, which the Earn-page half of
      // the read supplies through the merge (firstNonNull: dashboard null,
      // Earn 15/15). No card, or a closed flyout: null either way — a null
      // honestly falls back to the full configured batch instead of a wrong
      // cap, and the caller's dump collects the card's markup.
      const card = findPointsCard();
      if (!card) return null;
      const controlled = card.getAttribute("aria-controls");
      const panel = controlled ? document.getElementById(controlled) : null;
      if (!panel) return null;
      const scope = panel;

      const cells = Array.from(scope.querySelectorAll("span, p, div"));
      const pairs = cells.filter(el => {
        const t = textOf(el);
        if (!/^\d+\s*\/\s*\d+$/.test(t)) return false;
        return Number(t.match(/(\d+)\s*\/\s*(\d+)/)[2]) >= 4;
      });
      for (const el of pairs) {
        // The live table's row test: the label ("Bing search") is the pair's
        // immediately preceding sibling. It must be the deciding evidence
        // when present — the ancestor walk alone would answer for ANY row of
        // the table, because the grid ancestor carries every row's text
        // (including "Bing search"), and the table can hold other max>=4
        // rows (an Edge "0/30" minutes row).
        const labelCell = el.previousElementSibling;
        if (labelCell && textOf(labelCell)) {
          if (/search/i.test(textOf(labelCell))) {
            return textOf(el).replace(/\s+/g, "");
          }
          continue;
        }
        // Unknown markup: a short bounded walk up — older designs put the
        // label and the value in one shared row element.
        let row = el.parentElement;
        for (let hops = 0; hops < 5 && row; hops++) {
          if (/search/i.test(textOf(row))) {
            return textOf(el).replace(/\s+/g, "");
          }
          row = row.parentElement;
        }
      }

      // The progressbar shape, for a panel that renders bars like the streak
      // cards do. Fractional valuenows (the page uses them elsewhere) round
      // to the whole points the row displays.
      const bars = Array.from(scope.querySelectorAll('[role="progressbar"]'));
      const bar = bars.find(el => {
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        if (!label.includes("search")) return false;
        const max = Number(el.getAttribute("aria-valuemax"));
        return Number.isFinite(max) && max >= 4;
      });
      if (bar) {
        const now = Number(bar.getAttribute("aria-valuenow"));
        const max = Number(bar.getAttribute("aria-valuemax"));
        if (Number.isFinite(now) && Number.isFinite(max)) {
          return `${Math.round(now)}/${Math.round(max)}`;
        }
      }
      return null;
    }

    // A streak card ("Bing Search Streak") carries two values: the day count
    // in a screen-reader-only line ("Day 4 of 7 streak completed.") and
    // today's progress in the footer ("Search: 1/1" — the max differs per
    // streak, 1 or 3). Both are shown ("Day 4 of 7 · 1/1"); a missing half
    // is dropped rather than guessed. The title pattern picks the card, then
    // the nearest ancestor holding a .sr-only line is its scope — the title
    // and the dots row are siblings, but the card root has no stable hook
    // beyond the (shared) cursor-pointer class. Bounded walk so a card
    // without its own sr-only can't reach into a sibling card's.
    function streakCardValue(titlePattern) {
      const titles = Array.from(
        document.querySelectorAll("p.text-globalBody2Strong")
      );
      const title = titles.find(el => titlePattern.test(textOf(el)));
      if (!title) return null;

      let scope = title.parentElement;
      for (let hops = 0; hops < 4 && scope; hops++) {
        if (scope.querySelector(".sr-only")) break;
        scope = scope.parentElement;
      }
      if (!scope || !scope.querySelector(".sr-only")) return null;

      const lines = Array.from(scope.querySelectorAll(".sr-only")).map(textOf);
      const dayLine = lines.find(line => /day \d+ of \d+/i.test(line));
      const day = dayLine
        ? dayLine.match(/day \d+ of \d+/i)[0].replace(/\s+/g, " ")
        : null;

      // The footer line lives outside the title's own column (the live card
      // puts it in a sibling of the column the title and dots sit in), so
      // the progress is searched in the card root: the nearest ancestor
      // marked clickable, which on this design is the card itself. If no
      // such ancestor exists, the tight sr-only scope is the best guess.
      let cardRoot = scope;
      for (let hops = 0; hops < 6 && cardRoot; hops++) {
        if (cardRoot.classList && cardRoot.classList.contains("cursor-pointer")) break;
        cardRoot = cardRoot.parentElement;
      }
      const progressScope = cardRoot || scope;

      // The footer cell is the card's own "Name: X/Y" line — the same shape
      // the progressbar tiles carried, on a div this time.
      const cells = Array.from(progressScope.querySelectorAll("div, span, p"));
      const progressCell = cells.find(el =>
        /^[a-z' -]+:\s*\d+\s*\/\s*\d+$/i.test(textOf(el))
      );
      const progress = progressCell
        ? (textOf(progressCell).match(/\d+\s*\/\s*\d+/) || [null])[0].replace(
            /\s+/g,
            ""
          )
        : null;

      if (day && progress) return day + " · " + progress;
      return day || progress || null;
    }

    // Each activity tile holds a role="progressbar" whose aria-label is the
    // tile's name. The page holds other progressbars ("Points", "Refreshing
    // Gold"), so the name has to match exactly rather than by containment.
    // Today's progress is the tile's metadata line ("Search: 1/1"); the prefix
    // is the dashboard's wording, not the stat's, so only the "X/Y" survives.
    function activityValue(name) {
      const wanted = String(name).trim().toLowerCase();
      const bars = Array.from(document.querySelectorAll('[role="progressbar"]'));
      const bar = bars.find(
        el => (el.getAttribute("aria-label") || "").trim().toLowerCase() === wanted
      );
      if (!bar) return null;

      const scope = bar.closest("button") || bar;
      const line = Array.from(scope.querySelectorAll("span")).find(el =>
        /^[a-z' -]+:\s*\d+\s*\/\s*\d+$/i.test(textOf(el))
      );
      if (line) {
        const match = textOf(line).match(/\d+\s*\/\s*\d+/);
        if (match) return match[0].replace(/\s+/g, "");
      }

      // No metadata line (renamed markup): the bar's own numbers still say it.
      const now = bar.getAttribute("aria-valuenow");
      const max = bar.getAttribute("aria-valuemax");
      if (now != null && max != null) return `${now}/${max}`;
      return null;
    }

    // The Earn page's streak cards sit in a react-aria Disclosure that can
    // load collapsed — and a collapsed panel renders no cards at all. Same
    // move as the keep-earning step's expandIfCollapsed, one shot: click the
    // section's own toggle. The toggle is identified structurally — a button
    // whose aria-controls points at a .react-aria-DisclosurePanel and whose
    // label says "streaks" — because the "About Streaks" info button next to
    // it also carries aria-expanded="false" and must not be the one clicked.
    function streaksToggles() {
      return Array.from(
        document.querySelectorAll("button[aria-controls]")
      ).filter(el => {
        const label = el.getAttribute("aria-label") || textOf(el) || "";
        if (!label.toLowerCase().includes("streak")) return false;
        const panel = document.getElementById(
          el.getAttribute("aria-controls") || ""
        );
        return !!panel && panel.classList.contains("react-aria-DisclosurePanel");
      });
    }

    // A press the way a real mouse delivers it: pointerdown, pointerup, click,
    // with the button's own center as the coordinates. Added for the live
    // 2026-09-05 failure the dump caught — twelve retried clicks on the
    // tile and the flyout never opened. react-aria's usePress answers a
    // bare element.click() as a "virtual" press (click detail 0 — its own
    // source says so), but the live tile runs custom code on a newer React
    // build than any capture, and something there does not honor the
    // virtual path. The pointer pair carries a real mouse pointerType, so a
    // pointer-guarded handler registers it too; usePress turns the full
    // sequence into exactly one onPress (its 80 ms self-click fallback is
    // cancelled by the click we dispatch), and the trailing element.click()
    // keeps click-only handlers (every static fixture) working.
    function pressButton(el) {
      const rect = el.getBoundingClientRect();
      const at = {
        bubbles: true,
        composed: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
      };
      if (typeof PointerEvent === "function") {
        // Non-zero size and pressure matter: react-aria reads a zero-sized
        // pointer event as a screen-reader tap and ignores the sequence.
        el.dispatchEvent(
          new PointerEvent("pointerdown", {
            ...at,
            buttons: 1,
            width: 1,
            height: 1,
            pressure: 0.5
          })
        );
        el.dispatchEvent(
          new PointerEvent("pointerup", {
            ...at,
            buttons: 0,
            width: 1,
            height: 1,
            pressure: 0
          })
        );
      }
      el.click();
    }

    // The evidence for the next live miss: how many presses were made on the
    // points card, whether the card ever answered (aria-expanded flips to
    // "true" and aria-controls appears when the flyout opens — even briefly),
    // and the tab's visibility at the last press. Lives on window so the
    // caller's dump injection — a separate executeScript in this same
    // isolated world — can read it after the read resolves. everExpanded
    // true + expanded false at dump time means the flyout opened and then
    // closed again; presses > 0 with both false means the press never
    // registered at all — and pressVisibility=visible with both false would
    // prove the press is being ignored, not lost (an untrusted-event guard).
    const pressLog = {
      presses: 0,
      everExpanded: false,
      everControlled: false,
      visibility: ""
    };

    // A click that lands flips the toggle's aria-expanded — the page's own
    // answer to "did that work?" — so a registered click is never repeated
    // (re-clicking an open disclosure would collapse it again). But a click
    // fired into a not-yet-hydrated tree is swallowed and the attribute stays
    // "false", so the reader retries at most every 1 s — the same lost-click
    // recovery as the claim tile (ADR-010 §1).
    let lastStreaksClickAt = 0;
    function expandStreaksIfCollapsed() {
      const toggle = streaksToggles().find(
        el => el.getAttribute("aria-expanded") === "false"
      );
      if (!toggle || typeof toggle.click !== "function") return;
      if (Date.now() - lastStreaksClickAt < 1000) return;
      lastStreaksClickAt = Date.now();
      pressButton(toggle);
    }

    // The breakdown opens as a MODAL flyout — the live capture (html2.html in
    // .claude/html-references/, 2026-09-05) shows the page shell going inert
    // while it is open — and a
    // click on an inert element never fires. The Streaks disclosure's own
    // click must therefore land first. A collapsed not-yet-clicked toggle on
    // the page makes this poll wait (expandStreaksIfCollapsed runs first in
    // poll(), so the retry usually passes on the very next line); a toggle
    // that has not RENDERED yet cannot be waited on directly — the streaks
    // section streams after the tile in the RSC payload — so a streaks-mode
    // read gives it a 1s head start. The dashboard read has no streaks
    // section at all and never waits.
    function streaksResolvedBeforeFlyout() {
      if (lastStreaksClickAt) return true; // a click is registered — done
      const toggles = streaksToggles();
      if (toggles.some(el => el.getAttribute("aria-expanded") !== "false")) {
        return true; // already open — nothing left to click
      }
      if (toggles.length) return false; // collapsed and unclickable: never mind
      return waitMode !== "streaks" || Date.now() - startedAt > 1000;
    }

    // The Today's points card's breakdown, same retry move: the card is its
    // own toggle (a button carrying aria-expanded, per the captures), and the
    // breakdown flyout only renders once it opens. Only a collapsed BUTTON is
    // ever clicked — a card that renders as an anchor navigates instead of
    // disclosing, and must be left alone — and only while it is still
    // collapsed: a click that landed flips aria-expanded, and re-clicking an
    // open tile would toggle the flyout shut. The retry exists because the
    // one-shot version was the live "it shows —" bug (2026-09-05): the read's
    // single click fired before React hydrated the button, was swallowed, and
    // the flyout never opened — the stat then honestly read null. The
    // timestamp of the last click feeds the read's completion window
    // (complete() below).
    let lastPointsClickAt = 0;
    let expandedPointsAt = 0;
    function expandPointsBreakdownIfCollapsed() {
      if (!streaksResolvedBeforeFlyout()) return;
      const card = findPointsCard();
      if (!card) return;
      if (card.tagName !== "BUTTON") return;
      if (card.getAttribute("aria-expanded") !== "false") return;
      if (typeof card.click !== "function") return;
      if (Date.now() - lastPointsClickAt < 1000) return;
      lastPointsClickAt = Date.now();
      expandedPointsAt = Date.now();
      pressLog.presses++;
      pressLog.visibility = document.visibilityState;
      pressButton(card);
    }

    // The Keep-earning section's verdict counts, mirroring the keep-earning
    // step's opener (injections/rewards-tiles.ts) filter for filter — the
    // same heading match, the same scope walk, the same tile exclusions — so
    // the count can never disagree with what the step would actually click.
    // "open" counts the tiles the step would still open (not completed, not
    // "reward up only"); "total" counts the usable tiles the section holds.
    // null when the section is not on this page or has not rendered (or
    // opened) yet — an unknown is never a verdict.
    const KEEP_EARNING_NAMES = [
      "keep earning",
      "more activities",
      "more ways to earn"
    ];
    const KE_SPENT_MARKERS = ["completed", "reward up only"];

    function keepEarningHeading() {
      const headings = Array.from(
        document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')
      );
      const tests = [
        h => KEEP_EARNING_NAMES.includes(textOf(h).toLowerCase()),
        h =>
          KEEP_EARNING_NAMES.some(name =>
            textOf(h).toLowerCase().startsWith(name)
          ),
        h =>
          KEEP_EARNING_NAMES.some(name =>
            textOf(h).toLowerCase().includes(name)
          )
      ];
      for (const test of tests) {
        const found = headings.find(test);
        if (found) return found;
      }
      return null;
    }

    function keIsDisabled(el) {
      return (
        el.getAttribute("aria-disabled") === "true" ||
        el.hasAttribute("data-disabled")
      );
    }

    function keCandidatesIn(scope) {
      const all = Array.from(
        scope.querySelectorAll(
          'a[href], button, div[role="button"], [role="link"]'
        )
      );
      return all.filter(el => !all.some(other => other !== el && other.contains(el)));
    }

    function keFindScope(heading) {
      const disclosure = heading.closest(".react-aria-Disclosure");
      if (disclosure) {
        const panel = disclosure.querySelector(".react-aria-DisclosurePanel");
        if (panel) return { scope: panel, panelId: panel.id };
      }

      let node = heading.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const own = keCandidatesIn(node).filter(
          el => !el.contains(heading) && !heading.contains(el)
        );
        if (own.length >= 2) return { scope: node, panelId: "" };
      }
      return null;
    }

    function keepEarningCount() {
      const heading = keepEarningHeading();
      if (!heading) return null;

      const found = keFindScope(heading);
      if (!found) return null;

      const candidates = keCandidatesIn(found.scope);
      // A collapsed section renders no tiles at all — same shape as "not
      // here yet", and the one-shot expansion below is what fixes it.
      if (!candidates.length) return null;

      const tiles = candidates.filter(el => {
        const body = textOf(el).toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const controls = el.getAttribute("aria-controls") || "";

        const isSectionChrome =
          (found.panelId && controls === found.panelId) ||
          el.contains(heading) ||
          heading.contains(el) ||
          KEEP_EARNING_NAMES.some(name => aria.includes(name));
        const isMeta =
          body.includes("expires in") ||
          (el.tagName === "BUTTON" &&
            KEEP_EARNING_NAMES.some(name => body.includes(name)));
        const href = (el.getAttribute("href") || "").toLowerCase();
        const isImageCreator =
          href.includes("bing.com/images/create") ||
          body.includes("image creator") ||
          body.includes("create and download");

        return !isSectionChrome && !isMeta && !keIsDisabled(el) && !isImageCreator;
      });

      const open = tiles.filter(
        el =>
          !KE_SPENT_MARKERS.some(marker =>
            textOf(el).toLowerCase().includes(marker)
          )
      ).length;
      return { open: open, total: tiles.length };
    }

    // A collapsed Keep-earning disclosure renders no tiles, so its count
    // reads null — expand it, the same retry-guarded move as the Streaks
    // disclosure above and BEFORE the points flyout (which opens modally and
    // makes the shell inert).
    let lastKeepEarningClickAt = 0;
    function expandKeepEarningIfCollapsed() {
      const heading = keepEarningHeading();
      if (!heading) return;
      const disclosure = heading.closest(".react-aria-Disclosure");
      if (!disclosure) return;
      const toggle = disclosure.querySelector('[aria-expanded="false"]');
      if (!toggle || typeof toggle.click !== "function") return;
      if (Date.now() - lastKeepEarningClickAt < 1000) return;
      lastKeepEarningClickAt = Date.now();
      pressButton(toggle);
    }

    function readAll() {
      if (waitMode === "search") return { ...emptyStats(), searchPoints: searchPointsValue() };
      return {
        // The card first (old design); the header pill answers the redesign
        // (the Available points card is gone — headerPointsBalance).
        availablePoints: cardValue("available points") || headerPointsBalance(),
        readyToClaim: cardValue("ready to claim"),
        dailyStreak: cardValue("daily streak"),
        // The membership tier from the header medal ("Gold Member").
        membership: membershipValue(),
        // The star count is the redesigned card's own progress read; the
        // older gradient-clipped "1,000 pts" card answers on the old design.
        stampBonus: stampBonusStars() || stampBonusValue(),
        // The search-points cap from the Today's points breakdown — read
        // best-effort, never blocking on its own (the window lives in
        // complete()).
        searchPoints: searchPointsValue(),
        activities: {
          // Streak cards first (they say how many days the streak has run —
          // what the stat means); the progressbar tiles are the fallback.
          bingSearch: streakCardValue(/bing search/i) || activityValue("bing"),
          dailySet: streakCardValue(/daily set/i) || activityValue("daily set"),
          bingApp:
            streakCardValue(/(bing|mobile) app/i) || activityValue("mobile app"),
          visualSearch:
            streakCardValue(/visual search/i) ||
            activityValue("visual search")
        },
        // The Keep-earning section's verdict counts — best-effort like the
        // breakdown, with its own bounded window in complete().
        keepEarning: keepEarningCount()
      };
    }

    // Keep polling until the half this read is waiting for answers — the
    // values render after "complete". "Ready to claim" and "Stamp bonus" are
    // read but never waited for: the claim tile legitimately stays absent when
    // nothing is pending, and waiting on it would burn the whole timeout on a
    // healthy page. The points breakdown gets a window instead — but the
    // give-up bound only applies while the tile still shows the click did not
    // land (collapsed): once the tile shows OPEN, the panel is the page's own
    // pending state — a slow breakdown stream is a delay, not a miss (proven
    // 2026-09-05: a table rendering 3 s after a landed click read null under
    // the flat 2.5 s bound, the live "it doesn't work" report) — so the read
    // then waits for it up to the same deadline every other value gets (and
    // the caller dumps the panel's markup if even that runs out).
    // Set by complete() the first poll where the streaks and the breakdown
    // have both answered — the start of the keep-earning counts' grace window.
    let keOtherAnsweredAt = 0;

    function complete(stats) {
      if (waitMode === "search") return stats.searchPoints != null;
      const cardsAnswered =
        stats.availablePoints != null && stats.dailyStreak != null;
      const streaksAnswered = Object.values(stats.activities).every(
        value => value != null
      );
      let breakdownAnswered = stats.searchPoints != null;
      if (!breakdownAnswered && expandedPointsAt) {
        const card = findPointsCard();
        const landed =
          !!card && card.getAttribute("aria-expanded") === "true";
        if (!landed && Date.now() - expandedPointsAt > 2500) {
          breakdownAnswered = true; // the click never landed — stop waiting
        }
      } else if (!breakdownAnswered) {
        breakdownAnswered = true; // never clicked: no card, or not a button
      }
      if (waitMode === "cards") return cardsAnswered && breakdownAnswered;
      if (waitMode === "streaks") {
        if (!streaksAnswered || !breakdownAnswered) return false;
        // The keep-earning counts get a bounded window once everything else
        // has answered: a collapsed section takes a poll or two to open after
        // the one-shot click above. A page without the section, or a count
        // that already answered, never waits; a section that never opens
        // gives up after the window rather than holding the read to the
        // deadline.
        if (stats.keepEarning != null || !keepEarningHeading()) return true;
        if (!keOtherAnsweredAt) keOtherAnsweredAt = Date.now();
        return Date.now() - keOtherAnsweredAt > 3000;
      }
      return cardsAnswered && streaksAnswered && breakdownAnswered;
    }

    function poll() {
      // Before each read: a collapsed Streaks disclosure is worth clicking
      // (a collapsed panel renders none of the cards we are after) — and so
      // is a collapsed Keep-earning section (its verdict counts need the
      // tiles), and the Today's points card's collapsed breakdown. The ORDER
      // is load-bearing: the breakdown's flyout is modal (the shell goes
      // inert), so both disclosure clicks must land first — see
      // streaksResolvedBeforeFlyout.
      if (waitMode !== "search") {
        expandStreaksIfCollapsed();
        expandKeepEarningIfCollapsed();
      }
      expandPointsBreakdownIfCollapsed();

      // The press log watches every poll, so a flyout that opens and closes
      // again between polls still leaves its trace (everExpanded). Pinned to
      // window for the caller's dump injection — see pressLog above.
      const watchedCard = findPointsCard();
      if (watchedCard) {
        if (watchedCard.getAttribute("aria-expanded") === "true") {
          pressLog.everExpanded = true;
        }
        if (watchedCard.getAttribute("aria-controls") != null) {
          pressLog.everControlled = true;
        }
        window.__meowPointsPress = pressLog;
      }

      let stats;
      try {
        stats = readAll();
      } catch (e) {
        // Never throw to the caller: an unreadable page reports its misses.
        console.warn("Stats: read failed:", e);
        stats = emptyStats();
      }

      if (complete(stats) || Date.now() >= deadline) {
        resolve(stats);
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    }

    poll();
  });
}
