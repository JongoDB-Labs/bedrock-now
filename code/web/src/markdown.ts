// Markdown → a plain node tree, from marked's *lexer* only (marked's HTML renderer is never used). The tree has a
// fixed set of tags and attributes; MarkdownView turns it into DOM nodes with Preact (text nodes and setAttribute,
// never innerHTML). Raw HTML in the source stays visible text; links are kept only for http(s) URLs; images are
// never loaded (shown as a link).
import { Lexer, type Token, type Tokens } from 'marked';
import { cleanPath, visible } from './text';

export interface MdEl {
  tag: string;
  attrs?: Record<string, string>;
  children: MdNode[];
}
export type MdNode = string | MdEl;

const MAX_NODES = 20_000;
const MAX_DEPTH = 40;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
/** Decode the few entities Markdown authors use; the result is text, so this is display-only. */
function entities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z0-9]{2,8});/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k.startsWith('#')) {
      const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      if (Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n);
    }
    return m;
  });
}

/** http(s) URL → normalised href, else null. Rejects javascript:, data:, vbscript:, file:, relative, protocol-relative. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > 4000) return null;
  const h = href.trim();
  if (!/^https?:\/\//i.test(h)) return null;
  try {
    const u = new URL(h);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null; // https://user@evil — misleading
    return u.href;
  } catch {
    return null;
  }
}

/** A relative link that looks like a workspace file (e.g. `src/app.ts:12`) → its path, else null. */
export function fileHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > 1000 || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return null;
  const p = cleanPath(href.replace(/[?#].*$/, '').replace(/:\d+(:\d+)?$/, ''));
  return p && /^[\w.@/ -]+$/.test(p) ? p : null;
}

interface Ctx {
  n: number;
}

function el(ctx: Ctx, tag: string, children: MdNode[], attrs?: Record<string, string>): MdEl {
  ctx.n++;
  return attrs ? { tag, attrs, children } : { tag, children };
}

function txt(ctx: Ctx, s: string, decode = true): string {
  ctx.n++;
  return visible(decode ? entities(s) : s);
}

function inline(tokens: Token[] | undefined, ctx: Ctx, depth: number): MdNode[] {
  const out: MdNode[] = [];
  if (!tokens) return out;
  for (const t of tokens) {
    if (ctx.n > MAX_NODES) {
      out.push('…');
      break;
    }
    if (depth > MAX_DEPTH) {
      out.push(txt(ctx, (t as { raw?: string }).raw ?? ''));
      continue;
    }
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length) out.push(...inline(tt.tokens, ctx, depth + 1));
        else out.push(txt(ctx, tt.text, !tt.escaped));
        break;
      }
      case 'escape':
        out.push(txt(ctx, (t as Tokens.Escape).text, false));
        break;
      case 'html':
        // raw HTML is shown as the text it is
        out.push(txt(ctx, (t as Tokens.HTML).text, false));
        break;
      case 'strong':
        out.push(el(ctx, 'strong', inline((t as Tokens.Strong).tokens, ctx, depth + 1)));
        break;
      case 'em':
        out.push(el(ctx, 'em', inline((t as Tokens.Em).tokens, ctx, depth + 1)));
        break;
      case 'del':
        out.push(el(ctx, 'del', inline((t as Tokens.Del).tokens, ctx, depth + 1)));
        break;
      case 'codespan':
        out.push(el(ctx, 'code', [txt(ctx, (t as Tokens.Codespan).text, false)]));
        break;
      case 'br':
        out.push(el(ctx, 'br', []));
        break;
      case 'link': {
        const lt = t as Tokens.Link;
        const children = inline(lt.tokens, ctx, depth + 1);
        const href = safeHref(lt.href);
        const file = href ? null : fileHref(lt.href);
        if (href) {
          const attrs: Record<string, string> = { href, target: '_blank', rel: 'noopener noreferrer nofollow', title: visible(href) };
          out.push(el(ctx, 'a', children, attrs));
        } else if (file !== null && file !== '') {
          out.push(el(ctx, 'a', children, { 'data-file': file, title: `Open ${file}`, href: '#' }));
        } else {
          // anything else (javascript:, data:, mailto:…) keeps its text and shows the target as text
          out.push(el(ctx, 'span', [...children, txt(ctx, ` (${lt.href})`, false)], { class: 'md-badlink' }));
        }
        break;
      }
      case 'image': {
        const it = t as Tokens.Image;
        const href = safeHref(it.href);
        const label = `[image${it.text ? ': ' + it.text : ''}]`;
        out.push(
          href
            ? el(ctx, 'a', [txt(ctx, label)], { href, target: '_blank', rel: 'noopener noreferrer nofollow', title: visible(href) })
            : el(ctx, 'span', [txt(ctx, label)], { class: 'md-badlink' }),
        );
        break;
      }
      case 'checkbox':
        out.push(el(ctx, 'input', [], (t as Tokens.Checkbox).checked ? { type: 'checkbox', disabled: '', checked: '' } : { type: 'checkbox', disabled: '' }));
        break;
      default: {
        const raw = (t as { raw?: string; text?: string }).text ?? (t as { raw?: string }).raw ?? '';
        if (raw) out.push(txt(ctx, raw, false));
      }
    }
  }
  return out;
}

function block(tokens: Token[], ctx: Ctx, depth: number): MdNode[] {
  const out: MdNode[] = [];
  for (const t of tokens) {
    if (ctx.n > MAX_NODES) {
      out.push(el(ctx, 'p', ['… (truncated)']));
      break;
    }
    if (depth > MAX_DEPTH) {
      out.push(el(ctx, 'p', [txt(ctx, (t as { raw?: string }).raw ?? '', false)]));
      continue;
    }
    switch (t.type) {
      case 'space':
      case 'def':
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        const level = Math.min(6, Math.max(1, h.depth));
        out.push(el(ctx, `h${level}`, inline(h.tokens, ctx, depth + 1)));
        break;
      }
      case 'paragraph':
        out.push(el(ctx, 'p', inline((t as Tokens.Paragraph).tokens, ctx, depth + 1)));
        break;
      case 'text': {
        const tt = t as Tokens.Text;
        out.push(el(ctx, 'p', tt.tokens ? inline(tt.tokens, ctx, depth + 1) : [txt(ctx, tt.text)]));
        break;
      }
      case 'code': {
        const c = t as Tokens.Code;
        const lang = (c.lang || '').trim().split(/\s+/)[0].slice(0, 30).replace(/[^\w+#.-]/g, '');
        out.push(el(ctx, 'pre', [el(ctx, 'code', [txt(ctx, c.text, false)])], lang ? { 'data-lang': lang } : undefined));
        break;
      }
      case 'blockquote':
        out.push(el(ctx, 'blockquote', block((t as Tokens.Blockquote).tokens, ctx, depth + 1)));
        break;
      case 'hr':
        out.push(el(ctx, 'hr', []));
        break;
      case 'list': {
        const l = t as Tokens.List;
        const items = l.items.slice(0, 2000).map((it) => {
          const loose = l.loose;
          const kids = loose ? block(it.tokens, ctx, depth + 1) : listItemTight(it.tokens, ctx, depth + 1);
          return el(ctx, 'li', kids, it.task ? { class: 'task' } : undefined);
        });
        const attrs: Record<string, string> = {};
        if (l.ordered && typeof l.start === 'number' && l.start !== 1 && Number.isFinite(l.start)) attrs.start = String(Math.max(0, Math.min(1e9, l.start)));
        out.push(el(ctx, l.ordered ? 'ol' : 'ul', items, Object.keys(attrs).length ? attrs : undefined));
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        const align = (a: string | null) => (a === 'center' || a === 'right' || a === 'left' ? { class: `al-${a}` } : undefined);
        const head = el(ctx, 'thead', [el(ctx, 'tr', tb.header.slice(0, 50).map((c) => el(ctx, 'th', inline(c.tokens, ctx, depth + 1), align(c.align))))]);
        const body = el(
          ctx,
          'tbody',
          tb.rows.slice(0, 1000).map((r) => el(ctx, 'tr', r.slice(0, 50).map((c) => el(ctx, 'td', inline(c.tokens, ctx, depth + 1), align(c.align))))),
        );
        out.push(el(ctx, 'div', [el(ctx, 'table', [head, body])], { class: 'md-table' }));
        break;
      }
      case 'html':
        // a raw HTML block: shown as code text
        out.push(el(ctx, 'pre', [el(ctx, 'code', [txt(ctx, (t as Tokens.HTML).text, false)])], { class: 'md-html' }));
        break;
      default: {
        const raw = (t as { raw?: string }).raw ?? '';
        if (raw.trim()) out.push(el(ctx, 'p', [txt(ctx, raw, false)]));
      }
    }
  }
  return out;
}

/** Tight list items: text tokens render inline (no <p>), nested lists as blocks. */
function listItemTight(tokens: Token[], ctx: Ctx, depth: number): MdNode[] {
  const out: MdNode[] = [];
  for (const t of tokens) {
    if (t.type === 'text') {
      const tt = t as Tokens.Text;
      out.push(...(tt.tokens ? inline(tt.tokens, ctx, depth) : [txt(ctx, tt.text)]));
    } else if (t.type === 'checkbox') out.push(...inline([t], ctx, depth));
    else out.push(...block([t], ctx, depth));
  }
  return out;
}

/** Markdown source → node tree. Never throws: a lexer failure shows the source as text. */
export function renderMarkdown(src: string): MdNode[] {
  const ctx: Ctx = { n: 0 };
  let tokens: Token[];
  try {
    // a single newline is a line break, as Claude Code's own terminal shows its answers
    tokens = Lexer.lex(src, { gfm: true, breaks: true, async: false });
  } catch {
    return [el(ctx, 'p', [visible(src)])];
  }
  return block(tokens, ctx, 0);
}

/** Flatten a tree to its text (tests, copy). */
export function textOf(nodes: MdNode[]): string {
  return nodes.map((n) => (typeof n === 'string' ? n : textOf(n.children))).join('');
}
