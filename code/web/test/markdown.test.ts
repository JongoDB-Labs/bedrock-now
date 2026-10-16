import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, safeHref, fileHref, textOf, type MdNode, type MdEl } from '../src/markdown';

const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'a', 'span', 'div', 'input']);
const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'title', 'class', 'start', 'type', 'disabled', 'checked', 'data-lang', 'data-file']);

function walk(nodes: MdNode[], f: (n: MdEl) => void): void {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    f(n);
    walk(n.children, f);
  }
}
function els(nodes: MdNode[], tag: string): MdEl[] {
  const out: MdEl[] = [];
  walk(nodes, (n) => n.tag === tag && out.push(n));
  return out;
}

test('raw HTML stays text, inline and block', () => {
  const src = 'a <img src=x onerror=alert(1)> b <script>alert(2)</script>\n\n<svg onload=alert(3)></svg>\n\n<iframe src="javascript:alert(4)"></iframe>';
  const t = renderMarkdown(src);
  const tags = new Set<string>();
  walk(t, (n) => tags.add(n.tag));
  for (const bad of ['img', 'script', 'svg', 'iframe', 'style', 'form']) assert.ok(!tags.has(bad), bad);
  const text = textOf(t);
  assert.ok(text.includes('<img src=x onerror=alert(1)>'));
  assert.ok(text.includes('<script>alert(2)</script>'));
  assert.ok(text.includes('<svg onload=alert(3)></svg>'));
});

test('only http(s) links become links, with noopener noreferrer', () => {
  const t = renderMarkdown('[a](javascript:alert(1)) [b](data:text/html,x) [c](vbscript:x) [d](https://ok.example/x) <javascript:alert(2)> [e](//evil.example) [f](https://u:p@evil.example)');
  const links = els(t, 'a').filter((a) => a.attrs?.href !== '#');
  assert.deepEqual(
    links.map((a) => a.attrs?.href),
    ['https://ok.example/x'],
  );
  assert.equal(links[0].attrs?.rel, 'noopener noreferrer nofollow');
  assert.equal(links[0].attrs?.target, '_blank');
  assert.ok(textOf(t).includes('javascript:alert(1)'), 'the bad target is shown as text');
});

test('images are never loaded: an http image becomes a link, others text', () => {
  const t = renderMarkdown('![pixel](https://evil.example/p.png) ![x](javascript:alert(1))');
  assert.equal(els(t, 'img').length, 0);
  const links = els(t, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].attrs?.href, 'https://evil.example/p.png');
  assert.ok(textOf(t).includes('[image: pixel]'));
});

test('every element and attribute is from the allow-lists', () => {
  const src = '# h\n\n> q\n\n- [x] done\n- [ ] todo\n\n1. one\n\n| a | b |\n|:-|-:|\n| `c` | **d** |\n\n```ts\nconst a = 1 < 2;\n```\n\n---\n\nline  \nbreak ~~del~~ _em_ [l](https://x.example "t")';
  const t = renderMarkdown(src);
  walk(t, (n) => {
    assert.ok(ALLOWED_TAGS.has(n.tag), n.tag);
    for (const k of Object.keys(n.attrs ?? {})) assert.ok(ALLOWED_ATTRS.has(k), k);
  });
  const boxes = els(t, 'input');
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((b) => 'disabled' in (b.attrs ?? {})));
  assert.equal(els(t, 'pre')[0].attrs?.['data-lang'], 'ts');
  assert.equal(textOf(els(t, 'pre')), 'const a = 1 < 2;');
  assert.ok(els(t, 'th')[0].attrs?.class === 'al-left');
});

test('entities are decoded as text, code keeps its characters', () => {
  const t = renderMarkdown('&lt;b&gt; &amp; &#x3C;i&#x3E; `&lt;` ');
  const text = textOf(t);
  assert.ok(text.includes('<b> & <i>'));
  assert.equal(textOf(els(t, 'code')), '&lt;');
});

test('bidi controls are made visible in text and code', () => {
  const t = renderMarkdown('admin‮ txt `x⁦y`');
  const text = textOf(t);
  assert.ok(text.includes('⟨U+202E⟩'));
  assert.ok(text.includes('⟨U+2066⟩'));
  assert.ok(!/[‪-‮⁦-⁩]/.test(text));
});

test('huge and deeply nested input is bounded and never throws', () => {
  const deep = '> '.repeat(500) + 'x';
  const t1 = renderMarkdown(deep);
  assert.ok(textOf(t1).length > 0);
  const big = Array.from({ length: 30_000 }, (_, i) => `- item ${i}`).join('\n');
  const t2 = renderMarkdown(big);
  let n = 0;
  walk(t2, () => n++);
  assert.ok(n < 25_000, `nodes: ${n}`);
  const word = renderMarkdown('x'.repeat(300_000));
  assert.equal(textOf(word).length, 300_000);
});

test('relative links that look like files open in the editor', () => {
  assert.equal(fileHref('src/app.ts'), 'src/app.ts');
  assert.equal(fileHref('src/app.ts:12'), 'src/app.ts');
  assert.equal(fileHref('../etc/passwd'), null);
  assert.equal(fileHref('javascript:alert(1)'), null);
  assert.equal(fileHref('//evil.example/x'), null);
  const t = renderMarkdown('[see](scripts/deploy.sh)');
  const a = els(t, 'a')[0];
  assert.equal(a.attrs?.['data-file'], 'scripts/deploy.sh');
  assert.equal(a.attrs?.href, '#');
});

test('safeHref', () => {
  assert.equal(safeHref('https://a.example/b?c#d'), 'https://a.example/b?c#d');
  assert.equal(safeHref(' HTTPS://A.example '), 'https://a.example/');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/rel', 'https://u@evil.example', 'x'.repeat(5000), 42 as unknown as string]) {
    assert.equal(safeHref(bad), null, String(bad).slice(0, 30));
  }
});
