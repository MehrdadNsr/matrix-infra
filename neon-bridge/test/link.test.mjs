import test from 'node:test';
import assert from 'node:assert/strict';

import { linkGemMessage, linkMessage } from '../src/core/message.js';
import { runLinkAttempt } from '../src/modes/link.js';

const CARD = {
  id: 'c1', seq: 3, file_path: 'a/b.js',
  prompt: 'Rewrite a/b.js in ESM.',
  read_url: 'https://read.example.com/task/c1',
};

// --- linkMessage ---

test('linkMessage: read link + instruction block, ends with END-<id>', () => {
  const msg = linkMessage(CARD, 1);
  assert.match(msg, /Read the task here: https:\/\/read\.example\.com\/task\/c1/);
  assert.match(msg, /exactly one fenced code block/);
  assert.match(msg, /END-c1/);
  assert.match(msg, /QUESTION c1/); // one-line QUESTION instruction, so the ask flow still works
  assert.doesNotMatch(msg, /Rewrite a\/b\.js in ESM/); // the task text is not pasted
});

test('linkMessage: no read_url -> falls back to pasting the card text', () => {
  const msg = linkMessage({ ...CARD, read_url: undefined }, 1);
  assert.match(msg, /Rewrite a\/b\.js in ESM/);
  assert.match(msg, /END-c1/);
});

test('linkMessage: never byte-identical across attempts (rotating intro)', () => {
  assert.notEqual(linkMessage(CARD, 1), linkMessage(CARD, 2));
});

test('linkGemMessage: CARD + link + one-line reminder', () => {
  const msg = linkGemMessage(CARD);
  assert.match(msg, /^CARD c1\n/);
  assert.match(msg, /Read the task here: https:\/\/read\.example\.com\/task\/c1/);
  assert.match(msg, /Follow your rules\. End with END-c1\./);
});

test('linkGemMessage: no read_url -> the card text', () => {
  const msg = linkGemMessage({ ...CARD, read_url: undefined });
  assert.match(msg, /Rewrite a\/b\.js in ESM/);
});

// --- runLinkAttempt wiring (fake ctx/adapter/client) ---

// The link attempt routes questions with window.location.href (as in
// the real userscript); node has no window, so define one for tests.
globalThis.window = { location: { href: 'https://gemini.google.com/app/c/test' } };

function fakeCtx({ messages = [], insertedFail = false, duplicate = false, submitted = null } = {}) {
  const calls = { inserted: [], sent: [], continues: 0, submits: [], fails: [], statuses: [], asks: [] };
  let queue = [...messages];
  const state = { sentToday: 0, blockedCount: 0, latestQuestion: '' };
  return {
    calls, state,
    settings: { dryRun: false },
    client: {
      claim: async () => ({ duplicate }),
      setStatus: async (id, fields) => { calls.statuses.push({ id, ...fields }); return {}; },
      ask: async (id, question, chatUrl) => { calls.asks.push({ id, question, chatUrl }); return {}; },
    },
    adapter: {
      insertText: async (text) => { calls.inserted.push(text); return !insertedFail; },
      send: async () => true,
      waitForCompletion: async () => ({ frozen: false, timedOut: false }),
      readMessages: () => queue,
      newChat: () => {},
    },
    sendWithBounceRetry: async () => { calls.sent.push(true); return { sent: true }; },
    failCard: async (card, model, reason) => { calls.fails.push(reason); return 'failed'; },
    submitCard: async (card, model, msgs, verdict) => {
      calls.submits.push({ card, model, msgs, verdict });
      return submitted ?? 'done';
    },
    checkCardActive: async () => true,
    buildLinkMessage: (card, attempt) => linkMessage(card, attempt),
    clearPending: () => {},
    updatePending: () => {},
    persistState: () => {},
    log: () => {},
    sleep: async () => {},
    isRunning: () => true,
    panel: { setCard: () => {}, setBlocked: () => {} },
  };
}

function fakeS(overrides = {}) {
  return {
    card: CARD, model: 'neon', thinking: 'medium', attempt: 1, maxAttempts: 4,
    continues: 0, isAnswered: false, ...overrides,
  };
}

const CODE_REPLY = [
  { role: 'user', text: 'Read the task here: https://read.example.com/task/c1' },
  { role: 'model', text: 'Here is the file:\n```js\nexport const x = 1;\n```\nEND-c1' },
];

test('runLinkAttempt: sends the read link, extracts the code block, submits', async () => {
  const ctx = fakeCtx({ messages: CODE_REPLY });
  const out = await runLinkAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'done');
  assert.equal(ctx.calls.inserted.length, 1);
  assert.match(ctx.calls.inserted[0], /read\.example\.com\/task\/c1/);
  assert.equal(ctx.calls.submits.length, 1);
  // The submitted verdict covers all messages; extraction strips fences + END.
  assert.deepEqual(ctx.calls.submits[0].verdict.message_indexes, [0, 1]);
  assert.equal(ctx.state.sentToday, 1);
});

test('runLinkAttempt: cut-off answer gets a Continue, then submits', async () => {
  const cutOff = [
    { role: 'user', text: 'Read the task here: https://read.example.com/task/c1' },
    { role: 'model', text: '```js\nexport const x = 1;\n' }, // unclosed fence, no END
  ];
  const complete = [
    { role: 'user', text: 'Read the task here: https://read.example.com/task/c1' },
    { role: 'model', text: '```js\nexport const x = 1;\n```\nEND-c1' },
  ];
  let reads = 0;
  const ctx = fakeCtx({ messages: cutOff });
  ctx.adapter.readMessages = () => (reads += 1, reads === 1 ? cutOff : complete);
  ctx.adapter.send = async () => { ctx.calls.continues += 1; return true; };
  const out = await runLinkAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'done');
  assert.equal(ctx.calls.continues, 1);
  assert.equal(ctx.calls.submits.length, 1);
});

test('runLinkAttempt: no code in the answer -> retry (new chat)', async () => {
  const ctx = fakeCtx({ messages: [{ role: 'model', text: 'I cannot read that link.' }] });
  const out = await runLinkAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'retry');
  assert.equal(ctx.calls.submits.length, 0);
});

test('runLinkAttempt: claim 409 -> skipped, nothing sent', async () => {
  const ctx = fakeCtx({ messages: CODE_REPLY, duplicate: true });
  const out = await runLinkAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'skipped');
  assert.equal(ctx.calls.inserted.length, 0);
  assert.equal(ctx.calls.submits.length, 0);
});

test('runLinkAttempt: insert failure -> failed', async () => {
  const ctx = fakeCtx({ messages: CODE_REPLY, insertedFail: true });
  const out = await runLinkAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'failed');
  assert.deepEqual(ctx.calls.fails, ['could not insert prompt']);
});

test('runLinkAttempt: QUESTION block -> blocked, question routed, no submit', async () => {
  const ctx = fakeCtx({
    messages: [{ role: 'model', text: 'QUESTION c1\nShould this use ESM or CJS?\nEND-c1' }],
  });
  const out = await runLinkAttempt(ctx, fakeS());
  assert.equal(out.outcome, 'blocked');
  assert.equal(ctx.calls.asks.length, 1);
  assert.equal(ctx.calls.asks[0].question, 'Should this use ESM or CJS?');
  assert.equal(ctx.state.blockedCount, 1);
  assert.equal(ctx.calls.submits.length, 0);
});
