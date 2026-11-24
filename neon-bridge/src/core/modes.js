// Mode choice + MCP health — pure logic, no DOM.
//
// Each card runs in one mode: MCP first (Gemini works through the
// neon-mcp tools and delivers with submit_file), paste as the
// fallback (send the prompt in the chat, supervise, extract, submit).
// Settings.mode is "auto" | "mcp" | "paste" (default "auto").
// Answered cards always run in paste mode: their answer is delivered
// as chat text, which is a paste-mode interaction.

export const MODE_SETTING_VALUES = Object.freeze(['auto', 'mcp', 'paste']);
export const MCP_FALLBACKS_BEFORE_PASTE = 2; // consecutive fallbacks
export const MCP_HEALTH_WINDOW_MS = 30 * 60 * 1000; // paste for 30 min

/** Fresh MCP health (persisted in the worker state). */
export function createMcpHealth() {
  return { consecutiveFallbacks: 0, pasteUntil: 0 };
}

/**
 * Decide the mode for a card.
 * Input: { modeSetting, health, card, now }.
 * health is { consecutiveFallbacks, pasteUntil } (ms epoch, 0 = none).
 * - answered cards -> paste (the answer is chat text)
 * - mode "paste" -> paste, always; mode "mcp" -> mcp, always
 * - auto -> paste while inside the health window, else mcp
 */
export function chooseMode({ modeSetting, health, card, now }) {
  const setting = MODE_SETTING_VALUES.includes(modeSetting) ? modeSetting : 'auto';
  if (card && card.status === 'answered') return 'paste';
  if (setting === 'paste') return 'paste';
  if (setting === 'mcp') return 'mcp';
  const h = health || createMcpHealth();
  if (h.pasteUntil && now < h.pasteUntil) return 'paste';
  return 'mcp';
}

/**
 * After an MCP fallback: one more consecutive fallback. The second
 * consecutive fallback opens a 30-minute paste window, then MCP is
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
 * the fallback streak resets and any paste window closes.
 */
export function recordMcpSuccess(health) {
  return { consecutiveFallbacks: 0, pasteUntil: 0 };
}
