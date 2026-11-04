// @ts-nocheck
// Serialized into an isolated page world: these functions intentionally have
// no imports or references to module state. Only coupon-specific UI is pressed.

export function readCouponCount(timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 5000);
    const triggerPattern = /^coupons?\s*\(\s*(\d+)\s*\)$/i;
    const text = el => String(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
    function poll() {
      const trigger = Array.from(document.querySelectorAll('button, [role="button"], a')).find(el => triggerPattern.test(text(el)));
      if (trigger) return resolve(Number(triggerPattern.exec(text(trigger))[1]));
      if (/\bno coupons? available\b/i.test(text(document.body))) return resolve(0);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(poll, 500);
    }
    poll();
  });
}

/** Clicks once, then requires a changed coupon UI before counting success. */
export function claimDashboardCoupons(timeoutMs, lease) {
  return new Promise(resolve => {
    const expiresAt = Math.min(Number(lease?.expiresAt) || Date.now() + 45000, Date.now() + Math.max(1000, Number(timeoutMs) || 45000));
    const marker = {};
    globalThis.__rraCouponTask = marker;
    const triggerPattern = /^coupons?\s*\(\s*(\d+)\s*\)$/i;
    const applyPattern = /^apply coupon$/i;
    const appliedPattern = /^(?:coupon )?applied$/i;
    const text = el => String(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = el => !!el && !el.hidden && el.getAttribute?.('aria-hidden') !== 'true' && (!el.getClientRects || el.getClientRects().length > 0);
    const enabled = el => visible(el) && !el.disabled && el.getAttribute?.('aria-disabled') !== 'true';
    const controls = root => Array.from(root.querySelectorAll('button, [role="button"]'));
    const trigger = () => controls(document).find(el => triggerPattern.test(text(el)) && enabled(el));
    const count = () => { const match = triggerPattern.exec(text(trigger())); return match ? Number(match[1]) : null; };
    let settled = false, opened = false, attempted = 0, claimed = 0, pollTimer;
    const pressed = new WeakSet();
    let pending = null, panel = null, available = null, initialCount = null;
    const finish = (status, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      clearTimeout(pollTimer);
      resolve({ status, reason, opened, attempted, claimed, available });
    };
    const expiry = setTimeout(() => finish('unverified', 'Coupon check expired before every result was verified'), Math.max(0, expiresAt - Date.now()));
    const allowed = async () => {
      if (settled || Date.now() >= expiresAt || globalThis.__rraCouponTask !== marker) return false;
      if (typeof location !== 'undefined' && (!['rewards.bing.com', 'rewards.microsoft.com'].includes(location.hostname) || !/^\/(?:dashboard)?\/?$/.test(location.pathname))) return false;
      if (!lease) return true;
      try {
        const { runState } = await chrome.storage.local.get('runState');
        return !settled && Date.now() < expiresAt && globalThis.__rraCouponTask === marker && runState?.stopEpoch === lease.stopEpoch;
      } catch { return false; }
    };
    async function press(el) {
      if (!(await allowed()) || !enabled(el)) return false;
      const rect = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 1, height: 1 };
      const at = { bubbles: true, composed: true, cancelable: true, view: window,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
      // React Aria needs the pointer sequence; click remains for native controls.
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1, pressure: 0.5 }));
        el.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0, pressure: 0 }));
      }
      el.click();
      return true;
    }
    function findPanel() {
      return Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(el => {
        if (!visible(el)) return false;
        const labelledBy = String(el.getAttribute?.('aria-labelledby') || '').split(/\s+/).map(id => text(document.getElementById?.(id))).join(' ');
        const name = text({ textContent: el.getAttribute?.('aria-label') || labelledBy });
        return /^coupons?$/i.test(name) || Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')).some(heading => /^coupons?$/i.test(text(heading)));
      }) || null;
    }
    const later = () => { if (!settled) pollTimer = setTimeout(() => void poll(), 250); };
    async function poll() {
      try {
        if (!(await allowed())) return finish('cancelled', 'Coupon check stopped or the page changed');
        if (!opened) {
          initialCount = count();
          panel = findPanel();
          if (panel) opened = true;
          else {
            const button = trigger();
            if (button) {
              if (count() === 0) { available = 0; return finish('none', 'No coupons available to apply'); }
              if (!await press(button)) return finish('cancelled', 'Coupon check stopped before opening');
              opened = true;
              return later();
            }
            if (/\bno coupons? available\b/i.test(text(document.body))) { available = 0; return finish('none', 'No coupons available to apply'); }
            return later();
          }
        }
        panel = findPanel();
        const all = panel ? controls(panel) : [];
        const apply = all.filter(el => applyPattern.test(text(el)));
        const ready = apply.filter(el => enabled(el) && !pressed.has(el));
        const applied = all.filter(el => appliedPattern.test(text(el))).length;
        if (pending) {
          const confirmed = applied > pending.applied || (count() != null && pending.count != null && count() < pending.count);
          if (confirmed) { claimed++; pending = null; }
          else if (Date.now() - pending.at >= 6000) return finish('unverified', 'The coupon was pressed, but application was not confirmed');
          else return later();
        }
        if (!panel) {
          if (claimed > 0 && count() === 0) { available = 0; return finish('applied', `Applied ${claimed} coupon(s)`); }
          return later();
        }
        if (!ready.length) {
          if (apply.length) return later(); // Disabled can mean processing, not success.
          if (applied > 0 && (initialCount == null || applied >= initialCount || count() === 0)) { available = 0; return finish(claimed ? 'applied' : 'none', claimed ? `Applied ${claimed} coupon(s)` : 'Every coupon is already applied'); }
          return later();
        }
        available = ready.length;
        if (attempted >= 20) return finish('unverified', 'Coupon safety limit reached');
        const next = ready[0];
        pending = { at: Date.now(), applied, count: count() };
        if (!await press(next)) return finish('cancelled', 'Coupon check stopped before application');
        pressed.add(next);
        attempted++;
        later();
      } catch { finish('failed', 'The coupon panel could not be read safely'); }
    }
    void poll();
  });
}
