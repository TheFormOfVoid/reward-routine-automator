// @ts-nocheck
// The Rewards-dashboard injections — the tile clicker behind the daily set /
// keep earning steps, and the page-side claim routine. VERBATIM page-side port
// from src-froyo/injections/rewards-tiles.js. Injected via
// chrome.scripting.executeScript({func}), serialized with .toString(), so each
// function must be fully self-contained: no imports, no closures over module
// state (see ADR-017). @ts-nocheck because these run against the live page (not
// the worker's lib.dom view) and are validated by browser/live runs, not the
// type-checker; the typed signatures below are still exported for callers.

// Retries until the section's heading, its container AND its tiles exist, then
// clicks them. maxOpen <= 0 means "however many are there", which is what Keep
// earning needs — that section holds a different number of activities each day.
export function openRewardsSectionTiles(
  names: string[],
  maxOpen: number,
  label: string,
  skipSpent: boolean,
  lease?: { stopEpoch: number; expiresAt: number }
): Promise<number> {
  return new Promise(resolve => {
    let settled = false;
    const expiresAt = Math.min(lease?.expiresAt || Date.now() + 40000, Date.now() + 40000);
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      resolve(value);
    };
    const expiry = setTimeout(() => finish(-1), Math.max(0, expiresAt - Date.now()));
    const allowed = async () => {
      if (settled || Date.now() >= expiresAt) return false;
      if (!lease) return true;
      try {
        const { runState } = await chrome.storage.local.get('runState');
        return !settled && Date.now() < expiresAt && runState?.stopEpoch === lease.stopEpoch;
      } catch { return false; }
    };
    const MAX_RETRIES = 20;
    const RETRY_INTERVAL_MS = 500;
    const CLICK_DELAY_MS = 800;
    // Backstop for the open-ended case: if the filters below ever go wrong, this
    // is the difference between a few stray tabs and a hundred.
    const HARD_CEILING = 20;
    // When nothing looks incomplete, the tiles get clicked anyway — the
    // "completed" test is only a heuristic. But conservatively, because the
    // other explanation is that today is genuinely finished.
    const BLIND_LIMIT = 3;
    // skipSpent (Keep earning, 2026-09-05): a tile carrying any of these in
    // its body text can no longer earn, so it is skipped outright. "Completed"
    // is the page's own status; "reward up only" is the wording on tiles that
    // only ever paid a capped amount and now pay nothing. The daily set keeps
    // the blind-click fallback above because its "completed" test is only a
    // heuristic there — for Keep earning, a spent tile is just a dead tab.
    const SPENT_MARKERS = ["completed", "reward up only"];

    const requested = Number(maxOpen) > 0 ? Number(maxOpen) : HARD_CEILING;
    const limit = Math.min(requested, HARD_CEILING);
    const wanted = names.map(name => String(name).toLowerCase());

    let attempts = 0;
    let expandedOnce = false;

    const textOf = el =>
      (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();

    function scheduleRetry(reason) {
      console.warn(reason);
      if (attempts < MAX_RETRIES) {
        setTimeout(() => { void tryFindAndClick().catch(() => finish(-1)); }, RETRY_INTERVAL_MS);
      } else {
        console.warn(`${label}: giving up after retries.`);
        finish(0);
      }
    }

    // Exact match first, so "Keep earning" can't lose to a heading that merely
    // mentions it.
    function findHeading() {
      const headings = Array.from(
        document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')
      );
      const tests = [
        h => wanted.includes(textOf(h)),
        h => wanted.some(name => textOf(h).startsWith(name)),
        h => wanted.some(name => textOf(h).includes(name))
      ];

      for (const test of tests) {
        const found = headings.find(test);
        if (found) return found;
      }
      return null;
    }

    // A nest of clickables is one tile, not several: keeping only the outermost
    // of each nest is what stops a single card being clicked twice.
    //
    // react-aria renders the Rewards tiles as <span role="link"> rather than
    // <a href>, so [role="link"] has to be in the selector or the /earn page
    // yields no candidates at all.
    function isDisabled(el) {
      return (
        el.getAttribute("aria-disabled") === "true" ||
        el.hasAttribute("data-disabled")
      );
    }

    function candidatesIn(scope) {
      const all = Array.from(
        scope.querySelectorAll(
          'a[href], button, div[role="button"], [role="link"]'
        )
      );
      return all.filter(el => !all.some(other => other !== el && other.contains(el)));
    }

    // The daily set sits in a react-aria Disclosure. Keep earning may not, so
    // fall back to the nearest ancestor that actually holds several tiles.
    function findScope(heading) {
      const disclosure = heading.closest(".react-aria-Disclosure");
      if (disclosure) {
        const panel = disclosure.querySelector(".react-aria-DisclosurePanel");
        if (panel) return { scope: panel, panelId: panel.id, disclosure };
      }

      let node = heading.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const own = candidatesIn(node).filter(
          el => !el.contains(heading) && !heading.contains(el)
        );
        if (own.length >= 2) return { scope: node, panelId: "", disclosure: null };
      }
      return null;
    }

    // A collapsed section renders no tiles at all. Only touched when the page
    // itself says it is shut, and only once.
    function expandIfCollapsed(disclosure) {
      if (expandedOnce || !disclosure) return false;
      const toggle = disclosure.querySelector('[aria-expanded="false"]');
      if (!toggle || typeof toggle.click !== "function") return false;

      expandedOnce = true;
      toggle.click();
      return true;
    }

    async function tryFindAndClick() {
      if (!(await allowed())) { finish(-1); return; }
      attempts++;

      const heading = findHeading();
      if (!heading) {
        scheduleRetry(`${label}: heading not found yet, retrying...`);
        return;
      }

      const found = findScope(heading);
      if (!found) {
        scheduleRetry(`${label}: section container not found yet, retrying...`);
        return;
      }

      const candidates = candidatesIn(found.scope);
      console.log(`${label}: clickable candidates:`, candidates.length);

      if (!candidates.length) {
        if (expandIfCollapsed(found.disclosure)) {
          scheduleRetry(`${label}: section was collapsed, expanding it...`);
        } else {
          scheduleRetry(`${label}: no clickable candidates yet, retrying...`);
        }
        return;
      }

      const tiles = candidates.filter(el => {
        const body = textOf(el);
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const controls = el.getAttribute("aria-controls") || "";

        // The section's own header toggle and its "about" button are not tiles.
        const isSectionChrome =
          (found.panelId && controls === found.panelId) ||
          el.contains(heading) ||
          heading.contains(el) ||
          wanted.some(name => aria.includes(name));

        // "Expires in" marks a tile's metadata, and the section's own collapse
        // button carries the section name as its label. Both are skipped — but
        // a tile's body text mentioning the name is not, on its own, enough to
        // drop it: only buttons were ever the risky case.
        const isMeta =
          body.includes("expires in") ||
          (el.tagName === "BUTTON" && wanted.some(name => body.includes(name)));

        // Completed tiles render aria-disabled — they won't earn anything and
        // their handlers may not even fire.
        //
        // The Image Creator tile ("create your own wallpaper" and friends)
        // earns its points only on the Image Creator page itself, which a plain
        // click doesn't complete — so opening it just leaves a dead tab behind.
        const href = (el.getAttribute("href") || "").toLowerCase();
        const isImageCreator =
          href.includes("bing.com/images/create") ||
          body.includes("image creator") ||
          body.includes("create and download");

        return (
          !isSectionChrome && !isMeta && !isDisabled(el) && !isImageCreator
        );
      });

      if (!tiles.length) {
        // Candidates exist but none are clickable: the section rendered, its
        // tiles are just all completed or disabled. Retrying won't change that,
        // so report "none" now rather than spinning out the full 10s of retries.
        if (candidates.length) {
          console.warn(
            `${label}: ${candidates.length} candidates, none usable (completed or disabled).`
          );
          finish(0);
          return;
        }
        scheduleRetry(`${label}: no tiles in the section yet, retrying...`);
        return;
      }

      // With skipSpent, spent tiles are dropped before the pool: "completed"
      // and "reward up only" both mean the tile cannot earn. Without it (the
      // daily set), the old incomplete/blind split stands.
      const unspent = skipSpent
        ? tiles.filter(
            el => !SPENT_MARKERS.some(marker => textOf(el).includes(marker))
          )
        : tiles.filter(el => !textOf(el).includes("completed"));

      if (skipSpent && !unspent.length) {
        // Every tile is spent — retrying cannot change that. "0" reports the
        // section as having nothing to open, which is exactly true.
        console.warn(
          `${label}: ${tiles.length} tiles, all spent (completed or reward up only) — nothing to open.`
        );
        finish(0);
        return;
      }

      const pool = unspent.length ? unspent : tiles;
      const cap = unspent.length ? limit : Math.min(limit, BLIND_LIMIT);
      const toClick = pool.slice(0, cap);

      if (pool.length > toClick.length) {
        console.warn(
          `${label}: ${pool.length} activities available, opening ${toClick.length} (limit).`
        );
      }
      console.log(`${label}: clicking ${toClick.length} of ${tiles.length} tiles.`);

      let opened = 0;
      toClick.forEach((el, idx) => {
        setTimeout(async () => {
          if (!(await allowed())) { finish(-1); return; }
          try {
            if (el && typeof el.click === "function") { el.click(); opened++; }
          } catch { finish(-1); }
        }, idx * CLICK_DELAY_MS);
      });

      setTimeout(
        () => finish(opened),
        toClick.length * CLICK_DELAY_MS + 500
      );
    }

    void tryFindAndClick().catch(() => finish(-1));
  });
}

// Claims the Rewards Dashboard's pending points: the "Ready to claim" tile
// opens a react-aria side panel (section[role="dialog"]) whose claim card is
// one big button — clicking it claims everything pending at once.
//
// The UI strings matched here ("Ready to claim", "Claim points", the outcome
// texts) are English-only — the same limitation openRewardsSectionTiles
// already accepts when it matches on the section headings.
//
// The tile click is retried while the page still shows the tile collapsed
// and no dialog is open at all — a click lost to a react-aria re-render or a
// not-yet-hydrated tree would otherwise leave the panel forever shut (live
// regression, 2026-09-03: "panel did not open"). Every failure branch dumps
// the markup it was staring at to this console, the same contract as the
// redeem watch, because this DOM is unreachable from the test fixtures: the
// dashboard redesign of 2026-09 (Tailwind streak cards) proved the live
// markup can drift under a passing suite.
//
// Resolves one of:
//   { outcome: "claimed", points }   — the panel said "Successfully claimed!"
//   { outcome: "nothing" }           — no pending points (the tile/verdict said so)
//   { outcome: "failed", reason }    — the panel never opened / the card was
//                                      missing / the panel reported an error
//   { outcome: "unknown", points }   — clicked, but no verdict before timeout
// The failed and unknown outcomes also carry `dump` — the markup the branch
// was staring at — which reportClaimResult forwards into the Activity row
// (the same contract as the redeem watch and the stats read).
export function claimDashboardPoints(timeoutMs: number, lease?: { stopEpoch: number; expiresAt: number }) {
  return new Promise(resolve => {
    let settled = false;
    const expiresAt = Math.min(lease?.expiresAt || Date.now() + 40000, Date.now() + 40000);
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      resolve(value);
    };
    const expiry = setTimeout(() => finish({ outcome: "unknown", reason: "claim deadline expired" }), Math.max(0, expiresAt - Date.now()));
    const cancelled = () => finish({ outcome: "cancelled", reason: "stopped or expired" });
    const allowed = async () => {
      if (settled || Date.now() >= expiresAt) return false;
      if (!lease) return true;
      try {
        const { runState } = await chrome.storage.local.get('runState');
        return !settled && Date.now() < expiresAt && runState?.stopEpoch === lease.stopEpoch;
      } catch { return false; }
    };
    const TILE_POLL_ATTEMPTS = 20;  // ~10s for the dashboard to hydrate — the
                                    // stats reader waits 12s for the same
                                    // reason, and a slow tile render would
                                    // otherwise read as "nothing to claim"
    const PANEL_WAIT_MS = 10000;    // the panel slides in; give it time
    const BUTTON_POLL_ATTEMPTS = 6; // the card renders with the panel
    const POLL_INTERVAL_MS = 500;

    const waitMs = Math.max(1000, Number(timeoutMs) || 15000);
    const deadline = Date.now() + waitMs;

    const textOf = el =>
      (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();

    function after(ms, fn) {
      setTimeout(async () => {
        if (!(await allowed())) { cancelled(); return; }
        try { await fn(); } catch (e) { finish({ outcome: "failed", reason: String(e?.message || e) }); }
      }, ms);
    }

    // Press the way a real mouse does (the stats read's pressButton, copied
    // here because an injected function must be self-contained): a
    // pointerdown/pointerup pair with a mouse pointerType, the element's own
    // center as the coordinates, and non-zero size and pressure (react-aria
    // reads a zero-sized pointer event as a screen-reader tap and ignores the
    // sequence), then the plain click. The live dashboard's current build
    // ignores bare element.click() on its react-aria controls (proven by the
    // search-points flyout, 2026-09-05), and the claim's "still processing
    // when we stopped watching" report is the same signature: the panel was
    // open (the dashboard renders it open), the claim card was found and
    // virtually pressed, the page ignored it, no verdict ever rendered. The
    // trailing click keeps click-only handlers (every static fixture)
    // working, and inside usePress the whole sequence is exactly one press.
    async function click(el) {
      if (!(await allowed())) { cancelled(); return false; }
      if (!el || typeof el.click !== "function") return;
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
      return true;
    }

    // The tile is a <button>; the sibling "Available points" tile is an <a>
    // whose label says "Redeem", so the text match can't pick it up. The
    // 2026-09 redesign renders its cards as plain divs whose only click
    // affordance is Tailwind's cursor-pointer class, so those are searched
    // too — buttons first, because the older markup must keep matching.
    function findTile() {
      const buttons = Array.from(
        document.querySelectorAll("button[aria-controls], button")
      );
      const byButton = buttons.find(el =>
        textOf(el).includes("ready to claim")
      );
      if (byButton) return byButton;
      const cards = Array.from(document.querySelectorAll("div.cursor-pointer"));
      return cards.find(el => textOf(el).includes("ready to claim")) || null;
    }

    // Prefer a dialog that says "Claim points"; fall back to whatever dialog
    // is open while the tile says it is expanded — the 2026-09 redesign
    // changed panel headings once already, and the tile's aria-expanded is
    // the page's own answer to "did the click work?".
    function findDialog(tile) {
      const dialogs = Array.from(
        document.querySelectorAll('section[role="dialog"], [role="dialog"]')
      );
      const byText = dialogs.find(el => textOf(el).includes("claim points"));
      if (byText) return byText;
      if (
        tile &&
        tile.getAttribute("aria-expanded") === "true" &&
        dialogs.length
      ) {
        return dialogs[0];
      }
      return null;
    }

    function isDismiss(el) {
      const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      return aria === "close" || aria === "dismiss";
    }

    // The claim card is the panel's big <button>. The h2 title is not a
    // button, and the Close button carries its label in aria-label rather
    // than text, so the text filter excludes both — the aria-label check is
    // belt-and-braces. Redesigned panels may render the card as a
    // role="button" div or a cursor-pointer card (like the streak tiles), so
    // those are fallbacks behind the buttons, matched on "claim" alone (no
    // word boundaries: adjacent text nodes can concatenate to
    // "…pointsClaim") in case the label drifted from "Claim points".
    function findClaimButton(dialog) {
      const buttons = Array.from(dialog.querySelectorAll("button"));
      const byText = buttons.find(
        el => !isDismiss(el) && textOf(el).includes("claim points")
      );
      if (byText) return byText;
      const byWord = buttons.find(
        el => !isDismiss(el) && /claim/i.test(textOf(el))
      );
      if (byWord) return byWord;
      const others = Array.from(
        dialog.querySelectorAll('[role="button"], div.cursor-pointer')
      );
      return (
        others.find(el => !isDismiss(el) && /claim/i.test(textOf(el))) || null
      );
    }

    function isDisabled(el) {
      return (
        el.disabled === true ||
        el.getAttribute("aria-disabled") === "true" ||
        el.hasAttribute("data-disabled")
      );
    }

    // The pending points sit inside the card, e.g. "456 Pending Claim points"
    // — the pageHeader <p> holds the number when the class is present.
    function pointsIn(card) {
      const para = card.querySelector("p.text-pageHeader");
      const source = para ? textOf(para) : textOf(card);
      const match = source.match(/\d+/);
      return match ? Number(match[0]) : null;
    }

    // Step 1: the tile. It does not render at all when nothing is pending, so
    // "never appeared" and "nothing to claim" are the same thing.
    function waitForTile(attempt) {
      const tile = findTile();
      if (tile) {
        return openPanel(tile);
      }
      if (attempt < TILE_POLL_ATTEMPTS) {
        after(POLL_INTERVAL_MS, () => waitForTile(attempt + 1));
      } else {
        console.warn("Claim: no 'Ready to claim' tile on the page.");
        finish({ outcome: "nothing" });
      }
    }

    // Step 2: the panel. It may already be open when we arrive, in which case
    // the tile is left unclicked.
    async function openPanel(tile) {
      const dialog = findDialog(tile);
      if (dialog) {
        return waitForClaimButton(dialog, 0);
      }
      if (!(await click(tile))) return;
      waitForPanel(0);
    }

    // The tile click can be lost twice over: fired into a not-yet-hydrated
    // tree, or onto a node a react-aria re-render swapped out. So the wait
    // re-clicks the tile (at most every 1.5s) while the page still shows it
    // collapsed AND no dialog is open at all. Both guards matter: a click
    // that landed flips the tile's aria-expanded, and re-clicking into an
    // opening panel would toggle it shut again.
    async function waitForPanel(waitedMs) {
      // Re-query each time: react-aria re-renders can replace the node.
      const tile = findTile();
      const dialog = findDialog(tile);
      if (dialog) {
        return waitForClaimButton(dialog, 0);
      }
      if (waitedMs < PANEL_WAIT_MS) {
        const pageShowsNothingOpen =
          !document.querySelector('[role="dialog"]') &&
          (!tile || tile.getAttribute("aria-expanded") !== "true");
        if (tile && waitedMs > 0 && waitedMs % 1500 === 0 && pageShowsNothingOpen) {
          if (!(await click(tile))) return;
        }
        after(POLL_INTERVAL_MS, () => waitForPanel(waitedMs + POLL_INTERVAL_MS));
      } else {
        // Same contract as the redeem watch: this DOM is unreachable from
        // the fixtures, so a real failure ships us the markup to fix against.
        // The dump also travels in the result (result.dump) into the popup's
        // Activity row, because the service worker console is not a place
        // the user can go ("all errors should be available at the Activity
        // section", 2026-09-05).
        const anyDialog = document.querySelector('[role="dialog"]');
        const parts = [];
        if (tile) {
          console.warn(
            "Claim: tile markup (report to dev):",
            tile.outerHTML.slice(0, 1500)
          );
          parts.push("tile: " + tile.outerHTML.slice(0, 1500));
        }
        if (anyDialog) {
          console.warn(
            "Claim: dialog markup (report to dev):",
            anyDialog.outerHTML.slice(0, 1500)
          );
          parts.push("dialog: " + anyDialog.outerHTML.slice(0, 1500));
        }
        console.warn("Claim: the claim panel did not open.");
        finish({
          outcome: "failed",
          reason: "panel did not open",
          dump: parts.join(" ")
        });
      }
    }

    // Step 3: the claim card inside the panel.
    function waitForClaimButton(dialog, attempt) {
      const button = findClaimButton(dialog);
      if (button && !isDisabled(button)) {
        return claimIt(dialog, button);
      }

      // A panel with nothing pending says so in words rather than offering a
      // card, and a disabled card that never recovers is the same verdict.
      if (textOf(dialog).includes("no points to claim")) {
        finish({ outcome: "nothing" });
        return;
      }

      if (attempt < BUTTON_POLL_ATTEMPTS) {
        after(POLL_INTERVAL_MS, () => waitForClaimButton(dialog, attempt + 1));
      } else {
        console.warn(
          "Claim: panel markup (report to dev):",
          dialog.outerHTML.slice(0, 1500)
        );
        console.warn("Claim: claim card not found in the panel.");
        finish({
          outcome: "failed",
          reason: "claim button not found",
          dump: dialog.outerHTML.slice(0, 1500)
        });
      }
    }

    // Steps 4+5: capture the points, click once, poll for the verdict.
    async function claimIt(dialog, button) {
      const points = pointsIn(button);
      if (!(await click(button))) return;
      waitForOutcome(dialog, points);
    }

    function waitForOutcome(dialog, points) {
      // Re-query so a re-render can't leave us reading a detached node — and
      // a panel that vanished entirely is no longer a "fall back to the
      // stale one" case: a successful claim can close the panel (react-aria
      // unmounts it) and put its verdict anywhere else on the page, and the
      // old watch polled the dead node's frozen text forever — the live
      // "still processing when we stopped watching" report (2026-09-05,
      // three times: the watch itself was blind to every outcome outside
      // the panel). The tile is handed to findDialog for the same reason
      // openPanel hands it over: a redesigned panel without a "Claim
      // points" heading is only identifiable by the expanded tile.
      const tile = findTile();
      const live = findDialog(tile);
      const panel = live ? textOf(live) : "";
      // The verdict scan covers the whole rendered page. innerText, not
      // textContent: the page's RSC payloads inside <script> tags are
      // textContent but never rendered, and must not answer.
      const page = ((document.body && document.body.innerText) || "")
        .replace(/\s+/g, " ")
        .toLowerCase();

      if (
        panel.includes("successfully claimed") ||
        page.includes("successfully claimed")
      ) {
        finish({ outcome: "claimed", points });
        return;
      }
      if (panel.includes("no points to claim") || page.includes("no points to claim")) {
        finish({ outcome: "nothing" });
        return;
      }
      if (panel.includes("error claiming") || page.includes("error claiming")) {
        finish({
          outcome: "failed",
          reason: "error message shown",
          dump: (live || document.body).outerHTML.slice(0, 1500)
        });
        return;
      }

      if (!live) {
        // The panel is gone. The "Ready to claim" tile only renders while
        // points are pending, so tile and panel both gone is the page's
        // own "done": the claim went through.
        if (!tile) {
          finish({ outcome: "claimed", points });
          return;
        }
        // The panel shut but the tile still offers points: keep waiting — a
        // re-render may re-open it with the verdict. The deadline branch
        // dumps the page if it never does.
      }

      // Anything else — "Claiming" in progress, the card gone or disabled
      // with no verdict yet — is still worth waiting for.
      if (Date.now() >= deadline) {
        // With the panel gone there is no panel markup to dump; the rendered
        // page is the evidence (what the page chose to show instead).
        const dump = live
          ? live.outerHTML.slice(0, 1500)
          : "page: " + page.slice(0, 1500);
        console.warn("Claim: panel markup at timeout (report to dev):", dump);
        console.warn("Claim: timed out waiting for the outcome.");
        finish({ outcome: "unknown", points, dump });
        return;
      }
      after(POLL_INTERVAL_MS, () => waitForOutcome(live || dialog, points));
    }

    try {
      after(0, () => waitForTile(0));
    } catch (e) {
      // Never throw to the caller: an unreadable page reports failure instead.
      finish({ outcome: "failed", reason: String((e && e.message) || e) });
    }
  });
}
