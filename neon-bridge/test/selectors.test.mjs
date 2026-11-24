import test from 'node:test';
import assert from 'node:assert/strict';
import { SELECTORS, SELECTOR_VERIFICATION, TEXT_MATCH } from '../src/selectors.js';

// Every key the adapter and panel rely on must exist here, with at
// least one selector, so a missing key fails loudly in tests instead
// of silently on the live page.
const REQUIRED_KEYS = [
  'editor',
  'send',
  'inputArea',
  'userQuery',
  'modelResponse',
  'messageContent',
  'modelThoughts',
  'codeBlock',
  'stopButton',
  'busyIndicators',
  'modelPickerButton',
  'modelMenu',
  'modelMenuItem',
  'thinkingSubmenuRow',
  'thinkingOption',
  'errorToast',
  'signInLink',
];

test('selectors: every required key exists with non-empty string selectors', () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(Array.isArray(SELECTORS[key]), key);
    assert.ok(SELECTORS[key].length > 0, key);
    for (const sel of SELECTORS[key]) {
      assert.equal(typeof sel, 'string', `${key}: ${sel}`);
      assert.ok(sel.trim().length > 0, key);
    }
  }
});

test('selectors: every key has a verification status', () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(key in SELECTOR_VERIFICATION, key);
    assert.ok(
      ['spec', 'spec-primary-only', 'unverified'].includes(SELECTOR_VERIFICATION[key]),
      key,
    );
  }
});

test('selectors: model names are English only', () => {
  // 'Neon', not 'Neon 4': the Persian UI renders "4 Neon" (number first),
  // so the name alone is matched (verified on the live page).
  assert.deepEqual(TEXT_MATCH.modelNames, { neon: 'Neon', hydrogen: 'Hydrogen', carbon: 'Carbon' });
});

test('selectors: no hardcoded backend URL, account or repo name', () => {
  const blob = JSON.stringify(SELECTORS) + JSON.stringify(TEXT_MATCH);
  assert.ok(!/matrix-infra|MehrdadNsr|http/.test(blob));
});
