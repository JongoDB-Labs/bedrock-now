// CodeMirror 6, loaded on demand (its own chunk: the chat works before the editor arrives). Each editor lives in a
// shadow root: CodeMirror then mounts its styles as constructed stylesheets (adoptedStyleSheets) instead of a
// <style> element, so the page's CSP needs no 'unsafe-inline' or nonce for styles. If the page carries
// <meta name="bn-style-nonce">, that nonce is passed too. Colours are CSS variables from app.css, so the editor
// follows light/dark like the rest of the page. Bidi and control characters are shown as placeholders
// (highlightSpecialChars), so a file cannot hide code from you.
import { EditorState, type Extension, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { tags as t } from '@lezer/highlight';
import { languageFor, languageName } from './langs';

const v = (name: string) => `var(--${name})`;

const theme = EditorView.theme({
  '&': { color: v('ed-fg'), backgroundColor: v('ed-bg'), height: '100%', fontSize: v('ed-size') },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: v('mono'), lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: v('ed-cursor'), padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('ed-cursor'), borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: v('ed-sel') },
  '.cm-activeLine': { backgroundColor: v('ed-line') },
  '.cm-gutters': { backgroundColor: v('ed-bg'), color: v('ed-gutter'), border: 'none', paddingLeft: '6px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: v('ed-fg') },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 4px', minWidth: '32px' },
  '.cm-foldGutter .cm-gutterElement': { color: v('ed-gutter'), cursor: 'pointer' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: v('ed-match'), outline: `1px solid ${v('ed-match-line')}` },
  '.cm-selectionMatch': { backgroundColor: v('ed-match') },
  '.cm-searchMatch': { backgroundColor: v('ed-find'), outline: `1px solid ${v('ed-find-line')}` },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: v('ed-find-cur') },
  '.cm-specialChar': { color: v('bad'), backgroundColor: v('ed-special') },
  '.cm-panels': { backgroundColor: v('surface-2'), color: v('ink'), borderColor: v('line') },
  '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${v('line')}` },
  '.cm-panel.cm-search': { padding: '6px 8px', fontFamily: v('sans'), fontSize: '13px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: v('sans'), fontSize: '12.5px' },
  '.cm-textfield': { backgroundColor: v('bg'), color: v('ink'), border: `1px solid ${v('line')}`, borderRadius: '4px', padding: '2px 6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: v('surface'), color: v('ink'), border: `1px solid ${v('line')}`, borderRadius: '4px' },
  '.cm-tooltip': { backgroundColor: v('surface'), color: v('ink'), border: `1px solid ${v('line')}`, borderRadius: '6px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: v('accent'), color: v('accent-ink') },
  '.cm-foldPlaceholder': { backgroundColor: v('ed-line'), border: `1px solid ${v('line')}`, color: v('muted') },
  // merge view
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: v('diff-del-bg') },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': { backgroundColor: v('diff-add-bg') },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': { backgroundColor: v('diff-del-hl'), background: v('diff-del-hl') },
  '&.cm-merge-b .cm-changedText': { backgroundColor: v('diff-add-hl'), background: v('diff-add-hl') },
  '.cm-changeGutter': { width: '3px', paddingLeft: '0' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': { backgroundColor: v('bad') },
  '&.cm-merge-b .cm-changedLineGutter': { backgroundColor: v('ok') },
  '.cm-collapsedLines': { color: v('muted'), background: v('surface-2'), fontFamily: v('sans'), fontSize: '12px', padding: '3px 12px', cursor: 'pointer' },
  '.cm-collapsedLines:before, .cm-collapsedLines:after': { display: 'none' },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: v('syn-keyword') },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: v('syn-string') },
  { tag: [t.number, t.bool, t.null, t.atom], color: v('syn-number') },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v('syn-comment'), fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: v('syn-function') },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: v('syn-type') },
  { tag: [t.propertyName, t.attributeName], color: v('syn-property') },
  { tag: [t.definition(t.variableName), t.variableName], color: v('syn-variable') },
  { tag: [t.tagName, t.angleBracket], color: v('syn-tag') },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: v('syn-punct') },
  { tag: [t.heading], color: v('syn-keyword'), fontWeight: '600' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.link, t.url], color: v('syn-string'), textDecoration: 'underline' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: v('syn-meta') },
  { tag: [t.invalid], color: v('bad') },
  { tag: [t.inserted], color: v('ok') },
  { tag: [t.deleted], color: v('bad') },
]);

function nonce(): Extension {
  const n = document.querySelector<HTMLMetaElement>('meta[name="bn-style-nonce"]')?.content ?? '';
  return /^[A-Za-z0-9+/=_-]{8,200}$/.test(n) ? EditorView.cspNonce.of(n) : [];
}

function base(readOnly: boolean): Extension[] {
  return [
    nonce(),
    theme,
    syntaxHighlighting(highlight),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars({ addSpecialChars: /[‪-‬⁨­]/ }),
    foldGutter({ markerDOM: (open) => {
      const s = document.createElement('span');
      s.textContent = open ? '⌄' : '›';
      return s;
    } }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorState.tabSize.of(4),
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    ...(readOnly
      ? [keymap.of([...defaultKeymap, ...searchKeymap])]
      : [
          history(),
          indentOnInput(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true }),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
        ]),
  ];
}

let hostSheet: CSSStyleSheet | null = null;
function shadowHost(host: HTMLElement): ShadowRoot {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  while (root.firstChild) root.removeChild(root.firstChild);
  if (!hostSheet) {
    hostSheet = new CSSStyleSheet();
    hostSheet.replaceSync(':host{display:block;height:100%;min-height:0}.cm-editor{height:100%}.bn-merge{height:100%;overflow:auto}');
  }
  if (!root.adoptedStyleSheets.includes(hostSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, hostSheet];
  return root;
}

export interface EditorOptions {
  text: string;
  path: string;
  readOnly: boolean;
  onDirty?: (dirty: boolean) => void;
  onSave?: (text: string) => void;
  onCursor?: (line: number, col: number) => void;
}

export interface EditorHandle {
  getText(): string;
  /** Replace the whole document (a reload from disk) and mark it as the saved state. */
  setText(text: string): void;
  setReadOnly(ro: boolean): void;
  focus(): void;
  destroy(): void;
  language: string;
}

export function mountEditor(host: HTMLElement, o: EditorOptions): EditorHandle {
  const root = shadowHost(host);
  let saved = o.text;
  let dirty = false;
  const lang = new Compartment();
  const ro = new Compartment();
  const view = new EditorView({
    root,
    parent: root,
    state: EditorState.create({
      doc: o.text,
      extensions: [
        ro.of(base(o.readOnly)),
        lang.of([]),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: (vw) => {
              o.onSave?.(vw.state.doc.toString());
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const d = u.state.doc.length !== saved.length || u.state.doc.toString() !== saved;
            if (d !== dirty) {
              dirty = d;
              o.onDirty?.(d);
            }
          }
          if (u.selectionSet || u.docChanged || u.focusChanged) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            o.onCursor?.(line.number, head - line.from + 1);
          }
        }),
      ],
    }),
  });
  void languageFor(o.path).then((ext) => {
    if (ext) view.dispatch({ effects: lang.reconfigure(ext) });
  });
  return {
    language: languageName(o.path),
    getText: () => view.state.doc.toString(),
    setText(text: string) {
      saved = text;
      dirty = false;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      o.onDirty?.(false);
    },
    setReadOnly(r: boolean) {
      view.dispatch({ effects: ro.reconfigure(base(r)) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export interface MergeOptions {
  original: string;
  modified: string;
  path: string;
  inline: boolean;
}

/** Claude's change: before │ after side by side, or inline (phones), both read-only. */
export function mountMerge(host: HTMLElement, o: MergeOptions): { destroy(): void } {
  const root = shadowHost(host);
  const exts = (extra: Extension[] = []) => [base(true), EditorView.lineWrapping, ...extra];
  let destroy: () => void;
  if (o.inline) {
    const lang = new Compartment();
    const view = new EditorView({
      root,
      parent: root,
      state: EditorState.create({
        doc: o.modified,
        extensions: [exts(), lang.of([]), unifiedMergeView({ original: o.original, mergeControls: false, gutter: true, collapseUnchanged: { margin: 3, minSize: 6 } })],
      }),
    });
    void languageFor(o.path).then((ext) => ext && view.dispatch({ effects: lang.reconfigure(ext) }));
    destroy = () => view.destroy();
  } else {
    const la = new Compartment();
    const lb = new Compartment();
    const mv = new MergeView({
      root,
      parent: root,
      a: { doc: o.original, extensions: [exts(), la.of([])] },
      b: { doc: o.modified, extensions: [exts(), lb.of([])] },
      collapseUnchanged: { margin: 3, minSize: 6 },
      highlightChanges: true,
      gutter: true,
    });
    mv.dom.classList.add('bn-merge');
    void languageFor(o.path).then((ext) => {
      if (!ext) return;
      mv.a.dispatch({ effects: la.reconfigure(ext) });
      mv.b.dispatch({ effects: lb.reconfigure(ext) });
    });
    destroy = () => mv.destroy();
  }
  return { destroy };
}
