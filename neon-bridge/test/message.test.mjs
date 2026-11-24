import test from 'node:test';
import assert from 'node:assert/strict';
import { answerMessage, buildGemMessage, buildMessage, buildMessageWithLinks, continueMessage, introForAttempt, messageFooter } from '../src/core/message.js';

test('messageFooter: contains the CARD line, the END line and the rules', () => {
  const footer = messageFooter('42');
  assert.match(footer, /CARD 42/);
  assert.match(footer, /END-42/);
  assert.match(footer, /ONE file in ONE fenced code block/);
  assert.match(footer, /CONTINUE/);
});

test('messageFooter: unclear task -> ask a QUESTION, do not guess', () => {
  const footer = messageFooter('42');
  assert.match(footer, /QUESTION 42/);
  assert.match(footer, /do NOT guess/);
  assert.match(footer, /contradicts the repo/);
});

test('answerMessage: answers first, then continue with the same rules', () => {
  const msg = answerMessage('7', 'Use API v2.');
  assert.ok(msg.startsWith('Answer to your questions:\nUse API v2.'));
  assert.match(msg, /Now continue the task/);
  assert.match(msg, /one file, one code block/);
  assert.match(msg, /END-7/);
  // A resend prefixes the rotating intro so it is never byte-identical.
  assert.notEqual(answerMessage('7', 'Use API v2.', 1), answerMessage('7', 'Use API v2.', 2));
  assert.match(answerMessage('7', 'Use API v2.', 2), /Answer to your questions/);
});

test('buildMessage: intro + prompt + footer', () => {
  const card = { id: '7', prompt: 'Rewrite src/foo.js to use ESM.' };
  const msg = buildMessage(card);
  assert.match(msg, /Rewrite src\/foo\.js to use ESM\./);
  assert.match(msg, /CARD 7/);
  assert.match(msg, /END-7/);
});

test('buildMessage: intro rotates by attempt, so resends are never byte-identical', () => {
  const card = { id: '7', prompt: 'Do it.' };
  const msgs = [1, 2, 3, 4].map((a) => buildMessage(card, a));
  assert.equal(new Set(msgs).size, 4);
  assert.equal(buildMessage(card, 5), buildMessage(card, 1));
  assert.equal(introForAttempt(1), introForAttempt(5));
});

test('buildGemMessage: only CARD + task + one-line reminder, no full footer', () => {
  const card = { id: '7', prompt: 'Rewrite src/foo.js to use ESM.' };
  const msg = buildGemMessage(card);
  assert.ok(msg.startsWith('CARD 7'));
  assert.match(msg, /Rewrite src\/foo\.js to use ESM\./);
  assert.match(msg, /Follow your rules\. End with END-7\./);
  assert.ok(!msg.includes('ONE file in ONE fenced code block'));
  assert.ok(!msg.includes('If links were given'));
  // Resends still vary.
  assert.notEqual(buildGemMessage(card, 1), buildGemMessage(card, 2));
});

test('continueMessage: same code block, no repetition, END marker', () => {
  const msg = continueMessage('7');
  assert.match(msg, /Continue exactly where you stopped/);
  assert.match(msg, /no repetition/);
  assert.match(msg, /END-7/);
});

test('buildMessageWithLinks: linked text pasted inline', () => {
  const card = { id: '3', prompt: 'Fix it.' };
  const msg = buildMessageWithLinks(card, [
    { url: 'https://example.invalid/a.js', text: 'const a = 1;' },
  ]);
  assert.match(msg, /linked file: https:\/\/example\.invalid\/a\.js/);
  assert.match(msg, /const a = 1;/);
  assert.match(msg, /END-3/);
});
