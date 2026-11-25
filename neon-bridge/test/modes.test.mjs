import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_FALLBACKS_BEFORE_PASTE,
  MCP_HEALTH_WINDOW_MS,
  canFallback,
  createMcpHealth,
  createModeCounters,
  createModeStats,
  decideSubmit,
  displayFirstMode,
  firstModeForCard,
  formatModeCounter,
  recordMcpFallback,
  recordMcpSuccess,
  recordModeStats,
  resolveCardStrategy,
  resolveModeStrategy,
} from '../src/core/modes.js';
import { detectMcpToolError, mcpPollDecision, runMcpAttempt } from '../src/modes/mcp.js';
import { DEFAULT_SETTINGS } from '../src/ui/panel.js';

const HEALTHY = { consecutiveFallbacks: 0, pasteUntil: 0 };
const NOW = 1_700_000_000_000;

// --- modeStrategy ---

test('resolveModeStrategy: explicit setting wins', () => {
  assert.equal(resolveModeStrategy({ setting: 'mcp-first', explicit: true, testMode: true, site: 'gemini' }), 'mcp-first');
  assert.equal(resolveModeStrategy({ setting: 'paste-only', explicit: true, testMode: false, site: 'gemini' }), 'paste-only');
});

test('resolveModeStrategy: testMode defaults Gemini to ab, otherwise paste-first', () => {
  assert.equal(resolveModeStrategy({ setting: 'paste-first', explicit: false, testMode: true, site: 'gemini' }), 'ab');
  assert.equal(resolveModeStrategy({ setting: 'paste-first', explicit: false, testMode: false, site: 'gemini' }), 'paste-first');
  assert.equal(resolveModeStrategy({ setting: 'paste-first', explicit: false, testMode: true, site: 'grok' }), 'paste-first');
  assert.equal(resolveModeStrategy({ setting: 'weird', explicit: false, testMode: false, site: 'gemini' }), 'paste-first');
});

test('resolveCardStrategy: card.mode_hint overrides, invalid hint ignored', () => {
  assert.equal(resolveCardStrategy({ strategy: 'paste-first', card: { mode_hint: 'mcp-only' } }), 'mcp-only');
  assert.equal(resolveCardStrategy({ strategy: 'paste-first', card: { mode_hint: 'nope' } }), 'paste-first');
  assert.equal(resolveCardStrategy({ strategy: 'ab', card: {} }), 'ab');
  assert.equal(resolveCardStrategy({ strategy: 'ab', card: null }), 'ab');
});

test('firstModeForCard: per strategy, ab alternates by seq', () => {
  const card = (seq) => ({ status: 'queued', seq });
  assert.equal(firstModeForCard({ strategy: 'paste-first', card: card(1), health: HEALTHY }), 'link');
  assert.equal(firstModeForCard({ strategy: 'mcp-first', card: card(2), health: HEALTHY }), 'mcp');
  assert.equal(firstModeForCard({ strategy: 'ab', card: card(1), health: HEALTHY }), 'mcp'); // odd -> MCP
  assert.equal(firstModeForCard({ strategy: 'ab', card: card(2), health: HEALTHY }), 'link'); // even -> LINK
  assert.equal(firstModeForCard({ strategy: 'paste-only', card: card(1), health: HEALTHY }), 'link');
  assert.equal(firstModeForCard({ strategy: 'mcp-only', card: card(2), health: HEALTHY }), 'mcp');
});

test('firstModeForCard: answered cards always link; health window forces link except mcp-only', () => {
  const inWindow = { consecutiveFallbacks: 0, pasteUntil: NOW + 60_000 };
  assert.equal(firstModeForCard({ strategy: 'mcp-first', card: { status: 'answered', seq: 1 }, health: HEALTHY }), 'link');
  assert.equal(firstModeForCard({ strategy: 'mcp-first', card: { status: 'queued', seq: 1 }, health: inWindow, now: NOW }), 'link');
  assert.equal(firstModeForCard({ strategy: 'mcp-only', card: { status: 'queued', seq: 1 }, health: inWindow, now: NOW }), 'mcp');
  assert.equal(firstModeForCard({ strategy: 'mcp-first', card: { status: 'queued', seq: 1 }, health: inWindow, now: NOW + 61_000 }), 'mcp');
});

test('canFallback: only the *-only strategies never fall back', () => {
  assert.equal(canFallback({ strategy: 'mcp-only', from: 'mcp' }), false);
  assert.equal(canFallback({ strategy: 'paste-only', from: 'link' }), false);
  assert.equal(canFallback({ strategy: 'mcp-first', from: 'mcp' }), true);
  assert.equal(canFallback({ strategy: 'paste-first', from: 'mcp' }), true);
  assert.equal(canFallback({ strategy: 'ab', from: 'mcp' }), true);
  assert.equal(canFallback({ strategy: 'ab', from: 'link' }), true);
});

test('displayFirstMode: ab shows ab, others the first mode', () => {
  assert.equal(displayFirstMode({ strategy: 'ab', health: HEALTHY }), 'ab');
  assert.equal(displayFirstMode({ strategy: 'paste-first', health: HEALTHY }), 'link');
  assert.equal(displayFirstMode({ strategy: 'mcp-first', health: HEALTHY }), 'mcp');
});

test('defaults: modeStrategy paste-first, pickup 90 s, MCP timeout 6 min, testMode off', () => {
  assert.equal(DEFAULT_SETTINGS.modeStrategy, 'paste-first');
  assert.equal(DEFAULT_SETTINGS.mcpPickupTimeoutSec, 90);
  assert.equal(DEFAULT_SETTINGS.mcpTimeoutMin, 6);
  assert.equal(DEFAULT_SETTINGS.testMode, false);
  assert.equal(DEFAULT_SETTINGS.mode, undefined);
});

// --- MCP health ---

test('recordMcpFallback: first fallback streaks, second opens a 30-min link window', () => {
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

// --- mode_stats ---

test('createModeStats: zeroed stats shape', () => {
  assert.deepEqual(createModeStats(), {
    mode_used: '', fell_back: false, fallback_reason: '', duration_s: 0,
    permission_prompts: 0, auto_approved: 0, retries: 0, ok: false,
  });
});

test('recordModeStats + formatModeCounter: per-mode cards, ok %, averages', () => {
  let counters = createModeCounters();
  counters = recordModeStats(counters, {
    mode_used: 'mcp', ok: true, duration_s: 120, permission_prompts: 3,
  });
  counters = recordModeStats(counters, {
    mode_used: 'mcp', ok: false, duration_s: 60, permission_prompts: 1,
  });
  counters = recordModeStats(counters, {
    mode_used: 'link', ok: true, duration_s: 45, permission_prompts: 0,
  });
  assert.equal(counters.mcp.cards, 2);
  assert.equal(counters.mcp.ok, 1);
  assert.equal(formatModeCounter('MCP', counters.mcp), 'MCP 2 cards · 50% ok · avg 90s · avg 2.0 prompts');
  assert.equal(formatModeCounter('LINK', counters.link), 'LINK 1 cards · 100% ok · avg 45s · avg 0.0 prompts');
  assert.equal(formatModeCounter('MCP', createModeCounters().mcp), 'MCP 0 cards');
});

test('decideSubmit: never submit the same card twice', () => {
  assert.equal(decideSubmit(null), 'submit'); // backend has no card action: proceed
  assert.equal(decideSubmit({ status: 'waiting' }), 'submit');
  assert.equal(decideSubmit({ status: 'queued' }), 'submit');
  assert.equal(decideSubmit({ status: 'done' }), 'already-done');
  assert.equal(decideSubmit({ status: 'skipped' }), 'cancelled');
  assert.equal(decideSubmit({ status: 'failed' }), 'cancelled');
});

// --- mcpPollDecision ---

const BASE = {
  card: { status: 'waiting' },
  seen: false, nudged: false, elapsedMs: 10_000,
  pickupTimeoutMs: 90_000, taskTimeoutMs: 6 * 60_000,
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

test('mcpPollDecision: task timeout is 6 min now', () => {
  const out = mcpPollDecision({ ...BASE, elapsedMs: 7 * 60_000, seen: true });
  assert.equal(out.action, 'fallback');
  assert.match(out.reason, /MCP task timeout \(6 min\)/);
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

test('mcpPollDecision: MCP not active -> fallback immediately', () => {
  const out = mcpPollDecision({ ...BASE, card: { status: 'waiting', mcp_active: false } });
  assert.equal(out.action, 'fallback');
  assert.match(out.reason, /not active/);
  const active = mcpPollDecision({ ...BASE, card: { status: 'waiting', mcp_active: true } });
  assert.equal(active.action, 'wait');
});

test('mcpPollDecision: tool errors twice -> fallback; one is not enough', () => {
  const one = mcpPollDecision({ ...BASE, toolErrors: 1 });
  assert.equal(one.action, 'wait');
  const two = mcpPollDecision({ ...BASE, toolErrors: 2 });
  assert.equal(two.action, 'fallback');
  assert.match(two.reason, /tool error 2 times/);
});

test('mcpPollDecision: more than 3 permission prompts -> fallback', () => {
  assert.equal(mcpPollDecision({ ...BASE, permissionPrompts: 3 }).action, 'wait');
  const out = mcpPollDecision({ ...BASE, permissionPrompts: 4 });
  assert.equal(out.action, 'fallback');
  assert.match(out.reason, /more than 3 permission prompts/);
});

test('mcpPollDecision: nudge once, only when the reply finished', () => {
  const first = mcpPollDecision({ ...BASE, replyFinished: true, replyText: 'Here is the file.' });
  assert.equal(first.action, 'nudge');
  const already = mcpPollDecision({ ...BASE, replyFinished: true, nudged: true, replyText: 'Here is the file.' });
  assert.equal(already.action, 'wait');
  const notFinished = mcpPollDecision({ ...BASE, replyFinished: false, replyText: 'Working…' });
  assert.equal(notFinished.action, 'wait');
});

test('detectMcpToolError: tool failures, English and Persian', () => {
  assert.equal(detectMcpToolError('submit_file failed: file too large'), true);
  assert.equal(detectMcpToolError('get_task error: not found'), true);
  assert.equal(detectMcpToolError('Tool error while calling read_file'), true);
  assert.equal(detectMcpToolError('خطای ابزار هنگام فراخوانی submit_file'), true);
  assert.equal(detectMcpToolError('Here is the complete file.'), false);
  assert.equal(detectMcpToolError(''), false);
});

// --- runMcpAttempt wiring (fake ctx/adapter/client) ---

function fakeCtx({ cards, replyText = '', running = true, pickupSec = 90, taskMin = 6, stats = null }) {
  const calls = { inserted: [], sent: [], cardPolls: 0 };
  let queue = [...cards];
  const state = { sentToday: 0, blockedCount: 0, latestQuestion: '' };
  return {
    calls, state,
    settings: { dryRun: false, mcpPickupTimeoutSec: pickupSec, mcpTimeoutMin: taskMin },
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

test('runMcpAttempt: MCP not active on the card -> fallback', async () => {
  const ctx = fakeCtx({ cards: [{ status: 'waiting', mcp_active: false }] });
  const out = await runMcpAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'fallback');
  assert.match(out.reason, /not active/);
});

test('runMcpAttempt: second distinct tool error -> fallback', async () => {
  const ctx = fakeCtx({
    cards: [{ status: 'waiting' }],
    replyText: 'submit_file failed: file too large',
  });
  const s = fakeS({
    mcp: {
      startedAt: Date.now(), nudged: false, seen: true, sent: true,
      lastText: '', lastTextAt: 0, toolErrors: 1, lastToolError: 'get_task error: not found',
    },
  });
  const out = await runMcpAttempt(ctx, s);
  assert.equal(out.outcome, 'fallback');
  assert.match(out.reason, /tool error 2 times/);
});

test('runMcpAttempt: more than 3 permission prompts on the card -> fallback', async () => {
  const ctx = fakeCtx({ cards: [{ status: 'waiting' }] });
  const s = fakeS({ stats: { permission_prompts: 4, auto_approved: 4 } });
  const out = await runMcpAttempt(ctx, s);
  assert.equal(out.outcome, 'fallback');
  assert.match(out.reason, /more than 3 permission prompts/);
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
