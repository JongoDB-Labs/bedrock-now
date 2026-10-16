// Renders markdown.ts's node tree with Preact: elements from a fixed list, attributes from a fixed list, all text as
// text nodes. No HTML string ever reaches the DOM.
import { h, type ComponentChildren, type VNode } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { renderMarkdown, type MdNode } from '../markdown';
import { openFile } from '../app';
import { copyText, memo } from './ui';
import { Icon } from './icons';

const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'a', 'span', 'div', 'input']);
const ATTRS = new Set(['href', 'target', 'rel', 'title', 'class', 'start', 'type', 'disabled', 'checked', 'data-lang', 'data-file']);

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="md-code">
      <div class="md-code-head">
        <span class="md-code-lang">{lang || 'text'}</span>
        <button
          type="button"
          class="md-copy"
          title="Copy"
          onClick={async () => {
            if (await copyText(code)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function textOf(n: MdNode): string {
  return typeof n === 'string' ? n : n.children.map(textOf).join('');
}

function toVNode(n: MdNode, key: number): ComponentChildren {
  if (typeof n === 'string') return n;
  if (!TAGS.has(n.tag)) return n.children.map(toVNode);
  if (n.tag === 'pre' && n.attrs?.class !== 'md-html') {
    return <CodeBlock key={key} lang={n.attrs?.['data-lang'] ?? ''} code={n.children.map(textOf).join('')} />;
  }
  const props: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(n.attrs ?? {})) {
    if (!ATTRS.has(k)) continue;
    if (k === 'disabled' || k === 'checked') props[k] = true;
    else props[k] = v;
  }
  if (n.tag === 'a' && n.attrs?.['data-file']) {
    const path = n.attrs['data-file'];
    props.class = 'md-file';
    props.onClick = (e: Event) => {
      e.preventDefault();
      void openFile(path);
    };
  } else if (n.tag === 'a' && !(typeof props.href === 'string' && /^https?:\/\//.test(props.href))) {
    delete props.href;
  }
  if (n.tag === 'input') props.readOnly = true;
  return h(n.tag, props, n.children.length ? n.children.map(toVNode) : null) as VNode;
}

export const MarkdownView = memo(function MarkdownView({ text, class: cls }: { text: string; class?: string }) {
  const nodes = useMemo(() => renderMarkdown(text), [text]);
  return <div class={`md${cls ? ' ' + cls : ''}`}>{nodes.map(toVNode)}</div>;
});
