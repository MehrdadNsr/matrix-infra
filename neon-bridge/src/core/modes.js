// Code-mode strategy + MCP health + per-card mode stats — pure logic.
//
// Two code modes exist: MCP (Gemini works through the neon-mcp tools
// and delivers with submit_file) and LINK (the AI gets a read link,
// reads the task, writes the code; the script copies the answer and
// submits it). Which runs first is the strategy:
//   "paste-first" (default), "mcp-first", "ab", "paste-only", "mcp-only"
// "ab" alternates per card (odd seq MCP-first, even seq LINK-first)
// so both methods get comparable data. During the test period, Gemini
// defaults to "ab" when the testMode setting is on. A backend card
// may override the strategy for that card with card.mode_hint.
// Answered cards always run in LINK mode: their answer is delivered
// as chat text.
//
// MCP health (unchanged): after 2 consecutive MCP fallbacks the
// worker uses LINK for 30 minutes, then tries MCP again.

export const MODE_STRATEGIES = Object.freeze(['paste-first', 'mcp-first', 'ab', 'paste-only', 'mcp-only']);
export const MCP_FALLBACKS_BEFORE_PASTE = 2; // consecutive fallbacks
export const MCP_HEALTH_WINDOW_MS = 30 * 60 * 1000; // link for 30 min

/** Fresh MCP health (persisted in the worker state). */
export function createMcpHealth() {
  return { consecutiveFallbacks: 0, pasteUntil: 0 };
}

/**
 * Effective strategy for this tab. An explicitly set modeStrategy
 * wins; otherwise Gemini defaults to "ab" during the test period
 * (testMode on), and everything else defaults to "paste-first".
 * `explicit` is true when the user ever saved modeStrategy.
 */
export function resolveModeStrategy({ setting, explicit, testMode, site }) {
  if (explicit && MODE_STRATEGIES.includes(setting)) return setting;
  if (testMode && site === 'gemini') return 'ab';
  return 'paste-first';
}

/** A backend card may override the strategy with card.mode_hint. */
export function resolveCardStrategy({ strategy, card }) {
  const hint = card && card.mode_hint;
  if (hint && MODE_STRATEGIES.includes(hint)) return hint;
  return strategy;
}

/**
 * First mode for a card under a strategy. The MCP-health window
 * forces LINK first (except for mcp-only, which never falls back).
 * Answered cards always run in LINK mode.
 */
export function firstModeForCard({ strategy, card, health, now = Date.now() }) {
  if (card && card.status === 'answered') return 'link';
  const h = health || createMcpHealth();
  const inWindow = h.pasteUntil && now < h.pasteUntil;
  if (strategy === 'mcp-only') return 'mcp';
  if (strategy === 'paste-only') return 'link';
  if (inWindow) return 'link';
  if (strategy === 'mcp-first') return 'mcp';
  if (strategy === 'ab') return (card && (card.seq ?? 0) % 2 === 1) ? 'mcp' : 'link';
  return 'link'; // paste-first (and anything unknown)
}

/** May this strategy fall back from `from` to the other mode? */
export function canFallback({ strategy, from }) {
  if (strategy === 'mcp-only' || strategy === 'paste-only') return false;
  return from === 'mcp' || from === 'link';
}

/** First mode for the panel / heartbeat when no card is in flight. */
export function displayFirstMode({ strategy, health, now = Date.now() }) {
  if (strategy === 'ab') return 'ab';
  return firstModeForCard({ strategy, card: { status: 'queued', seq: 0 }, health, now });
}

/**
 * After an MCP fallback: one more consecutive fallback. The second
 * consecutive fallback opens a 30-minute LINK window, then MCP is
 * tried again on the next card. Returns the new health.
 */
export function recordMcpFallback(health, now) {
  const h = health || createMcpHealth();
  const consecutive = (h.consecutiveFallbacks || 0) + 1;
  if (consecutive >= MCP_FALLBACKS_BEFORE_PASTE) {
    return { consecutiveFallbacks: 0, pasteUntil: now + MCP_HEALTH_WINDOW_MS };
  }
  return { consecutiveFallbacks: consecutive, pasteUntil: 0 };
}

/**
 * After MCP demonstrably worked (done, blocked via tools, or a
 * backend "failed" status — the tools ran, the task itself failed):
 * the fallback streak resets and any LINK window closes.
 */
export function recordMcpSuccess(health) {
  return { consecutiveFallbacks: 0, pasteUntil: 0 };
}

/* --- Per-card mode stats (mode_stats) --- */

/** Fresh per-card stats, sent with submit and on failure via status. */
export function createModeStats() {
  return {
    mode_used: '',
    fell_back: false,
    fallback_reason: '',
    duration_s: 0,
    permission_prompts: 0, // prompts the watcher saw on this card
    auto_approved: 0, // of those, the ones auto-approved
    retries: 0, // extra attempts after the first
    ok: false,
  };
}

/** Fresh per-mode counters (persisted in the worker state). */
export function createModeCounters() {
  return {
    mcp: { cards: 0, ok: 0, totalDurationS: 0, permissionPrompts: 0 },
    link: { cards: 0, ok: 0, totalDurationS: 0, permissionPrompts: 0 },
  };
}

/** Fold one card's stats into the counters. Returns new counters. */
export function recordModeStats(counters, stats) {
  const c = counters || createModeCounters();
  const mode = stats.mode_used === 'mcp' ? 'mcp' : 'link';
  const prev = c[mode] || { cards: 0, ok: 0, totalDurationS: 0, permissionPrompts: 0 };
  return {
    ...c,
    [mode]: {
      cards: prev.cards + 1,
      ok: prev.ok + (stats.ok ? 1 : 0),
      totalDurationS: prev.totalDurationS + (stats.duration_s || 0),
      permissionPrompts: prev.permissionPrompts + (stats.permission_prompts || 0),
    },
  };
}

/** One mode's counter line for the panel: "MCP 12 cards · 83% ok · avg 94s · avg 1.2 prompts". */
export function formatModeCounter(label, counter) {
  const c = counter || { cards: 0, ok: 0, totalDurationS: 0, permissionPrompts: 0 };
  if (!c.cards) return `${label} 0 cards`;
  const okPct = Math.round((c.ok / c.cards) * 100);
  const avgS = Math.round(c.totalDurationS / c.cards);
  const avgPrompts = (c.permissionPrompts / c.cards).toFixed(1);
  return `${label} ${c.cards} cards · ${okPct}% ok · avg ${avgS}s · avg ${avgPrompts} prompts`;
}

/**
 * Whether the card may be submitted now. `fresh` is the re-read card
 * (null when the backend does not provide the card action — then the
 * caller proceeds, it cannot verify). Never submit the same card
 * twice: an already-done card must not be submitted again.
 */
export function decideSubmit(fresh) {
  if (!fresh) return 'submit';
  if (fresh.status === 'done') return 'already-done';
  if (fresh.status === 'skipped' || fresh.status === 'failed') return 'cancelled';
  return 'submit';
}
