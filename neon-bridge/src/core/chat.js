// Chat mode: pure logic for the group-chat relay. No DOM, no HTTP —
// unit-testable. The wiring (adapter calls, backend calls, room
// state) lives in src/modes/chat.js.
//
// Safety, in one place:
//  - allowedSenders: only transcript lines from senders in the list
//    are relayed at all (the backend also filters).
//  - Only mehrdad / oracle may authorize tool actions that write
//    (submit_file etc.). When a relayed transcript has lines from
//    anyone else, the relay message carries a guard line saying so.
//  - Loop brake: at most 6 chat replies per room per 10 minutes
//    without a human message (mehrdad / oracle) in between.

export const DEFAULT_ALLOWED_SENDERS = [
  'mehrdad', 'oracle', 'claude', 'morpheus', 'neon', 'muse', 'grok', 'gpt',
];

/** Senders whose lines may authorize tool actions that write. */
export const PRIVILEGED_SENDERS = ['mehrdad', 'oracle'];

/** A reply is one logical chat reply (all its parts together). */
export const MAX_CHAT_REPLIES_PER_WINDOW = 6;
export const CHAT_BRAKE_WINDOW_MS = 10 * 60 * 1000;

/** Split a long reply into parts of at most `maxChars` each. */
export const CHAT_REPLY_MAX_CHARS = 3500;

/** After this many relayed turns in one room chat, rotate it. */
export const ROOM_ROTATION_TURNS = 40;

/** Display name for an agent id: neon -> Neon, gpt -> GPT, else capitalized. */
export function agentDisplayName(agent) {
  const name = String(agent || '').trim().toLowerCase();
  if (name === 'gpt') return 'GPT';
  if (!name) return 'Agent';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function normSender(sender) {
  return String(sender || '').trim().toLowerCase();
}

/** Keep only transcript lines from senders in `allowedSenders`. */
export function filterTranscript(transcript, allowedSenders = DEFAULT_ALLOWED_SENDERS) {
  const allowed = new Set((allowedSenders || []).map(normSender));
  const lines = (transcript || []).filter((line) => allowed.has(normSender(line.sender)));
  const dropped = (transcript || []).length - lines.length;
  return { lines, dropped };
}

/** True when the transcript has a line from someone other than mehrdad/oracle. */
export function hasUnprivilegedSenders(lines) {
  return (lines || []).some((line) => !PRIVILEGED_SENDERS.includes(normSender(line.sender)));
}

/** True when the transcript has a line from a human (mehrdad / oracle). */
export function hasHumanMessage(lines) {
  return (lines || []).some((line) => PRIVILEGED_SENDERS.includes(normSender(line.sender)));
}

/** "PASS" means exactly that, after trimming. Anything else is a reply. */
export function isPassReply(text) {
  return String(text || '').trim() === 'PASS';
}

/**
 * Split a reply over CHAT_REPLY_MAX_CHARS into parts. Splits on
 * paragraph boundaries first, then sentences, then hard cuts — never
 * mid-word unless a single word exceeds the limit.
 */
export function splitReply(text, maxChars = CHAT_REPLY_MAX_CHARS) {
  const body = String(text || '');
  if (body.length <= maxChars) return [body];
  const parts = [];
  let rest = body;
  while (rest.length > maxChars) {
    const chunk = rest.slice(0, maxChars);
    // Prefer a paragraph break, then a sentence end, then a space.
    let cut = chunk.lastIndexOf('\n\n');
    if (cut < maxChars * 0.5) cut = chunk.lastIndexOf('. ');
    if (cut < maxChars * 0.5) cut = chunk.lastIndexOf(' ');
    if (cut <= 0) cut = maxChars;
    else if (chunk[cut] === ' ') cut += 0; // keep the space with the next part
    else cut += 1; // keep the sentence-ending '.' / '\n' with this part
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

/** True when a room's chat has had more than 40 relayed turns. */
export function needsRotation(turns) {
  return (turns || 0) > ROOM_ROTATION_TURNS;
}

/**
 * Loop brake: may this room receive another chat reply now?
 * `state` is the room's { replyTimes: [ts...], lastHumanTs }.
 * At most 6 replies in the last 10 minutes without a human message
 * in between; a human message resets the count.
 */
export function loopBrakeAllows(state, now = Date.now()) {
  const windowStart = now - CHAT_BRAKE_WINDOW_MS;
  const sinceHuman = state.lastHumanTs || 0;
  const recent = (state.replyTimes || []).filter((t) => t >= windowStart && t > sinceHuman);
  return recent.length < MAX_CHAT_REPLIES_PER_WINDOW;
}

/** Record one chat reply sent to the room at `now`. */
export function recordChatReply(state, now = Date.now()) {
  const windowStart = now - CHAT_BRAKE_WINDOW_MS;
  const replyTimes = (state.replyTimes || []).filter((t) => t >= windowStart);
  replyTimes.push(now);
  return { ...state, replyTimes };
}

/** Record a human message in the room at `ts` (resets the brake). */
export function recordHumanMessage(state, ts) {
  return { ...state, lastHumanTs: ts };
}

/**
 * Which job runs next: chat wins over a code card, but a chat item
 * never interrupts a card while the AI is generating — the caller
 * only calls this between cards, and runChatItem re-checks
 * adapter.isGenerating() before sending.
 */
export function nextWork({ chatEnabled, codeEnabled, hasChatItem, hasCard }) {
  if (chatEnabled && hasChatItem) return 'chat';
  if (codeEnabled && hasCard) return 'card';
  return 'idle';
}

/** Default codeEnabled per site: only Gemini has code flows so far. */
export function defaultCodeEnabled(site) {
  return site === 'gemini';
}
