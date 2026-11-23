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

export const ERROR_KINDS = Object.freeze([
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
export function classifyError(rawText) {
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
export function isStopKind(kind) {
  return (
    kind === 'signed_out' ||
    kind === 'captcha' ||
    kind === 'unusual_traffic' ||
    kind === 'weekly_cap'
  );
}

/** True when the kind is worth one new-chat retry before giving up. */
export function isNewChatRetryKind(kind) {
  return kind === 'generic' || kind === 'quota' || kind === 'send_failure';
}
