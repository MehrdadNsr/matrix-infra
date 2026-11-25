// Hashing — pure logic, no DOM.
// sent_hash is sha256(message + attempt number). We use WebCrypto
// (available on https pages and in Node 18+) so the implementation is
// correct by construction instead of a hand-rolled SHA-256.

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
export async function sha256Hex(text) {
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
export async function sentHash(message, attempt) {
  return sha256Hex(`${message}\n#attempt:${attempt}`);
}
