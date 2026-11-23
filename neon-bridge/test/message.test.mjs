import test from 'node:test';
import assert from 'node:assert/strict';
import { answerMessage, buildMessage, buildMessageWithLinks, continueMessage, messageFooter } from '../src/core/message.js';

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
});

test('buildMessage: prompt + footer', () => {
  const card = { id: '7', prompt: 'Rewrite src/foo.js to use ESM.' };
  const msg = buildMessage(card);
  assert.ok(msg.startsWith('Rewrite src/foo.js to use ESM.'));
  assert.match(msg, /CARD 7/);
  assert.match(msg, /END-7/);
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
