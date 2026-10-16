// Every keyboard shortcut of the page, in one list: the shortcut sheet (⌘/ or ?), the empty editor's short list and
// the command palette's hints all read it. The keys themselves are handled where they act (Shell's global keys, the
// composer, the editor, the palette).
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** ⌘ on a Mac, Ctrl elsewhere */
export const MOD = mac ? '⌘' : 'Ctrl';

export interface Shortcut {
  keys: string;
  what: string;
  group: 'Chat' | 'Find and go' | 'Files and editor' | 'Panels' | 'Review' | 'In the palette';
  /** shown on the empty editor too */
  welcome?: boolean;
  /** the palette action it opens (its hint there) */
  action?: string;
}

export function shortcuts(): Shortcut[] {
  return [
    { group: 'Chat', what: 'Send', keys: 'Enter', welcome: true },
    { group: 'Chat', what: 'New line', keys: 'Shift+Enter', welcome: true },
    { group: 'Chat', what: 'Stop Claude', keys: 'Esc', welcome: true },
    { group: 'Chat', what: 'Cycle permission mode', keys: 'Shift+Tab', welcome: true },
    { group: 'Chat', what: 'Open the permission mode menu', keys: 'Alt+M', action: 'mode-menu' },
    { group: 'Chat', what: 'Previous prompt', keys: '↑ in an empty box' },
    { group: 'Chat', what: 'Commands, skills, plugin commands', keys: '/' },
    { group: 'Chat', what: 'Mention a file', keys: '@' },
    { group: 'Chat', what: 'Answer a permission prompt (once you are in its card)', keys: '1 · 2 · 3' },
    { group: 'Find and go', what: 'Command palette', keys: `${MOD}+K · Ctrl+Shift+P`, welcome: true },
    { group: 'Find and go', what: 'Go to file', keys: `${MOD}+P`, welcome: true, action: 'go-to-file' },
    { group: 'Find and go', what: 'Search in files', keys: `${MOD}+Shift+F`, welcome: true, action: 'search' },
    { group: 'Find and go', what: 'Review changes', keys: `${MOD}+Shift+D`, welcome: true, action: 'review' },
    { group: 'Find and go', what: 'Keyboard shortcuts', keys: `${MOD}+/ · ?`, action: 'shortcuts' },
    { group: 'Files and editor', what: 'Save the file', keys: `${MOD}+S`, welcome: true },
    { group: 'Files and editor', what: 'Find in the file', keys: `${MOD}+F` },
    { group: 'Panels', what: 'Toggle the terminal', keys: 'Ctrl+`', welcome: true, action: 'terminal' },
    { group: 'Panels', what: 'Toggle the explorer', keys: `${MOD}+B`, action: 'explorer' },
    { group: 'Review', what: 'Comment on a line (it goes with your next prompt)', keys: 'Comment button · Enter' },
    { group: 'Review', what: 'Cancel a comment', keys: 'Esc' },
    { group: 'In the palette', what: 'Move', keys: '↑ ↓ · Tab' },
    { group: 'In the palette', what: 'Run', keys: 'Enter' },
    { group: 'In the palette', what: 'Close', keys: 'Esc' },
    { group: 'In the palette', what: 'Only actions · only sessions', keys: '> · #' },
  ];
}

/** The palette's hint for an action (its shortcut), or '' */
export function keysFor(action: string): string {
  return shortcuts().find((s) => s.action === action)?.keys ?? '';
}
