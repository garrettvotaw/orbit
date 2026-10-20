/** The keys the composer cares about, as a KeyboardEvent carries them. */
export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
}

/** Enter sends in every lane, Ctrl+Enter too; Shift+Enter is a new line, and Enter inside an IME composition is the IME's. */
export function sendsOnKey(e: ComposerKey): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}
