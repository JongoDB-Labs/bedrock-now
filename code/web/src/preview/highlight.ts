// Notebook code cells: highlighted with CodeMirror's own language parsers (the editor's, src/editor/langs.ts: each
// loaded on first use), as runs of text with @lezer/highlight's "tok-*" classes — static text, not an editor per cell.
// A cell over HIGHLIGHT_MAX characters, or a language without a parser, stays plain text.
import { classHighlighter, highlightCode } from '@lezer/highlight';
import type { Parser } from '@lezer/common';
import { languageFor } from '../editor/langs';

export const HIGHLIGHT_MAX = 100_000;

const EXT: Record<string, string> = {
  python: 'py', python3: 'py', ipython: 'py', ipython3: 'py', javascript: 'js', typescript: 'ts', r: 'r', sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh',
  ruby: 'rb', go: 'go', rust: 'rs', c: 'c', 'c++': 'cpp', cpp: 'cpp', java: 'java', kotlin: 'kt', scala: 'java', lua: 'lua', php: 'php', perl: 'pl',
  swift: 'swift', json: 'json', html: 'html', markdown: 'md', yaml: 'yaml', toml: 'toml',
};

const parsers = new Map<string, Promise<Parser | null>>();

/** The parser for a notebook's language (its kernel's), or null. */
export function parserFor(lang: string): Promise<Parser | null> {
  const ext = EXT[lang.toLowerCase()] ?? null;
  if (!ext) return Promise.resolve(null);
  let p = parsers.get(ext);
  if (!p) {
    p = languageFor(`cell.${ext}`).then((x) => {
      const o = x as { parser?: Parser; language?: { parser?: Parser } } | null;
      return o?.language?.parser ?? o?.parser ?? null;
    });
    parsers.set(ext, p);
  }
  return p;
}

export interface Tok {
  text: string;
  cls: string;
}

/** Code → runs of text with highlight classes (line breaks as "\n" runs). */
export function highlight(code: string, parser: Parser | null): Tok[] {
  if (!parser || code.length > HIGHLIGHT_MAX) return [{ text: code, cls: '' }];
  const out: Tok[] = [];
  try {
    highlightCode(code, parser.parse(code), classHighlighter, (text, cls) => out.push({ text, cls }), () => out.push({ text: '\n', cls: '' }));
  } catch {
    return [{ text: code, cls: '' }];
  }
  return out;
}
