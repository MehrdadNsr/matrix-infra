import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, isNewChatRetryKind, isStopKind } from '../src/core/errors.js';

const cases = [
  // English
  ['Something went wrong. Please try again.', 'generic'],
  ['An error occurred (1076)', 'generic'],
  ['Error 1099, please retry', 'generic'],
  ["You've reached your limit for Neon. Try again in 5 hours.", 'quota'],
  ['Quota exceeded for this model', 'quota'],
  ['Rate limit exceeded', 'quota'],
  ['Weekly limit reached for this model', 'weekly_cap'],
  ['Please sign in to continue', 'signed_out'],
  ['Verify you are human — captcha required', 'captcha'],
  ['Our systems have detected unusual traffic from your computer network', 'unusual_traffic'],
  ["Couldn't send your message", 'send_failure'],
  ['The links were not read before answering', 'links_not_read'],
  ["I don't have access to any tools", 'no_mcp_tools'],
  ["I don't have tools in this chat", 'no_mcp_tools'],
  ["I can't access the neon-mcp server", 'no_mcp_tools'],
  ['This feature is NOT SUPPORTED', 'no_mcp_tools'],
  ['The MCP tools are not available right now', 'no_mcp_tools'],
  // Wins over 'generic': "try again" alone would be generic.
  ["I don't have tools, please try again later", 'no_mcp_tools'],
  // Persian
  ['مشکلی پیش آمد، دوباره تلاش کنید', 'generic'],
  ['خطایی رخ داد', 'generic'],
  ['به حد مجاز رسیدید', 'quota'],
  ['سهمیه شما تمام شد', 'quota'],
  ['محدودیت هفتگی فعال است', 'weekly_cap'],
  ['لطفاً وارد شوید', 'signed_out'],
  ['ترافیک غیرمعمول شناسایی شد', 'unusual_traffic'],
  ['پیام ارسال نشد', 'send_failure'],
  ['لینک‌ها خوانده نشد', 'links_not_read'],
  ['به ابزار دسترسی ندارم', 'no_mcp_tools'],
  ['ابزار ندارم', 'no_mcp_tools'],
  ['ابزار در دسترس نیست', 'no_mcp_tools'],
  ['این قابلیت پشتیبانی نمی‌شود', 'no_mcp_tools'],
];

for (const [text, kind] of cases) {
  test(`classifyError: ${JSON.stringify(text)} -> ${kind}`, () => {
    assert.equal(classifyError(text).kind, kind);
  });
}

test('classifyError: unknown text is kept verbatim, kind unknown', () => {
  const weird = 'florp 12345 zzz';
  const out = classifyError(weird);
  assert.equal(out.kind, 'unknown');
  assert.equal(out.text, weird);
  assert.equal(classifyError('').kind, 'unknown');
  assert.equal(classifyError(null).kind, 'unknown');
});

test('classifyError: blocking kinds win over generic (priority order)', () => {
  assert.equal(classifyError('unusual traffic — something went wrong').kind, 'unusual_traffic');
  assert.equal(classifyError('weekly limit reached, something went wrong').kind, 'weekly_cap');
});

test('isStopKind / isNewChatRetryKind', () => {
  for (const k of ['signed_out', 'captcha', 'unusual_traffic', 'weekly_cap']) {
    assert.equal(isStopKind(k), true, k);
  }
  for (const k of ['generic', 'quota', 'unknown', 'send_failure']) {
    assert.equal(isStopKind(k), false, k);
  }
  assert.equal(isNewChatRetryKind('generic'), true);
  assert.equal(isNewChatRetryKind('quota'), true);
  assert.equal(isNewChatRetryKind('captcha'), false);
});
