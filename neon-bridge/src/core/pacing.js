// Pacing, quiet hours, backoff and quota guard — pure logic, no DOM.
// Every function takes the clock / randomness in, so tests can pin them.
// Times are local time unless stated otherwise.

/** "02:00" -> 120 (minutes since midnight). Throws on bad input. */
export function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) throw new Error(`pacing: bad HH:MM value ${JSON.stringify(value)}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) {
    throw new Error(`pacing: bad HH:MM value ${JSON.stringify(value)}`);
  }
  return h * 60 + min;
}

export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * True when `now` falls inside quiet hours.
 * Overnight ranges work: { start: '22:00', end: '06:00' } covers
 * 22:00-24:00 and 00:00-06:00. start === end means "never quiet"
 * (a zero-length range), so a disabled range cannot block the loop.
 */
export function isQuietHours(now, quietHours) {
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (start === end) return false;
  const t = minutesOfDay(now);
  if (start < end) return t >= start && t < end;
  return t >= start || t < end; // overnight
}

/** Minutes from `now` until quiet hours end (0 when not quiet). */
export function minutesUntilQuietEnd(now, quietHours) {
  if (!isQuietHours(now, quietHours)) return 0;
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  const t = minutesOfDay(now);
  if (start < end) return end - t;
  // Overnight: before midnight we wait until end tomorrow morning.
  return t >= start ? 24 * 60 - t + end : end - t;
}

/** Heartbeat interval: other agents watch this to see the bridge is alive. */
export const HEARTBEAT_INTERVAL_MS = 60000;

/** Random whole milliseconds in [minMs, maxMs]. `rand` is injectable. */
export function randomMs(minMs, maxMs, rand = Math.random) {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  const r = Math.min(rand(), 1 - Number.EPSILON);
  return lo + Math.floor(r * (hi - lo + 1));
}

/**
 * Human-like pause before a click (300-900 ms). The script runs as a
 * real user in a normal browser profile — never a bot framework —
 * so clicks land with human timing instead of back-to-back.
 */
export function humanClickDelayMs(rand = Math.random) {
  return randomMs(300, 900, rand);
}

/** Human-like pause between steps: set model -> set thinking -> send. */
export function stepDelayMs(rand = Math.random) {
  return randomMs(2000, 6000, rand);
}

/** Random whole seconds in [minSec, maxSec]. `rand` is injectable. */
export function randomPaceSec(minSec, maxSec, rand = Math.random) {
  const lo = Math.min(minSec, maxSec);
  const hi = Math.max(minSec, maxSec);
  // Clamp: Math.random() never returns 1, but an injected rand might,
  // and without the clamp the result could overshoot hi by one.
  const r = Math.min(rand(), 1 - Number.EPSILON);
  return lo + Math.floor(r * (hi - lo + 1));
}

/**
 * Exponential backoff in ms: base * 2^(attempt-1), capped, with up to
 * 25% jitter so several workers do not retry in lockstep.
 * attempt is 1-based.
 */
export function backoffMs(attempt, baseMs = 1000, capMs = 30000, rand = Math.random) {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, capMs);
  return Math.floor(capped * (1 + rand() * 0.25));
}

/** Seconds to sleep when the queue is empty: random 2-5 minutes. */
export function idlePollSec(rand = Math.random) {
  const r = Math.min(rand(), 1 - Number.EPSILON);
  return 120 + Math.floor(r * (300 - 120 + 1));
}

/**
 * Quota guard, from the remaining quota percentage (null = unknown).
 * - null: run (nothing known).
 * - 0: pause entirely.
 * - below 20%: only hydrogen/low cards may run.
 * - otherwise: run anything.
 * Returns { allowed, onlyHydrogenLow, reason }.
 */
export function quotaDecision(quotaPct, plan) {
  if (quotaPct == null) return { allowed: true, onlyHydrogenLow: false, reason: '' };
  if (quotaPct <= 0) {
    return { allowed: false, onlyHydrogenLow: false, reason: 'quota 0%' };
  }
  if (quotaPct < 20) {
    const ok = plan && plan.model === 'hydrogen' && plan.thinking === 'low';
    return {
      allowed: ok,
      onlyHydrogenLow: true,
      reason: ok ? '' : 'quota below 20%: hydrogen/low only',
    };
  }
  return { allowed: true, onlyHydrogenLow: false, reason: '' };
}

/**
 * ms until the next 5-hour quota refresh boundary.
 * Boundaries are at local-midnight + k*5h (00:00, 05:00, 10:00, 15:00,
 * 20:00, then 00:00 next day). A plain modulo does not work here
 * because 24h is not a multiple of 5h: at 23:00 the next boundary is
 * midnight (1h away), not 01:00. Exactly on a boundary counts as a
 * full 5h to the next one.
 */
export function msUntilNextRefresh(now) {
  const hourMs = 60 * 60 * 1000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const elapsed = now.getTime() - midnight.getTime();
  const boundaries = [0, 5, 10, 15, 20, 24, 29].map((h) => h * hourMs);
  for (const b of boundaries) {
    if (b > elapsed) return b - elapsed;
  }
  return 5 * hourMs; // unreachable given the 29h boundary, but safe
}

/** True when the soft daily message cap is reached. */
export function dailyCapReached(sentToday, dailySoftCap) {
  return sentToday >= dailySoftCap;
}
