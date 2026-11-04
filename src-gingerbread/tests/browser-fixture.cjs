const { existsSync } = require('node:fs');
const path = require('node:path');

function selectedBrowser() {
  if (process.env.GINGERBREAD_BROWSER === 'chromium') return { channel: 'chromium' };
  const brave = process.env.BRAVE_EXECUTABLE || path.join(process.env.ProgramFiles || 'C:/Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe');
  if (process.env.BRAVE_EXECUTABLE && !existsSync(brave)) throw Error('BRAVE_EXECUTABLE does not exist: ' + brave);
  return existsSync(brave) ? { executablePath: brave } : { channel: 'chromium' };
}
function browserOptions(build) {
  return { ...selectedBrowser(), headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`, '--no-first-run'] };
}
function browserName() { return selectedBrowser().executablePath ? 'Brave' : 'Chromium'; }

// Browser-created tabs can start their first request before Playwright attaches
// its page routing. Attach on a blank target first, then navigate through the
// known Page. This changes fixture transport only; the production worker still
// owns real tabs, storage, readiness checks and serialized injections.
async function routeExtensionTabs(worker, context) {
  await worker.evaluate(() => {
    const create = chrome.tabs.create.bind(chrome.tabs);
    let sequence = 0;
    globalThis.__fixtureNavigationQueue = [];
    chrome.tabs.create = async properties => {
      if (!/^https:\/\//.test(properties.url || '')) return create(properties);
      const marker = 'about:blank#gingerbread-fixture-' + (++sequence);
      const tab = await create({ ...properties, url: marker });
      await new Promise((resolve, reject) => globalThis.__fixtureNavigationQueue.push({ marker, url: properties.url, resolve, reject }));
      return chrome.tabs.get(tab.id);
    };
  });
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const jobs = await worker.evaluate(() => globalThis.__fixtureNavigationQueue.filter(job => !job.handled).map(job => {
        job.handled = true;
        return { marker: job.marker, url: job.url };
      }));
      for (const job of jobs) {
        try {
          const deadline = Date.now() + 5000;
          let page;
          while (!(page = context.pages().find(candidate => candidate.url() === job.marker))) {
            if (Date.now() > deadline) throw Error('Fixture tab did not attach');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          await page.goto(job.url, { waitUntil: 'domcontentloaded' });
          await worker.evaluate(marker => globalThis.__fixtureNavigationQueue.find(job => job.marker === marker).resolve(), job.marker);
        } catch (error) {
          await worker.evaluate(({ marker, message }) => globalThis.__fixtureNavigationQueue.find(job => job.marker === marker).reject(Error(message)),
            { marker: job.marker, message: String(error) }).catch(() => {});
        }
      }
    } catch { /* the context may be closing */ }
    finally { polling = false; }
  }, 10);
  return () => clearInterval(timer);
}
module.exports = { browserOptions, browserName, routeExtensionTabs };
