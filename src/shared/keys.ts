/**
 * Whether `text` names a story key on its own: not inside a longer word, so `ACME-12` isn't found
 * in `ACME-123`, but beside punctuation, so `AB#100204` and a branch `ACME-12-saved-cards` count.
 */
export function mentionsKey(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)${escaped}(?!\\w)`).test(text);
}
