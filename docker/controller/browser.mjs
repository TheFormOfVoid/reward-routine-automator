// Chromium lifecycle: launch with the extension and the persistent profile,
// talk to it over CDP, and shut it down cleanly.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Cdp } from './cdp.mjs'
import { log } from './log.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Settings the controller owns. The controller is the clock, so the
// extension's own start triggers stay off: no run on browser start, no
// in-extension schedule, no 15s confirm window nobody is there to answer, and
// no all-day "prowl" searches. Low-power mode keeps the Pi's CPU free.
export const CONTROLLED_SETTINGS = {
  startupEnabled: false,
  confirmBeforeRoutine: false,
  scheduledRunEnabled: false,
  randomSearchEnabled: false,
  restockWatcherEnabled: false,
  lowPowerMode: true,
  animationsEnabled: false,
  background: 'none',
}

export class BrowserError extends Error {
  constructor(message, code = 'BROWSER') { super(message); this.code = code }
}

export class Browser {
  constructor(cfg) {
    this.cfg = cfg
    this.proc = null
    this.cdp = null
    this.extensionId = null
    this.pageSession = null
    this.startedAt = 0
    this.purpose = null
  }

  get running() { return this.proc != null && this.proc.exitCode == null && this.proc.signalCode == null }

  async launch(purpose) {
    if (this.running) { this.purpose = purpose; return }
    const { chromiumPath, profileDir, extensionDir, debugPort } = this.cfg
    fs.mkdirSync(profileDir, { recursive: true })
    // A container killed mid-run leaves these behind, and Chromium then
    // refuses the profile as "in use by another computer".
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.rmSync(path.join(profileDir, f), { force: true }) } catch {}
    }
    const args = [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--lang=en-US',
      `--window-size=${this.cfg.screenWidth},${this.cfg.screenHeight}`,
      '--window-position=0,0',
      ...this.cfg.extraChromiumArgs,
      'about:blank',
    ]
    log.info(`Starting Chromium (${purpose})`)
    this.proc = spawn(chromiumPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, DISPLAY: this.cfg.display },
    })
    this.purpose = purpose
    this.startedAt = Date.now()
    let stderrTail = ''
    this.proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000) })
    this.proc.on('exit', (code, signal) => {
      if (this.proc && (code != null || signal)) log.info(`Chromium exited (${signal || code})`)
      this.cdp?.close()
      this.cdp = null
      this.pageSession = null
    })
    try {
      await this.connect()
      await this.findExtension()
      await this.openControlPage()
      await this.applySettings()
    } catch (e) {
      log.error(`Chromium start failed: ${e.message}${stderrTail ? `\n${stderrTail.trim().split('\n').slice(-8).join('\n')}` : ''}`)
      await this.close()
      throw e instanceof BrowserError ? e : new BrowserError(e.message)
    }
  }

  async connect() {
    const deadline = Date.now() + 45000
    let lastErr
    while (Date.now() < deadline) {
      if (!this.running) throw new BrowserError('Chromium exited during startup')
      try {
        const res = await fetch(`http://127.0.0.1:${this.cfg.debugPort}/json/version`)
        const info = await res.json()
        this.cdp = await Cdp.connect(info.webSocketDebuggerUrl)
        log.info(`Connected to ${info.Browser}`)
        return
      } catch (e) { lastErr = e }
      await sleep(500)
    }
    throw new BrowserError(`DevTools endpoint never came up: ${lastErr?.message}`)
  }

  async findExtension() {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const { targetInfos } = await this.cdp.send('Target.getTargets')
      const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'))
      if (sw) {
        this.extensionId = new URL(sw.url).host
        return
      }
      await sleep(500)
    }
    throw new BrowserError('The Reward Routine extension did not load (no service worker found)', 'EXTENSION')
  }

  // A blank page in the extension's origin: it has chrome.runtime and
  // chrome.storage, and loads none of the extension's React UI.
  async openControlPage() {
    const url = `chrome-extension://${this.extensionId}/manifest.json`
    const { targetId } = await this.cdp.send('Target.createTarget', { url, background: true })
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    this.controlTargetId = targetId
    this.pageSession = sessionId
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        const ok = await this.cdp.evaluate(sessionId, '() => typeof chrome !== "undefined" && !!chrome.runtime?.id')
        if (ok) return
      } catch {}
      await sleep(300)
    }
    throw new BrowserError('Extension control page has no chrome.runtime', 'EXTENSION')
  }

  async ext(fnSource, arg, opts) {
    if (!this.cdp || !this.pageSession) throw new BrowserError('Browser is not connected')
    return this.cdp.evaluate(this.pageSession, fnSource, arg, opts)
  }

  async applySettings() {
    const result = await this.ext(`async (patch) => {
      const { settings = {} } = await chrome.storage.sync.get('settings')
      const changed = Object.keys(patch).filter((k) => settings[k] !== patch[k])
      if (changed.length) await chrome.storage.sync.set({ settings: { ...settings, ...patch } })
      return changed
    }`, CONTROLLED_SETTINGS)
    if (result?.length) log.info(`Applied controller settings: ${result.join(', ')}`)
  }

  async sendMessage(message, { timeoutMs = 30000 } = {}) {
    return this.ext('(m) => chrome.runtime.sendMessage(m)', message, { timeoutMs })
  }

  async readLocal(keys) {
    return this.ext('(k) => chrome.storage.local.get(k)', keys)
  }

  extensionVersion() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.cfg.extensionDir, 'manifest.json'), 'utf8')).version
    } catch { return 'unknown' }
  }

  // Open a page in a normal tab and report where it ended up.
  async probePage(url, { settleMs = 6000, timeoutMs = 45000 } = {}) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url, background: true })
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    try {
      const deadline = Date.now() + timeoutMs
      let state = 'loading'
      while (Date.now() < deadline) {
        try { state = await this.cdp.evaluate(sessionId, '() => document.readyState', null, { timeoutMs: 5000 }) } catch {}
        if (state === 'complete') break
        await sleep(500)
      }
      await sleep(settleMs)
      return await this.cdp.evaluate(sessionId, `() => ({
        href: location.href,
        title: document.title,
        text: (document.body?.innerText || '').slice(0, 4000),
      })`, null, { timeoutMs: 10000 })
    } finally {
      await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    }
  }

  async openTab(url) {
    await this.cdp.send('Target.createTarget', { url })
  }

  async close() {
    const proc = this.proc
    if (!proc) return
    if (this.running) {
      log.info('Closing Chromium')
      try { await this.cdp?.send('Browser.close', {}, { timeoutMs: 5000 }) } catch {}
      const deadline = Date.now() + 15000
      while (this.running && Date.now() < deadline) await sleep(250)
      if (this.running) { proc.kill('SIGKILL'); await sleep(500) }
    }
    this.cdp?.close()
    this.cdp = null
    this.pageSession = null
    this.proc = null
    this.purpose = null
  }
}
