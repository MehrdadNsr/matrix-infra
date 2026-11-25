// Grok adapter — grok.com. Implements the same interface as
// GeminiAdapter (selfTest, newChat, openChat, currentChatUrl, send,
// waitForReply, readLastReply, detectErrors, detectLimits, plus
// healthCheck / isGenerating / setModel / setThinking).
//
// ALL selectors are [unverified]: best guesses only, never checked
// on the live page. selfTest() reports exactly which keys are
// missing; a failed self-test runs the tab "disabled" (heartbeat +
// owner alert kind "selectors"). Never guess silently.

import { SELECTORS } from '../selectors.js';
import { classifyError } from '../core/errors.js';
import { humanClickDelayMs, stepDelayMs } from '../core/pacing.js';
import {
  allMatches,
  firstMatch,
  firstMatches,
  insertIntoEditor,
  pageErrorText as domPageErrorText,
  sendViaSelectors,
  startPermissionWatcher as startWatcher,
  visible,
  waitFor,
  waitForReply as waitForReplyHelper,
  waitMs,
} from './dom.js';

export const GROK_APP_URL = 'https://grok.com';

export class GrokAdapter {
  constructor({ log = () => {} } = {}) {
    this.log = log;
  }

  /** Startup self-test: editor and send must be found. */
  selfTest() {
    const missing = [];
    if (!firstMatch(SELECTORS.grokEditor)) missing.push('grokEditor');
    if (!firstMatch(SELECTORS.grokSend) && !firstMatch(SELECTORS.grokInputArea)) missing.push('grokSend');
    return { ok: missing.length === 0, missing };
  }

  /** Editor present, no blocking error on the page. */
  healthCheck() {
    const found = classifyError(domPageErrorText(SELECTORS.grokErrorToast));
    if (found.kind === 'signed_out') return { ok: false, problem: 'signed out', kind: 'signed_out' };
    if (found.kind === 'captcha') return { ok: false, problem: 'captcha', kind: 'captcha' };
    if (!firstMatch(SELECTORS.grokEditor)) {
      return { ok: false, problem: 'editor not found', kind: 'selector_missing' };
    }
    return { ok: true };
  }

  /**
   * New chat: navigate to `target` (default grok.com). The caller
   * persists state first — this reloads the page.
   */
  newChat(target = GROK_APP_URL) {
    if (window.location.href.startsWith(target)) window.location.reload();
    else window.location.href = target;
  }

  /** Open an existing chat by URL (reloads the page). */
  openChat(url) {
    if (!url) return false;
    if (window.location.href === url || window.location.href.startsWith(url)) {
      window.location.reload();
    } else {
      window.location.href = url;
    }
    return true;
  }

  /** The URL of the chat currently open. */
  currentChatUrl() {
    return window.location.href;
  }

  editor() {
    return firstMatch(SELECTORS.grokEditor);
  }

  /** Put text in the editor and verify it landed there. */
  async insertText(text) {
    return insertIntoEditor(this.editor(), text);
  }

  /** Human pause before a click (300-900 ms, random). */
  async humanPause() {
    await waitMs(humanClickDelayMs());
  }

  /** Human pause between steps. */
  async stepPause() {
    await waitMs(stepDelayMs());
  }

  /**
   * Send: with `text`, insert it first, then click send. Without
   * `text`, just click send. Every click is preceded by a human pause.
   */
  async send(text) {
    if (text != null && !(await this.insertText(text))) return false;
    return sendViaSelectors({
      sendSelectors: SELECTORS.grokSend,
      inputAreaSelectors: SELECTORS.grokInputArea,
      editor: this.editor(),
      humanPause: () => this.humanPause(),
      log: this.log,
    });
  }

  /** True when a new user turn containing our text appeared. */
  async waitForUserQuery(text, timeoutMs = 10000) {
    const needle = text.slice(0, 120);
    return Boolean(
      await waitFor(() => {
        const turns = allMatches(SELECTORS.grokUserTurn);
        return turns.some((t) => (t.innerText || '').includes(needle));
      }, timeoutMs),
    );
  }

  /** True when the editor still holds our text (the known bounce-back). */
  editorHoldsText(text) {
    const editor = this.editor();
    if (!editor) return false;
    const current = editor.innerText || editor.value || editor.textContent || '';
    return current.includes(text.slice(0, 80));
  }

  stopButtonPresent() {
    return allMatches(SELECTORS.grokStopButton).some((b) => visible(b) && !b.disabled);
  }

  busyIndicatorsPresent() {
    return allMatches(SELECTORS.grokBusyIndicators).length > 0;
  }

  /** Is anything generating right now? */
  isGenerating() {
    return this.stopButtonPresent() || this.busyIndicatorsPresent();
  }

  /**
   * Wait for generation to finish: nothing generating AND the last
   * reply text unchanged for 8 s. Hard timeout 10 min.
   * Returns { done, timedOut, frozen }.
   */
  async waitForCompletion({ timeoutMs = 10 * 60 * 1000, stableMs = 8000 } = {}) {
    const r = await waitForReplyHelper({
      isGenerating: () => this.isGenerating(),
      getLastText: () => this.readLastReply(),
      timeoutMs, stableMs,
    });
    return { done: r.finished, timedOut: !r.finished && !r.frozen, frozen: r.frozen };
  }

  /** Wait for the current reply to finish. Returns { text, finished }. */
  async waitForReply() {
    const r = await waitForReplyHelper({
      isGenerating: () => this.isGenerating(),
      getLastText: () => this.readLastReply(),
    });
    return { text: r.text, finished: r.finished };
  }

  /** Text of the last assistant turn. */
  readLastReply() {
    const turns = firstMatches(SELECTORS.grokAssistantTurn);
    const last = turns.length ? turns[turns.length - 1] : null;
    return last ? (last.innerText || '').trim() : '';
  }

  /** Error kind on the page, or '' when none. */
  detectErrors() {
    const found = classifyError(domPageErrorText(SELECTORS.grokErrorToast));
    return found.kind === 'unknown' ? '' : found.kind;
  }

  /** Quota/limit kind on the page, or '' when none. */
  detectLimits() {
    const found = classifyError(domPageErrorText(SELECTORS.grokErrorToast));
    return found.kind === 'quota' || found.kind === 'weekly_cap' ? found.kind : '';
  }

  /** Grok has no model/thinking picker in this bridge: no-ops. */
  async setModel() { return false; }
  async setThinking() { return false; }
  readSettings() { return { model: null, thinking: null }; }

  /**
   * Permission-prompt watcher (MCP tool approval, neon-mcp only).
   * Same rules as Gemini; only the hostname is pinned to grok.com.
   */
  startPermissionWatcher(handlers) {
    return startWatcher({
      hostnameSuffix: 'grok.com',
      log: this.log,
      ...handlers,
    });
  }
}
