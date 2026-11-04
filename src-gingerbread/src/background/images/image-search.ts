// The image-search step: fetch a random image, open a Bing tab, click the
// visual-search (camera) icon, then hand the upload dialog the image.
//
// Bing renders that dialog inside an iframe, so the file input does not exist
// in the top frame. Phase 1 clicks the icon in the top frame; phase 2 probes
// every frame until one of them exposes an upload target, then hands the
// image to that frame alone.

import { beginActivity, endActivity, currentStopEpoch } from '../core/run-state.ts'
import { sleep } from '../core/delays.ts'
import { holdKeepAlive, releaseKeepAlive } from '../core/keepalive.ts'
import { withDeadline } from '../pure/search-recovery.ts'
import { createNormalTab } from '../core/normal-tabs.ts'
import { beginTabCapture, closeCapturedTabs, claimTab, waitForTabComplete } from '../core/tabs.ts'
import { reportImageSearch } from '../core/log.ts'
import { fetchRandomImageData } from './sources.ts'
import {
  clickVisualSearchButton,
  probeVisualSearchTarget,
  attachRandomImageToVisualSearch,
} from '../injections/visual-search.ts'

const VISUAL_SEARCH_ATTEMPTS = 24
const VISUAL_SEARCH_INTERVAL_MS = 500
const INJECTION_TIMEOUT_MS = 10000

export async function runRandomImageSearch(): Promise<void> {
  // Marks this run as the current activity so the popup's Stop button covers
  // it too; the returned epoch tells this run when it has been stopped.
  const myEpoch = await beginActivity('Image search')
  const stopped = (): Promise<boolean> => currentStopEpoch().then((v) => v !== myEpoch)
  holdKeepAlive()

  try {
    await reportImageSearch('fetching a random image')

    const imgData = await withDeadline(fetchRandomImageData(), 30000, 'Image sources')
    if (!imgData.base64) {
      await reportImageSearch(`failed - every image source failed (${imgData.error})`, false)
      return
    }

    // Stop checkpoint before any tab work: nothing has been opened yet, so
    // stopping here leaves nothing behind at all.
    if (await stopped()) {
      await reportImageSearch('stopped', false)
      return
    }

    await reportImageSearch(`got image from ${imgData.source}, opening Bing`)

    await beginTabCapture('imageSearch')
    try {
      // base64 is guarded above, and every source that yields base64 also
      // yields mimeType — the loose result shape just doesn't narrow both.
      await attachImageOnBing({ base64: imgData.base64, mimeType: imgData.mimeType as string }, stopped)
    } finally {
      await closeCapturedTabs('imageSearch', 'closeTabsAfterImageSearch')
    }
  } catch (error) {
    await reportImageSearch((await stopped()) ? 'stopped' : `failed - ${(error as Error).message}`, false)
  } finally {
    try { await endActivity('Image search') } finally { releaseKeepAlive() }
  }
}

interface ImageData {
  base64: string
  mimeType: string
}

// The caller passes its stopped() helper so a mid-poll stop is honored here.
async function attachImageOnBing(imgData: ImageData, stopped: () => Promise<boolean>): Promise<void> {
  const bingTab = await createNormalTab('https://www.bing.com/', true)
  const bingTabId = bingTab.id
  if (bingTabId == null) {
    await reportImageSearch('failed - could not open Bing tab', false)
    return
  }
  await claimTab('imageSearch', bingTabId)

  const loaded = await waitForTabComplete(bingTabId)
  if (!loaded) console.warn('Image search: tab did not finish loading in time.')
  if (await stopped()) return

  // Phase 1: press the camera icon in the top frame.
  let clicked: { ok: boolean; detail: string } | null | undefined = null
  try {
    const [injection] = await withDeadline(chrome.scripting.executeScript({
      target: { tabId: bingTabId, frameIds: [0] },
      func: clickVisualSearchButton,
      args: [Date.now() + INJECTION_TIMEOUT_MS],
    }), INJECTION_TIMEOUT_MS, 'Image camera injection')
    clicked = injection && injection.result
  } catch (e) {
    console.warn('Image search: camera click injection failed:', e)
  }

  if (!clicked || !clicked.ok) {
    const why = (clicked && clicked.detail) || 'injection failed'
    await reportImageSearch(`failed - camera icon not found (${why})`, false)
    return
  }

  await reportImageSearch(`clicked camera (${clicked.detail}), waiting for dialog`)

  // Phase 2: wait for the dialog and give it the image. Two-phase on purpose:
  // the base64 image is tens of KB, and marshalling it into every frame on
  // every attempt is pure waste — a cheap argless probe finds the frame
  // first, and only that frame ever receives the payload.
  for (let attempt = 1; attempt <= VISUAL_SEARCH_ATTEMPTS; attempt++) {
    // Stop checkpoint: attempt 1 follows the pre-capture check in the caller
    // closely enough, but the poll itself can run for ~12s — without this, a
    // stopped run would keep injecting until a frame accepts the image.
    if (await stopped()) {
      await reportImageSearch('stopped', false)
      return
    }

    // Hold the drag-drop and paste routes back until the end: neither can be
    // verified, so guessing early would stop us before the iframe appears.
    const allowFallbacks = attempt > VISUAL_SEARCH_ATTEMPTS - 4

    let probes: chrome.scripting.InjectionResult<{ candidate: boolean; hasFileInput: boolean }>[] = []
    try {
      probes = await withDeadline(chrome.scripting.executeScript({
        target: { tabId: bingTabId, allFrames: true },
        func: probeVisualSearchTarget,
        args: [allowFallbacks, Date.now() + INJECTION_TIMEOUT_MS],
      }), INJECTION_TIMEOUT_MS, 'Image dialog probe')
    } catch (e) {
      console.warn('Image search: probe injection failed:', e)
      break
    }

    // A real file input beats an unverifiable fallback in another frame, so
    // prefer a frame that reported one; execution results carry their
    // frameId, which is what targets the payload injection below.
    const candidate =
      probes.find((r) => r && r.result && r.result.hasFileInput) ||
      probes.find((r) => r && r.result && r.result.candidate)

    if (await stopped()) return
    if (candidate) {
      let results: chrome.scripting.InjectionResult<{ ok: boolean; detail: string }>[] = []
      try {
        results = await withDeadline(chrome.scripting.executeScript({
          target: { tabId: bingTabId, frameIds: [candidate.frameId] },
          func: attachRandomImageToVisualSearch,
          args: [imgData.base64, imgData.mimeType, allowFallbacks, Date.now() + INJECTION_TIMEOUT_MS],
        }), INJECTION_TIMEOUT_MS, 'Image upload injection')
      } catch (e) {
        console.warn('Image search: attach injection failed:', e)
        break
      }

      const wins = results
        .filter((r) => r && r.result && r.result.ok)
        .map((r) => r.result as { ok: boolean; detail: string })
      // A real file input beats an unverifiable fallback.
      const win = wins.find((w) => w.detail.includes('file input')) || wins[0]

      if (win) {
        await reportImageSearch(`image handed to Bing via ${win.detail}`, true)
        return
      }
    }

    await sleep(VISUAL_SEARCH_INTERVAL_MS)
  }

  await reportImageSearch('failed - no frame exposed a file input', false)
}
