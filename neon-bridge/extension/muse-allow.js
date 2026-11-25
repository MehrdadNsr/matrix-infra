// Trafactor Auto-Allow for Muse, packaged into the server Chrome extension (no Tampermonkey needed).
// Same logic as the "Trafactor Auto-Allow - Musa (Muse)" userscript v1.0; GM_* storage is replaced
// with chrome.storage.local. Auto-clicks Allow / Allow all / Allow everything on Muse permission prompts.
(() => {
  'use strict';
  if (window.top !== window) return;
  if (globalThis.__museAllowLoaded) return;
  globalThis.__museAllowLoaded = true;

  // ---------- Settings ----------
  const SCAN_MS = 700;
  const COOLDOWN_MS = 600;          // min gap between two clicks
  const MAX_CLICKS_PER_MIN = 40;    // safety brake if something loops

  // Broadest permission first
  const PRIORITY = [
    /allow\s+everything(\s+at\s+once)?/i,
    /allow\s+all/i,
    /always\s+allow/i,
    /allow\s+for\s+(this\s+)?(session|chat|conversation|project)/i,
    /^\s*allow\s*$/i,
    /^\s*approve\s*$/i,
  ];
  const BLOCK = /(don'?t|do not|deny|reject|never|disallow|cancel|decline|block)/i;

  // ---------- State ----------
  let enabled = true;
  let lastClick = 0;
  let clickTimes = [];
  let total = 0;
  const clicked = new WeakSet();

  const store = chrome.storage.local;
  const save = (k, v) => { try { store.set({ [k]: v }); } catch (_) { /* extension reloaded */ } };

  // ---------- Helpers ----------
  const textOf = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();

  function visible(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  }

  function candidates() {
    return [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [role="radio"]')]
      .filter((el) => !el.closest('#tfb-panel') && !el.closest('#taa-panel') && !clicked.has(el) && visible(el));
  }

  function scan() {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastClick < COOLDOWN_MS) return;
    clickTimes = clickTimes.filter((t) => now - t < 60000);
    if (clickTimes.length >= MAX_CLICKS_PER_MIN) { setStatus('Paused: too many clicks/min'); return; }

    const els = candidates();
    for (const re of PRIORITY) {
      const hit = els.find((el) => {
        const t = textOf(el);
        return t && t.length < 60 && re.test(t) && !BLOCK.test(t);
      });
      if (hit) {
        clicked.add(hit);
        hit.click();
        lastClick = now;
        clickTimes.push(now);
        total++; save('museAllowTotal', total);
        setStatus(`Clicked: ${textOf(hit).slice(0, 28)}`);
        console.log('[Musa auto-allow] clicked:', textOf(hit));
        return;
      }
    }
  }

  // ---------- Panel (no innerHTML) ----------
  let panel, btn, statusEl, countEl;
  function buildPanel() {
    if (!document.body || document.getElementById('taa-panel')) return;
    panel = document.createElement('div');
    panel.id = 'taa-panel';
    panel.style.cssText = 'position:fixed;bottom:110px;right:12px;z-index:2147483647;background:#111;color:#eee;font:12px sans-serif;padding:8px 10px;border-radius:8px;box-shadow:0 2px 8px #0006;max-width:260px;border:1px solid #444';
    const title = document.createElement('b');
    title.textContent = 'Auto-Allow - Musa (server)';
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'margin:4px 0';
    countEl = document.createElement('div');
    countEl.style.cssText = 'margin:0 0 4px;color:#999';
    btn = document.createElement('button');
    btn.onclick = toggle;
    panel.append(title, statusEl, countEl, btn);
    document.body.appendChild(panel);
    render();
  }

  function render() {
    if (!btn) return;
    btn.textContent = enabled ? 'Turn OFF' : 'Turn ON';
    if (statusEl && !statusEl.dataset.msg) statusEl.textContent = enabled ? 'ON - watching' : 'OFF';
    statusEl.style.color = enabled ? '#6f6' : '#f66';
    if (countEl) countEl.textContent = `Total allowed: ${total}`;
  }

  function setStatus(t) {
    if (!statusEl) return;
    statusEl.dataset.msg = '1';
    statusEl.textContent = t;
    render();
    setTimeout(() => { delete statusEl.dataset.msg; render(); }, 2000);
  }

  function toggle() {
    enabled = !enabled;
    save('museAutoAllow', enabled);
    render();
  }

  // ---------- Start ----------
  store.get(['museAutoAllow', 'museAllowTotal'], (v) => {
    if (typeof v?.museAutoAllow === 'boolean') enabled = v.museAutoAllow;
    if (typeof v?.museAllowTotal === 'number') total = v.museAllowTotal;
    buildPanel();
    setInterval(buildPanel, 3000);
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    setInterval(scan, SCAN_MS);
  });
})();
