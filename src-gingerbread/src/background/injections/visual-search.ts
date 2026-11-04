// @ts-nocheck
// The visual-search injections — the page-side halves of the image-search
// step. VERBATIM page-side port from src-froyo/injections/visual-search.js. Each
// function's source is handed to chrome.scripting.executeScript({func}), which
// serializes it with .toString(), so each must be fully self-contained: no
// imports, no closures over module state (see ADR-017). @ts-nocheck because
// these run against the live page (not the worker's lib.dom view) and are
// validated by browser/live runs, not the type-checker; the typed signatures
// below are still exported for callers.

// Runs in the top frame of https://www.bing.com/ — finds and presses the
// camera icon that opens Bing's "search using an image" dialog.
export function clickVisualSearchButton(expiresAt = 0): { ok: boolean; detail: string } {
  if (expiresAt && Date.now() >= expiresAt) return { ok: false, detail: 'expired attempt' };
  // Bing's markup varies by page and A/B experiment, so try stable ids first.
  const SELECTORS = [
    "#sbsbi",                  // camera on the Bing homepage
    "#sb_sbi",                 // camera in the results-page search box
    "#sbi_b",
    ".sbihpicn[role='button']",
    ".sbicampl",
    "[aria-label*='search using an image' i]",
    "[aria-label*='search by image' i]",
    "[aria-label*='visual search' i]",
    "[title*='search using an image' i]",
    "[title*='visual search' i]"
  ];

  // Whole phrases only. A bare "image" would match the Images nav link and
  // navigate the tab away instead of opening the dialog.
  const LABEL_PHRASES = [
    "search using an image",
    "search by image",
    "search with an image",
    "visual search",
    "باستخدام صورة" // ar: "using an image"
  ];

  // Clicking a <label> bound to a file input opens the OS file picker, which
  // an extension cannot drive — that would hang the whole flow.
  function opensOsPicker(el) {
    if (!el) return true;
    if (el.tagName === "LABEL") return true;
    if (typeof el.querySelector === "function" && el.querySelector('input[type="file"]')) {
      return true;
    }
    const forId = el.getAttribute && el.getAttribute("for");
    if (forId) {
      const bound = document.getElementById(forId);
      if (bound && bound.type === "file") return true;
    }
    return false;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function findButton() {
    for (const selector of SELECTORS) {
      let matches = [];
      try {
        matches = Array.from(document.querySelectorAll(selector));
      } catch (e) {
        continue; // selector syntax unsupported here
      }

      const usable = matches.filter(el => !opensOsPicker(el));
      const hit = usable.find(isVisible) || usable[0];
      if (hit) return { el: hit, detail: selector };
    }

    const candidates = Array.from(
      document.querySelectorAll(
        "button, a, div[role='button'], span[role='button']"
      )
    );

    for (const el of candidates) {
      const label = (
        el.getAttribute("aria-label") ||
        el.title ||
        el.innerText ||
        ""
      ).toLowerCase();

      if (LABEL_PHRASES.some(phrase => label.includes(phrase)) && !opensOsPicker(el)) {
        return { el, detail: `label "${label.trim().slice(0, 40)}"` };
      }
    }

    return null;
  }

  const found = findButton();
  if (!found) return { ok: false, detail: "no camera icon in the top frame" };

  found.el.scrollIntoView({ block: "center" });
  // Exactly one click: some Bing handlers toggle the dialog, so a synthetic
  // pointerdown followed by a click would open and immediately close it.
  found.el.click();

  return { ok: true, detail: found.detail };
}

// Runs in EVERY frame of the Bing tab, but carries no payload: it only
// reports whether this frame holds something attachRandomImageToVisualSearch
// below could use, so the worker can marshal the base64 image into the one
// frame that answered yes instead of into all of them on every attempt.
export function probeVisualSearchTarget(allowFallbacks: boolean, expiresAt = 0): { candidate: boolean; hasFileInput: boolean } {
  if (expiresAt && Date.now() >= expiresAt) return { candidate: false, hasFileInput: false };
  const byId = ["sb_fileinput", "sbfileinput", "sbi_file", "vs_fileinput"]
    .map(id => document.getElementById(id))
    .filter(el => el && el.type === "file");

  const all = Array.from(document.querySelectorAll('input[type="file"]'));
  const ordered = byId.concat(all.filter(el => !byId.includes(el)));
  const fileInput =
    ordered.find(el => !el.accept || /image/i.test(el.accept)) || ordered[0];

  if (fileInput) return { candidate: true, hasFileInput: true };
  if (!allowFallbacks) return { candidate: false, hasFileInput: false };

  // With fallbacks allowed every frame is a candidate: the paste route below
  // needs only a text field, or failing that the body — exactly the frames
  // the attach function would have tried anyway.
  return { candidate: true, hasFileInput: false };
}

// Runs in the ONE frame the probe flagged as holding the upload dialog.
export function attachRandomImageToVisualSearch(
  imageBase64: string,
  mimeType: string,
  allowFallbacks: boolean,
  expiresAt = 0
): { ok: boolean; detail: string } {
  if (expiresAt && Date.now() >= expiresAt) return { ok: false, detail: 'expired attempt' };
  function frameNote() {
    return window.top === window
      ? "top frame"
      : `iframe ${location.host}${location.pathname}`;
  }

  function makeFile() {
    const binary = atob(imageBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType || "image/jpeg" });
    return new File([blob], "random-image.jpg", { type: blob.type });
  }

  function transferWith(file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }

  const byId = ["sb_fileinput", "sbfileinput", "sbi_file", "vs_fileinput"]
    .map(id => document.getElementById(id))
    .filter(el => el && el.type === "file");

  const all = Array.from(document.querySelectorAll('input[type="file"]'));
  const ordered = byId.concat(all.filter(el => !byId.includes(el)));
  const target =
    ordered.find(el => !el.accept || /image/i.test(el.accept)) || ordered[0];

  if (target) {
    try {
      target.files = transferWith(makeFile()).files;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        detail: `file input${target.id ? " #" + target.id : ""} in ${frameNote()}`
      };
    } catch (e) {
      return { ok: false, detail: `file input rejected the image: ${e}` };
    }
  }

  if (!allowFallbacks) {
    return { ok: false, detail: `no file input in ${frameNote()}` };
  }

  // The dialog also takes a dragged or pasted image. Neither route reports
  // back, so these are last-resort attempts and flagged unverified.
  const dropTarget =
    document.querySelector(
      "[data-drop-target], .vs_dropzone, #sb_vsdrop, [class*='dropzone' i], [class*='drop-zone' i]"
    ) ||
    Array.from(document.querySelectorAll("div, section, form")).find(el => {
      // The children count is the cheap test, so it gates the text read; and
      // textContent rather than innerText — innerText forces a layout per
      // element, which this scan must not do in the user's tab.
      if (el.children.length >= 30) return false;
      const text = (el.textContent || "").toLowerCase();
      return text.includes("drag") && text.includes("drop");
    });

  if (dropTarget) {
    const dt = transferWith(makeFile());
    for (const type of ["dragenter", "dragover", "drop"]) {
      dropTarget.dispatchEvent(
        new DragEvent(type, {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          composed: true
        })
      );
    }
    return { ok: true, detail: `drop target in ${frameNote()} (unverified)` };
  }

  try {
    const pasteTarget =
      document.querySelector("input[type='text'], textarea") || document.body;
    pasteTarget.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transferWith(makeFile()),
        bubbles: true,
        cancelable: true
      })
    );
    return { ok: true, detail: `paste into ${frameNote()} (unverified)` };
  } catch (e) {
    return {
      ok: false,
      detail: `no file input, drop target, or paste route in ${frameNote()}`
    };
  }
}
