import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, sentHash } from '../src/core/hash.js';

test('sha256Hex: known vectors', async () => {
  assert.equal(
    await sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    await sha256Hex('hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});

test('sha256Hex: output is 64 lowercase hex chars, deterministic', async () => {
  const a = await sha256Hex('CARD 42 prompt');
  const b = await sha256Hex('CARD 42 prompt');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('sentHash: same message + attempt is stable, attempt changes the hash', async () => {
  const msg = 'do the thing\n\nRules: Start your answer with the line CARD 7.';
  const h1 = await sentHash(msg, 1);
  const h1b = await sentHash(msg, 1);
  const h2 = await sentHash(msg, 2);
  assert.equal(h1, h1b);
  assert.notEqual(h1, h2);
});
