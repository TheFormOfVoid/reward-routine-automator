import { cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config.ts'

// The one-click updater (6.9.8) ships INSIDE the extension folder, so it has to
// land in dist/ — the zip and the unpacked folder are both just dist/ — but it
// is not part of the bundle and nothing imports it. Copied whole, after the
// bundle is written, straight from source: updater/'s layout in the repo is
// already its layout in the zip. Chrome ignores the extra folder.
function copyUpdater() {
  return {
    name: 'copy-updater',
    closeBundle() {
      cpSync(fileURLToPath(new URL('./updater', import.meta.url)), 'dist/updater', { recursive: true })
    },
  }
}

// The extension bundles to dist/, which is what you load unpacked.
// build.target is pinned high (modern Chrome) on purpose: esbuild then emits no
// runtime helpers, and the page-side functions handed to
// chrome.scripting.executeScript({func}) are serialized via .toString() — a
// helper reference would make the serialized source fail in the page.
export default defineConfig({
  plugins: [react(), crx({ manifest }), copyUpdater()],
  build: {
    target: 'chrome124',
    rollupOptions: {
      // Extra HTML surfaces the worker opens directly (not the popup). The
      // dashboard (6.4.0) also carries the routine's finish overlay (6.8.0),
      // which replaced routine-done.html.
      input: {
        confirm: 'confirm.html',
        dashboard: 'dashboard.html',
      },
    },
  },
  server: { port: 5175, strictPort: false },
})
