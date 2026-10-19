// The sandbox's own words in a failure (git's, or Claude Code's for Write message): apart, in a box of their own,
// labelled as its words — never as a sentence of ours — under the fixed line, which stays above them however long they
// are (the words' box scrolls). No quote marks: a quote mark inside could look like their end.
import { NEVER_ASKS, SAID_BY } from '../git';
import { label } from '../text';
import type { SandboxWords } from '../types';

// (the words come normalized — label(…, 300) in api.ts, invisible characters shown as ⟨U+202E⟩ or ⟨U+E0100⟩ —, so up
// to ~2,700 characters: shown whole, in their box that scrolls)
const SHOWN = 3000;

// who: the label, when it is not whose words in general but what they are ("Claude Code's reason:")
export function SandboxSaid({ words, compact = false, never = true, who }: { words: SandboxWords; compact?: boolean; never?: boolean; who?: string }) {
  return (
    <div class={`said${compact ? ' said-compact' : ''}`} data-testid="sandbox-said">
      {never && <span class="said-never" data-testid="sandbox-said-never">{NEVER_ASKS}</span>}
      <span class="said-who">{who ?? SAID_BY[words.by]}</span>
      <span class="said-text" data-testid="sandbox-said-text">{label(words.said, SHOWN)}</span>
    </div>
  );
}
