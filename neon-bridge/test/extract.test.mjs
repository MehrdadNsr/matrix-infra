import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectQuestion,
  extractFencedBlocks,
  extractFinalFile,
  extractSingleFile,
  hasEndMarker,
  hasUnclosedFence,
  isCutOff,
  seamOverlap,
  stitchParts,
  stripProtocolLines,
} from '../src/core/extract.js';

test('extractFencedBlocks: single block with language', () => {
  const blocks = extractFencedBlocks('here\n```js\nconst a = 1;\n```\ndone');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, 'js');
  assert.equal(blocks[0].code, 'const a = 1;');
  assert.equal(blocks[0].closed, true);
});

test('extractFencedBlocks: multiple blocks, unclosed last one', () => {
  const text = '```py\nprint(1)\n```\ntext\n```js\nconst x = 2;';
  const blocks = extractFencedBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].closed, true);
  assert.equal(blocks[1].closed, false);
  assert.equal(hasUnclosedFence(text), true);
});

test('extractFencedBlocks: nested fences — inner ``` does not close outer ````', () => {
  const text = '````md\n# doc\n```js\ncode()\n```\nend\n````';
  const blocks = extractFencedBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].closed, true);
  assert.match(blocks[0].code, /```js/);
});

test('extractSingleFile: several blocks -> longest; none -> null', () => {
  const text = '```js\nshort\n```\n```js\nline1\nline2\nline3\nline4\n```';
  assert.match(extractSingleFile(text), /line4/);
  assert.equal(extractSingleFile('no fences here'), null);
});

test('stripProtocolLines: removes CARD/END/CONTINUE lines only', () => {
  const code = 'CARD 9\nconst a = 1;\n// mentions END-9 in a comment\nEND-9\nCONTINUE';
  const out = stripProtocolLines(code, '9');
  assert.equal(out, 'const a = 1;\n// mentions END-9 in a comment');
});

test('seamOverlap + stitchParts: overlapping lines at the seam are removed once', () => {
  const a = 'line1\nline2\nline3\nline4';
  const b = 'line3\nline4\nline5\nline6';
  assert.equal(seamOverlap(a.split('\n'), b.split('\n')), 2);
  assert.equal(stitchParts([a, b]), 'line1\nline2\nline3\nline4\nline5\nline6');
});

test('stitchParts: no overlap joins cleanly; full duplicate part collapses', () => {
  assert.equal(stitchParts(['a\nb', 'c\nd']), 'a\nb\nc\nd');
  assert.equal(stitchParts(['a\nb', 'a\nb']), 'a\nb');
  assert.equal(stitchParts(['a\nb', 'b\nc', 'c\nd']), 'a\nb\nc\nd');
  assert.equal(stitchParts([]), '');
  assert.equal(stitchParts(['  only  ']), 'only');
});

test('extractFinalFile: stitches supervisor-indexed messages in order, strips protocol', () => {
  const messages = [
    { role: 'user', text: 'prompt' },
    { role: 'model', text: 'CARD 5\n```js\nconst a = 1;\nconst b = 2;\n```' },
    { role: 'model', text: '```js\nconst b = 2;\nconst c = 3;\n```\nEND-5' },
    { role: 'model', text: '```js\nunrelated\n```' },
  ];
  const out = extractFinalFile(messages, [1, 2], '5');
  assert.equal(out, 'const a = 1;\nconst b = 2;\nconst c = 3;');
  // A non-model index and an out-of-range index are skipped.
  assert.equal(extractFinalFile(messages, [0, 99], '5'), '');
});

test('detectQuestion: English question block', () => {
  const text = 'QUESTION 7\nWhich version of the API should I target?\nIs the old endpoint still supported?\nEND-7';
  assert.deepEqual(detectQuestion(text, '7'), {
    question: 'Which version of the API should I target?\nIs the old endpoint still supported?',
  });
});

test('detectQuestion: Persian question text (markers stay in English)', () => {
  const text = 'QUESTION 7\nکدام نسخهٔ API را هدف بگیرم؟\nEND-7';
  assert.deepEqual(detectQuestion(text, '7'), { question: 'کدام نسخهٔ API را هدف بگیرم؟' });
});

test('detectQuestion: a code block in the same answer does not hide the question', () => {
  const text = '```js\nconst a = 1;\n```\nQUESTION 7\nShould this use ESM or CommonJS?\nEND-7';
  assert.deepEqual(detectQuestion(text, '7'), { question: 'Should this use ESM or CommonJS?' });
});

test('detectQuestion: no QUESTION block, wrong id, or missing END line -> null', () => {
  assert.equal(detectQuestion('just an answer\nEND-7', '7'), null);
  assert.equal(detectQuestion('QUESTION 8\nWhat?\nEND-8', '7'), null);
  // Cut off before the END line: not a question, a cut-off answer.
  assert.equal(detectQuestion('QUESTION 7\nWhat should I do?', '7'), null);
  assert.equal(detectQuestion('QUESTION 7\n\nEND-7', '7'), null);
  assert.equal(detectQuestion('', '7'), null);
});

test('hasEndMarker / isCutOff', () => {
  assert.equal(hasEndMarker('x\nEND-12', '12'), true);
  assert.equal(hasEndMarker('x\nEND-13', '12'), false);
  assert.equal(isCutOff('```js\na\n```\nEND-12', '12'), false);
  assert.equal(isCutOff('```js\na\n```', '12'), true); // no END marker
  assert.equal(isCutOff('```js\na\nEND-12', '12'), true); // unclosed fence
});
