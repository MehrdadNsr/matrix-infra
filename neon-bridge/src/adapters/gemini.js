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
import {
  allMatches,
  firstMatch,
  firstMatches,
  insertIntoEditor,
  pageErrorText as domPageErrorText,
  pressEnterKey,
  sendViaSelectors,
  startPermissionWatcher as startWatcher,
  visible,
  waitFor,
  waitForReply as waitForReplyHelper,
  waitMs,
} from './dom.js';

export const GEMINI_APP_URL = 'https://gemini.google.com/app';
export const GEMINI_USAGE_URL = 'https://gemini.google.com/usage';

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
  return domPageErrorText(SELECTORS.errorToast);
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
    return insertIntoEditor(this.editor(), text);
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
    return pressEnterKey(this.editor());
  }

  /**
   * Send: with `text`, insert it first, then click send (aria-label
   * "Send", then fallbacks, then the last enabled button inside the
   * input area, then Enter in the editor — the Enter fallback is
   * borrowed as an idea from Gemini Prompt Queue). Without `text`,
   * just click send (used by the paste/mcp modes). Every click is
   * preceded by a human pause.
   */
  async send(text) {
    if (text != null && !(await this.insertText(text))) return false;
    return sendViaSelectors({
      sendSelectors: SELECTORS.send,
      inputAreaSelectors: SELECTORS.inputArea,
      editor: this.editor(),
      humanPause: () => this.humanPause(),
      log: this.log,
    });
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
   * Non-blocking snapshot for the MCP poll: is anything generating
   * right now, and what does the last model turn say (thinking
   * removed)? Unlike waitForCompletion this returns immediately.
   */
  generationState() {
    const answers = allMatches(SELECTORS.modelResponse);
    const last = answers.length ? answers[answers.length - 1] : null;
    return {
      generating: this.stopButtonPresent() || this.busyIndicatorsPresent(),
      lastModelText: last ? answerTextWithoutThinking(last).trim() : '',
    };
  }

  /**
   * Wait for generation to finish: the stop button is gone AND the
   * answer text has been unchanged for 8 s. Hard timeout 10 min.
   * Returns { done, timedOut, frozen } — frozen means the DOM did not
   * change at all for 10 min while waiting.
   */
  async waitForCompletion({ timeoutMs = 10 * 60 * 1000, stableMs = 8000 } = {}) {
    const r = await waitForReplyHelper({
      isGenerating: () => this.isGenerating(),
      getLastText: () => this.readLastReply(),
      timeoutMs, stableMs,
    });
    return { done: r.finished, timedOut: !r.finished && !r.frozen, frozen: r.frozen };
  }

  /**
   * Common interface: wait for the current reply to finish.
   * Returns { text, finished }.
   */
  async waitForReply() {
    const r = await waitForReplyHelper({
      isGenerating: () => this.isGenerating(),
      getLastText: () => this.readLastReply(),
    });
    return { text: r.text, finished: r.finished };
  }

  /** Common interface: is anything generating right now? */
  isGenerating() {
    return this.stopButtonPresent() || this.busyIndicatorsPresent();
  }

  /** Common interface: text of the last model turn, thinking removed. */
  readLastReply() {
    const answers = allMatches(SELECTORS.modelResponse);
    const last = answers.length ? answers[answers.length - 1] : null;
    return last ? answerTextWithoutThinking(last).trim() : '';
  }

  /** Common interface: open an existing chat by URL (reloads the page). */
  openChat(url) {
    if (!url) return false;
    if (window.location.href === url || window.location.href.startsWith(url)) {
      window.location.reload();
    } else {
      window.location.href = url;
    }
    return true;
  }

  /** Common interface: the URL of the chat currently open. */
  currentChatUrl() {
    return window.location.href;
  }

  /** Common interface: error kind on the page, or '' when none. */
  detectErrors() {
    const found = classifyError(pageErrorText());
    return found.kind === 'unknown' ? '' : found.kind;
  }

  /** Common interface: quota/limit kind on the page, or '' when none. */
  detectLimits() {
    const found = classifyError(pageErrorText());
    return found.kind === 'quota' || found.kind === 'weekly_cap' ? found.kind : '';
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

  /**
   * Permission-prompt watcher (MCP tool approval, neon-mcp only).
   * `handlers`:
   *  getConfig: () => ({ serverName, toolNames })
   *  isActive: () => boolean — approvals only while the worker runs
   *  onApproved: ({ tool, serverName, promptText }) => void
   *  onUnknown: (promptText) => void — a prompt that does not belong
   *    to our server: never clicked, handed to the caller to pause
   *    the worker and alert the owner.
   * Watches with a MutationObserver plus a 2 s fallback poll. Never
   * clicks "Deny", and never approves anything outside
   * gemini.google.com (guarded here as well as by the @match).
   * Returns { stop }.
   */
  /**
   * Permission-prompt watcher (MCP tool approval, neon-mcp only).
   * See src/adapters/dom.js for the shared implementation; this one
   * only pins the hostname to gemini.google.com.
   */
  startPermissionWatcher(handlers) {
    return startWatcher({
      hostnameSuffix: 'gemini.google.com',
      log: this.log,
      ...handlers,
    });
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
      const items = firstMatches(SELECTORS.modelMenuItem);
      result.modelSelectable = items.some((el) =>
        Object.values(TEXT_MATCH.modelNames).some((name) => (el.innerText || '').includes(name)),
      );
      const menu = firstMatch(SELECTORS.modelMenu);
      const rows = menu ? firstMatches(SELECTORS.modelMenuItem, menu) : [];
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        await this.humanPause();
        lastRow.click(); // opens the thinking submenu
        await waitMs(600);
        result.thinkingSelectable = firstMatches(SELECTORS.thinkingOption).filter(visible).length >= 3;
      }
      return result;
    } finally {
      this.closeMenu();
    }
  }

  /** Pick a model by its English name ("Neon", "Hydrogen"). */
  async setModel(modelKey) {
    const want = TEXT_MATCH.modelNames[modelKey];
    if (!want) return false;
    if (!(await this.openModelMenu())) return false;
    const items = firstMatches(SELECTORS.modelMenuItem);
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
   * Open the thinking submenu (last model-menu row) and return its
   * visible options, or null when the menu does not open. Leaves the
   * menu open; the caller closes it (or picks an option, which closes
   * it on its own).
   */
  async openThinkingSubmenu() {
    if (!(await this.openModelMenu())) return null;
    const menu = firstMatch(SELECTORS.modelMenu);
    if (!menu) return null;
    const rows = firstMatches(SELECTORS.modelMenuItem, menu);
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return null;
    await this.humanPause();
    lastRow.click(); // opens the thinking submenu
    await waitMs(600);
    return firstMatches(SELECTORS.thinkingOption).filter(visible);
  }

  /**
   * Verify the thinking level by reopening the model menu and reading
   * aria-checked on 'gem-menu[role="menu"] gem-menu-item[role=
   * "menuitemradio"]' (index 0 low, 1 medium, 2 high), then closing
   * the menu. The plain read-back cannot see the options once the
   * menu closes, so this is the reliable check. Returns
   * 'low' | 'medium' | 'high' | null (null = could not read).
   */
  async readThinkingViaMenu() {
    let options = null;
    try {
      options = await this.openThinkingSubmenu();
      if (!options) return null;
      const checked = options.findIndex(
        (o) => o.getAttribute('aria-checked') === 'true' || o.getAttribute('aria-selected') === 'true',
      );
      return checked >= 0 ? ['low', 'medium', 'high'][checked] : null;
    } finally {
      this.closeMenu();
    }
  }

  /**
   * Pick a thinking level by index in the submenu the last menu row
   * opens: 0 = low, 1 = medium, 2 = high. Verifies the checkmark
   * (aria-checked / aria-selected / a check icon) afterwards.
   */
  async setThinking(level) {
    const index = ['low', 'medium', 'high'].indexOf(level);
    if (index < 0) return false;
    const options = await this.openThinkingSubmenu();
    if (!options) return false;
    const option = options[index];
    if (!option) return false;
    await this.humanPause();
    option.click();
    await waitMs(600);
    return this.thinkingIsChecked(level);
  }

  thinkingIsChecked(level) {
    const index = ['low', 'medium', 'high'].indexOf(level);
    const options = firstMatches(SELECTORS.thinkingOption).filter(visible);
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
    // the submenu shows when it can be read, otherwise null. (When the
    // menu is closed there are no options in the DOM — use
    // readThinkingViaMenu() for a reliable check.)
    let thinking = null;
    const options = firstMatches(SELECTORS.thinkingOption);
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
