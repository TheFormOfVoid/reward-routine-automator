import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { withDeadline } from '../src/background/pure/search-recovery.ts'
import { clickVisualSearchButton, probeVisualSearchTarget, attachRandomImageToVisualSearch } from '../src/background/injections/visual-search.ts'

async function imageRun(mode: 'success' | 'fetch-hang' | 'camera-hang' | 'stop') {
  const reports: any[][] = [], injections: any[] = []
  let epoch = 0, holds = 0, closed = 0, tabs = 0
  const camera = () => {}, probe = () => {}, attach = () => {}
  const context = createContext({
    console: { warn() {} }, Date,
    beginActivity: async () => 0, currentStopEpoch: async () => epoch,
    endActivity: async () => {}, holdKeepAlive: () => holds++, releaseKeepAlive: () => holds--,
    reportImageSearch: async (...args: any[]) => { reports.push(args) },
    fetchRandomImageData: () => mode === 'fetch-hang' ? new Promise(() => {}) :
      Promise.resolve({ base64: 'fixture', mimeType: 'image/png', source: 'fixture' }),
    withDeadline: (work: Promise<any>, _ms: number, label: string) => withDeadline(work, 5, label),
    beginTabCapture: async () => {}, claimTab: async () => {},
    closeCapturedTabs: async () => { closed++ },
    createNormalTab: async (_url: string, active: boolean) => { assert.equal(active, true); tabs++; return { id: 7 } },
    waitForTabComplete: async () => { if (mode === 'stop') epoch++; return true },
    sleep: async () => {},
    clickVisualSearchButton: camera, probeVisualSearchTarget: probe, attachRandomImageToVisualSearch: attach,
    chrome: { scripting: { executeScript: (options: any) => {
      injections.push(options)
      if (options.func === camera) return mode === 'camera-hang' ? new Promise(() => {}) : Promise.resolve([{ result: { ok: true, detail: 'camera' } }])
      if (options.func === probe) return Promise.resolve([{ frameId: 3, result: { candidate: true, hasFileInput: true } }])
      return Promise.resolve([{ result: { ok: true, detail: 'file input' } }])
    } } },
  })
  const source = readFileSync(new URL('../src/background/images/image-search.ts', import.meta.url), 'utf8')
  runInContext(stripTypeScriptTypes(source)
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^export /gm, ''), context)
  await runInContext('runRandomImageSearch()', context)
  return { reports, injections, holds, closed, tabs }
}

test('image upload selects a normal tab and targets only the discovered frame with an expiry', async () => {
  const h = await imageRun('success')
  assert.equal(h.tabs, 1)
  assert.equal(h.injections.length, 3)
  assert.equal(h.injections[2].target.frameIds[0], 3)
  assert.equal(h.injections[2].args[0], 'fixture')
  assert.ok(h.injections[2].args[3] > Date.now())
  assert.equal(h.reports.at(-1)?.[1], true)
  assert.equal(h.holds, 0)
  assert.equal(h.closed, 1)
})

test('hung image fetch and camera replies terminate with failure and release the worker hold', async () => {
  for (const mode of ['fetch-hang', 'camera-hang'] as const) {
    const h = await imageRun(mode)
    assert.equal(h.reports.at(-1)?.[1], false)
    assert.equal(h.holds, 0)
    assert.equal(h.tabs, mode === 'fetch-hang' ? 0 : 1)
  }
})

test('Stop during page load prevents the camera and upload effects', async () => {
  const h = await imageRun('stop')
  assert.equal(h.injections.length, 0)
  assert.equal(h.holds, 0)
})

test('expired page-side visual-search injections refuse to touch the DOM', () => {
  const expired = Date.now() - 1
  assert.equal(clickVisualSearchButton(expired).ok, false)
  assert.equal(probeVisualSearchTarget(true, expired).candidate, false)
  assert.equal(attachRandomImageToVisualSearch('fixture', 'image/png', true, expired).ok, false)
})
