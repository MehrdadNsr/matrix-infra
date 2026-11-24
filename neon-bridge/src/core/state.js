// State machine — pure logic, no DOM.
// The queue loop asks these functions what to do next; it never
// invents transitions inline, so the retry / escalation ladder is
// testable in one place.

export const THINKING_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const MODELS = Object.freeze(['neon', 'hydrogen']);

export const MAX_CONTINUES = 3; // same-chat "Continue" turns per card
export const MAX_GENERIC_FAILURES_BEFORE_STOP = 3; // consecutive cards
export const MAX_QUESTIONS = 3; // ask/answer rounds per card

/** One thinking level up, or null when already at the top. */
export function escalateThinking(level) {
  const idx = THINKING_LEVELS.indexOf(level);
  if (idx < 0) return 'medium'; // unknown level: start from the middle
  return idx + 1 < THINKING_LEVELS.length ? THINKING_LEVELS[idx + 1] : null;
}

/**
 * Resolve the plan for a card. A card flagged only_neon always runs
 * on neon, whatever the backend planned.
 */
export function resolvePlan(card, plan) {
  const model = card.only_neon ? 'neon' : plan.model || 'neon';
  const thinking = THINKING_LEVELS.includes(plan.thinking) ? plan.thinking : 'medium';
  return { model, thinking, reason: plan.reason || '' };
}

/**
 * Decide what to do after a supervisor verdict.
 * Input: { verdict, attempt, maxAttempts, continues, thinking }
 * verdict: { action, complete, needs_stitch, stale }
 * Returns { action, thinking?, note? } where action is one of
 * 'submit' | 'continue' | 'retry' | 'escalate' | 'fail'.
 *
 * - accept + complete -> submit (stitching happens in extractFinalFile).
 * - accept + incomplete -> continue (the answer was cut off).
 * - continue -> continue, up to MAX_CONTINUES, then retry in a new chat.
 * - retry -> new chat, resend (attempt+1); 'stale echo' is logged by
 *   the caller when verdict.stale is true.
 * - escalate -> one thinking level up, new chat, resend; at 'high'
 *   already, fall back to a plain retry.
 * - ask -> the model asked a question: a first-class state, not an
 *   error. The caller routes it to the backend and moves on; see
 *   recordAsk for the question cap.
 * - fail -> fail with the supervisor's reason.
 * Any branch that would exceed maxAttempts fails the card instead.
 */
export function decideAfterVerdict(input) {
  const { verdict, attempt, maxAttempts, continues, thinking } = input;
  const fail = (note) => ({ action: 'fail', note });
  const outOfAttempts = attempt >= maxAttempts;

  switch (verdict.action) {
    case 'accept': {
      if (verdict.complete) return { action: 'submit' };
      if (continues < MAX_CONTINUES) return { action: 'continue' };
      return outOfAttempts
        ? fail('accept but incomplete after max continues')
        : { action: 'retry', note: 'accept but incomplete after max continues' };
    }
    case 'continue': {
      if (continues < MAX_CONTINUES) return { action: 'continue' };
      return outOfAttempts
        ? fail('max continues reached')
        : { action: 'retry', note: 'max continues reached, retry in a new chat' };
    }
    case 'retry': {
      return outOfAttempts ? fail('max attempts reached') : { action: 'retry' };
    }
    case 'escalate': {
      const next = escalateThinking(thinking);
      if (next) {
        return outOfAttempts
          ? fail('max attempts reached')
          : { action: 'escalate', thinking: next };
      }
      // Already at high: nothing left to escalate to.
      return outOfAttempts ? fail('max attempts reached') : { action: 'retry' };
    }
    case 'ask': {
      return { action: 'ask', question: verdict.question || verdict.reason || '' };
    }
    case 'fail':
    default:
      return fail(verdict.reason || 'supervisor failed the card');
  }
}

/**
 * Bookkeeping for one ask round. Questions do NOT count toward
 * maxAttemptsPerCard, so the consumed-attempt count goes back down by
 * one: the answered resume re-runs the same attempt number with the
 * answer included. Returns { action: 'ask' | 'fail', attempt, questions, note? }.
 */
export function recordAsk({ attempt, questions }) {
  if (questions >= MAX_QUESTIONS) {
    return { action: 'fail', attempt, questions, note: 'too many questions' };
  }
  return { action: 'ask', attempt: Math.max(0, attempt - 1), questions: questions + 1 };
}

/**
 * Pick the next card from a `next` response. The backend gives
 * `answered` cards priority over queued ones; this is the pure
 * function the loop uses, so the rule is testable here.
 * `response` is { card } or { cards: [...] }. Returns a card or null.
 * Answered cards come first (oldest seq first); queued cards follow
 * in seq order.
 */
export function chooseNextCard(response) {
  const cards = Array.isArray(response.cards)
    ? response.cards
    : response.card
      ? [response.card]
      : [];
  if (cards.length === 0) return null;
  const answered = cards.filter((c) => c.status === 'answered');
  const queued = cards.filter((c) => c.status !== 'answered');
  const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0);
  answered.sort(bySeq);
  queued.sort(bySeq);
  return answered[0] || queued[0] || null;
}

/**
 * True when a card was cancelled by an agent: the worker must abort
 * that card cleanly instead of sending or submitting for it.
 */
export function isCancelledStatus(status) {
  return status === 'skipped' || status === 'failed';
}

/** After a send/generic failure: retry the card, or fail it. */
export function decideAfterSendFailure(attempt, maxAttempts) {
  return attempt >= maxAttempts
    ? { action: 'fail', note: 'max attempts reached' }
    : { action: 'retry' };
}

/** Stop the whole worker after this many consecutive generic failures. */
export function shouldStopAfterGenericFailures(consecutiveCount) {
  return consecutiveCount >= MAX_GENERIC_FAILURES_BEFORE_STOP;
}

/** Validate a supervisor verdict payload; returns null when usable. */
export function verdictProblem(verdict) {
  if (!verdict || typeof verdict !== 'object') return 'missing verdict';
  if (!['accept', 'continue', 'retry', 'escalate', 'fail', 'ask'].includes(verdict.action)) {
    return `unknown verdict action: ${String(verdict.action)}`;
  }
  if (!Array.isArray(verdict.message_indexes)) return 'verdict has no message_indexes';
  return null;
}

/**
 * Fresh persisted worker state (what survives a new-chat navigation).
 * `pending` is the in-flight card, saved before every navigation:
 * { card, plan, attempt, continues, thinking, model, linksInlined }
 * where `attempt` is the number of attempts already consumed, so a
 * resume re-runs the next attempt number, never the same one twice.
 */
export function createWorkerState() {
  return {
    running: false,
    dryRun: false,
    pending: null,
    sentToday: 0,
    sentDate: '',
    consecutiveGenericFailures: 0,
    stoppedReason: '',
    quotaPct: null,
    blockedCount: 0, // cards waiting for an answer (status "blocked")
    latestQuestion: '', // text of the most recent routed question
  };
}
