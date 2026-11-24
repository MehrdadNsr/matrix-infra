// Gemini adapter — EVERYTHING that touches the Gemini page lives here.
// Core never touches the DOM; a future AI Studio or ChatGPT adapter
// only has to implement this same interface, core stays untouched.
//
// Interface (all methods async unless noted):
//   healthCheck()        -> { ok, problem? } (login, editor, captcha...)
//   selfTest()           -> { ok, missing: [selectorKey...] }
//   newChat()            -> navigates to a fresh chat (page reloads)
//   setModel(name)       -> pick "Neon 4" / "Hydrogen" from the picker
//   setThinking(level)   -> pick low/medium/high by index in the submenu
//   readSettings()       -> { model, thinking } as read back from the UI
//   insertText(text)     -> put text in the editor, verified afterwards
//   send()               -> click send
//   waitForUserQuery(text, timeoutMs) -> true when our prompt appears
//   waitForCompletion(opts) -> { done, timedOut, frozen }
//   readMessages(limit)  -> last N { role, text } turns, thinking removed
//   readQuotaFromUsagePage(doc?) -> number|null (best effort)
//   pageErrorText()      -> raw error/toast text or ''
//
// Selectors come from selectors.js only. UI text is never matched
// except English model names ("Neon 4", "Hydrogen", "Carbon") and the
// send/stop labels listed in TEXT_MATCH.

import { SELECTORS, TEXT_MATCH } from '../selectors.js';
import { classifyError } from '../core/errors.js';
import { humanClickDelayMs, stepDelayMs } from '../core/pacing.js';

export const GEMINI_APP_URL = 'https://gemini.google.com/app';
export const GEMINI_USAGE_URL = 'https://gemini.google.com/usage';

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function firstMatch(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function allMatches(selectors) {
  const out = [];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el) => out.push(el));
  }
  return out;
}

function visible(el) {
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

/** Clone an answer node with thinking sections removed, then read text. */
function answerTextWithoutThinking(node) {
  const clone = node.cloneNode(true);
  for (const sel of SELECTORS.modelThoughts) {
    clone.querySelectorAll(sel).forEach((el) => el.remove());
  }
  // Any collapsible "thinking" section: remove by attribute hint only,
  // never by matching UI text.
  clone
    .querySelectorAll('[data-thinking], [aria-label*="hinking" i]')
    .forEach((el) => el.remove());
  return clone.innerText || clone.textContent || '';
}

/** The page's own text that indicates a blocking problem, if any. */
export function pageErrorText() {
  const bodyText = document.body ? document.body.innerText || '' : '';
  const toast = firstMatch(SELECTORS.errorToast);
  const toastText = toast ? toast.innerText || '' : '';
  return `${toastText}\n${bodyText}`.trim();
}

export class GeminiAdapter {
  constructor({ log = () => {} } = {}) {
    this.log = log;
  }

  /** Startup self-test: editor, send and model picker must be found. */
  selfTest() {
    const missing = [];
    if (!firstMatch(SELECTORS.editor)) missing.push('editor');
    if (!firstMatch(SELECTORS.send) && !firstMatch(SELECTORS.inputArea)) missing.push('send');
    if (!firstMatch(SELECTORS.modelPickerButton)) missing.push('modelPickerButton');
    return { ok: missing.length === 0, missing };
  }

  /** Logged in, editor present, no captcha / sign-in / unusual traffic. */
  healthCheck() {
    const text = pageErrorText();
    const found = classifyError(text);
    if (found.kind === 'signed_out') return { ok: false, problem: 'signed out', kind: 'signed_out' };
    if (found.kind === 'captcha') return { ok: false, problem: 'captcha', kind: 'captcha' };
    if (found.kind === 'unusual_traffic') {
      return { ok: false, problem: 'unusual traffic', kind: 'unusual_traffic' };
    }
    if (!firstMatch(SELECTORS.editor)) {
      return { ok: false, problem: 'editor not found', kind: 'selector_missing' };
    }
    return { ok: true };
  }

  /**
   * New chat: navigate to `target` (a Gem URL in Gem mode, otherwise
   * /app). The caller persists state first — this reloads the page.
   * Already on the target? A reload still opens a fresh chat, and an
   * assignment to the same URL may not reload.
   */
  newChat(target = GEMINI_APP_URL) {
    if (window.location.href.startsWith(target)) window.location.reload();
    else window.location.href = target;
  }

  editor() {
    return firstMatch(SELECTORS.editor);
  }

  /** Put text in the editor and verify it landed there. */
  async insertText(text) {
    const editor = this.editor();
    if (!editor) return false;
    editor.focus();
    document.execCommand('insertText', false, text);
    await waitMs(200);
    const current = editor.innerText || editor.textContent || '';
    return current.includes(text.slice(0, 80));
  }

  /** Human pause before a click (300-900 ms, random). */
  async humanPause() {
    await waitMs(humanClickDelayMs());
  }

  /** Human pause between steps: set model -> set thinking -> send. */
  async stepPause() {
    await waitMs(stepDelayMs());
  }

  /** Press Enter in the editor (send fallback when no send button is found). */
  dispatchEnterKey() {
    const editor = this.editor();
    if (!editor) return false;
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
    );
    return true;
  }

  /**
   * Click send: aria-label "Send", then fallbacks, then the last
   * enabled button inside the input area, then Enter in the editor
   * (the Enter fallback is borrowed as an idea from Gemini Prompt
   * Queue). Every click is preceded by a human pause.
   */
  async send() {
    for (const sel of SELECTORS.send) {
      const btn = document.querySelector(sel);
      if (btn && visible(btn) && !btn.disabled) {
        await this.humanPause();
        btn.click();
        return true;
      }
    }
    const area = firstMatch(SELECTORS.inputArea);
    if (area) {
      const buttons = [...area.querySelectorAll('button')].filter(
        (b) => !b.disabled && visible(b),
      );
      const last = buttons[buttons.length - 1];
      if (last) {
        await this.humanPause();
        last.click();
        return true;
      }
    }
    this.log('no send button found; falling back to Enter');
    await this.humanPause();
    return this.dispatchEnterKey();
  }

  /** True when a new user-query containing our text appeared. */
  async waitForUserQuery(text, timeoutMs = 10000) {
    const needle = text.slice(0, 120);
    return Boolean(
      await waitFor(() => {
        const turns = allMatches(SELECTORS.userQuery);
        return turns.some((t) => (t.innerText || '').includes(needle));
      }, timeoutMs),
    );
  }

  /** True when the editor still holds our text (the known bounce-back). */
  editorHoldsText(text) {
    const editor = this.editor();
    if (!editor) return false;
    const current = editor.innerText || editor.textContent || '';
    return current.includes(text.slice(0, 80));
  }

  stopButtonPresent() {
    return allMatches(SELECTORS.stopButton).some((b) => visible(b) && !b.disabled);
  }

  /** Busy indicators: generation in progress even without a stop button. */
  busyIndicatorsPresent() {
    return allMatches(SELECTORS.busyIndicators).length > 0;
  }

  /**
   * Wait for generation to finish: the stop button is gone AND the
   * answer text has been unchanged for 8 s. Hard timeout 10 min.
   * Returns { done, timedOut, frozen } — frozen means the DOM did not
   * change at all for 10 min while waiting.
   */
  async waitForCompletion({ timeoutMs = 10 * 60 * 1000, stableMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastText = '';
    let stableSince = Date.now();
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      const answers = allMatches(SELECTORS.modelResponse);
      const text = answers.map((a) => a.innerText || '').join('\n');
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
        stableSince = Date.now();
      }
      if (Date.now() - lastChange > 10 * 60 * 1000) {
        return { done: false, timedOut: false, frozen: true };
      }
      const generating = this.stopButtonPresent() || this.busyIndicatorsPresent();
      if (!generating && text.trim() !== '' && Date.now() - stableSince >= stableMs) {
        return { done: true, timedOut: false, frozen: false };
      }
      await waitMs(1000);
    }
    return { done: false, timedOut: true, frozen: false };
  }

  /**
   * Up to the last `limit` turns (user + model), thinking removed.
   * Model turns carry their code in `pre code`; the raw text is kept
   * too so the extractor can fall back to fenced ``` parsing.
   */
  readMessages(limit = 5) {
    const turns = [];
    const users = allMatches(SELECTORS.userQuery);
    const models = allMatches(SELECTORS.modelResponse);
    // Turns are interleaved on the page; order by document position.
    const all = [...users, ...models]
      .map((el) => ({ el, isUser: users.includes(el) }))
      .sort((a, b) => {
        const pos = a.el.compareDocumentPosition(b.el);
        // eslint-disable-next-line no-bitwise
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    for (const { el, isUser } of all) {
      if (isUser) {
        const text = (el.innerText || '').trim();
        if (text) turns.push({ role: 'user', text });
      } else {
        const content = firstMatch(SELECTORS.messageContent)
          ? el.querySelector(SELECTORS.messageContent[0]) || el
          : el;
        const text = answerTextWithoutThinking(content).trim();
        if (text) turns.push({ role: 'model', text });
      }
    }
    return turns.slice(-limit);
  }

  /** The model picker button in the input bar. */
  modelPickerButton() {
    // Prefer a button whose visible text names a known model.
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const named = buttons.find((b) =>
      Object.values(TEXT_MATCH.modelNames).some((name) =>
        (b.innerText || '').includes(name),
      ),
    );
    if (named) return named;
    return firstMatch(SELECTORS.modelPickerButton);
  }

  async openModelMenu() {
    const btn = this.modelPickerButton();
    if (!btn) return false;
    await this.humanPause();
    btn.click();
    await waitMs(600);
    return firstMatch(SELECTORS.modelMenu) != null;
  }

  /** Close any open menu (Escape), best effort. */
  closeMenu() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
    );
    document.body.click();
  }

  /**
   * Gem-mode probe: can the model and thinking level still be
   * selected inside the current Gem? Opens the model menu read-only
   * (nothing is picked) and checks for a known model name and for
   * thinking options. Always closes the menu afterwards.
   */
  async probeModelControls() {
    const result = { modelSelectable: false, thinkingSelectable: false };
    try {
      if (!(await this.openModelMenu())) return result;
      const items = allMatches(SELECTORS.modelMenuItem);
      result.modelSelectable = items.some((el) =>
        Object.values(TEXT_MATCH.modelNames).some((name) => (el.innerText || '').includes(name)),
      );
      const rows = [...(firstMatch(SELECTORS.modelMenu)?.querySelectorAll(SELECTORS.modelMenuItem.join(',')) || [])];
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        await this.humanPause();
        lastRow.click(); // opens the thinking submenu
        await waitMs(600);
        result.thinkingSelectable = allMatches(SELECTORS.thinkingOption).filter(visible).length >= 3;
      }
      return result;
    } finally {
      this.closeMenu();
    }
  }

  /** Pick a model by its English name ("Neon 4", "Hydrogen"). */
  async setModel(modelKey) {
    const want = TEXT_MATCH.modelNames[modelKey];
    if (!want) return false;
    if (!(await this.openModelMenu())) return false;
    const items = allMatches(SELECTORS.modelMenuItem);
    const item = items.find((el) => (el.innerText || '').includes(want));
    if (!item) return false;
    // "Carbon" is locked: never pick it, and never click a locked row.
    if (item.getAttribute('aria-disabled') === 'true' || item.classList.contains('disabled')) {
      return false;
    }
    await this.humanPause();
    item.click();
    await waitMs(600);
    return true;
  }

  /**
   * Pick a thinking level by index in the submenu the last menu row
   * opens: 0 = low, 1 = medium, 2 = high. Verifies the checkmark
   * (aria-checked / aria-selected / a check icon) afterwards.
   */
  async setThinking(level) {
    const index = ['low', 'medium', 'high'].indexOf(level);
    if (index < 0) return false;
    if (!(await this.openModelMenu())) return false;
    const menu = firstMatch(SELECTORS.modelMenu);
    if (!menu) return false;
    const rows = [...menu.querySelectorAll(SELECTORS.modelMenuItem.join(','))];
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return false;
    await this.humanPause();
    lastRow.click(); // opens the thinking submenu
    await waitMs(600);
    const options = allMatches(SELECTORS.thinkingOption).filter(visible);
    const option = options[index];
    if (!option) return false;
    await this.humanPause();
    option.click();
    await waitMs(600);
    return this.thinkingIsChecked(level);
  }

  thinkingIsChecked(level) {
    const index = ['low', 'medium', 'high'].indexOf(level);
    const options = allMatches(SELECTORS.thinkingOption).filter(visible);
    const option = options[index];
    if (!option) return false;
    if (option.getAttribute('aria-checked') === 'true') return true;
    if (option.getAttribute('aria-selected') === 'true') return true;
    return Boolean(option.querySelector('svg, [class*="check" i], [data-icon*="check" i]'));
  }

  /** Read back the current model + thinking from the UI. */
  readSettings() {
    const btn = this.modelPickerButton();
    const label = btn ? btn.innerText || btn.getAttribute('aria-label') || '' : '';
    let model = null;
    for (const [key, name] of Object.entries(TEXT_MATCH.modelNames)) {
      if (label.includes(name)) model = key;
    }
    // Thinking level has no reliable always-visible label; report what
    // the submenu shows when it can be read, otherwise null.
    let thinking = null;
    const options = allMatches(SELECTORS.thinkingOption);
    const checked = options.findIndex(
      (o) => o.getAttribute('aria-checked') === 'true' || o.getAttribute('aria-selected') === 'true',
    );
    if (checked >= 0) thinking = ['low', 'medium', 'high'][checked];
    return { model, thinking };
  }

  /**
   * Best-effort quota read from the usage page (/usage). Call it only
   * when already on that page; returns a percentage (0-100) or null
   * when parsing fails. A null never blocks the loop.
   */
  readQuotaFromUsagePage(doc = document) {
    try {
      const text = doc.body ? doc.body.innerText || '' : '';
      const m = text.match(/(\d{1,3})\s*%/);
      if (!m) return null;
      const pct = Number(m[1]);
      return pct >= 0 && pct <= 100 ? pct : null;
    } catch {
      return null;
    }
  }
}
