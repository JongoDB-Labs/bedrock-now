// Where the keyboard focus is when a permission card appears: the card takes it only from nothing you type into.

/** What this needs of a focused element (a DOM Element has both). */
export interface Focused {
  tagName?: string;
  isContentEditable?: boolean;
}

/** A field, an editor (contenteditable, as CodeMirror's) or a frame (the terminal) — empty or not: a card that
 *  appears must not take the focus from it, or the next keystroke meant for it would land on the card. */
export function typingIn(el: Focused | null | undefined): boolean {
  if (!el) return false;
  const t = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return ['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'OBJECT', 'EMBED'].includes(t) || el.isContentEditable === true;
}
