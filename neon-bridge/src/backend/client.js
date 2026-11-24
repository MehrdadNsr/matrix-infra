// Backend client — all HTTP calls to the bridge backend.
// Transport is GM_xmlhttpRequest (cross-origin from a userscript).
// A custom `request` function can be injected for tests.
//
// Every call: 3 tries with backoff on network errors and 5xx.
// A 401 means the bridge key is invalid: stop and show "key invalid".
// A 409 on claim means the message was already sent: do not send it.
//
// NOTE: this file must never use blocking browser dialogs — the
// build fails if those calls appear. Owner notification goes through
// the backend alert action via notifyOwner().

import { backoffMs } from '../core/pacing.js';

export class BridgeKeyInvalidError extends Error {
  constructor() {
    super('bridge key invalid (401)');
    this.name = 'BridgeKeyInvalidError';
  }
}

export class BridgeDuplicateError extends Error {
  constructor() {
    super('duplicate claim (409): message already sent');
    this.name = 'BridgeDuplicateError';
  }
}

export class BridgeHttpError extends Error {
  constructor(status, body) {
    super(`backend HTTP ${status}: ${String(body || '').slice(0, 200)}`);
    this.name = 'BridgeHttpError';
    this.status = status;
  }
}

const MAX_TRIES = 3;

/** Default transport: GM_xmlhttpRequest wrapped in a Promise. */
export function gmRequest({ url, method, headers, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest !== 'function') {
      reject(new Error('GM_xmlhttpRequest is not available'));
      return;
    }
    GM_xmlhttpRequest({
      method,
      url,
      headers,
      data: body,
      timeout: timeoutMs,
      onload: (res) => resolve({ status: res.status, text: res.responseText }),
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('request timed out')),
    });
  });
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class BackendClient {
  constructor({ backendUrl, bridgeKey, request = gmRequest }) {
    this.backendUrl = String(backendUrl || '').replace(/\/$/, '');
    this.bridgeKey = bridgeKey || '';
    this.request = request;
  }

  /** One backend action, with retries. Returns the parsed JSON body. */
  async call(action, payload = {}) {
    if (!this.backendUrl) throw new Error('backendUrl is not set');
    if (!this.bridgeKey) throw new Error('bridgeKey is not set');
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      try {
        const res = await this.request({
          url: this.backendUrl,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bridge-key': this.bridgeKey,
          },
          body: JSON.stringify({ action, ...payload }),
        });
        if (res.status === 401) throw new BridgeKeyInvalidError();
        if (res.status === 409) throw new BridgeDuplicateError();
        if (res.status >= 500) throw new BridgeHttpError(res.status, res.text);
        if (res.status < 200 || res.status >= 300) {
          throw new BridgeHttpError(res.status, res.text);
        }
        return JSON.parse(res.text || '{}');
      } catch (err) {
        lastError = err;
        // 401 / 409 are final answers, never retried.
        if (err instanceof BridgeKeyInvalidError || err instanceof BridgeDuplicateError) throw err;
        // 4xx other than 401/409 is a client error: do not retry.
        if (err instanceof BridgeHttpError && err.status < 500) throw err;
        if (attempt < MAX_TRIES) await sleepMs(backoffMs(attempt));
      }
    }
    throw lastError;
  }

  /** Fetch a raw URL (used for read_links, ?raw=1, max 60 KB each). */
  async fetchText(url, maxBytes = 60 * 1024) {
    const res = await this.request({ url, method: 'GET', headers: {}, body: '' });
    if (res.status < 200 || res.status >= 300) {
      throw new BridgeHttpError(res.status, res.text);
    }
    return String(res.text || '').slice(0, maxBytes);
  }

  next(worker) {
    return this.call('next', { worker });
  }

  plan(id) {
    return this.call('plan', { id });
  }

  async claim(id, sentHash) {
    try {
      await this.call('claim', { id, sent_hash: sentHash });
      return { duplicate: false };
    } catch (err) {
      if (err instanceof BridgeDuplicateError) return { duplicate: true };
      throw err;
    }
  }

  setStatus(id, fields) {
    return this.call('status', { id, ...fields });
  }

  supervise(id, messages) {
    return this.call('supervise', { id, messages });
  }

  submit(id, content, extra = {}) {
    return this.call('submit', { id, content, ...extra });
  }

  /**
   * Route a model's question to the agent that created the card.
   * The card becomes status "blocked" server-side; the script does
   * nothing else here and never waits for the answer.
   */
  ask(id, question, chatUrl) {
    return this.call('ask', { id, question, chat_url: chatUrl });
  }

  /**
   * Heartbeat so other agents can see whether the bridge is alive.
   * Sent every 60 s and on every state change. A failed heartbeat
   * never stops the worker — the caller logs it and moves on.
   */
  heartbeat({ worker, state, cardId, quotaPct, lastError, version, lastAutoApproval }) {
    return this.call('heartbeat', {
      worker,
      state,
      card_id: cardId || null,
      quota_pct: quotaPct == null ? null : quotaPct,
      last_error: lastError || null,
      version,
      last_auto_approval: lastAutoApproval || null,
    });
  }

  /**
   * Lightweight re-read of one card. The backend may not provide
   * this action: a 400/404/501 means "not provided" and returns
   * null (the caller proceeds). Other errors are rethrown.
   */
  async card(id) {
    let res;
    try {
      res = await this.call('card', { id });
    } catch (err) {
      if (err instanceof BridgeHttpError && [400, 404, 501].includes(err.status)) return null;
      throw err;
    }
    if (!res || typeof res !== 'object') return null;
    if (res.card && typeof res.card === 'object') return res.card;
    return res.id ? res : null;
  }

  /**
   * Owner notification. Kinds: "stopped" | "selectors" | "account"
   * (full stops) and "permission" (an unknown permission prompt was
   * found and left alone — the worker pauses instead of approving).
   */
  notifyOwner(kind, message) {
    return this.call('alert', { kind, message });
  }
}
