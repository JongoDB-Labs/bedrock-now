// The Import sheet's transcript: the entries a copy would write, as the page's history events — every one of them,
// so nothing goes along unseen: your prompts and Claude's words as the history shows them (normalize.mjs), and what the
// history leaves out — an attachment, Claude Code's own note to the model, a local command's output, a compaction's
// boundary and summary — as a line of its own ("local"), saying what it is and what of it is copied.
import { fromHistory } from './normalize.mjs';

const MAX = 600;
const cut = (s) => (s.length > MAX ? `${s.slice(0, MAX)} …` : s);
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n') : '');
const local = (s) => ({ type: 'local', text: cut(s) });

/** previewEvents(entries) -> history events of a transcript as it would be copied */
export function previewEvents(entries) {
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'user' && e.isCompactSummary === true) { out.push(local(`Compaction summary (Claude's words): ${text(e.message?.content)}`)); continue; }
    if (e.type === 'user' && e.isMeta === true) { out.push(local(`Claude Code's note to the model: ${text(e.message?.content)}`)); continue; }
    if (e.type === 'user' || e.type === 'assistant') { out.push(...fromHistory(e)); continue; }
    if (e.type === 'attachment' && e.attachment && typeof e.attachment === 'object') {
      const a = e.attachment;
      const what = a.filename ?? a.path ?? a.uri ?? a.hookName ?? '';
      const body = a.content?.file?.content ?? a.content?.contents?.[0]?.text ?? (typeof a.content === 'string' ? a.content : '') ?? a.prompt ?? '';
      out.push(local(`Attachment (${a.type}${what ? `: ${what}` : ''})${body || a.prompt ? `: ${body || a.prompt}` : ''}`));
      continue;
    }
    if (e.type === 'system') { out.push(local(e.subtype === 'compact_boundary' ? 'Conversation compacted' : `Local command: ${typeof e.content === 'string' ? e.content : ''}`)); continue; }
    if (e.type === 'summary') out.push(local(`Summary: ${e.summary}`));
  }
  return out;
}
