// Permission-prompt classification — pure logic, no DOM.
//
// The adapter finds candidate Allow / Always allow buttons; this
// module decides whether a prompt belongs to our MCP server. The
// rule is deliberately narrow: approve ONLY when the prompt text
// names our server or one of our tool names. Anything else is
// "unknown" — never click it. This is the guard against prompt
// injection making Gemini call other tools.
//
// Button label patterns live in selectors.js (TEXT_MATCH.
// permissionButtons); they are passed in so this module stays
// testable without the DOM.

/** Prompt text sent to the owner is capped at this many characters. */
export const MAX_PROMPT_TEXT_CHARS = 300;

/**
 * Classify one button label: 'always' | 'allow' | null.
 * `patterns` is TEXT_MATCH.permissionButtons ({ always: [...], allow: [...] }).
 * Matching is exact (anchored) so "Allow all" or "Allow once" never match.
 */
export function matchPermissionButton(label, patterns) {
  const text = (label || '').trim();
  if (!text) return null;
  if (patterns.always.some((re) => re.test(text))) return 'always';
  if (patterns.allow.some((re) => re.test(text))) return 'allow';
  return null;
}

/** First of our tool names that appears in the prompt text, or null. */
export function detectToolName(text, toolNames) {
  const hay = text || '';
  for (const name of toolNames || []) {
    if (name && hay.includes(name)) return name;
  }
  return null;
}

/**
 * Decide what to do with a permission prompt.
 * Input: { text, buttons, serverName, toolNames } where `buttons` is
 * the list of classified button kinds present in the prompt
 * ('always' / 'allow').
 * Returns { decision, tool, hasServerName } where decision is:
 *  - 'approve-always' — ours, and an "Always allow" button exists
 *  - 'approve' — ours, only an "Allow" button exists
 *  - 'unknown' — the prompt does not name our server or any of our
 *    tools, or there is no approve button at all: never click.
 */
export function classifyPermissionPrompt({ text, buttons, serverName, toolNames }) {
  const hasServerName = Boolean(serverName) && (text || '').includes(serverName);
  const tool = detectToolName(text, toolNames);
  if (!hasServerName && !tool) {
    return { decision: 'unknown', tool: null, hasServerName: false };
  }
  if ((buttons || []).includes('always')) return { decision: 'approve-always', tool, hasServerName };
  if ((buttons || []).includes('allow')) return { decision: 'approve', tool, hasServerName };
  return { decision: 'unknown', tool: null, hasServerName };
}

/** Collapse whitespace and cap prompt text for the owner alert. */
export function truncatePromptText(text, max = MAX_PROMPT_TEXT_CHARS) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}
