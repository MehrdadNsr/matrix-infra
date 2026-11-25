import test from 'node:test';
import assert from 'node:assert/strict';
import { answerMessage, buildGemMessage, buildMessage, buildMessageWithLinks, continueMessage, introForAttempt, mcpMessage, mcpNudgeMessage, messageFooter } from '../src/core/message.js';

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

test('mcpMessage: attempt 1 is the exact spec text', () => {
  const card = { id: 'c9', prompt: 'do the thing' };
  assert.equal(
    mcpMessage(card, 1),
    'Use the neon-mcp tools only. Call get_task with task_id=c9. ' +
    'Read the real files with read_file/list_dir, write the COMPLETE file, ' +
    'and deliver it with submit_file. Never paste the file in the chat. ' +
    'If something is unclear, call ask_question instead of guessing. ' +
    'When submit_file succeeds, reply with the PR link and DONE-c9.',
  );
});

test('mcpMessage: first sentence rotates by attempt, never byte-identical', () => {
  const card = { id: 'c9', prompt: 'do the thing' };
  const first = mcpMessage(card, 1);
  const second = mcpMessage(card, 2);
  assert.notEqual(first, second);
  assert.match(second, /task_id=c9/);
  assert.match(second, /DONE-c9/);
  assert.match(second, /submit_file/);
  assert.match(second, /never paste the file/i);
  assert.equal(mcpMessage(card, 5), first); // 4 intros, attempt 5 == attempt 1
});

test('mcpNudgeMessage: exact one-time nudge text', () => {
  assert.equal(
    mcpNudgeMessage({ id: 'c9' }),
    'You did not finish with submit_file. Call submit_file now with task_id=c9 and the complete file.',
  );
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
