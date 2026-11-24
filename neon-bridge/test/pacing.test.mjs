import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEARTBEAT_INTERVAL_MS,
  backoffMs,
  dailyCapReached,
  humanClickDelayMs,
  idlePollSec,
  isQuietHours,
  minutesUntilQuietEnd,
  msUntilNextRefresh,
  parseHHMM,
  quotaDecision,
  randomMs,
  randomPaceSec,
  stepDelayMs,
} from '../src/core/pacing.js';

function at(h, m) {
  const d = new Date(2026, 10, 23, h, m, 0, 0);
  return d;
}

test('parseHHMM', () => {
  assert.equal(parseHHMM('02:00'), 120);
  assert.equal(parseHHMM('23:59'), 1439);
  assert.throws(() => parseHHMM('24:00'));
  assert.throws(() => parseHHMM('nope'));
});

test('isQuietHours: daytime range', () => {
  const q = { start: '02:00', end: '08:00' };
  assert.equal(isQuietHours(at(1, 59), q), false);
  assert.equal(isQuietHours(at(2, 0), q), true);
  assert.equal(isQuietHours(at(5, 30), q), true);
  assert.equal(isQuietHours(at(7, 59), q), true);
  assert.equal(isQuietHours(at(8, 0), q), false);
});

test('isQuietHours: overnight range wraps midnight', () => {
  const q = { start: '22:00', end: '06:00' };
  assert.equal(isQuietHours(at(21, 59), q), false);
  assert.equal(isQuietHours(at(22, 0), q), true);
  assert.equal(isQuietHours(at(0, 30), q), true);
  assert.equal(isQuietHours(at(5, 59), q), true);
  assert.equal(isQuietHours(at(6, 0), q), false);
  assert.equal(isQuietHours(at(12, 0), q), false);
});

test('isQuietHours: start == end means never quiet', () => {
  assert.equal(isQuietHours(at(3, 0), { start: '02:00', end: '02:00' }), false);
});

test('minutesUntilQuietEnd: daytime and overnight', () => {
  assert.equal(minutesUntilQuietEnd(at(5, 0), { start: '02:00', end: '08:00' }), 180);
  assert.equal(minutesUntilQuietEnd(at(9, 0), { start: '02:00', end: '08:00' }), 0);
  // 23:00 in a 22:00-06:00 range: 60 min to midnight + 360 = 420.
  assert.equal(minutesUntilQuietEnd(at(23, 0), { start: '22:00', end: '06:00' }), 420);
  assert.equal(minutesUntilQuietEnd(at(2, 0), { start: '22:00', end: '06:00' }), 240);
});

test('human timing: pre-click 300-900 ms, between steps 2-6 s', () => {
  assert.equal(humanClickDelayMs(() => 0), 300);
  assert.equal(humanClickDelayMs(() => 1), 900);
  assert.equal(stepDelayMs(() => 0), 2000);
  assert.equal(stepDelayMs(() => 1), 6000);
  assert.equal(randomMs(100, 200, () => 0.5), 150);
  assert.equal(HEARTBEAT_INTERVAL_MS, 60000);
});

test('randomPaceSec: stays in range, uses the injected random', () => {
  assert.equal(randomPaceSec(60, 180, () => 0), 60);
  assert.equal(randomPaceSec(60, 180, () => 1), 180);
  assert.equal(randomPaceSec(60, 180, () => 0.5), 120);
  // Swapped bounds still work.
  assert.equal(randomPaceSec(180, 60, () => 0), 60);
});

test('backoffMs: doubles, caps, 1-based attempt', () => {
  const noJitter = () => 0;
  assert.equal(backoffMs(1, 1000, 30000, noJitter), 1000);
  assert.equal(backoffMs(2, 1000, 30000, noJitter), 2000);
  assert.equal(backoffMs(3, 1000, 30000, noJitter), 4000);
  assert.equal(backoffMs(10, 1000, 30000, noJitter), 30000);
});

test('idlePollSec: 2-5 minutes', () => {
  assert.equal(idlePollSec(() => 0), 120);
  assert.equal(idlePollSec(() => 1), 300);
});

test('quotaDecision: thresholds at 20% and 0%', () => {
  assert.deepEqual(quotaDecision(null, { model: 'neon', thinking: 'high' }).allowed, true);
  assert.equal(quotaDecision(50, { model: 'neon', thinking: 'high' }).allowed, true);
  assert.equal(quotaDecision(20, { model: 'neon', thinking: 'high' }).allowed, true);
  const low = quotaDecision(19, { model: 'neon', thinking: 'high' });
  assert.equal(low.allowed, false);
  assert.equal(low.onlyHydrogenLow, true);
  assert.equal(quotaDecision(19, { model: 'hydrogen', thinking: 'low' }).allowed, true);
  assert.equal(quotaDecision(19, { model: 'hydrogen', thinking: 'medium' }).allowed, false);
  assert.equal(quotaDecision(0, { model: 'hydrogen', thinking: 'low' }).allowed, false);
});

test('msUntilNextRefresh: 5h boundaries from local midnight', () => {
  // 03:00 -> next boundary 05:00 = 2h.
  assert.equal(msUntilNextRefresh(at(3, 0)), 2 * 60 * 60 * 1000);
  // 05:00 exactly -> a full 5h to the next one.
  assert.equal(msUntilNextRefresh(at(5, 0)), 5 * 60 * 60 * 1000);
  // 23:00 -> next boundary is 00:00 next day = 1h.
  assert.equal(msUntilNextRefresh(at(23, 0)), 60 * 60 * 1000);
});

test('dailyCapReached', () => {
  assert.equal(dailyCapReached(49, 50), false);
  assert.equal(dailyCapReached(50, 50), true);
  assert.equal(dailyCapReached(51, 50), true);
});
