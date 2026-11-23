// Code-block extraction and stitching — pure logic, no DOM.
//
// The model must output exactly ONE file in ONE fenced code block.
// Reality is messier: answers get cut off, continue-turns repeat a few
// lines at the seam, and sometimes several blocks appear. These helpers
// deal with that without ever touching the page.

/** A fenced block: { lang, code, fence } where fence is the backtick run. */
export function extractFencedBlocks(text) {
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
export function extractSingleFile(text) {
  const blocks = extractFencedBlocks(text);
  if (blocks.length === 0) return null;
  let best = blocks[0];
  for (const b of blocks) {
    if (b.code.length > best.code.length) best = b;
  }
  return best.code;
}

/** True when the text contains an unclosed fence. */
export function hasUnclosedFence(text) {
  return extractFencedBlocks(text).some((b) => !b.closed);
}

export function hasEndMarker(text, id) {
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
export function detectQuestion(text, id) {
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
export function isCutOff(text, id) {
  return !hasEndMarker(text, id) || hasUnclosedFence(text);
}

/**
 * Remove the protocol lines the model was asked to emit:
 * the opening `CARD <id>` line, the closing `END-<id>` line and a
 * trailing `CONTINUE` line. Lines are matched exactly (after trim);
 * code that merely mentions them is untouched.
 */
export function stripProtocolLines(code, id) {
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
export function seamOverlap(aLines, bLines) {
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
export function stitchParts(parts) {
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
export function extractFinalFile(messages, indexes, id) {
  const parts = [];
  for (const idx of indexes) {
    const msg = messages[idx];
    if (!msg || msg.role !== 'model') continue;
    const code = extractSingleFile(msg.text);
    if (code != null && code.trim() !== '') parts.push(code);
  }
  return stripProtocolLines(stitchParts(parts), id);
}
