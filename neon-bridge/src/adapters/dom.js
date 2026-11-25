// Shared DOM helpers for the site adapters. Every adapter uses
// these, so a fix here (e.g. the send fallback order) applies to
// Gemini, Muse, Grok and ChatGPT alike. Core never imports this file;
// only adapters do.
//
// The permission watcher also lives here: it scans plain <button>
// elements, so it works on every site, not just Gemini. It only ever
// auto-approves our own neon-mcp tools (see src/core/permission.js).

import { classifyPermissionPrompt, matchPermissionButton, truncatePromptText } from '../core/permission.js';
import { randomMs } from '../core/pacing.js';
import { TEXT_MATCH } from '../selectors.js';

export function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function firstMatch(selectors, root = document) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Union of ALL entries — only for lists where that is safe. */
export function allMatches(selectors, root = document) {
  const out = [];
  for (const sel of selectors) {
    root.querySelectorAll(sel).forEach((el) => out.push(el));
  }
  return out;
}

/**
 * Matches of the FIRST selector that matches anything — no union.
 * Use this for lists whose entries are NOT safe to union
 * (modelMenuItem, thinkingOption, per-site message lists).
 */
export function firstMatches(selectors, root = document) {
  for (const sel of selectors) {
    const found = [...root.querySelectorAll(sel)];
    if (found.length) return found;
  }
  return [];
}

export function visible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
}

/** Wait until fn() returns a truthy value, or the timeout hits. */
export async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = fn();
    if (last) return last;
    await waitMs(intervalMs);
  }
  return last;
}

/** The page's own text that indicates a blocking problem, if any. */
export function pageErrorText(toastSelectors) {
  const bodyText = document.body ? document.body.innerText || '' : '';
  const toast = firstMatch(toastSelectors);
  const toastText = toast ? toast.innerText || '' : '';
  return `${toastText}\n${bodyText}`.trim();
}

/** Put text in an editor and verify it landed there. */
export async function insertIntoEditor(editor, text) {
  if (!editor) return false;
  editor.focus();
  document.execCommand('insertText', false, text);
  await waitMs(200);
  let current = editor.innerText || editor.value || editor.textContent || '';
  if (current.includes(text.slice(0, 80))) return true;
  // React-controlled textarea/input: execCommand does not update
  // React state, so use the native value setter + an input event.
  if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
    try {
      const proto = editor.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(editor, (editor.value || '') + text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await waitMs(200);
      return (editor.value || '').includes(text.slice(0, 80));
    } catch {
      return false;
    }
  }
  return false;
}

/** Press Enter in the editor (send fallback when no send button is found). */
export function pressEnterKey(editor) {
  if (!editor) return false;
  editor.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
  );
  return true;
}

/**
 * Click send: the send selectors in order, then the last enabled
 * button inside the input area, then Enter in the editor. Every
 * click is preceded by a human pause (300-900 ms). Returns true
 * when something was clicked / Enter was dispatched.
 */
export async function sendViaSelectors({ sendSelectors, inputAreaSelectors, editor, humanPause, log = () => {} }) {
  for (const sel of sendSelectors) {
    const btn = document.querySelector(sel);
    if (btn && visible(btn) && !btn.disabled) {
      await humanPause();
      btn.click();
      return true;
    }
  }
  const area = firstMatch(inputAreaSelectors);
  if (area) {
    const buttons = [...area.querySelectorAll('button')].filter(
      (b) => !b.disabled && visible(b),
    );
    const last = buttons[buttons.length - 1];
    if (last) {
      await humanPause();
      last.click();
      return true;
    }
  }
  log('no send button found; falling back to Enter');
  await humanPause();
  return pressEnterKey(editor);
}

/**
 * Wait for a reply to finish: nothing is generating AND the last
 * reply text has been unchanged for `stableMs`. Hard timeout 10 min.
 * Returns { text, finished, frozen } — frozen means the DOM did not
 * change at all for 10 min while waiting. `isGenerating` and
 * `getLastText` are supplied by the calling adapter.
 */
export async function waitForReply({ isGenerating, getLastText, timeoutMs = 10 * 60 * 1000, stableMs = 8000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stableSince = Date.now();
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const text = getLastText();
    if (text !== lastText) {
      lastText = text;
      lastChange = Date.now();
      stableSince = Date.now();
    }
    if (Date.now() - lastChange > 10 * 60 * 1000) {
      return { text: lastText, finished: false, frozen: true };
    }
    if (!isGenerating() && text.trim() !== '' && Date.now() - stableSince >= stableMs) {
      return { text: lastText, finished: true, frozen: false };
    }
    await waitMs(1000);
  }
  return { text: lastText, finished: false, frozen: false };
}

/**
 * Permission-prompt watcher (MCP tool approval, neon-mcp only).
 * `handlers`:
 *  getConfig: () => ({ serverName, toolNames })
 *  isActive: () => boolean — approvals only while the worker runs
 *  onApproved: ({ tool, serverName, promptText }) => void
 *  onUnknown: (promptText) => void — a prompt that does not belong
 *    to our server: never clicked, handed to the caller to pause
 *    the worker and alert the owner.
 * `hostnameSuffix` limits approvals to one site (e.g.
 * 'gemini.google.com'). Watches with a MutationObserver plus a 2 s
 * fallback poll. Never clicks "Deny". Returns { stop }.
 */
export function startPermissionWatcher({ hostnameSuffix, log = () => {}, getConfig, isActive, onApproved, onUnknown }) {
  const noop = { stop() {} };
  if (!window.location.hostname.endsWith(hostnameSuffix)) return noop;
  const seen = new WeakSet(); // prompt buttons already handled once
  let stopped = false;
  let lastScan = 0;

  const scan = () => {
    if (stopped) return;
    // Throttle: the page mutates constantly while generating; the
    // 2 s poll guarantees detection even when scans are skipped.
    const now = Date.now();
    if (now - lastScan < 500) return;
    lastScan = now;
    const patterns = TEXT_MATCH.permissionButtons;
    const candidates = [...document.querySelectorAll('button')].filter((b) => {
      if (!visible(b) || seen.has(b)) return false;
      return matchPermissionButton(b.innerText || b.textContent, patterns) != null;
    });
    for (const button of candidates) {
      const container =
        button.closest('[role="dialog"], [role="alertdialog"]') || button.parentElement;
      if (!container) continue;
      const promptText = (container.innerText || '').trim();
      const kinds = [...container.querySelectorAll('button')]
        .map((b) => matchPermissionButton(b.innerText || b.textContent, patterns))
        .filter(Boolean);
      if (!kinds.length) continue;
      // Mark every button in this prompt as seen: one prompt is
      // handled once, even if it re-renders or stays on screen.
      for (const b of container.querySelectorAll('button')) seen.add(b);
      const { serverName, toolNames } = getConfig();
      const verdict = classifyPermissionPrompt({ text: promptText, buttons: kinds, serverName, toolNames });
      if (verdict.decision === 'unknown') {
        onUnknown(truncatePromptText(promptText));
        continue;
      }
      if (!isActive()) continue; // approve only while running
      // Ours: wait a human-like 400-1200 ms, then prefer
      // "Always allow", else "Allow". Re-checked right before the
      // click: a paused worker or a vanished prompt clicks nothing.
      const targetKind = verdict.decision === 'approve-always' ? 'always' : 'allow';
      const target =
        [...container.querySelectorAll('button')].find(
          (b) => matchPermissionButton(b.innerText || b.textContent, patterns) === targetKind,
        ) || button;
      const tool = verdict.tool || 'tool';
      setTimeout(async () => {
        if (stopped || !isActive()) return;
        await waitMs(randomMs(400, 1200));
        if (stopped || !isActive() || !target.isConnected) return;
        target.click();
        log(`auto-approved ${tool} for ${serverName}`);
        onApproved({ tool: verdict.tool, serverName, promptText: truncatePromptText(promptText) });
      }, 0);
    }
  };

  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const timer = setInterval(scan, 2000);
  scan();
  return {
    stop() {
      stopped = true;
      observer.disconnect();
      clearInterval(timer);
    },
  };
}
