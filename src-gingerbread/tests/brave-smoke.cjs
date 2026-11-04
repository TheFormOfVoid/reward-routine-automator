// Offline built-extension check in a disposable profile. Uses installed Brave
// when present, otherwise Playwright Chromium (GINGERBREAD_BROWSER=chromium).
const { chromium } = require('@playwright/test');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const { runInNewContext } = require('node:vm');
const { browserOptions, browserName, routeExtensionTabs } = require('./browser-fixture.cjs');

(async () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'gingerbread-brave-fixture-'));
  const build = path.resolve(__dirname, '../dist');
  const version = JSON.parse(readFileSync(path.join(build, 'manifest.json'), 'utf8')).version;
  let context, stopNavigation;
  try {
    context = await chromium.launchPersistentContext(profile, browserOptions(build));
    const submitted = [];
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'www.bing.com') return route.fulfill({ status: 404, body: 'offline fixture' });
      if (url.pathname === '/search') submitted.push(url.searchParams.get('q'));
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><form id="sb_form" action="/search"><input id="sb_form_q" name="q"><button id="sb_form_go" type="submit">Search</button></form>' });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    await worker.evaluate(() => { globalThis.__fixtureStates=[]; chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.runState) globalThis.__fixtureStates.push({at:Date.now(),...changes.runState.newValue})}) });
    stopNavigation = await routeExtensionTabs(worker, context);
    const extensionId = new URL(worker.url()).hostname;
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/index.html`);
    for (let n=0; n<200 && !await control.evaluate(async () => !!(await chrome.storage.sync.get('settings')).settings); n++) await new Promise(resolve=>setTimeout(resolve,25));
    await control.evaluate(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...settings, startupEnabled: false, randomSearchEnabled: false, scheduledRunEnabled: false,
        searchesPerBatch: 2, rightSizeSearchBatch: false, querySourceOrder: ['local'],
        minDelaySec: 0, maxDelaySec: 0, closeTabsAfterSearch: false, refreshStatsOnPopupOpen: false } });
    });
    const started = await control.evaluate(() => chrome.runtime.sendMessage({ type: 'START_SEARCH_BATCH' }));
    assert.equal(started.ok, true);
    // Admission acknowledges before its asynchronous preparation publishes the
    // durable batch. Observing initial idle is not proof of completion.
    const preparationDeadline=Date.now()+30000;
    while (!await control.evaluate(async () => Boolean((await chrome.storage.local.get('runState')).runState?.batch))) {
      assert.ok(Date.now()<preparationDeadline,'Search preparation must publish a durable batch');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    const until = Date.now() + 90000;
    let finalState;
    while (Date.now() < until) {
      finalState = await control.evaluate(() => chrome.storage.local.get(['runState', 'lastTabAction']));
      if (finalState.runState && !finalState.runState.batch) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(finalState.runState && !finalState.runState.batch, 'batch must terminate within fixture deadline');
    if (submitted.length !== 2) console.error('Fixture state', JSON.stringify(await worker.evaluate(async () => {
      const data = await chrome.storage.local.get(['runState','lastTabAction','runHistory','activeRun']);
      return { ...data, transitions:globalThis.__fixtureStates?.slice(-10) };
    })));
    assert.equal(submitted.length, 2, 'each confirmed submission must navigate once');
    const tabs = await worker.evaluate(() => chrome.tabs.query({}));
    const searchTab = tabs.find(tab => tab.url?.startsWith('https://www.bing.com/search'));
    assert.ok(searchTab?.active, 'search tab selected inside its window');
    const windows = await worker.evaluate(() => chrome.windows.getAll({}));
    assert.ok(windows.every(window => window.type === 'normal'), 'no popup/standalone window');

    // Validate the real isolated-world storage/Stop lease, not just DOM typing.
    const page = context.pages().find(page => page.url().startsWith('https://www.bing.com/search'));
    await page.goto('https://www.bing.com/');
    await control.evaluate(async tabId => {
      await chrome.storage.local.set({ runState: { v: 1, stopEpoch: 9, activity: null, routine: null,
        rightSizeRun: null, captures: { capturing: [], opened: {} },
        batch: { runId: 999, remaining: 1, tabId, attemptId: 1, attemptStartedAt: Date.now(), nextRunAt: Date.now() + 120000 } } });
    }, searchTab.id);
    const raw = stripTypeScriptTypes(readFileSync(path.resolve(__dirname, '../src/background/injections/typed-search.ts'), 'utf8')).replace(/^export /gm, '');
    const typed = runInNewContext(raw + '; performHumanTypedSearchOnBing');
    const injection = worker.evaluate(`(async () => {
      const typed = ${typed.toString()};
      return chrome.scripting.executeScript({target:{tabId:${searchTab.id}},func:typed,args:['cancel this search',{runId:999,attemptId:1,stopEpoch:9,expiresAt:Date.now()+60000}]});
    })()`);
    const typing = await Promise.race([
      page.waitForFunction(() => document.querySelector('#sb_form_q').value.length > 0).then(() => ({ started: true })),
      injection.then(reply => ({ reply })),
    ]);
    assert.equal(typing.started, true, 'typing must start before Stop: ' + JSON.stringify(typing));
    await control.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP_BATCH' }));
    const reply = await injection;
    assert.equal(reply[0].result.ok, false);
    assert.equal(submitted.length, 2, 'Stop must prevent the third submission');
    console.log(JSON.stringify({ passed: true, version, browser: browserName(), submissions: 2,
      selectedSearchTab: true, onlyNormalWindows: true, stopPreventedSubmission: true,
      scope: 'offline fixture, disposable profile, no live Rewards account' }));
  } finally {
    if (stopNavigation) stopNavigation();
    if (context) await context.close();
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('gingerbread-brave-fixture-')) throw Error('Unsafe fixture cleanup path');
    rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
