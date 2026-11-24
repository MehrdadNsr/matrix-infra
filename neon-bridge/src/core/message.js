// Message building — pure logic, no DOM.
// The exact footer text is part of the contract with the supervisor:
// the CARD / END markers let the supervisor (and the extractor) tell
// a complete answer from a cut-off one.
//
// Never send a byte-identical message twice: the short intro line
// rotates by attempt number, so a resend after an error is worded
// differently (the hash already includes the attempt number too).

/** Short intro phrasings, rotated by attempt so resends are never byte-identical. */
export const INTRO_PHRASES = Object.freeze([
  'Here is the next task.',
  'Next up:',
  'Here is another task for you.',
  'Continuing with the next task:',
]);

/** Intro line for an attempt (1-based). Attempt 5 reuses attempt 1. */
export function introForAttempt(attempt) {
  const idx = ((attempt - 1) % INTRO_PHRASES.length + INTRO_PHRASES.length) % INTRO_PHRASES.length;
  return INTRO_PHRASES[idx];
}

/** The footer appended to every card prompt. `id` is the card id. */
export function messageFooter(id) {
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
export function answerMessage(id, answer, attempt = 1) {
  const body =
    `Answer to your questions:\n${answer}\n` +
    `Now continue the task. Same rules: one file, one code block, end with END-${id}.`;
  // On a resend (attempt > 1) the rotating intro is prefixed so the
  // message is never byte-identical to the first send.
  return attempt > 1 ? `${introForAttempt(attempt)}\n\n${body}` : body;
}

/** Full message sent to Gemini for a card. */
export function buildMessage(card, attempt = 1) {
  return `${introForAttempt(attempt)}\n\n${card.prompt}\n\n${messageFooter(card.id)}`;
}

/**
 * Gem-mode message: only CARD <id> + the task, plus a one-line
 * reminder. The standing rules live in the Gem's instructions, so
 * the full footer is not sent. The intro still rotates by attempt
 * so a resend is never byte-identical.
 */
export function buildGemMessage(card, attempt = 1) {
  return (
    `CARD ${card.id}\n\n` +
    `${introForAttempt(attempt)}\n\n` +
    `${card.prompt}\n\n` +
    `Follow your rules. End with END-${card.id}.`
  );
}

/**
 * MCP-mode message. The first sentence rotates by attempt so a
 * resend is never byte-identical; attempt 1 is the exact spec text.
 * Gemini does the work through the neon-mcp tools and delivers the
 * file with submit_file — it never pastes the file in the chat.
 */
export const MCP_INTROS = Object.freeze([
  'Use the neon-mcp tools only.',
  'Please work through the neon-mcp tools only.',
  'For this task, use the neon-mcp tools only.',
  'Work with the neon-mcp tools only.',
]);

export function mcpMessage(card, attempt = 1) {
  const idx = ((attempt - 1) % MCP_INTROS.length + MCP_INTROS.length) % MCP_INTROS.length;
  return (
    `${MCP_INTROS[idx]} Call get_task with task_id=${card.id}. ` +
    'Read the real files with read_file/list_dir, write the COMPLETE file, ' +
    'and deliver it with submit_file. Never paste the file in the chat. ' +
    'If something is unclear, call ask_question instead of guessing. ' +
    `When submit_file succeeds, reply with the PR link and DONE-${card.id}.`
  );
}

/** Sent once when Gemini's reply finished without submit_file. */
export function mcpNudgeMessage(card) {
  return `You did not finish with submit_file. Call submit_file now with task_id=${card.id} and the complete file.`;
}

/** Ask for the rest of a cut-off answer, in the same chat. */
export function continueMessage(id) {
  return (
    'Continue exactly where you stopped, inside the same code block, ' +
    'no repetition. ' +
    `End with END-${id}.`
  );
}

/** Message used when links were not read: prompt + linked text inline. */
export function buildMessageWithLinks(card, linkedTexts, attempt = 1) {
  const inline = linkedTexts
    .map((t) => `--- linked file: ${t.url} ---\n${t.text}`)
    .join('\n\n');
  return `${introForAttempt(attempt)}\n\n${card.prompt}\n\n${inline}\n\n${messageFooter(card.id)}`;
}
