// @ts-nocheck
// Serialized into the isolated page world: every helper must remain inside
// this function. The worker bounds its await; this shorter page lease prevents
// a late timer from submitting after the worker has already scheduled a retry.
export function performHumanTypedSearchOnBing(
  query: string,
  lease?: { runId: number; attemptId: number; stopEpoch: number; expiresAt: number },
): Promise<{ ok: boolean; busyMs: number; reason?: string }> {
  return new Promise(resolve => {
    const started = Date.now();
    const expiresAt = Math.min(lease?.expiresAt || started + 60000, started + 60000);
    const marker = {};
    globalThis.__rraSearchAttempt = marker;
    let done = false;
    let timer;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      resolve({ ok, busyMs: Date.now() - started, ...(reason ? { reason } : {}) });
    };
    const deadline = setTimeout(() => finish(false, 'typing-deadline'), Math.max(0, expiresAt - Date.now()));
    let lastCheck = 0;
    const allowed = async (force = false) => {
      if (done || Date.now() >= expiresAt || globalThis.__rraSearchAttempt !== marker) return false;
      if (!lease || (!force && Date.now() - lastCheck < 1000)) return true;
      try {
        const { runState } = await chrome.storage.local.get('runState');
        lastCheck = Date.now();
        return !done && Date.now() < expiresAt && globalThis.__rraSearchAttempt === marker &&
          runState?.stopEpoch === lease.stopEpoch && runState?.batch?.runId === lease.runId &&
          runState.batch.attemptId === lease.attemptId && runState.batch.attemptStartedAt > 0;
      } catch { return false; }
    };
    const input = document.querySelector('#sb_form_q') || document.querySelector('input[name="q"]') ||
      document.querySelector('input[type="search"]');
    if (!input) { finish(false, 'missing-input'); return; }
    const form = document.querySelector('#sb_form') || input.form;
    const button = document.querySelector('#sb_form_go') ||
      (form && form.querySelector('input[type="submit"], button[type="submit"]'));
    if (!button && !form) { finish(false, 'missing-submit'); return; }
    const nativeValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    const setValue = value => nativeValue?.set ? nativeValue.set.call(input, value) : input.value = value;
    const fireKey = (type, key) => input.dispatchEvent(new KeyboardEvent(type, {
      key, bubbles: true, cancelable: true, composed: true,
    }));
    let index = 0;
    async function next() {
      try {
        if (!(await allowed())) { finish(false, 'stopped-or-expired'); return; }
        if (index === 0) { setValue(''); input.focus(); }
        if (index >= query.length) {
          timer = setTimeout(async () => {
            try {
              if (!(await allowed(true))) { finish(false, 'stopped-or-expired'); return; }
              // Reply first, then submit in the next task so navigation cannot
              // destroy the executeScript reply. Worker verifies the results URL.
              finish(true);
              setTimeout(async () => {
                if (Date.now() >= expiresAt || globalThis.__rraSearchAttempt !== marker) return;
                try {
                  if (lease) {
                    const { runState } = await chrome.storage.local.get('runState');
                    if (Date.now() >= expiresAt || globalThis.__rraSearchAttempt !== marker ||
                        runState?.stopEpoch !== lease.stopEpoch || runState?.batch?.runId !== lease.runId ||
                        runState.batch.attemptId !== lease.attemptId || !runState.batch.attemptStartedAt) return;
                  }
                  if (button) button.click();
                  else if (typeof form.requestSubmit === 'function') form.requestSubmit();
                  else form.submit();
                } catch { /* Worker verifies navigation and retries a failed click. */ }
              }, 0);
            } catch { finish(false, 'submit-failed'); }
          }, 400 + Math.random() * 800);
          return;
        }
        const ch = query[index++];
        fireKey('keydown', ch);
        fireKey('keypress', ch);
        setValue(input.value + ch);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }));
        fireKey('keyup', ch);
        timer = setTimeout(next, 80 + Math.random() * 180 + (Math.random() < 0.08 ? 200 + Math.random() * 400 : 0));
      } catch { finish(false, 'typing-failed'); }
    }
    next();
  });
}
