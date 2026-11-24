// MCP mode — Gemini works through the neon-mcp tools and delivers
// the file with submit_file; the script polls the backend until the
// card is done, blocked or failed, and only falls back to paste mode
// on a pickup timeout, a "no tools" reply, or a task timeout.
//
// The poll decision (mcpPollDecision) is pure and unit-tested; the
// wiring below (send + poll loop) is thin. `ctx` and `s` are the same
// shapes paste.js uses (see its header). `s.mcp` is
// { startedAt, nudged, seen, sent, lastText, lastTextAt } — persisted
// in pending so a reload resumes polling instead of re-sending.

import { sentHash } from '../core/hash.js';
import { classifyError } from '../core/errors.js';
import { decideAfterSendFailure } from '../core/state.js';
import { mcpMessage, mcpNudgeMessage } from '../core/message.js';

export const MCP_POLL_MS = 10000;
const REPLY_STABLE_MS = 8000; // reply text unchanged this long = finished

/**
 * Pure poll decision. Input:
 *  card: fresh card from the backend, or null when the backend does
 *    not provide the card action
 *  seen: whether mcp_seen_at was already non-null
 *  nudged: whether the "did not submit" nudge was already sent
 *  elapsedMs, pickupTimeoutMs, taskTimeoutMs
 *  replyFinished: the reply ended (stop button gone, text stable)
 *  replyText: the last model turn, thinking removed
 * Returns { action, reason?, prUrl?, question?, seen } where action
 * is 'done' | 'blocked' | 'failed' | 'fallback' | 'nudge' | 'wait'.
 */
export function mcpPollDecision({
  card, seen, nudged, elapsedMs, pickupTimeoutMs, taskTimeoutMs,
  replyFinished, replyText,
}) {
  if (!card) return { action: 'fallback', reason: 'backend does not provide card action', seen };
  if (card.status === 'done') {
    return { action: 'done', prUrl: card.result_pr_url || card.pr_url || '', seen: seen || Boolean(card.mcp_seen_at) };
  }
  if (card.status === 'blocked') {
    return {
      action: 'blocked',
      question: card.question || card.last_error || 'Question asked via MCP tools',
      seen: seen || Boolean(card.mcp_seen_at),
    };
  }
  if (card.status === 'failed') {
    return { action: 'failed', reason: card.last_error || 'MCP task failed', seen: seen || Boolean(card.mcp_seen_at) };
  }
  const seenNow = seen || Boolean(card.mcp_seen_at);
  // A "no tools" reply is recognised immediately — no point waiting
  // for the pickup timeout when Gemini already said it cannot use
  // the tools.
  if (replyText && classifyError(replyText).kind === 'no_mcp_tools') {
    return { action: 'fallback', reason: 'Gemini reports no MCP tools', seen: seenNow };
  }
  if (!seenNow && elapsedMs > pickupTimeoutMs) {
    return { action: 'fallback', reason: `no MCP pickup in ${Math.round(pickupTimeoutMs / 1000)}s`, seen: seenNow };
  }
  if (elapsedMs > taskTimeoutMs) {
    return { action: 'fallback', reason: `MCP task timeout (${Math.round(taskTimeoutMs / 60000)} min)`, seen: seenNow };
  }
  if (replyFinished && !nudged) return { action: 'nudge', seen: seenNow };
  return { action: 'wait', seen: seenNow };
}

/**
 * One MCP-mode attempt. Returns { outcome, reason?, mcpWorked? }
 * where outcome is 'done' | 'failed' | 'skipped' | 'blocked' |
 * 'retry' | 'fallback' | 'paused'. 'mcpWorked' is true when the
 * tools demonstrably ran (done / blocked / backend-failed), so the
 * caller can reset the fallback streak. A backend "failed" status is
 * terminal there already — this function does NOT call failCard for
 * it. 'paused' means the user paused mid-poll: pending is kept for
 * resume, and the caller must not clear it.
 */
export async function runMcpAttempt(ctx, s) {
  const { card } = s;
  const model = s.model;
  const settings = ctx.settings;
  const mcp = s.mcp || (s.mcp = {
    startedAt: Date.now(), nudged: false, seen: false, sent: false,
    lastText: '', lastTextAt: 0,
  });

  if (!mcp.sent) {
    const message = mcpMessage(card, s.attempt);
    if (settings.dryRun) {
      ctx.log(`[dry run] would send MCP message (${message.length} chars) to ${model}/${s.thinking}, then poll for submit_file`);
      ctx.clearPending();
      return { outcome: 'done' };
    }
    const hash = await sentHash(message, s.attempt);
    const claim = await ctx.client.claim(card.id, hash);
    if (claim.duplicate) {
      ctx.log(`claim 409: card #${card.seq} was already sent; moving on`);
      ctx.clearPending();
      return { outcome: 'skipped' };
    }
    const inserted = await ctx.adapter.insertText(message);
    if (!inserted) {
      await ctx.failCard(card, model, 'could not insert prompt');
      return { outcome: 'failed' };
    }
    // Re-read before sending: an agent may have cancelled the card.
    if (!(await ctx.checkCardActive(card))) {
      ctx.clearPending();
      return { outcome: 'skipped' };
    }
    const sent = await ctx.sendWithBounceRetry(message);
    if (!sent.sent) {
      await ctx.client.setStatus(card.id, { status: 'waiting', last_error: sent.reason, model_used: model });
      const decision = decideAfterSendFailure(s.attempt, s.maxAttempts);
      if (decision.action === 'fail') {
        await ctx.failCard(card, model, sent.reason);
        return { outcome: 'failed' };
      }
      return { outcome: 'retry' };
    }
    ctx.state.sentToday += 1;
    ctx.persistState();
    mcp.sent = true;
    mcp.startedAt = Date.now();
    ctx.updatePending({ mcp: { ...mcp } });
  }

  // Poll the backend every 10 s until the card is done, blocked or
  // failed. The permission watcher (already running) auto-approves
  // neon-mcp tool prompts while this runs.
  while (true) {
    if (!ctx.isRunning()) return { outcome: 'paused' };
    let fresh = null;
    try {
      fresh = await ctx.client.card(card.id);
    } catch (err) {
      ctx.log(`card poll failed (${err.message}); retrying in 10s`);
      await ctx.sleep(MCP_POLL_MS);
      continue;
    }
    // Reply state: finished means the stop button is gone and the
    // last model text has been stable for 8 s.
    const gen = ctx.adapter.generationState();
    let replyFinished = false;
    if (!gen.generating && gen.lastModelText) {
      if (gen.lastModelText !== mcp.lastText) {
        mcp.lastText = gen.lastModelText;
        mcp.lastTextAt = Date.now();
      }
      replyFinished = Date.now() - mcp.lastTextAt >= REPLY_STABLE_MS;
    } else if (gen.generating) {
      mcp.lastText = gen.lastModelText;
      mcp.lastTextAt = Date.now();
    }
    const decision = mcpPollDecision({
      card: fresh,
      seen: mcp.seen,
      nudged: mcp.nudged,
      elapsedMs: Date.now() - mcp.startedAt,
      pickupTimeoutMs: settings.mcpPickupTimeoutSec * 1000,
      taskTimeoutMs: settings.mcpTaskTimeoutMin * 60 * 1000,
      replyFinished,
      replyText: gen.lastModelText,
    });
    mcp.seen = decision.seen || mcp.seen;
    if (decision.action === 'done') {
      ctx.log(`MCP done: card #${card.seq} -> ${decision.prUrl || 'ok'}`);
      if (ctx.panel) ctx.panel.setCard(`#${card.seq} done — ${decision.prUrl || ''}`);
      return { outcome: 'done', mcpWorked: true };
    }
    if (decision.action === 'blocked') {
      ctx.state.blockedCount = (ctx.state.blockedCount || 0) + 1;
      ctx.state.latestQuestion = decision.question;
      if (ctx.panel) ctx.panel.setBlocked(ctx.state.blockedCount, ctx.state.latestQuestion);
      ctx.log(`MCP blocked: question asked via tools (card #${card.seq})`);
      return { outcome: 'blocked', mcpWorked: true };
    }
    if (decision.action === 'failed') {
      ctx.log(`MCP failed: card #${card.seq} — ${decision.reason}`);
      return { outcome: 'failed', reason: decision.reason, mcpWorked: true };
    }
    if (decision.action === 'fallback') {
      return { outcome: 'fallback', reason: decision.reason };
    }
    if (decision.action === 'nudge') {
      const nudge = mcpNudgeMessage(card);
      const ok = await ctx.adapter.insertText(nudge) &&
        (await ctx.sendWithBounceRetry(nudge)).sent;
      // Sent once only, even when the send itself fails.
      mcp.nudged = true;
      if (ok) ctx.log('MCP nudge sent: asking Gemini to call submit_file now');
      else ctx.log('MCP nudge failed to send; continuing to poll');
    }
    ctx.updatePending({ mcp: { ...mcp } });
    await ctx.sleep(MCP_POLL_MS);
  }
}
