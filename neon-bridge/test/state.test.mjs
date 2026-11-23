import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONTINUES,
  MAX_QUESTIONS,
  chooseNextCard,
  createWorkerState,
  decideAfterSendFailure,
  decideAfterVerdict,
  escalateThinking,
  recordAsk,
  resolvePlan,
  shouldStopAfterGenericFailures,
  verdictProblem,
} from '../src/core/state.js';

test('escalateThinking: low->medium->high, then null', () => {
  assert.equal(escalateThinking('low'), 'medium');
  assert.equal(escalateThinking('medium'), 'high');
  assert.equal(escalateThinking('high'), null);
  assert.equal(escalateThinking('weird'), 'medium');
});

test('resolvePlan: only_neon forces neon', () => {
  const card = { only_neon: true };
  assert.deepEqual(
    resolvePlan(card, { model: 'hydrogen', thinking: 'low', reason: 'cheap' }),
    { model: 'neon', thinking: 'low', reason: 'cheap' },
  );
  assert.equal(resolvePlan({ only_neon: false }, { model: 'hydrogen', thinking: 'high' }).model, 'hydrogen');
  // Unknown thinking falls back to medium.
  assert.equal(resolvePlan({}, { model: 'neon', thinking: 'ultra' }).thinking, 'medium');
});

test('decideAfterVerdict: accept+complete -> submit; accept+incomplete -> continue', () => {
  const base = { attempt: 1, maxAttempts: 4, continues: 0, thinking: 'low' };
  assert.equal(
    decideAfterVerdict({ ...base, verdict: { action: 'accept', complete: true } }).action,
    'submit',
  );
  assert.equal(
    decideAfterVerdict({ ...base, verdict: { action: 'accept', complete: false } }).action,
    'continue',
  );
});

test('decideAfterVerdict: continue caps at MAX_CONTINUES, then retry', () => {
  const base = { attempt: 1, maxAttempts: 4, thinking: 'low' };
  assert.equal(
    decideAfterVerdict({ ...base, continues: 0, verdict: { action: 'continue' } }).action,
    'continue',
  );
  assert.equal(
    decideAfterVerdict({ ...base, continues: MAX_CONTINUES, verdict: { action: 'continue' } }).action,
    'retry',
  );
  // At max attempts the same situation fails the card instead.
  assert.equal(
    decideAfterVerdict({ ...base, attempt: 4, continues: MAX_CONTINUES, verdict: { action: 'continue' } }).action,
    'fail',
  );
});

test('decideAfterVerdict: retry respects max attempts', () => {
  assert.equal(
    decideAfterVerdict({ attempt: 1, maxAttempts: 4, continues: 0, thinking: 'low', verdict: { action: 'retry' } }).action,
    'retry',
  );
  assert.equal(
    decideAfterVerdict({ attempt: 4, maxAttempts: 4, continues: 0, thinking: 'low', verdict: { action: 'retry' } }).action,
    'fail',
  );
});

test('decideAfterVerdict: escalate goes one level up; at high it retries', () => {
  const out = decideAfterVerdict({
    attempt: 1, maxAttempts: 4, continues: 0, thinking: 'medium',
    verdict: { action: 'escalate' },
  });
  assert.deepEqual(out, { action: 'escalate', thinking: 'high' });
  const atHigh = decideAfterVerdict({
    attempt: 1, maxAttempts: 4, continues: 0, thinking: 'high',
    verdict: { action: 'escalate' },
  });
  assert.equal(atHigh.action, 'retry');
  const atHighLast = decideAfterVerdict({
    attempt: 4, maxAttempts: 4, continues: 0, thinking: 'high',
    verdict: { action: 'escalate' },
  });
  assert.equal(atHighLast.action, 'fail');
});

test('decideAfterVerdict: fail passes the reason through', () => {
  const out = decideAfterVerdict({
    attempt: 1, maxAttempts: 4, continues: 0, thinking: 'low',
    verdict: { action: 'fail', reason: 'wrong file entirely' },
  });
  assert.equal(out.action, 'fail');
  assert.match(out.note, /wrong file/);
});

test('decideAfterSendFailure', () => {
  assert.equal(decideAfterSendFailure(1, 4).action, 'retry');
  assert.equal(decideAfterSendFailure(4, 4).action, 'fail');
});

test('shouldStopAfterGenericFailures: stops at 3 consecutive', () => {
  assert.equal(shouldStopAfterGenericFailures(2), false);
  assert.equal(shouldStopAfterGenericFailures(3), true);
  assert.equal(shouldStopAfterGenericFailures(4), true);
});

test('verdictProblem: validates the supervisor payload', () => {
  assert.equal(verdictProblem(null), 'missing verdict');
  assert.match(verdictProblem({ action: 'dance' }), /unknown verdict action/);
  assert.match(verdictProblem({ action: 'accept' }), /message_indexes/);
  assert.equal(
    verdictProblem({ action: 'accept', message_indexes: [1], complete: true }),
    null,
  );
});

test('createWorkerState: fresh state has no pending card', () => {
  const s = createWorkerState();
  assert.equal(s.running, false);
  assert.equal(s.pending, null);
  assert.equal(s.sentToday, 0);
  assert.equal(s.blockedCount, 0);
  assert.equal(s.latestQuestion, '');
});

test('decideAfterVerdict: ask is a first-class state, not an error', () => {
  const out = decideAfterVerdict({
    attempt: 1, maxAttempts: 4, continues: 0, thinking: 'low',
    verdict: { action: 'ask', question: 'Which API version?' },
  });
  assert.deepEqual(out, { action: 'ask', question: 'Which API version?' });
});

test('verdictProblem: accepts ask', () => {
  assert.equal(
    verdictProblem({ action: 'ask', question: 'Which one?', message_indexes: [] }),
    null,
  );
});

test('recordAsk: questions do not consume an attempt; cap is 3', () => {
  // First question on attempt 2: the attempt is refunded for the resume.
  assert.deepEqual(recordAsk({ attempt: 2, questions: 0 }), { action: 'ask', attempt: 1, questions: 1 });
  assert.deepEqual(recordAsk({ attempt: 1, questions: 2 }), { action: 'ask', attempt: 0, questions: 3 });
  // The 4th question round fails the card.
  assert.deepEqual(recordAsk({ attempt: 2, questions: 3 }), {
    action: 'fail', attempt: 2, questions: 3, note: 'too many questions',
  });
  assert.equal(MAX_QUESTIONS, 3);
});

test('chooseNextCard: answered cards have priority over queued ones', () => {
  const queued1 = { id: 'q1', seq: 1, status: 'queued' };
  const queued2 = { id: 'q2', seq: 2, status: 'queued' };
  const answered = { id: 'a1', seq: 9, status: 'answered', answer: 'Use v2.' };
  // Answered wins even with the highest seq.
  assert.equal(chooseNextCard({ cards: [queued1, queued2, answered] }).id, 'a1');
  assert.equal(chooseNextCard({ cards: [queued2, queued1] }).id, 'q1');
  assert.equal(chooseNextCard({ cards: [answered, { ...answered, id: 'a2', seq: 3 }] }).id, 'a2');
  // Single-card shape still works.
  assert.equal(chooseNextCard({ card: queued1 }).id, 'q1');
  assert.equal(chooseNextCard({ card: null }), null);
  assert.equal(chooseNextCard({}), null);
  assert.equal(chooseNextCard({ cards: [] }), null);
});
