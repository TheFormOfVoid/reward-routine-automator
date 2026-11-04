// Render the editable vector into Chrome/Brave's required PNG sizes.
// Uses the existing Playwright development tooling; no production dependency.
const { chromium } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');

(async () => {
  const dir = path.resolve(__dirname, '../icons');
  const svg = readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const browser = await chromium.launch({
    executablePath: process.env.BRAVE_EXECUTABLE || path.join(process.env.ProgramFiles || 'C:/Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    headless: true,
  });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const size of [16, 32, 48, 128]) {
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
      await page.locator('svg').screenshot({ path: path.join(dir, `icon${size}.png`), omitBackground: true });
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
