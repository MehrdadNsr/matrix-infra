// ==UserScript==
// @name         Neon Bridge v2
// @namespace    https://example.invalid/neon-bridge
// @version      0.1.0
// @description  Works through a queue of coding task cards on Gemini: picks model/thinking, sends the prompt, supervises the answer, submits the file to a backend that opens a PR.
// @author       Neon Bridge contributors
// @license      MIT
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
'use strict';

// ---- src/selectors.js ----
// The one map of every selector the script uses.
// A Gemini UI change means editing this file, not hunting through code.
//
// Each key maps to an ordered list of CSS selectors tried in order.
// Keys marked 'spec' were given as verified page facts; keys marked
// 'unverified' are best guesses the owner must check on the live page
// (see README.md "Selectors not yet verified"). Text matching (model
// names, "Send" / "ارسال") is done by the adapter using the strings in
// TEXT_MATCH below — never match on other UI text, because the UI
// language may be Persian.
//
// Model names are always matched in English: "Hydrogen", "Neon 4",
// "Carbon" (locked).

const SELECTORS = {
  // Prompt editor (contenteditable). [spec]
  editor: ['rich-textarea .ql-editor', '.ql-editor[contenteditable="true"]'],

  // Send button. Primary is the aria-label; the rest are fallbacks.
  // The final fallback (last enabled button in the input area) is
  // implemented by the adapter, not as a selector. [spec, fallbacks unverified]
  send: [
    'button[aria-label*="Send" i]',
    'button.send-button',
    'button[aria-label*="ارسال"]',
  ],
  // The input area that contains the send button (for the last-button fallback).
  inputArea: ['rich-textarea', '[data-testid="input-area"]'],

  // Conversation turns. [spec]
  userQuery: ['user-query'],
  modelResponse: ['model-response'],
  messageContent: ['message-content'],
  // Thinking sections inside an answer — excluded when reading text.
  modelThoughts: ['model-thoughts', '[data-thoughts]', '.thinking-content'],
  // Code blocks inside an answer. [spec]
  codeBlock: ['pre code'],

  // Stop-generation button (present while Gemini is answering).
  stopButton: ['button[aria-label*="Stop" i]', 'button[aria-label*="توقف"]'],

  // Model picker: the button in the input bar showing the current
  // mode name, and the menu it opens. [unverified — see README]
  modelPickerButton: [
    'button[aria-label*="model" i]',
    'button[aria-label*="Model" i]',
  ],
  modelMenu: ['[role="menu"]', '[role="listbox"]'],
  modelMenuItem: ['[role="menuitem"]', '[role="option"]', 'li'],
  // The last menu row opens the thinking-level submenu. [unverified]
  thinkingSubmenuRow: ['[role="menu"] > *:last-child', '[role="listbox"] > *:last-child'],
  thinkingOption: ['[role="menuitemradio"]', '[role="option"]', '[aria-checked]'],

  // Toasts / inline errors. [unverified]
  errorToast: ['[role="alert"]', '.error-toast', '[data-testid="error-toast"]'],

  // Sign-in / captcha / unusual-traffic markers (checked by text too).
  signInLink: ['a[href*="accounts.google.com"]'],
};

/** Text fragments the adapter may match on (model names only in English). */
const TEXT_MATCH = {
  modelNames: { neon: 'Neon 4', hydrogen: 'Hydrogen', carbon: 'Carbon' },
  sendLabels: ['Send', 'ارسال'],
  stopLabels: ['Stop', 'توقف'],
  signedOut: ['Sign in', 'ورود'],
  captcha: ['captcha', 'unusual traffic', 'ترافیک غیرمعمول'],
};

/** Which selector keys still need a live-page check by the owner. */
const SELECTOR_VERIFICATION = {
  editor: 'spec',
  send: 'spec-primary-only',
  inputArea: 'unverified',
  userQuery: 'spec',
  modelResponse: 'spec',
  messageContent: 'spec',
  modelThoughts: 'spec',
  codeBlock: 'spec',
  stopButton: 'unverified',
  modelPickerButton: 'unverified',
  modelMenu: 'unverified',
  modelMenuItem: 'unverified',
  thinkingSubmenuRow: 'unverified',
  thinkingOption: 'unverified',
  errorToast: 'unverified',
  signInLink: 'unverified',
};


// ---- src/core/hash.js ----
// Hashing — pure logic, no DOM.
// sent_hash is sha256(message + attempt number). We use WebCrypto
// (available on https pages and in Node 18+) so the implementation is
// correct by construction instead of a hand-rolled SHA-256.

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
async function sha256Hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    // Tampermonkey on https://gemini.google.com always has WebCrypto.
    // Fail loudly instead of silently downgrading the hash.
    throw new Error('hash: WebCrypto (crypto.subtle) is not available');
  }
  const data = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The hash claimed to the backend before sending a card.
 * The attempt number is part of the input so a resend of the same
 * message on a later attempt is a different claim.
 */
async function sentHash(message, attempt) {
  return sha256Hex(`${message}\n#attempt:${attempt}`);
}


// ---- src/core/errors.js ----
// Error classification — pure logic, no DOM.
//
// The adapter reports raw page text; this module turns it into a kind
// the queue loop can act on. Patterns cover English and Persian because
// the Gemini UI language may be Persian. Model names are always matched
// in English (see selectors.js).
//
// Unknown texts are NOT swallowed: classifyError returns kind 'unknown'
// and keeps the raw text verbatim so the loop can log it and the owner
// can add a pattern later.

const ERROR_KINDS = Object.freeze([
  'signed_out',
  'captcha',
  'unusual_traffic',
  'weekly_cap',
  'quota',
  'generic',
  'send_failure',
  'links_not_read',
  'settings_mismatch',
  'network',
  'unknown',
]);

// Order matters: the first matching group wins. Blocking / account
// problems are checked before quota, quota before generic errors.
const PATTERNS = [
  {
    kind: 'signed_out',
    patterns: [
      /sign\s*in/i,
      /signed\s*out/i,
      /log\s*in/i,
      /وارد\s*شوید/,
      /ورود\s*به\s*حساب/,
      /از\s*حساب\s*خارج/,
    ],
  },
  {
    kind: 'captcha',
    patterns: [
      /captcha/i,
      /verify\s+you('re| are)\s+human/i,
      /i'?m\s+not\s+a\s+robot/i,
      /are\s+you\s+a\s+robot/i,
    ],
  },
  {
    kind: 'unusual_traffic',
    patterns: [
      /unusual\s+traffic/i,
      /ترافیک\s*غیر\s*معمول/,
      /ترافیک\s*غیر\s*عادی/,
    ],
  },
  {
    kind: 'weekly_cap',
    patterns: [
      /weekly\s+(limit|cap)/i,
      /week'?s\s+limit/i,
      /محدودیت\s*هفتگی/,
      /سقف\s*هفتگی/,
    ],
  },
  {
    kind: 'quota',
    patterns: [
      /quota/i,
      /limit\s+(reached|exceeded)/i,
      /you'?ve\s+reached\s+(your|the)\s+limit/i,
      /reached\s+your\s+limit/i,
      /rate\s+limit/i,
      /try\s+again\s+(in|later|tomorrow)/i,
      /محدودیت/,
      /سهمیه/,
      /به\s*حد\s*مجاز/,
      /ظرفیت\s*(تکمیل|تمام)/,
    ],
  },
  {
    kind: 'generic',
    patterns: [
      /something\s+went\s+wrong/i,
      /an\s+error\s+occurred/i,
      /\berror\s*(1076|1099)\b/,
      /\b(1076|1099)\b/,
      /try\s+again/i,
      /خطایی\s*رخ\s*داد/,
      /مشکلی\s*پیش\s*آمد/,
      /خطا/,
      /دوباره\s*تلاش\s*کنید/,
    ],
  },
  {
    kind: 'send_failure',
    patterns: [
      /couldn'?t\s+send/i,
      /failed\s+to\s+send/i,
      /message\s+(could\s*not|didn'?t)\s+send/i,
      /not\s+sent/i,
      /ارسال\s*نشد/,
      /پیام\s*ارسال\s*نشد/,
    ],
  },
  {
    kind: 'links_not_read',
    patterns: [
      /links?\s+(were\s+)?not\s+read/i,
      /didn'?t\s+read\s+the\s+links?/i,
      /did\s+not\s+(read|open)\s+the\s+links?/i,
      /haven'?t\s+read/i,
      /پیوند.*خوانده\s*نشد/,
      /لینک.*خوانده\s*نشد/,
    ],
  },
  {
    kind: 'settings_mismatch',
    patterns: [
      /model\s+(changed|switched)/i,
      /thinking\s+(level\s+)?changed/i,
      /switched\s+to\s+\w+/i,
    ],
  },
  {
    kind: 'network',
    patterns: [
      /network\s+error/i,
      /you'?re\s+offline/i,
      /no\s+internet/i,
      /connection\s+(lost|failed|timed?\s*out)/i,
      /اتصال\s*قطع/,
      /اینترنت/,
    ],
  },
];

/**
 * Classify raw page / toast / supervisor text.
 * Returns { kind, text } where text is the original text verbatim
 * (trimmed, capped at 500 chars so a huge page dump cannot flood logs).
 */
function classifyError(rawText) {
  const text = String(rawText == null ? '' : rawText).trim().slice(0, 500);
  if (!text) return { kind: 'unknown', text: '' };
  for (const group of PATTERNS) {
    for (const re of group.patterns) {
      if (re.test(text)) return { kind: group.kind, text };
    }
  }
  return { kind: 'unknown', text };
}

/** True when the kind is a full-stop condition (never auto-recovered). */
function isStopKind(kind) {
  return (
    kind === 'signed_out' ||
    kind === 'captcha' ||
    kind === 'unusual_traffic' ||
    kind === 'weekly_cap'
  );
}

/** True when the kind is worth one new-chat retry before giving up. */
function isNewChatRetryKind(kind) {
  return kind === 'generic' || kind === 'quota' || kind === 'send_failure';
}


// ---- src/core/extract.js ----
// Code-block extraction and stitching — pure logic, no DOM.
//
// The model must output exactly ONE file in ONE fenced code block.
// Reality is messier: answers get cut off, continue-turns repeat a few
// lines at the seam, and sometimes several blocks appear. These helpers
// deal with that without ever touching the page.

/** A fenced block: { lang, code, fence } where fence is the backtick run. */
function extractFencedBlocks(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^(`{3,})\s*([^\s`]*)\s*$/);
    if (!open) {
      i += 1;
      continue;
    }
    const fence = open[1];
    const lang = open[2] || '';
    const body = [];
    let closed = false;
    i += 1;
    while (i < lines.length) {
      // A closing fence is a run of backticks >= the opening run,
      // alone on its line. This is what makes nested fences work:
      // an inner ``` does not close an outer ```` block.
      if (/^`{3,}\s*$/.test(lines[i]) && lines[i].trim().length >= fence.length) {
        closed = true;
        i += 1;
        break;
      }
      body.push(lines[i]);
      i += 1;
    }
    blocks.push({ lang, code: body.join('\n'), fence, closed });
  }
  return blocks;
}

/**
 * Pick the single file out of answer text.
 * - One block: it.
 * - Several blocks: the longest one (usually the file; the others are
 *   usually short snippets or examples). Returns null when there is none.
 * - No fence at all: null — the caller falls back to the raw text only
 *   if the supervisor explicitly accepted it, never silently.
 */
function extractSingleFile(text) {
  const blocks = extractFencedBlocks(text);
  if (blocks.length === 0) return null;
  let best = blocks[0];
  for (const b of blocks) {
    if (b.code.length > best.code.length) best = b;
  }
  return best.code;
}

/** True when the text contains an unclosed fence. */
function hasUnclosedFence(text) {
  return extractFencedBlocks(text).some((b) => !b.closed);
}

function hasEndMarker(text, id) {
  return String(text).includes(`END-${id}`);
}

/**
 * Detect a QUESTION block in an answer: a block starting with the
 * line `QUESTION <id>`, the questions listed, ending with `END-<id>`.
 * Works whether or not the same answer also contains code — a model
 * that asks must be treated as asking even if it also pasted code.
 * The question text itself may be English or Persian; only the
 * markers are matched. Returns { question } or null when there is no
 * complete QUESTION block for this id (a block without its END line
 * is a cut-off answer, not a question).
 */
function detectQuestion(text, id) {
  const lines = String(text == null ? '' : text).split('\n');
  const start = lines.findIndex((line) => line.trim() === `QUESTION ${id}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, idx) => idx > start && line.trim() === `END-${id}`);
  if (end < 0) return null;
  const question = lines.slice(start + 1, end).join('\n').trim();
  if (!question) return null;
  return { question };
}

/** Cut off = no END marker, or a fence was left open. */
function isCutOff(text, id) {
  return !hasEndMarker(text, id) || hasUnclosedFence(text);
}

/**
 * Remove the protocol lines the model was asked to emit:
 * the opening `CARD <id>` line, the closing `END-<id>` line and a
 * trailing `CONTINUE` line. Lines are matched exactly (after trim);
 * code that merely mentions them is untouched.
 */
function stripProtocolLines(code, id) {
  return String(code == null ? '' : code)
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t !== `CARD ${id}` && t !== `END-${id}` && t !== 'CONTINUE';
    })
    .join('\n')
    .trim();
}

const MAX_SEAM_OVERLAP = 40; // lines; a real repeat at a seam is short

/**
 * Find how many trailing lines of `a` equal the leading lines of `b`.
 * Blank lines at the seam are ignored on both sides.
 */
function seamOverlap(aLines, bLines) {
  const a = [...aLines];
  const b = [...bLines];
  while (a.length && a[a.length - 1].trim() === '') a.pop();
  while (b.length && b[0].trim() === '') b.shift();
  const max = Math.min(a.length, b.length, MAX_SEAM_OVERLAP);
  for (let k = max; k >= 1; k -= 1) {
    let same = true;
    for (let j = 0; j < k; j += 1) {
      if (a[a.length - k + j] !== b[j]) {
        same = false;
        break;
      }
    }
    if (same) return k;
  }
  return 0;
}

/**
 * Join continued parts of one file, removing lines repeated at a seam.
 * Parts are joined in order; each new part drops its leading lines
 * that duplicate the tail of what came before.
 */
function stitchParts(parts) {
  const cleaned = parts.map((p) => String(p == null ? '' : p).trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  let acc = cleaned[0];
  for (let idx = 1; idx < cleaned.length; idx += 1) {
    const aLines = acc.split('\n');
    const bLines = cleaned[idx].split('\n');
    const overlap = seamOverlap(aLines, bLines);
    const rest = bLines.slice(overlap).join('\n');
    acc = `${acc}\n${rest}`.trim();
  }
  return acc;
}

/**
 * Build the final file from the supervisor-accepted messages.
 * `messages` are the collected { role, text } turns, `indexes` are the
 * supervisor's message_indexes in order. Each message contributes its
 * single-file code; the parts are stitched, then protocol lines are
 * stripped once at the end.
 */
function extractFinalFile(messages, indexes, id) {
  const parts = [];
  for (const idx of indexes) {
    const msg = messages[idx];
    if (!msg || msg.role !== 'model') continue;
    const code = extractSingleFile(msg.text);
    if (code != null && code.trim() !== '') parts.push(code);
  }
  return stripProtocolLines(stitchParts(parts), id);
}


// ---- src/core/pacing.js ----
// Pacing, quiet hours, backoff and quota guard — pure logic, no DOM.
// Every function takes the clock / randomness in, so tests can pin them.
// Times are local time unless stated otherwise.

/** "02:00" -> 120 (minutes since midnight). Throws on bad input. */
function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) throw new Error(`pacing: bad HH:MM value ${JSON.stringify(value)}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) {
    throw new Error(`pacing: bad HH:MM value ${JSON.stringify(value)}`);
  }
  return h * 60 + min;
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * True when `now` falls inside quiet hours.
 * Overnight ranges work: { start: '22:00', end: '06:00' } covers
 * 22:00-24:00 and 00:00-06:00. start === end means "never quiet"
 * (a zero-length range), so a disabled range cannot block the loop.
 */
function isQuietHours(now, quietHours) {
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (start === end) return false;
  const t = minutesOfDay(now);
  if (start < end) return t >= start && t < end;
  return t >= start || t < end; // overnight
}

/** Minutes from `now` until quiet hours end (0 when not quiet). */
function minutesUntilQuietEnd(now, quietHours) {
  if (!isQuietHours(now, quietHours)) return 0;
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  const t = minutesOfDay(now);
  if (start < end) return end - t;
  // Overnight: before midnight we wait until end tomorrow morning.
  return t >= start ? 24 * 60 - t + end : end - t;
}

/** Random whole seconds in [minSec, maxSec]. `rand` is injectable. */
function randomPaceSec(minSec, maxSec, rand = Math.random) {
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
function backoffMs(attempt, baseMs = 1000, capMs = 30000, rand = Math.random) {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, capMs);
  return Math.floor(capped * (1 + rand() * 0.25));
}

/** Seconds to sleep when the queue is empty: random 2-5 minutes. */
function idlePollSec(rand = Math.random) {
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
function quotaDecision(quotaPct, plan) {
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
function msUntilNextRefresh(now) {
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
function dailyCapReached(sentToday, dailySoftCap) {
  return sentToday >= dailySoftCap;
}


// ---- src/core/message.js ----
// Message building — pure logic, no DOM.
// The exact footer text is part of the contract with the supervisor:
// the CARD / END markers let the supervisor (and the extractor) tell
// a complete answer from a cut-off one.

/** The footer appended to every card prompt. `id` is the card id. */
function messageFooter(id) {
  return [
    `Rules: Start your answer with the line CARD ${id}.`,
    'If links were given, first quote the first line of each linked file exactly.',
    'Output exactly ONE file in ONE fenced code block: the complete file, no placeholders.',
    `End with the line END-${id}.`,
    'If you must stop early, end with CONTINUE instead.',
    `If anything in the task is unclear or contradicts the repo, do NOT guess. Output only a block starting with the line QUESTION ${id}, list your questions, end with END-${id}, and stop.`,
  ].join(' ');
}

/**
 * Message sent when a card comes back answered: the answers to the
 * model's questions, then the instruction to continue the task.
 */
function answerMessage(id, answer) {
  return (
    `Answer to your questions:\n${answer}\n` +
    `Now continue the task. Same rules: one file, one code block, end with END-${id}.`
  );
}

/** Full message sent to Gemini for a card. */
function buildMessage(card) {
  return `${card.prompt}\n\n${messageFooter(card.id)}`;
}

/** Ask for the rest of a cut-off answer, in the same chat. */
function continueMessage(id) {
  return (
    'Continue exactly where you stopped, inside the same code block, ' +
    'no repetition. ' +
    `End with END-${id}.`
  );
}

/** Message used when links were not read: prompt + linked text inline. */
function buildMessageWithLinks(card, linkedTexts) {
  const inline = linkedTexts
    .map((t) => `--- linked file: ${t.url} ---\n${t.text}`)
    .join('\n\n');
  return `${card.prompt}\n\n${inline}\n\n${messageFooter(card.id)}`;
}


// ---- src/core/state.js ----
// State machine — pure logic, no DOM.
// The queue loop asks these functions what to do next; it never
// invents transitions inline, so the retry / escalation ladder is
// testable in one place.

const THINKING_LEVELS = Object.freeze(['low', 'medium', 'high']);
const MODELS = Object.freeze(['neon', 'hydrogen']);

const MAX_CONTINUES = 3; // same-chat "Continue" turns per card
const MAX_GENERIC_FAILURES_BEFORE_STOP = 3; // consecutive cards
const MAX_QUESTIONS = 3; // ask/answer rounds per card

/** One thinking level up, or null when already at the top. */
function escalateThinking(level) {
  const idx = THINKING_LEVELS.indexOf(level);
  if (idx < 0) return 'medium'; // unknown level: start from the middle
  return idx + 1 < THINKING_LEVELS.length ? THINKING_LEVELS[idx + 1] : null;
}

/**
 * Resolve the plan for a card. A card flagged only_neon always runs
 * on neon, whatever the backend planned.
 */
function resolvePlan(card, plan) {
  const model = card.only_neon ? 'neon' : plan.model || 'neon';
  const thinking = THINKING_LEVELS.includes(plan.thinking) ? plan.thinking : 'medium';
  return { model, thinking, reason: plan.reason || '' };
}

/**
 * Decide what to do after a supervisor verdict.
 * Input: { verdict, attempt, maxAttempts, continues, thinking }
 * verdict: { action, complete, needs_stitch, stale }
 * Returns { action, thinking?, note? } where action is one of
 * 'submit' | 'continue' | 'retry' | 'escalate' | 'fail'.
 *
 * - accept + complete -> submit (stitching happens in extractFinalFile).
 * - accept + incomplete -> continue (the answer was cut off).
 * - continue -> continue, up to MAX_CONTINUES, then retry in a new chat.
 * - retry -> new chat, resend (attempt+1); 'stale echo' is logged by
 *   the caller when verdict.stale is true.
 * - escalate -> one thinking level up, new chat, resend; at 'high'
 *   already, fall back to a plain retry.
 * - ask -> the model asked a question: a first-class state, not an
 *   error. The caller routes it to the backend and moves on; see
 *   recordAsk for the question cap.
 * - fail -> fail with the supervisor's reason.
 * Any branch that would exceed maxAttempts fails the card instead.
 */
function decideAfterVerdict(input) {
  const { verdict, attempt, maxAttempts, continues, thinking } = input;
  const fail = (note) => ({ action: 'fail', note });
  const outOfAttempts = attempt >= maxAttempts;

  switch (verdict.action) {
    case 'accept': {
      if (verdict.complete) return { action: 'submit' };
      if (continues < MAX_CONTINUES) return { action: 'continue' };
      return outOfAttempts
        ? fail('accept but incomplete after max continues')
        : { action: 'retry', note: 'accept but incomplete after max continues' };
    }
    case 'continue': {
      if (continues < MAX_CONTINUES) return { action: 'continue' };
      return outOfAttempts
        ? fail('max continues reached')
        : { action: 'retry', note: 'max continues reached, retry in a new chat' };
    }
    case 'retry': {
      return outOfAttempts ? fail('max attempts reached') : { action: 'retry' };
    }
    case 'escalate': {
      const next = escalateThinking(thinking);
      if (next) {
        return outOfAttempts
          ? fail('max attempts reached')
          : { action: 'escalate', thinking: next };
      }
      // Already at high: nothing left to escalate to.
      return outOfAttempts ? fail('max attempts reached') : { action: 'retry' };
    }
    case 'ask': {
      return { action: 'ask', question: verdict.question || verdict.reason || '' };
    }
    case 'fail':
    default:
      return fail(verdict.reason || 'supervisor failed the card');
  }
}

/**
 * Bookkeeping for one ask round. Questions do NOT count toward
 * maxAttemptsPerCard, so the consumed-attempt count goes back down by
 * one: the answered resume re-runs the same attempt number with the
 * answer included. Returns { action: 'ask' | 'fail', attempt, questions, note? }.
 */
function recordAsk({ attempt, questions }) {
  if (questions >= MAX_QUESTIONS) {
    return { action: 'fail', attempt, questions, note: 'too many questions' };
  }
  return { action: 'ask', attempt: Math.max(0, attempt - 1), questions: questions + 1 };
}

/**
 * Pick the next card from a `next` response. The backend gives
 * `answered` cards priority over queued ones; this is the pure
 * function the loop uses, so the rule is testable here.
 * `response` is { card } or { cards: [...] }. Returns a card or null.
 * Answered cards come first (oldest seq first); queued cards follow
 * in seq order.
 */
function chooseNextCard(response) {
  const cards = Array.isArray(response.cards)
    ? response.cards
    : response.card
      ? [response.card]
      : [];
  if (cards.length === 0) return null;
  const answered = cards.filter((c) => c.status === 'answered');
  const queued = cards.filter((c) => c.status !== 'answered');
  const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0);
  answered.sort(bySeq);
  queued.sort(bySeq);
  return answered[0] || queued[0] || null;
}

/** After a send/generic failure: retry the card, or fail it. */
function decideAfterSendFailure(attempt, maxAttempts) {
  return attempt >= maxAttempts
    ? { action: 'fail', note: 'max attempts reached' }
    : { action: 'retry' };
}

/** Stop the whole worker after this many consecutive generic failures. */
function shouldStopAfterGenericFailures(consecutiveCount) {
  return consecutiveCount >= MAX_GENERIC_FAILURES_BEFORE_STOP;
}

/** Validate a supervisor verdict payload; returns null when usable. */
function verdictProblem(verdict) {
  if (!verdict || typeof verdict !== 'object') return 'missing verdict';
  if (!['accept', 'continue', 'retry', 'escalate', 'fail', 'ask'].includes(verdict.action)) {
    return `unknown verdict action: ${String(verdict.action)}`;
  }
  if (!Array.isArray(verdict.message_indexes)) return 'verdict has no message_indexes';
  return null;
}

/**
 * Fresh persisted worker state (what survives a new-chat navigation).
 * `pending` is the in-flight card, saved before every navigation:
 * { card, plan, attempt, continues, thinking, model, linksInlined }
 * where `attempt` is the number of attempts already consumed, so a
 * resume re-runs the next attempt number, never the same one twice.
 */
function createWorkerState() {
  return {
    running: false,
    dryRun: false,
    pending: null,
    sentToday: 0,
    sentDate: '',
    consecutiveGenericFailures: 0,
    stoppedReason: '',
    quotaPct: null,
    blockedCount: 0, // cards waiting for an answer (status "blocked")
    latestQuestion: '', // text of the most recent routed question
  };
}


// ---- src/backend/client.js ----
// Backend client — all HTTP calls to the bridge backend.
// Transport is GM_xmlhttpRequest (cross-origin from a userscript).
// A custom `request` function can be injected for tests.
//
// Every call: 3 tries with backoff on network errors and 5xx.
// A 401 means the bridge key is invalid: stop and show "key invalid".
// A 409 on claim means the message was already sent: do not send it.
//
// NOTE: this file must never use blocking browser dialogs — the
// build fails if those calls appear. Owner notification goes through
// the backend alert action via notifyOwner().


class BridgeKeyInvalidError extends Error {
  constructor() {
    super('bridge key invalid (401)');
    this.name = 'BridgeKeyInvalidError';
  }
}

class BridgeDuplicateError extends Error {
  constructor() {
    super('duplicate claim (409): message already sent');
    this.name = 'BridgeDuplicateError';
  }
}

class BridgeHttpError extends Error {
  constructor(status, body) {
    super(`backend HTTP ${status}: ${String(body || '').slice(0, 200)}`);
    this.name = 'BridgeHttpError';
    this.status = status;
  }
}

const MAX_TRIES = 3;

/** Default transport: GM_xmlhttpRequest wrapped in a Promise. */
function gmRequest({ url, method, headers, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest !== 'function') {
      reject(new Error('GM_xmlhttpRequest is not available'));
      return;
    }
    GM_xmlhttpRequest({
      method,
      url,
      headers,
      data: body,
      timeout: timeoutMs,
      onload: (res) => resolve({ status: res.status, text: res.responseText }),
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('request timed out')),
    });
  });
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class BackendClient {
  constructor({ backendUrl, bridgeKey, request = gmRequest }) {
    this.backendUrl = String(backendUrl || '').replace(/\/$/, '');
    this.bridgeKey = bridgeKey || '';
    this.request = request;
  }

  /** One backend action, with retries. Returns the parsed JSON body. */
  async call(action, payload = {}) {
    if (!this.backendUrl) throw new Error('backendUrl is not set');
    if (!this.bridgeKey) throw new Error('bridgeKey is not set');
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      try {
        const res = await this.request({
          url: this.backendUrl,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bridge-key': this.bridgeKey,
          },
          body: JSON.stringify({ action, ...payload }),
        });
        if (res.status === 401) throw new BridgeKeyInvalidError();
        if (res.status === 409) throw new BridgeDuplicateError();
        if (res.status >= 500) throw new BridgeHttpError(res.status, res.text);
        if (res.status < 200 || res.status >= 300) {
          throw new BridgeHttpError(res.status, res.text);
        }
        return JSON.parse(res.text || '{}');
      } catch (err) {
        lastError = err;
        // 401 / 409 are final answers, never retried.
        if (err instanceof BridgeKeyInvalidError || err instanceof BridgeDuplicateError) throw err;
        // 4xx other than 401/409 is a client error: do not retry.
        if (err instanceof BridgeHttpError && err.status < 500) throw err;
        if (attempt < MAX_TRIES) await sleepMs(backoffMs(attempt));
      }
    }
    throw lastError;
  }

  /** Fetch a raw URL (used for read_links, ?raw=1, max 60 KB each). */
  async fetchText(url, maxBytes = 60 * 1024) {
    const res = await this.request({ url, method: 'GET', headers: {}, body: '' });
    if (res.status < 200 || res.status >= 300) {
      throw new BridgeHttpError(res.status, res.text);
    }
    return String(res.text || '').slice(0, maxBytes);
  }

  next(worker) {
    return this.call('next', { worker });
  }

  plan(id) {
    return this.call('plan', { id });
  }

  async claim(id, sentHash) {
    try {
      await this.call('claim', { id, sent_hash: sentHash });
      return { duplicate: false };
    } catch (err) {
      if (err instanceof BridgeDuplicateError) return { duplicate: true };
      throw err;
    }
  }

  setStatus(id, fields) {
    return this.call('status', { id, ...fields });
  }

  supervise(id, messages) {
    return this.call('supervise', { id, messages });
  }

  submit(id, content, extra = {}) {
    return this.call('submit', { id, content, ...extra });
  }

  /**
   * Route a model's question to the agent that created the card.
   * The card becomes status "blocked" server-side; the script does
   * nothing else here and never waits for the answer.
   */
  ask(id, question, chatUrl) {
    return this.call('ask', { id, question, chat_url: chatUrl });
  }

  /** Owner notification — only called when the script fully stops. */
  notifyOwner(kind, message) {
    return this.call('alert', { kind, message });
  }
}


// ---- src/adapters/gemini.js ----
// Gemini adapter — EVERYTHING that touches the Gemini page lives here.
// Core never touches the DOM; a future AI Studio or ChatGPT adapter
// only has to implement this same interface, core stays untouched.
//
// Interface (all methods async unless noted):
//   healthCheck()        -> { ok, problem? } (login, editor, captcha...)
//   selfTest()           -> { ok, missing: [selectorKey...] }
//   newChat()            -> navigates to a fresh chat (page reloads)
//   setModel(name)       -> pick "Neon 4" / "Hydrogen" from the picker
//   setThinking(level)   -> pick low/medium/high by index in the submenu
//   readSettings()       -> { model, thinking } as read back from the UI
//   insertText(text)     -> put text in the editor, verified afterwards
//   send()               -> click send
//   waitForUserQuery(text, timeoutMs) -> true when our prompt appears
//   waitForCompletion(opts) -> { done, timedOut, frozen }
//   readMessages(limit)  -> last N { role, text } turns, thinking removed
//   readQuotaFromUsagePage(doc?) -> number|null (best effort)
//   pageErrorText()      -> raw error/toast text or ''
//
// Selectors come from selectors.js only. UI text is never matched
// except English model names ("Neon 4", "Hydrogen", "Carbon") and the
// send/stop labels listed in TEXT_MATCH.


const GEMINI_APP_URL = 'https://gemini.google.com/app';
const GEMINI_USAGE_URL = 'https://gemini.google.com/usage';

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function firstMatch(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function allMatches(selectors) {
  const out = [];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el) => out.push(el));
  }
  return out;
}

function visible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
}

/** Wait until fn() returns a truthy value, or the timeout hits. */
async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = fn();
    if (last) return last;
    await waitMs(intervalMs);
  }
  return last;
}

/** Clone an answer node with thinking sections removed, then read text. */
function answerTextWithoutThinking(node) {
  const clone = node.cloneNode(true);
  for (const sel of SELECTORS.modelThoughts) {
    clone.querySelectorAll(sel).forEach((el) => el.remove());
  }
  // Any collapsible "thinking" section: remove by attribute hint only,
  // never by matching UI text.
  clone
    .querySelectorAll('[data-thinking], [aria-label*="hinking" i]')
    .forEach((el) => el.remove());
  return clone.innerText || clone.textContent || '';
}

/** The page's own text that indicates a blocking problem, if any. */
function pageErrorText() {
  const bodyText = document.body ? document.body.innerText || '' : '';
  const toast = firstMatch(SELECTORS.errorToast);
  const toastText = toast ? toast.innerText || '' : '';
  return `${toastText}\n${bodyText}`.trim();
}

class GeminiAdapter {
  constructor({ log = () => {} } = {}) {
    this.log = log;
  }

  /** Startup self-test: editor, send and model picker must be found. */
  selfTest() {
    const missing = [];
    if (!firstMatch(SELECTORS.editor)) missing.push('editor');
    if (!firstMatch(SELECTORS.send) && !firstMatch(SELECTORS.inputArea)) missing.push('send');
    if (!firstMatch(SELECTORS.modelPickerButton)) missing.push('modelPickerButton');
    return { ok: missing.length === 0, missing };
  }

  /** Logged in, editor present, no captcha / sign-in / unusual traffic. */
  healthCheck() {
    const text = pageErrorText();
    const found = classifyError(text);
    if (found.kind === 'signed_out') return { ok: false, problem: 'signed out', kind: 'signed_out' };
    if (found.kind === 'captcha') return { ok: false, problem: 'captcha', kind: 'captcha' };
    if (found.kind === 'unusual_traffic') {
      return { ok: false, problem: 'unusual traffic', kind: 'unusual_traffic' };
    }
    if (!firstMatch(SELECTORS.editor)) {
      return { ok: false, problem: 'editor not found', kind: 'selector_missing' };
    }
    return { ok: true };
  }

  /**
   * New chat: navigate to /app. The caller persists state first —
   * this reloads the page. Already on /app? A reload still opens a
   * fresh chat, and an assignment to the same URL may not reload.
   */
  newChat() {
    if (window.location.href.startsWith(GEMINI_APP_URL)) window.location.reload();
    else window.location.href = GEMINI_APP_URL;
  }

  editor() {
    return firstMatch(SELECTORS.editor);
  }

  /** Put text in the editor and verify it landed there. */
  async insertText(text) {
    const editor = this.editor();
    if (!editor) return false;
    editor.focus();
    document.execCommand('insertText', false, text);
    await waitMs(200);
    const current = editor.innerText || editor.textContent || '';
    return current.includes(text.slice(0, 80));
  }

  /** Click send: aria-label "Send", then fallbacks, then the last
   *  enabled button inside the input area. */
  send() {
    for (const sel of SELECTORS.send) {
      const btn = document.querySelector(sel);
      if (btn && visible(btn) && !btn.disabled) {
        btn.click();
        return true;
      }
    }
    const area = firstMatch(SELECTORS.inputArea);
    if (area) {
      const buttons = [...area.querySelectorAll('button')].filter(
        (b) => !b.disabled && visible(b),
      );
      const last = buttons[buttons.length - 1];
      if (last) {
        last.click();
        return true;
      }
    }
    return false;
  }

  /** True when a new user-query containing our text appeared. */
  async waitForUserQuery(text, timeoutMs = 10000) {
    const needle = text.slice(0, 120);
    return Boolean(
      await waitFor(() => {
        const turns = allMatches(SELECTORS.userQuery);
        return turns.some((t) => (t.innerText || '').includes(needle));
      }, timeoutMs),
    );
  }

  /** True when the editor still holds our text (the known bounce-back). */
  editorHoldsText(text) {
    const editor = this.editor();
    if (!editor) return false;
    const current = editor.innerText || editor.textContent || '';
    return current.includes(text.slice(0, 80));
  }

  stopButtonPresent() {
    return allMatches(SELECTORS.stopButton).some((b) => visible(b) && !b.disabled);
  }

  /**
   * Wait for generation to finish: the stop button is gone AND the
   * answer text has been unchanged for 8 s. Hard timeout 10 min.
   * Returns { done, timedOut, frozen } — frozen means the DOM did not
   * change at all for 10 min while waiting.
   */
  async waitForCompletion({ timeoutMs = 10 * 60 * 1000, stableMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastText = '';
    let stableSince = Date.now();
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      const answers = allMatches(SELECTORS.modelResponse);
      const text = answers.map((a) => a.innerText || '').join('\n');
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
        stableSince = Date.now();
      }
      if (Date.now() - lastChange > 10 * 60 * 1000) {
        return { done: false, timedOut: false, frozen: true };
      }
      const generating = this.stopButtonPresent();
      if (!generating && text.trim() !== '' && Date.now() - stableSince >= stableMs) {
        return { done: true, timedOut: false, frozen: false };
      }
      await waitMs(1000);
    }
    return { done: false, timedOut: true, frozen: false };
  }

  /**
   * Up to the last `limit` turns (user + model), thinking removed.
   * Model turns carry their code in `pre code`; the raw text is kept
   * too so the extractor can fall back to fenced ``` parsing.
   */
  readMessages(limit = 5) {
    const turns = [];
    const users = allMatches(SELECTORS.userQuery);
    const models = allMatches(SELECTORS.modelResponse);
    // Turns are interleaved on the page; order by document position.
    const all = [...users, ...models]
      .map((el) => ({ el, isUser: users.includes(el) }))
      .sort((a, b) => {
        const pos = a.el.compareDocumentPosition(b.el);
        // eslint-disable-next-line no-bitwise
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    for (const { el, isUser } of all) {
      if (isUser) {
        const text = (el.innerText || '').trim();
        if (text) turns.push({ role: 'user', text });
      } else {
        const content = firstMatch(SELECTORS.messageContent)
          ? el.querySelector(SELECTORS.messageContent[0]) || el
          : el;
        const text = answerTextWithoutThinking(content).trim();
        if (text) turns.push({ role: 'model', text });
      }
    }
    return turns.slice(-limit);
  }

  /** The model picker button in the input bar. */
  modelPickerButton() {
    // Prefer a button whose visible text names a known model.
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const named = buttons.find((b) =>
      Object.values(TEXT_MATCH.modelNames).some((name) =>
        (b.innerText || '').includes(name),
      ),
    );
    if (named) return named;
    return firstMatch(SELECTORS.modelPickerButton);
  }

  async openModelMenu() {
    const btn = this.modelPickerButton();
    if (!btn) return false;
    btn.click();
    await waitMs(600);
    return firstMatch(SELECTORS.modelMenu) != null;
  }

  /** Pick a model by its English name ("Neon 4", "Hydrogen"). */
  async setModel(modelKey) {
    const want = TEXT_MATCH.modelNames[modelKey];
    if (!want) return false;
    if (!(await this.openModelMenu())) return false;
    const items = allMatches(SELECTORS.modelMenuItem);
    const item = items.find((el) => (el.innerText || '').includes(want));
    if (!item) return false;
    // "Carbon" is locked: never pick it, and never click a locked row.
    if (item.getAttribute('aria-disabled') === 'true' || item.classList.contains('disabled')) {
      return false;
    }
    item.click();
    await waitMs(600);
    return true;
  }

  /**
   * Pick a thinking level by index in the submenu the last menu row
   * opens: 0 = low, 1 = medium, 2 = high. Verifies the checkmark
   * (aria-checked / aria-selected / a check icon) afterwards.
   */
  async setThinking(level) {
    const index = ['low', 'medium', 'high'].indexOf(level);
    if (index < 0) return false;
    if (!(await this.openModelMenu())) return false;
    const menu = firstMatch(SELECTORS.modelMenu);
    if (!menu) return false;
    const rows = [...menu.querySelectorAll(SELECTORS.modelMenuItem.join(','))];
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return false;
    lastRow.click(); // opens the thinking submenu
    await waitMs(600);
    const options = allMatches(SELECTORS.thinkingOption).filter(visible);
    const option = options[index];
    if (!option) return false;
    option.click();
    await waitMs(600);
    return this.thinkingIsChecked(level);
  }

  thinkingIsChecked(level) {
    const index = ['low', 'medium', 'high'].indexOf(level);
    const options = allMatches(SELECTORS.thinkingOption).filter(visible);
    const option = options[index];
    if (!option) return false;
    if (option.getAttribute('aria-checked') === 'true') return true;
    if (option.getAttribute('aria-selected') === 'true') return true;
    return Boolean(option.querySelector('svg, [class*="check" i], [data-icon*="check" i]'));
  }

  /** Read back the current model + thinking from the UI. */
  readSettings() {
    const btn = this.modelPickerButton();
    const label = btn ? btn.innerText || btn.getAttribute('aria-label') || '' : '';
    let model = null;
    for (const [key, name] of Object.entries(TEXT_MATCH.modelNames)) {
      if (label.includes(name)) model = key;
    }
    // Thinking level has no reliable always-visible label; report what
    // the submenu shows when it can be read, otherwise null.
    let thinking = null;
    const options = allMatches(SELECTORS.thinkingOption);
    const checked = options.findIndex(
      (o) => o.getAttribute('aria-checked') === 'true' || o.getAttribute('aria-selected') === 'true',
    );
    if (checked >= 0) thinking = ['low', 'medium', 'high'][checked];
    return { model, thinking };
  }

  /**
   * Best-effort quota read from the usage page (/usage). Call it only
   * when already on that page; returns a percentage (0-100) or null
   * when parsing fails. A null never blocks the loop.
   */
  readQuotaFromUsagePage(doc = document) {
    try {
      const text = doc.body ? doc.body.innerText || '' : '';
      const m = text.match(/(\d{1,3})\s*%/);
      if (!m) return null;
      const pct = Number(m[1]);
      return pct >= 0 && pct <= 100 ? pct : null;
    } catch {
      return null;
    }
  }
}


// ---- src/ui/panel.js ----
// Floating control panel — the only UI the script adds to the page.
// Prefixed with nb2- everywhere so it never collides with the v1
// "Trafactor Bridge - Gemini" panel. Top-right, collapsible.
// Never uses alert / confirm / prompt (a past bug): everything the
// user needs to see or change lives in this panel.

const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: '',
  bridgeKey: '',
  workerId: '',
  quietHours: { start: '02:00', end: '08:00' },
  paceMinSec: 60,
  paceMaxSec: 180,
  maxAttemptsPerCard: 4,
  dailySoftCap: 50,
  alertOnStop: true,
  dryRun: false,
});

const CSS = `
.nb2-panel{position:fixed;top:12px;right:12px;z-index:2147483647;width:320px;
  font:13px/1.5 system-ui,sans-serif;color:#111;background:#fff;
  border:1px solid #ccc;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.25);
  overflow:hidden}
.nb2-panel.nb2-collapsed .nb2-body{display:none}
.nb2-head{display:flex;align-items:center;gap:8px;padding:8px 10px;
  background:#0b1220;color:#fff;cursor:pointer;user-select:none}
.nb2-head b{flex:1}
.nb2-body{padding:10px;display:flex;flex-direction:column;gap:8px}
.nb2-row{display:flex;gap:6px;align-items:center}
.nb2-state{font-weight:600}
.nb2-log{height:160px;overflow:auto;background:#111;color:#d6ffd6;
  font:11px/1.4 ui-monospace,monospace;padding:6px;border-radius:6px;
  white-space:pre-wrap;word-break:break-word}
.nb2-panel input,.nb2-panel select{width:100%;padding:4px 6px;
  border:1px solid #bbb;border-radius:6px;font:inherit}
.nb2-panel label{display:block;font-size:12px;color:#444}
.nb2-panel button{padding:5px 10px;border:1px solid #888;border-radius:6px;
  background:#f2f2f2;cursor:pointer;font:inherit}
.nb2-panel button.nb2-primary{background:#0b1220;color:#fff;border-color:#0b1220}
.nb2-small{font-size:12px;color:#555}
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Build the panel. `deps`:
 *  store: { get(key, fallback), set(key, value) } (GM storage)
 *  settings: current settings object (mutated in place on save)
 *  onStart / onPause / onSelfTest: callbacks wired by main.js
 * Returns { setState, setCard, setQuota, log, setRunning }.
 */
function createPanel({ store, settings, onStart, onPause, onSelfTest }) {
  const style = el('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = el('div', 'nb2-panel');
  panel.id = 'nb2-panel';

  const head = el('div', 'nb2-head');
  head.id = 'nb2-panel-head';
  head.appendChild(el('b', '', 'Neon Bridge v2'));
  const collapseBtn = el('button', '', '–');
  collapseBtn.id = 'nb2-collapse';
  collapseBtn.type = 'button';
  head.appendChild(collapseBtn);
  panel.appendChild(head);

  const body = el('div', 'nb2-body');
  body.id = 'nb2-panel-body';

  const stateLine = el('div', 'nb2-state', 'Idle');
  stateLine.id = 'nb2-state';
  body.appendChild(stateLine);

  const cardLine = el('div', 'nb2-small', 'No card');
  cardLine.id = 'nb2-card';
  body.appendChild(cardLine);

  const quotaLine = el('div', 'nb2-small', 'Quota: unknown');
  quotaLine.id = 'nb2-quota';
  body.appendChild(quotaLine);

  const blockedLine = el('div', 'nb2-small', 'Blocked (waiting for answer): 0');
  blockedLine.id = 'nb2-blocked';
  body.appendChild(blockedLine);

  const questionLine = el('div', 'nb2-small', '');
  questionLine.id = 'nb2-question';
  body.appendChild(questionLine);

  const btnRow = el('div', 'nb2-row');
  const startBtn = el('button', 'nb2-primary', 'Start');
  startBtn.id = 'nb2-start';
  startBtn.type = 'button';
  const pauseBtn = el('button', '', 'Pause');
  pauseBtn.id = 'nb2-pause';
  pauseBtn.type = 'button';
  const testBtn = el('button', '', 'Self-test');
  testBtn.id = 'nb2-selftest';
  testBtn.type = 'button';
  btnRow.append(startBtn, pauseBtn, testBtn);
  body.appendChild(btnRow);

  const logBox = el('div', 'nb2-log', '');
  logBox.id = 'nb2-log';
  body.appendChild(logBox);

  // Settings form (saved to GM storage on change).
  const form = el('div');
  form.id = 'nb2-settings';
  const fields = [
    ['backendUrl', 'Backend URL', 'text'],
    ['bridgeKey', 'Bridge key', 'password'],
    ['workerId', 'Worker ID', 'text'],
    ['paceMinSec', 'Pace min (sec)', 'number'],
    ['paceMaxSec', 'Pace max (sec)', 'number'],
    ['maxAttemptsPerCard', 'Max attempts / card', 'number'],
    ['dailySoftCap', 'Daily soft cap', 'number'],
  ];
  const inputs = {};
  for (const [key, label, type] of fields) {
    const wrap = el('label', '', label);
    const input = el('input');
    input.id = `nb2-set-${key}`;
    input.type = type;
    input.value = String(settings[key] ?? '');
    input.addEventListener('change', () => {
      const value = type === 'number' ? Number(input.value) : input.value;
      settings[key] = value;
      store.set(`nb2-${key}`, value);
    });
    inputs[key] = input;
    wrap.appendChild(input);
    form.appendChild(wrap);
  }
  const quietLabel = el('label', '', 'Quiet hours (local)');
  const quietRow = el('div', 'nb2-row');
  const quietStart = el('input');
  quietStart.id = 'nb2-set-quietStart';
  quietStart.type = 'time';
  quietStart.value = settings.quietHours.start;
  const quietEnd = el('input');
  quietEnd.id = 'nb2-set-quietEnd';
  quietEnd.type = 'time';
  quietEnd.value = settings.quietHours.end;
  const saveQuiet = () => {
    settings.quietHours = { start: quietStart.value || '02:00', end: quietEnd.value || '08:00' };
    store.set('nb2-quietHours', settings.quietHours);
  };
  quietStart.addEventListener('change', saveQuiet);
  quietEnd.addEventListener('change', saveQuiet);
  quietRow.append(quietStart, el('span', '', '–'), quietEnd);
  quietLabel.appendChild(quietRow);
  form.appendChild(quietLabel);

  const dryLabel = el('label', '', 'Dry run (no send, no submit)');
  const dryCheck = el('input');
  dryCheck.id = 'nb2-set-dryRun';
  dryCheck.type = 'checkbox';
  dryCheck.checked = Boolean(settings.dryRun);
  dryCheck.addEventListener('change', () => {
    settings.dryRun = dryCheck.checked;
    store.set('nb2-dryRun', dryCheck.checked);
  });
  dryLabel.prepend(dryCheck);
  form.appendChild(dryLabel);

  const alertLabel = el('label', '', 'Notify owner on full stop');
  const alertCheck = el('input');
  alertCheck.id = 'nb2-set-alertOnStop';
  alertCheck.type = 'checkbox';
  alertCheck.checked = settings.alertOnStop !== false;
  alertCheck.addEventListener('change', () => {
    settings.alertOnStop = alertCheck.checked;
    store.set('nb2-alertOnStop', alertCheck.checked);
  });
  alertLabel.prepend(alertCheck);
  form.appendChild(alertLabel);

  body.appendChild(form);
  panel.appendChild(body);
  document.body.appendChild(panel);

  const lines = [];
  function log(message) {
    const stamp = new Date().toLocaleTimeString();
    lines.push(`[${stamp}] ${message}`);
    while (lines.length > 50) lines.shift();
    logBox.textContent = lines.join('\n');
    logBox.scrollTop = logBox.scrollHeight;
  }

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('nb2-collapsed');
    collapseBtn.textContent = panel.classList.contains('nb2-collapsed') ? '+' : '–';
  });
  head.addEventListener('click', () => {
    panel.classList.toggle('nb2-collapsed');
    collapseBtn.textContent = panel.classList.contains('nb2-collapsed') ? '+' : '–';
  });
  startBtn.addEventListener('click', () => onStart && onStart());
  pauseBtn.addEventListener('click', () => onPause && onPause());
  testBtn.addEventListener('click', () => onSelfTest && onSelfTest());

  return {
    log,
    setState(text) {
      stateLine.textContent = text;
    },
    setCard(text) {
      cardLine.textContent = text;
    },
    setQuota(pct) {
      quotaLine.textContent = pct == null ? 'Quota: unknown' : `Quota remaining: ${pct}%`;
    },
    setBlocked(count, latestQuestion) {
      blockedLine.textContent = `Blocked (waiting for answer): ${count}`;
      questionLine.textContent = latestQuestion ? `Latest question: ${latestQuestion}` : '';
    },
    setRunning(running) {
      startBtn.disabled = running;
      pauseBtn.disabled = !running;
    },
  };
}


// ---- src/main.js ----
// Main — wires core + adapter + backend + panel into the queue loop.
// This is the only file that knows the per-card flow end to end.
// It never touches the DOM directly (the adapter and panel do) and
// never talks to GitHub (the backend does).
//
// Persistence: a new chat reloads the page, so before every navigation
// the in-flight card is saved to GM storage as state.pending, and on
// load the loop resumes that card instead of fetching a new one.
// pending.attempt counts attempts already consumed, so a resume never
// re-runs (or re-claims) the same attempt twice.


const STORE_PREFIX = 'nb2-';
const LOCK_KEY = 'nb2-lock';
const LOCK_TTL_MS = 30000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Never resolves. Used after a navigation is triggered: the current
 * page keeps running until the unload commits, so returning to the
 * loop would clear the persisted resume state before the reload.
 * Hanging here lets the reload take over instead.
 */
function hangForever() {
  return new Promise(() => {});
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** GM storage behind a tiny interface, with a memory fallback. */
function createStore() {
  const memory = new Map();
  return {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(STORE_PREFIX + key, undefined);
          return v === undefined ? fallback : v;
        }
      } catch {
        // fall through to memory
      }
      return memory.has(STORE_PREFIX + key) ? memory.get(STORE_PREFIX + key) : fallback;
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(STORE_PREFIX + key, value);
          return;
        }
      } catch {
        // fall through to memory
      }
      memory.set(STORE_PREFIX + key, value);
    },
  };
}

function loadSettings(store) {
  const settings = { ...DEFAULT_SETTINGS, quietHours: { ...DEFAULT_SETTINGS.quietHours } };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const saved = store.get(key, undefined);
    if (saved !== undefined) settings[key] = saved;
  }
  return settings;
}

/**
 * Single-tab lock: one worker per browser. A second tab sees a fresh
 * heartbeat and stays idle. Returns { held, tabId, release }.
 */
function acquireLock(workerId) {
  const tabId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  let held = false;
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const existing = raw ? JSON.parse(raw) : null;
    if (!existing || Date.now() - existing.heartbeat > LOCK_TTL_MS) {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ workerId, tabId, heartbeat: Date.now() }));
      held = true;
    }
  } catch {
    held = true; // no storage: assume this is the only tab
  }
  const beat = setInterval(() => {
    if (!held) return;
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ workerId, tabId, heartbeat: Date.now() }));
    } catch {
      // ignore
    }
  }, 10000);
  return {
    held,
    tabId,
    release() {
      clearInterval(beat);
      try {
        const raw = localStorage.getItem(LOCK_KEY);
        if (raw && JSON.parse(raw).tabId === tabId) localStorage.removeItem(LOCK_KEY);
      } catch {
        // ignore
      }
    },
  };
}

function persistState(store, state) {
  store.set('state', state);
}

function restoreState(store) {
  const saved = store.get('state', null);
  if (saved && typeof saved === 'object') return { ...createWorkerState(), ...saved };
  return createWorkerState();
}

/** Fetch linked files inline (max 60 KB each) for the links-not-read retry. */
async function fetchLinkedTexts(client, urls, log) {
  const out = [];
  for (const url of urls.slice(0, 5)) {
    try {
      const text = await client.fetchText(`${url}?raw=1`);
      out.push({ url, text });
    } catch (err) {
      log(`linked file fetch failed (${url}): ${err.message}`);
    }
  }
  return out;
}

function start() {
  const store = createStore();
  const settings = loadSettings(store);
  const state = restoreState(store);
  const client = new BackendClient({
    backendUrl: settings.backendUrl,
    bridgeKey: settings.bridgeKey,
  });
  const adapter = new GeminiAdapter({ log: (m) => panel.log(m) });
  const lock = acquireLock(settings.workerId || 'default');

  let panel;

  const log = (message) => {
    if (panel) panel.log(message);
  };

  /** Full stop: persist, notify the owner once, show it in the panel. */
  async function fullStop(kind, message) {
    state.running = false;
    state.stoppedReason = message;
    persistState(store, state);
    if (panel) {
      panel.setState(`Stopped: ${message}`);
      panel.setRunning(false);
    }
    log(`STOP (${kind}): ${message}`);
    if (settings.alertOnStop) {
      try {
        await client.notifyOwner(kind, message);
      } catch (err) {
        log(`owner notification failed: ${err.message}`);
      }
    }
  }

  /** Set model + thinking, read both back, retry once on mismatch. */
  async function applySettings(plan) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await adapter.setModel(plan.model);
      await adapter.setThinking(plan.thinking);
      const readBack = adapter.readSettings();
      const modelOk = !readBack.model || readBack.model === plan.model;
      const thinkingOk = !readBack.thinking || readBack.thinking === plan.thinking;
      if (modelOk && thinkingOk) return { ok: true, readBack };
      log(`settings mismatch (try ${attempt + 1}): wanted ${plan.model}/${plan.thinking}`);
      await sleep(1000);
    }
    return { ok: false };
  }

  /** Send the message, handling the bounce-back symptom once. */
  async function sendWithBounceRetry(message) {
    if (!adapter.send()) return { sent: false, reason: 'send button not found' };
    const appeared = await adapter.waitForUserQuery(message, 10000);
    if (appeared) return { sent: true };
    if (adapter.editorHoldsText(message)) {
      log('message bounced back into the editor; pressing send once more');
      if (!adapter.send()) return { sent: false, reason: 'send button not found on retry' };
      const appearedAgain = await adapter.waitForUserQuery(message, 10000);
      if (appearedAgain) return { sent: true };
    }
    return { sent: false, reason: 'message did not appear as a user turn' };
  }

  async function failCard(card, model, lastError) {
    await client.setStatus(card.id, { status: 'failed', last_error: lastError, model_used: model });
    state.pending = null;
    persistState(store, state);
    return 'failed';
  }

  async function submitCard(card, model, messages, verdict) {
    const content = extractFinalFile(messages, verdict.message_indexes, card.id);
    if (!content) return failCard(card, model, 'no code extracted');
    const submitted = await client.submit(card.id, content, {
      model_used: model, account_used: settings.workerId,
    });
    log(`submitted card #${card.seq}: ${submitted.pr_url || submitted.commit || 'ok'}`);
    if (panel) panel.setCard(`#${card.seq} done — ${submitted.pr_url || ''}`);
    state.consecutiveGenericFailures = 0;
    state.pending = null;
    persistState(store, state);
    return 'done';
  }

  /**
   * One card, start to finish. `resume` is a persisted pending entry
   * (after a navigation reload): same card, attempts already consumed,
   * and the fresh chat is already open, so no second navigation.
   * Returns 'done' | 'failed' | 'skipped'.
   */
  async function runCard(card, resume = null) {
    const maxAttempts = settings.maxAttemptsPerCard;
    const planRes = resume ? { settings: resume.plan } : await client.plan(card.id);
    const plan = resolvePlan(card, planRes.settings || {});
    const model = plan.model;
    let thinking = plan.thinking;
    let attempt = resume ? resume.attempt : card.attempts || 0;
    let continues = resume ? resume.continues : 0;
    let linksInlined = resume ? resume.linksInlined : false;
    // Ask/answer bookkeeping (persisted in pending across navigations).
    const isAnswered = card.status === 'answered';
    let questions = resume ? (resume.questions ?? 0) : (card.questions_asked ?? 0);
    let answeredStage = resume ? (resume.answeredStage || null) : null;
    let promptResent = resume ? Boolean(resume.promptResent) : false;
    let answerSent = resume ? Boolean(resume.answerSent) : false;
    let answerContext = resume ? (resume.answerContext || '') : '';
    const lastQuestion = resume ? (resume.lastQuestion || '') : '';

    log(`card #${card.seq} ${card.file_path} -> ${model}/${thinking} (${plan.reason || 'plan'})`);

    // Quota guard: below 20% only hydrogen/low may run.
    const quota = quotaDecision(state.quotaPct, plan);
    if (!quota.allowed) {
      log(`quota guard: ${quota.reason}; skipping card #${card.seq}`);
      await client.setStatus(card.id, { status: 'skipped', last_error: quota.reason, model_used: model });
      state.pending = null;
      persistState(store, state);
      return 'skipped';
    }

    // Answered card: open its saved chat if it still loads, otherwise
    // fall back to a new chat that re-sends the original prompt.
    // Each navigation reloads the page; the stage is persisted and
    // the resume on load continues from it.
    if (isAnswered) {
      // The card is no longer blocked — count it once, on first entry.
      if (!resume) {
        state.blockedCount = Math.max(0, (state.blockedCount || 0) - 1);
        if (panel) panel.setBlocked(state.blockedCount, state.latestQuestion);
      }
      if (!answeredStage) {
        const base = {
          card, plan, attempt, continues, thinking, model, linksInlined,
          questions, promptResent, answerSent, answerContext, lastQuestion,
        };
        if (card.chat_url) {
          state.pending = { ...base, answeredStage: 'open-chat' };
          persistState(store, state);
          log(`opening saved chat for answered card #${card.seq}`);
          window.location.href = card.chat_url;
          await hangForever(); // the reload resumes the card
          return 'blocked';
        }
        state.pending = { ...base, answeredStage: 'fallback-ready' };
        persistState(store, state);
        adapter.newChat();
        await hangForever(); // the reload resumes the card
        return 'blocked';
      }
      if (answeredStage === 'open-chat') {
        // We just loaded the saved chat. Did it actually load?
        const health = adapter.healthCheck();
        const sameChat = window.location.href === card.chat_url ||
          window.location.href.startsWith(card.chat_url);
        if (health.ok && sameChat) {
          answeredStage = 'ready';
          log(`saved chat loaded for card #${card.seq}; continuing there`);
        } else {
          log('saved chat did not load; falling back to a new chat with the original prompt');
          state.pending = {
            card, plan, attempt, continues, thinking, model, linksInlined,
            questions, promptResent, answerSent, answerContext, lastQuestion,
            answeredStage: 'fallback-ready',
          };
          persistState(store, state);
          adapter.newChat();
          await hangForever(); // the reload resumes the card
          return 'blocked';
        }
      }
    }

    // A resume is already in a fresh chat; an answered card whose saved
    // chat loaded must also stay where it is — never navigate away.
    let skipNavigation = Boolean(resume) || (isAnswered && answeredStage === 'ready');

    while (attempt < maxAttempts) {
      attempt += 1;
      const pending = {
        card, plan, attempt: attempt - 1, continues, thinking, model, linksInlined,
        questions, answeredStage, promptResent, answerSent, answerContext, lastQuestion,
      };
      if (panel) {
        panel.setCard(`#${card.seq} ${card.file_path} · ${model}/${thinking} · attempt ${attempt}/${maxAttempts}`);
      }

      // Always a NEW chat per card (long chats burn quota and repeat).
      // Navigation reloads the page: persist first, resume on load.
      if (!settings.dryRun && !skipNavigation) {
        state.pending = pending;
        persistState(store, state);
        adapter.newChat();
        await hangForever(); // the reload resumes the card
        return 'failed';
      }
      skipNavigation = false;
      state.pending = { ...pending, attempt };
      persistState(store, state);

      const health = adapter.healthCheck();
      if (!health.ok) {
        const kind = health.kind || 'unknown';
        if (isStopKind(kind)) {
          await fullStop(kind === 'weekly_cap' ? 'stopped' : 'account', `health check failed: ${health.problem}`);
          return 'failed';
        }
        return failCard(card, model, health.problem);
      }

      const applied = await applySettings({ model, thinking });
      if (!applied.ok) return failCard(card, model, 'settings mismatch');

      // Re-check right before every send (model/thinking can drift).
      const beforeSend = adapter.readSettings();
      if ((beforeSend.model && beforeSend.model !== model) ||
          (beforeSend.thinking && beforeSend.thinking !== thinking)) {
        log('model/thinking drifted before send; re-applying');
        const reapplied = await applySettings({ model, thinking });
        if (!reapplied.ok) return failCard(card, model, 'settings mismatch');
      }

      // Answered card, first attempt: send the answers to the model's
      // questions. In the fallback case the saved chat is gone, so the
      // original prompt goes first to re-establish context.
      if (isAnswered && answeredStage === 'fallback-ready' && !promptResent) {
        const promptTurn = buildMessage(card);
        const ok = await adapter.insertText(promptTurn) &&
          (await sendWithBounceRetry(promptTurn)).sent;
        if (!ok) return failCard(card, model, 'could not re-send original prompt');
        const done = await adapter.waitForCompletion();
        if (done.frozen) return failCard(card, model, 'page frozen while re-sending prompt');
        promptResent = true;
        state.pending = { ...pending, attempt, promptResent };
        persistState(store, state);
      }
      let message;
      let sendingAnswer = false;
      if (isAnswered && !answerSent) {
        message = answerMessage(card.id, card.answer || '');
        sendingAnswer = true;
      } else if (answerContext) {
        // Later attempts keep the Q&A so the model is not asked
        // the same questions again in a fresh chat.
        message = `${buildMessage(card)}\n\n${answerContext}`;
      } else {
        message = buildMessage(card);
      }
      if (!sendingAnswer && linksInlined && card.read_links && card.read_links.length) {
        const texts = await fetchLinkedTexts(client, card.read_links, log);
        message = buildMessageWithLinks(card, texts);
      }

      if (settings.dryRun) {
        log(`[dry run] would send ${message.length} chars to ${model}/${thinking}, then supervise + submit`);
        state.pending = null;
        persistState(store, state);
        return 'done';
      }

      const hash = await sentHash(message, attempt);
      const claim = await client.claim(card.id, hash);
      if (claim.duplicate) {
        log(`claim 409: card #${card.seq} was already sent; moving on`);
        state.pending = null;
        persistState(store, state);
        return 'skipped';
      }

      const inserted = await adapter.insertText(message);
      if (!inserted) return failCard(card, model, 'could not insert prompt');
      const sent = await sendWithBounceRetry(message);
      if (!sent.sent) {
        await client.setStatus(card.id, { status: 'waiting', last_error: sent.reason, model_used: model });
        const decision = decideAfterSendFailure(attempt, maxAttempts);
        if (decision.action === 'fail') return failCard(card, model, sent.reason);
        continue; // retry in a new chat (persist + navigate at loop top)
      }
      state.sentToday += 1;
      if (sendingAnswer) {
        answerSent = true;
        answerContext = lastQuestion
          ? `Earlier questions and answers:\nQ: ${lastQuestion}\nA: ${card.answer || ''}`
          : '';
        state.pending = { ...pending, attempt, answerSent, answerContext };
      }
      persistState(store, state);

      await client.setStatus(card.id, { status: 'waiting', model_used: model });
      const completion = await adapter.waitForCompletion();
      if (completion.frozen) {
        // The old chat is lost with the reload: count this attempt as
        // consumed and resume as the next attempt in a fresh chat.
        log('page frozen for 10 min; reloading into a new chat');
        state.pending = { ...pending, attempt };
        persistState(store, state);
        adapter.newChat();
        await hangForever(); // the reload resumes as the next attempt
        return 'failed';
      }
      if (completion.timedOut) log('generation timed out after 10 min');

      // Supervise, with same-chat continues inside this attempt.
      let messages = adapter.readMessages(5);
      while (true) {
        const lastModel = [...messages].reverse().find((m) => m.role === 'model');
        if (lastModel && isCutOff(lastModel.text, card.id)) {
          log('answer looks cut off (no END marker / unclosed fence); supervisor decides');
        }
        const sup = await client.supervise(card.id, messages);
        let verdict = sup.verdict || {};
        // The model may ask a QUESTION block even when the supervisor
        // did not label it 'ask' — a detected QUESTION block wins.
        const detected = lastModel ? detectQuestion(lastModel.text, card.id) : null;
        if (verdict.action !== 'ask' && detected) {
          verdict = { action: 'ask', question: detected.question };
        }
        const problem = verdictProblem(verdict);
        if (problem) return failCard(card, model, `bad verdict: ${problem}`);
        log(`supervisor: ${verdict.action} — ${verdict.reason || ''}${verdict.stale ? ' (stale echo)' : ''}`);

        // Ask is a first-class state, not an error: route the question
        // to the backend (the card becomes "blocked" there), show it
        // in the panel, and move on to the next card. Never wait here.
        if (verdict.action === 'ask') {
          const askRec = recordAsk({ attempt, questions });
          if (askRec.action === 'fail') {
            return failCard(card, model, 'too many questions');
          }
          const question = verdict.question || detected?.question || verdict.reason || 'No question text received';
          await client.ask(card.id, question, window.location.href);
          questions = askRec.questions;
          state.blockedCount = (state.blockedCount || 0) + 1;
          state.latestQuestion = question;
          state.pending = {
            ...pending, attempt: askRec.attempt, questions, lastQuestion: question,
          };
          persistState(store, state);
          if (panel) panel.setBlocked(state.blockedCount, state.latestQuestion);
          log(`question routed (round ${questions}/${MAX_QUESTIONS}): ${question}`);
          return 'blocked';
        }

        // Links not read: one retry with the linked text pasted inline.
        if (verdict.action === 'retry' && !linksInlined &&
            classifyError(verdict.reason || '').kind === 'links_not_read' &&
            card.read_links && card.read_links.length) {
          linksInlined = true;
          log('supervisor says links were not read; retrying with linked text inline');
          break; // out of the supervise loop -> retry in a new chat
        }

        const decision = decideAfterVerdict({ verdict, attempt, maxAttempts, continues, thinking });
        if (decision.action === 'submit') return submitCard(card, model, messages, verdict);
        if (decision.action === 'fail') {
          return failCard(card, model, decision.note || verdict.reason || 'failed');
        }
        if (decision.action === 'escalate') {
          thinking = decision.thinking;
          log(`escalating thinking to ${thinking}`);
          break; // out of the supervise loop -> new chat, resend
        }
        if (decision.action === 'retry') break; // new chat, resend
        // decision.action === 'continue': same chat, one more turn.
        if (continues >= MAX_CONTINUES) return failCard(card, model, 'max continues reached');
        continues += 1;
        state.pending = { ...pending, attempt, continues, thinking, model, linksInlined };
        persistState(store, state);
        await adapter.insertText(continueMessage(card.id));
        adapter.send();
        await client.setStatus(card.id, { status: 'waiting', model_used: model });
        await adapter.waitForCompletion();
        messages = adapter.readMessages(5);
        // Loop: supervise the now-longer history.
      }
      // Retry / escalate / links-inline: next while iteration navigates
      // to a new chat (persisted at its top) and resends.
    }

    return failCard(card, model, 'max attempts reached');
  }

  /** The queue loop. */
  async function loop() {
    // Daily counter resets on a new local day.
    if (state.sentDate !== todayKey()) {
      state.sentDate = todayKey();
      state.sentToday = 0;
    }

    // Resume an in-flight card first (after a navigation reload).
    if (state.pending && state.pending.card) {
      const pending = state.pending;
      log(`resuming card #${pending.card.seq} after navigation`);
      await runCard(pending.card, pending);
    }

    while (state.running) {
      try {
        if (isQuietHours(new Date(), settings.quietHours)) {
          const mins = minutesUntilQuietEnd(new Date(), settings.quietHours);
          if (panel) panel.setState(`Quiet hours — resumes in ~${mins} min`);
          await sleep(Math.min(mins, 5) * 60 * 1000);
          continue;
        }
        if (dailyCapReached(state.sentToday, settings.dailySoftCap)) {
          if (panel) panel.setState(`Daily soft cap reached (${state.sentToday}/${settings.dailySoftCap})`);
          await sleep(5 * 60 * 1000);
          continue;
        }
        if (state.quotaPct === 0) {
          const waitMs = msUntilNextRefresh(new Date());
          if (panel) panel.setState(`Quota 0% — next refresh in ~${Math.round(waitMs / 60000)} min`);
          await sleep(Math.min(waitMs, 5 * 60 * 1000));
          continue;
        }

        const next = await client.next(settings.workerId);
        const card = chooseNextCard(next);
        if (!card) {
          if (panel) panel.setState('Queue empty — polling');
          await sleep(idlePollSec() * 1000);
          continue;
        }

        const outcome = await runCard(card);
        if (outcome === 'failed') {
          state.consecutiveGenericFailures += 1;
          if (shouldStopAfterGenericFailures(state.consecutiveGenericFailures)) {
            await fullStop('account', '3 consecutive cards failed with generic errors');
            break;
          }
        } else {
          state.consecutiveGenericFailures = 0;
        }
        state.pending = null;
        persistState(store, state);

        // Pace before the next message.
        const paceSec = settings.dryRun ? 2 : randomPaceSec(settings.paceMinSec, settings.paceMaxSec);
        if (panel) panel.setState(`Pacing ${paceSec}s before the next card…`);
        await sleep(paceSec * 1000);
      } catch (err) {
        if (err instanceof BridgeKeyInvalidError) {
          await fullStop('stopped', 'key invalid — check bridgeKey in the panel');
          break;
        }
        const found = classifyError(err.message || '');
        log(`loop error (${found.kind}): ${found.text || err.message}`);
        if (isStopKind(found.kind)) {
          await fullStop('account', found.text || err.message);
          break;
        }
        await sleep(backoffMs(1));
      }
    }
  }

  panel = createPanel({
    store,
    settings,
    onStart: async () => {
      if (!settings.backendUrl || !settings.bridgeKey || !settings.workerId) {
        log('set backendUrl, bridgeKey and workerId in the panel first');
        return;
      }
      if (!lock.held) {
        log('another tab holds this worker; this tab stays idle');
        if (panel) panel.setState('Idle — another tab is running this worker');
        return;
      }
      // Startup self-test before any work.
      const test = adapter.selfTest();
      if (!test.ok) {
        await fullStop('selectors', `self-test failed, missing: ${test.missing.join(', ')}`);
        return;
      }
      client.backendUrl = settings.backendUrl;
      client.bridgeKey = settings.bridgeKey;
      state.running = true;
      state.stoppedReason = '';
      persistState(store, state);
      panel.setRunning(true);
      panel.setState('Running');
      log('started');
      loop();
    },
    onPause: () => {
      state.running = false;
      persistState(store, state);
      if (panel) {
        panel.setRunning(false);
        panel.setState('Paused');
      }
      log('paused');
    },
    onSelfTest: () => {
      const test = adapter.selfTest();
      log(test.ok ? 'self-test OK: editor, send, model picker found' :
        `self-test FAILED, missing: ${test.missing.join(', ')}`);
      if (panel) panel.setState(test.ok ? 'Self-test OK' : `Self-test failed: ${test.missing.join(', ')}`);
    },
  });
  panel.setRunning(state.running);
  panel.setQuota(state.quotaPct);
  panel.setBlocked(state.blockedCount || 0, state.latestQuestion || '');
  panel.setState(
    state.stoppedReason ? `Stopped: ${state.stoppedReason}` :
    !lock.held ? 'Idle — another tab is running this worker' :
    state.running ? 'Running' : 'Idle',
  );
  if (state.pending && state.pending.card) {
    panel.setCard(`#${state.pending.card.seq} ${state.pending.card.file_path} (resumed)`);
  }
  log(lock.held ? 'Neon Bridge v2 ready' : 'Neon Bridge v2 ready (idle: another tab holds the lock)');

  // Best-effort quota read when landing on the usage page.
  if (window.location.href.startsWith(GEMINI_USAGE_URL)) {
    const pct = adapter.readQuotaFromUsagePage();
    if (pct != null) {
      state.quotaPct = pct;
      persistState(store, state);
      panel.setQuota(pct);
      log(`quota from usage page: ${pct}% remaining`);
    } else {
      log('quota read from usage page failed; continuing without it');
    }
  }

  // Resume automatically if the page reloaded mid-card while running.
  if (state.running && lock.held && state.pending && state.pending.card) {
    panel.setRunning(true);
    loop();
  }
}

// Tampermonkey entry point.
if (typeof window !== 'undefined') {
  start();
}

})();
