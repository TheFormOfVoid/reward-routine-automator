// Actual production worker/storage/injection Pause and Resume checks against
// offline Bing/Rewards fixtures. Never uses the installed user's profile.
const { chromium } = require('@playwright/test');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { browserOptions, browserName, routeExtensionTabs } = require('./browser-fixture.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw Error('Timed out: ' + label);
}
function rewardsMarkup(points) {
  const activity = (label, value) => `<button><span role="progressbar" aria-label="${label}" aria-valuenow="${value}" aria-valuemax="1"></span><span>Search: ${value}/1</span></button>`;
  return `<!doctype html><html><body>
    <button><p class="text-labelControl">Available points</p><p class="text-pageHeader">1,000</p></button>
    <button><p class="text-labelControl">Daily streak</p><p class="text-pageHeader">5 days</p></button>
    <button aria-expanded="true" aria-controls="points"><p class="text-labelControl">Today's points</p></button>
    <button>Coupon (0)</button>
    <section id="points"><div>Bing search</div><div>${points}</div></section>
    ${activity('bing', 0)}${activity('daily set', 1)}${activity('mobile app', 0)}${activity('visual search', 1)}
    </body></html>`;
}

(async () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'gingerbread-controls-fixture-'));
  const build = path.resolve(__dirname, '../dist');
  const version = JSON.parse(readFileSync(path.join(build, 'manifest.json'), 'utf8')).version;
  let context, stopNavigation;
  try {
    context = await chromium.launchPersistentContext(profile, browserOptions(build));
    let points = '57/60';
    let rewardsReads = 0;
    const submissions = [];
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'rewards.bing.com') {
        rewardsReads++;
        return route.fulfill({ contentType: 'text/html', body: rewardsMarkup(points) });
      }
      if (url.hostname !== 'www.bing.com') return route.fulfill({ status: 404, body: 'offline fixture' });
      if (url.pathname === '/search') submissions.push(url.searchParams.get('q'));
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><form id="sb_form" action="/search"><input id="sb_form_q" name="q"><button id="sb_form_go" type="submit">Search</button></form>' });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
    stopNavigation = await routeExtensionTabs(worker, context);
    await worker.evaluate(() => {
      globalThis.__fixtureWarnings = [];
      const warn = console.warn;
      console.warn = (...args) => {
        globalThis.__fixtureWarnings.push(args.map(value => String(value).replace(/https?:\/\/[^\s"]+/g, url => { try { return new URL(url).origin; } catch { return '[URL]'; } })));
        warn(...args);
      };
    });
    const id = new URL(worker.url()).hostname;
    const control = await context.newPage();
    await control.goto(`chrome-extension://${id}/index.html`);
    const read = () => control.evaluate(async () => (await chrome.storage.local.get('runState')).runState);
    const send = message => control.evaluate(message => chrome.runtime.sendMessage(message), message);
    await waitFor(() => control.evaluate(async () => Boolean((await chrome.storage.sync.get('settings')).settings)), 'settings initialization');
    await control.evaluate(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...settings, startupEnabled: false, randomSearchEnabled: false,
        scheduledRunEnabled: false, restockWatcherEnabled: false, confirmBeforeRoutine: false,
        searchesPerBatch: 3, rightSizeSearchBatch: false, minDelaySec: 1, maxDelaySec: 1,
        closeTabsAfterSearch: false, refreshStatsOnPopupOpen: false,
        querySourceOrder: ['local', 'bingAutosuggest', 'googleTrends', 'wikipedia', 'uselessFacts'] } });
    });

    assert.equal((await send({ type: 'START_SEARCH_BATCH' })).ok, true);
    const batch = await waitFor(async () => (await read())?.batch, 'first batch');
    const searchPage = await waitFor(() => context.pages().find(page => page.url().startsWith('https://www.bing.com/')), 'search page');
    await searchPage.waitForFunction(() => document.querySelector('#sb_form_q')?.value.length > 0);
    assert.equal((await send({ type: 'PAUSE_ACTIVITY' })).ok, true);
    const pending = await read();
    assert.ok(pending.pause?.requestedAt, 'pause request is durable during current typing');
    assert.equal(pending.pause.effectiveAt, undefined, 'in-flight typing must finish before pause is acknowledged');
    const paused = await waitFor(async () => { const state = await read(); return state?.pause?.effectiveAt ? state : null; }, 'effective pause');
    assert.equal(paused.batch.runId, batch.runId);
    assert.equal(paused.batch.remaining, 2, 'exactly the current submitted effect is committed');
    assert.equal(submissions.length, 1);
    await pause(1_200);
    assert.equal(submissions.length, 1, 'no next submission starts during an effective pause');
    assert.equal((await read()).batch.remaining, 2, 'pause preserves remaining work');
    const readsBeforeResume = rewardsReads;
    const resumed = await send({ type: 'RESUME_ACTIVITY' });
    assert.equal(resumed.ok, true, resumed.error);
    await waitFor(async () => {
      const state = await read();
      const message = await control.evaluate(async () => (await chrome.storage.local.get('lastTabAction')).lastTabAction?.detail);
      if (message?.startsWith('Resume failed:')) throw Error(message);
      return !state.pause;
    }, 'fresh Resume acknowledgment');
    assert.ok(rewardsReads > readsBeforeResume, 'Resume obtains actual fresh fixture progress');
    assert.equal((await read()).pause, undefined);
    await waitFor(() => submissions.length >= 2, 'resumed submission');
    assert.equal((await send({ type: 'STOP_BATCH' })).ok, true);
    const afterStop = await read();
    assert.equal(afterStop.batch, null);
    assert.equal(afterStop.pause, undefined);
    const countAtStop = submissions.length;
    await pause(1_200);
    assert.equal(submissions.length, countAtStop, 'Stop cannot submit another query');

    // Automatic right-sizing handles newly completed credit on Resume even
    // though ordinary fixed-count manual batches deliberately keep their cap.
    points = '60/60';
    await control.evaluate(async tabId => {
      const { settings } = await chrome.storage.sync.get('settings');
      const { runState } = await chrome.storage.local.get('runState');
      await chrome.storage.sync.set({ settings: { ...settings, rightSizeSearchBatch: true } });
      await chrome.storage.local.set({ runState: { ...runState, activity: null, routine: null, rightSizeRun: null,
        pause: { requestedAt: Date.now(), effectiveAt: Date.now() },
        batch: { runId: (runState.batchSequence || 0) + 100, remaining: 3, tabId, nextRunAt: Date.now() + 60_000 } } });
    }, batch.tabId);
    const beforeCompletedResume = submissions.length;
    const completed = await send({ type: 'RESUME_ACTIVITY' });
    assert.equal(completed.ok, true, completed.error);
    await waitFor(async () => !(await read()).batch, 'completed-credit batch settlement', 45_000);
    assert.equal(submissions.length, beforeCompletedResume, 'verified complete credit must not start another search');
    assert.equal((await read()).pause, undefined);
    console.log(JSON.stringify({ passed: true, version, browser: browserName(),
      pendingPause: true, effectivePause: true, exactRemainingPreserved: true,
      freshResumeRead: true, stopPreventsSubmission: true, completedCreditNoRerun: true,
      scope: 'offline fixtures, disposable profile, no live Rewards account' }));
  } catch (error) {
    const worker = context?.serviceWorkers()[0];
    if (worker) {
      const evidence = await worker.evaluate(async () => ({ ...await chrome.storage.local.get(['runState', 'lastStats', 'lastStatsLog', 'lastTabAction']), warnings: globalThis.__fixtureWarnings })).catch(() => null);
      console.error('Offline control fixture state:', JSON.stringify(evidence));
    }
    throw error;
  } finally {
    if (stopNavigation) stopNavigation();
    if (context) await context.close();
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('gingerbread-controls-fixture-')) throw Error('Unsafe fixture cleanup path');
    rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
