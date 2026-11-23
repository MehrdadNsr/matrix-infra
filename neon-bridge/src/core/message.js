// Message building — pure logic, no DOM.
// The exact footer text is part of the contract with the supervisor:
// the CARD / END markers let the supervisor (and the extractor) tell
// a complete answer from a cut-off one.

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
export function answerMessage(id, answer) {
  return (
    `Answer to your questions:\n${answer}\n` +
    `Now continue the task. Same rules: one file, one code block, end with END-${id}.`
  );
}

/** Full message sent to Gemini for a card. */
export function buildMessage(card) {
  return `${card.prompt}\n\n${messageFooter(card.id)}`;
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
export function buildMessageWithLinks(card, linkedTexts) {
  const inline = linkedTexts
    .map((t) => `--- linked file: ${t.url} ---\n${t.text}`)
    .join('\n\n');
  return `${card.prompt}\n\n${inline}\n\n${messageFooter(card.id)}`;
}
