import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendClient,
  BridgeDuplicateError,
  BridgeKeyInvalidError,
} from '../src/backend/client.js';

function json(status, body) {
  return { status, text: JSON.stringify(body) };
}

/** Fake transport: returns the queued responses in order. */
function fakeTransport(responses) {
  const calls = [];
  const request = async (req) => {
    calls.push(JSON.parse(req.body || '{}'));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { request, calls };
}

test('client: retries on 500, then succeeds; sends the key header', async () => {
  const { request, calls } = fakeTransport([
    json(500, { ok: false }),
    json(200, { ok: true, card: null }),
  ]);
  const client = new BackendClient({
    backendUrl: 'https://backend.example/bridge',
    bridgeKey: 'k1',
    request,
  });
  const out = await client.next('worker-1');
  assert.equal(out.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].action, 'next');
  assert.equal(calls[0].worker, 'worker-1');
});

test('client: gives up after 3 tries on network errors', async () => {
  const { request } = fakeTransport([
    new Error('network error'),
    new Error('network error'),
    new Error('network error'),
    json(200, { ok: true }),
  ]);
  const client = new BackendClient({ backendUrl: 'https://b.example/', bridgeKey: 'k', request });
  await assert.rejects(client.next('w'), /network error/);
});

test('client: 401 throws BridgeKeyInvalidError immediately (no retry)', async () => {
  let count = 0;
  const request = async () => {
    count += 1;
    return json(401, { ok: false });
  };
  const client = new BackendClient({ backendUrl: 'https://b.example/', bridgeKey: 'bad', request });
  await assert.rejects(client.next('w'), BridgeKeyInvalidError);
  assert.equal(count, 1);
});

test('client: claim 409 -> { duplicate: true }, other claims -> false', async () => {
  const dup = new BackendClient({
    backendUrl: 'https://b.example/', bridgeKey: 'k',
    request: async () => json(409, {}),
  });
  assert.deepEqual(await dup.claim('c1', 'abc'), { duplicate: true });

  const ok = new BackendClient({
    backendUrl: 'https://b.example/', bridgeKey: 'k',
    request: async () => json(200, { ok: true }),
  });
  assert.deepEqual(await ok.claim('c1', 'abc'), { duplicate: false });
  await assert.rejects(
    new BackendClient({
      backendUrl: 'https://b.example/', bridgeKey: 'k',
      request: async () => json(409, {}),
    }).call('submit', { id: 'c1' }),
    BridgeDuplicateError,
  );
});

test('client: ask() sends id, question and chat_url', async () => {
  const { request, calls } = fakeTransport([json(200, { ok: true })]);
  const client = new BackendClient({
    backendUrl: 'https://b.example/', bridgeKey: 'k', request,
  });
  const out = await client.ask('c9', 'Which API version?', 'https://gemini.google.com/app/abc123');
  assert.equal(out.ok, true);
  assert.equal(calls[0].action, 'ask');
  assert.equal(calls[0].id, 'c9');
  assert.equal(calls[0].question, 'Which API version?');
  assert.equal(calls[0].chat_url, 'https://gemini.google.com/app/abc123');
});

test('client: heartbeat sends worker, state, card, quota, version', async () => {
  const { request, calls } = fakeTransport([json(200, { ok: true })]);
  const client = new BackendClient({
    backendUrl: 'https://b.example/', bridgeKey: 'k', request,
  });
  await client.heartbeat({
    worker: 'w1', state: 'running', cardId: 'c9', quotaPct: 42, lastError: null, version: '0.1.0',
  });
  assert.equal(calls[0].action, 'heartbeat');
  assert.equal(calls[0].worker, 'w1');
  assert.equal(calls[0].state, 'running');
  assert.equal(calls[0].card_id, 'c9');
  assert.equal(calls[0].quota_pct, 42);
  assert.equal(calls[0].version, '0.1.0');
});

test('client: card() normalizes {card} and bare card; 404 means not provided', async () => {
  const ok = new BackendClient({
    backendUrl: 'https://b.example/', bridgeKey: 'k',
    request: async () => json(200, { ok: true, card: { id: 'c1', status: 'queued' } }),
  });
  assert.deepEqual(await ok.card('c1'), { id: 'c1', status: 'queued' });

  const bare = new BackendClient({
    backendUrl: 'https://b.example/', bridgeKey: 'k',
    request: async () => json(200, { id: 'c2', status: 'skipped' }),
  });
  assert.deepEqual(await bare.card('c2'), { id: 'c2', status: 'skipped' });

  const missing = new BackendClient({
    backendUrl: 'https://b.example/', bridgeKey: 'k',
    request: async () => json(404, { ok: false }),
  });
  assert.equal(await missing.card('c3'), null);

  const { request: errReq } = fakeTransport([
    json(500, { ok: false }),
    json(500, { ok: false }),
    json(500, { ok: false }),
  ]);
  const serverError = new BackendClient({
    backendUrl: 'https://b.example/', bridgeKey: 'k', request: errReq,
  });
  await assert.rejects(serverError.card('c4'), /HTTP 500/);
});

test('client: fetchText caps at 60 KB', async () => {
  const client = new BackendClient({
    backendUrl: 'https://b.example/', bridgeKey: 'k',
    request: async () => ({ status: 200, text: 'x'.repeat(100 * 1024) }),
  });
  const text = await client.fetchText('https://example.invalid/f.js?raw=1');
  assert.equal(text.length, 60 * 1024);
});

test('client: missing backendUrl / bridgeKey throws before any request', async () => {
  const noUrl = new BackendClient({ backendUrl: '', bridgeKey: 'k', request: async () => json(200, {}) });
  await assert.rejects(noUrl.next('w'), /backendUrl is not set/);
  const noKey = new BackendClient({ backendUrl: 'https://b.example/', bridgeKey: '', request: async () => json(200, {}) });
  await assert.rejects(noKey.next('w'), /bridgeKey is not set/);
});
