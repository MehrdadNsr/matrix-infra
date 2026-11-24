import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_FALLBACKS_BEFORE_PASTE,
  MCP_HEALTH_WINDOW_MS,
  chooseMode,
  createMcpHealth,
  recordMcpFallback,
  recordMcpSuccess,
} from '../src/core/modes.js';
import { mcpPollDecision, runMcpAttempt } from '../src/modes/mcp.js';
import { DEFAULT_SETTINGS } from '../src/ui/panel.js';

const HEALTHY = { consecutiveFallbacks: 0, pasteUntil: 0 };
const NOW = 1_700_000_000_000;

// --- chooseMode ---

test('chooseMode: auto -> mcp when healthy', () => {
  assert.equal(chooseMode({ modeSetting: 'auto', health: HEALTHY, card: { status: 'queued' }, now: NOW }), 'mcp');
});

test('chooseMode: auto -> paste inside the health window, mcp after it', () => {
  const inWindow = { consecutiveFallbacks: 0, pasteUntil: NOW + 60_000 };
  assert.equal(chooseMode({ modeSetting: 'auto', health: inWindow, card: { status: 'queued' }, now: NOW }), 'paste');
  assert.equal(chooseMode({ modeSetting: 'auto', health: inWindow, card: { status: 'queued' }, now: NOW + 61_000 }), 'mcp');
});

test('chooseMode: mode mcp never falls back, mode paste never tries MCP', () => {
  const inWindow = { consecutiveFallbacks: 0, pasteUntil: NOW + 60_000 };
  assert.equal(chooseMode({ modeSetting: 'mcp', health: inWindow, card: { status: 'queued' }, now: NOW }), 'mcp');
  assert.equal(chooseMode({ modeSetting: 'paste', health: HEALTHY, card: { status: 'queued' }, now: NOW }), 'paste');
});

test('chooseMode: answered cards always run in paste mode', () => {
  assert.equal(chooseMode({ modeSetting: 'mcp', health: HEALTHY, card: { status: 'answered' }, now: NOW }), 'paste');
  assert.equal(chooseMode({ modeSetting: 'auto', health: HEALTHY, card: { status: 'answered' }, now: NOW }), 'paste');
});

test('chooseMode: unknown setting behaves like auto', () => {
  assert.equal(chooseMode({ modeSetting: 'weird', health: HEALTHY, card: { status: 'queued' }, now: NOW }), 'mcp');
});

test('defaults: mode auto, pickup 90 s, task timeout 25 min', () => {
  assert.equal(DEFAULT_SETTINGS.mode, 'auto');
  assert.equal(DEFAULT_SETTINGS.mcpPickupTimeoutSec, 90);
  assert.equal(DEFAULT_SETTINGS.mcpTaskTimeoutMin, 25);
});

// --- MCP health ---

test('recordMcpFallback: first fallback streaks, second opens a 30-min paste window', () => {
  assert.equal(MCP_FALLBACKS_BEFORE_PASTE, 2);
  assert.equal(MCP_HEALTH_WINDOW_MS, 30 * 60 * 1000);
  const afterFirst = recordMcpFallback(HEALTHY, NOW);
  assert.deepEqual(afterFirst, { consecutiveFallbacks: 1, pasteUntil: 0 });
  const afterSecond = recordMcpFallback(afterFirst, NOW);
  assert.deepEqual(afterSecond, { consecutiveFallbacks: 0, pasteUntil: NOW + MCP_HEALTH_WINDOW_MS });
  // A success resets the streak, so the window never opens.
  const reset = recordMcpSuccess({ consecutiveFallbacks: 1, pasteUntil: 0 });
  assert.deepEqual(reset, { consecutiveFallbacks: 0, pasteUntil: 0 });
  assert.deepEqual(createMcpHealth(), HEALTHY);
});

// --- mcpPollDecision ---

const BASE = {
  card: { status: 'waiting' },
  seen: false, nudged: false, elapsedMs: 10_000,
  pickupTimeoutMs: 90_000, taskTimeoutMs: 25 * 60_000,
  replyFinished: false, replyText: '',
};

test('mcpPollDecision: done / blocked / failed statuses', () => {
  assert.deepEqual(
    mcpPollDecision({ ...BASE, card: { status: 'done', result_pr_url: 'https://x/pr/1' } }),
    { action: 'done', prUrl: 'https://x/pr/1', seen: false },
  );
  assert.deepEqual(
    mcpPollDecision({ ...BASE, card: { status: 'done', pr_url: 'https://x/pr/2' } }),
    { action: 'done', prUrl: 'https://x/pr/2', seen: false },
  );
  const blocked = mcpPollDecision({ ...BASE, card: { status: 'blocked', question: 'Which lib?' } });
  assert.equal(blocked.action, 'blocked');
  assert.equal(blocked.question, 'Which lib?');
  const blockedNoQ = mcpPollDecision({ ...BASE, card: { status: 'blocked' } });
  assert.equal(blockedNoQ.question, 'Question asked via MCP tools');
  const failed = mcpPollDecision({ ...BASE, card: { status: 'failed', last_error: 'bad file' } });
  assert.deepEqual(failed, { action: 'failed', reason: 'bad file', seen: false });
});

test('mcpPollDecision: no backend card action -> fallback', () => {
  const out = mcpPollDecision({ ...BASE, card: null });
  assert.equal(out.action, 'fallback');
  assert.match(out.reason, /card action/);
});

test('mcpPollDecision: pickup timeout (mcp_seen_at still null)', () => {
  const out = mcpPollDecision({ ...BASE, elapsedMs: 91_000 });
  assert.equal(out.action, 'fallback');
  assert.match(out.reason, /no MCP pickup in 90s/);
  // Seen: still waiting, no fallback.
  const seen = mcpPollDecision({ ...BASE, elapsedMs: 200_000, seen: true });
  assert.equal(seen.action, 'wait');
  assert.equal(seen.seen, true);
  // mcp_seen_at on the fresh card counts as seen.
  const seenAt = mcpPollDecision({ ...BASE, elapsedMs: 200_000, card: { status: 'waiting', mcp_seen_at: '2026-11-23T00:00:00Z' } });
  assert.equal(seenAt.action, 'wait');
  assert.equal(seenAt.seen, true);
});

test('mcpPollDecision: task timeout', () => {
  const out = mcpPollDecision({ ...BASE, elapsedMs: 26 * 60_000, seen: true });
  assert.equal(out.action, 'fallback');
  assert.match(out.reason, /MCP task timeout \(25 min\)/);
});

test('mcpPollDecision: "no tools" reply, English and Persian, beats the timeouts', () => {
  const en = mcpPollDecision({ ...BASE, replyText: "I don't have access to any tools here." });
  assert.equal(en.action, 'fallback');
  assert.equal(en.reason, 'Gemini reports no MCP tools');
  const en2 = mcpPollDecision({ ...BASE, replyText: 'This is NOT SUPPORTED in my setup.' });
  assert.equal(en2.action, 'fallback');
  const fa = mcpPollDecision({ ...BASE, replyText: 'متأسفم، به ابزار دسترسی ندارم.' });
  assert.equal(fa.action, 'fallback');
  const fa2 = mcpPollDecision({ ...BASE, replyText: 'ابزار neon-mcp در دسترس نیست.' });
  assert.equal(fa2.action, 'fallback');
});

test('mcpPollDecision: nudge once, only when the reply finished', () => {
  const first = mcpPollDecision({ ...BASE, replyFinished: true, replyText: 'Here is the file.' });
  assert.equal(first.action, 'nudge');
  const already = mcpPollDecision({ ...BASE, replyFinished: true, nudged: true, replyText: 'Here is the file.' });
  assert.equal(already.action, 'wait');
  const notFinished = mcpPollDecision({ ...BASE, replyFinished: false, replyText: 'Working…' });
  assert.equal(notFinished.action, 'wait');
});

// --- runMcpAttempt wiring (fake ctx/adapter/client) ---

function fakeCtx({ cards, replyText = '', running = true, pickupSec = 90, taskMin = 25 }) {
  const calls = { inserted: [], sent: [], cardPolls: 0 };
  let queue = [...cards];
  const state = { sentToday: 0, blockedCount: 0, latestQuestion: '' };
  return {
    calls, state,
    settings: { dryRun: false, mcpPickupTimeoutSec: pickupSec, mcpTaskTimeoutMin: taskMin },
    client: {
      claim: async () => ({ duplicate: false }),
      setStatus: async () => ({}),
      card: async () => { calls.cardPolls += 1; return queue.shift() ?? { status: 'waiting' }; },
    },
    adapter: {
      insertText: async (text) => { calls.inserted.push(text); return true; },
      generationState: () => ({ generating: false, lastModelText: replyText }),
      newChat: () => {},
    },
    sendWithBounceRetry: async () => { calls.sent.push(true); return { sent: true }; },
    failCard: async () => 'failed',
    checkCardActive: async () => true,
    clearPending: () => {},
    updatePending: () => {},
    persistState: () => {},
    log: () => {},
    sleep: async () => {},
    isRunning: () => running,
    panel: { setCard: () => {}, setBlocked: () => {} },
  };
}

function fakeS(overrides = {}) {
  return {
    card: { id: 'c1', seq: 3, file_path: 'a/b.js', prompt: 'do it' },
    model: 'neon', thinking: 'medium', attempt: 1, maxAttempts: 4,
    ...overrides,
  };
}

test('runMcpAttempt: done on first poll -> done, MCP message sent once', async () => {
  const ctx = fakeCtx({ cards: [{ status: 'done', result_pr_url: 'https://x/pr/9' }] });
  const s = fakeS();
  const out = await runMcpAttempt(ctx, s);
  assert.equal(out.outcome, 'done');
  assert.equal(out.mcpWorked, true);
  assert.equal(ctx.calls.inserted.length, 1);
  assert.match(ctx.calls.inserted[0], /Use the neon-mcp tools only/);
  assert.match(ctx.calls.inserted[0], /task_id=c1/);
  assert.match(ctx.calls.inserted[0], /DONE-c1/);
});

test('runMcpAttempt: pickup timeout with no mcp_seen_at -> fallback', async () => {
  const ctx = fakeCtx({ cards: [{ status: 'waiting' }], pickupSec: 0 });
  const out = await runMcpAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'fallback');
  assert.match(out.reason, /no MCP pickup/);
});

test('runMcpAttempt: "no tools" reply -> fallback without waiting', async () => {
  const ctx = fakeCtx({
    cards: [{ status: 'waiting' }],
    replyText: "I can't access the neon-mcp server from here.",
  });
  const out = await runMcpAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'fallback');
  assert.equal(out.reason, 'Gemini reports no MCP tools');
});

test('runMcpAttempt: nudge sent once when the reply finished, then done', async () => {
  // Pre-seed an already-sent attempt whose reply text has been
  // stable for 9 s, so the first poll sees a finished reply.
  const replyText = 'Here is the summary of the work.';
  const ctx = fakeCtx({
    cards: [{ status: 'waiting' }, { status: 'waiting' }, { status: 'done', result_pr_url: 'https://x/pr/10' }],
    replyText,
  });
  const s = fakeS({
    mcp: { startedAt: Date.now(), nudged: false, seen: true, sent: true, lastText: replyText, lastTextAt: Date.now() - 9000 },
  });
  const out = await runMcpAttempt(ctx, s);
  assert.equal(out.outcome, 'done');
  assert.equal(ctx.calls.inserted.length, 1); // the nudge, sent once
  assert.match(ctx.calls.inserted[0], /You did not finish with submit_file/);
  assert.match(ctx.calls.inserted[0], /task_id=c1/);
  assert.equal(s.mcp.nudged, true);
});

test('runMcpAttempt: paused mid-poll -> paused, no card poll storm', async () => {
  const ctx = fakeCtx({ cards: [{ status: 'waiting' }], running: false });
  const out = await runMcpAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'paused');
  assert.equal(ctx.calls.cardPolls, 0);
});

test('runMcpAttempt: blocked via tools -> blocked + mcpWorked', async () => {
  const ctx = fakeCtx({ cards: [{ status: 'blocked', question: 'Which version?' }] });
  const out = await runMcpAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'blocked');
  assert.equal(out.mcpWorked, true);
  assert.equal(ctx.state.blockedCount, 1);
  assert.equal(ctx.state.latestQuestion, 'Which version?');
});
