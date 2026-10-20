// Editor tabs: files open in CodeMirror (save with Ctrl/⌘-S, guarded by the file's mtime: a file that changed on
// disk is not overwritten silently), and Claude's edits open as a diff (before │ after). Every tab keeps its
// editor alive while open, so switching tabs keeps undo history and scroll position. Files that can be previewed
// (src/preview: Markdown, images, SVG, audio, video, PDF, CSV, JSON, YAML) open in Preview, with Source (the editor)
// one click away, and Split for Markdown (the preview follows your unsaved edits).
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, closeTab, setActiveTab, saveFile, reloadFile, markDirty, setCursor, openFile, openDiff, setPrefs, keepMine, toast, type Tab, type FileTab, type DiffTab } from '../app';
import { addLines, insertIntoPrompt } from '../attach';
import { RANGE_MAX, lineToken } from '../mentions';
import * as api from '../api';
import { countChanges, hunkLines } from '../diff';
import { basename, bytes, dirname, label, readOnlyTopOf } from '../text';
import { SandboxSaid } from './Said';
import { downloadUrl } from '../api';
import type { EditorHandle } from '../editor/cm';
import { Icon, Spinner } from './icons';
import { DiffLines } from './ToolCard';
import { useMedia } from './ui';
import { Preview, PreviewBar } from '../preview/Preview';
import { PreviewPane } from './DevPreview';
import { ReviewPane, useReviewList } from './Review';
import { GitDiffPane } from './GitPanel';
import { shortcuts } from '../shortcuts';

let cmPromise: Promise<typeof import('../editor/cm')> | null = null;
function loadCm() {
  cmPromise ??= import('../editor/cm');
  return cmPromise;
}

/** The live editors by tab key (the save button and conflict actions need their text). */
const editors = new Map<string, EditorHandle>();

/** The active file's selected lines as an @mention (Alt+K, the editor's "Add to prompt", the palette): a chip with
 *  those lines as the editor has them, and @path#L5-10 in the prompt box. -> whether there was an editor. */
export function mentionSelection(key?: string): boolean {
  const s = store.get();
  const tab = s.tabs.find((t) => t.key === (key ?? s.activeTab));
  const h = tab && tab.kind === 'file' ? editors.get(tab.key) : undefined;
  if (!tab || tab.kind !== 'file' || !h) {
    toast('Open a file in the editor and select some lines first (then Alt+K).');
    return false;
  }
  const sel = h.selectedLines();
  const to = Math.min(sel.to, sel.from + RANGE_MAX - 1);
  const text = to < sel.to ? sel.text.split('\n').slice(0, to - sel.from + 1).join('\n') : sel.text;
  if (to < sel.to) toast(`At most ${RANGE_MAX} lines go with one mention: lines ${sel.from}–${to}.`);
  void addLines(tab.path, sel.from, to, { text, total: sel.total, unsaved: tab.dirty });
  insertIntoPrompt(`${lineToken(tab.path, sel.from, to)} `);
  return true;
}

/** Save a file tab from its editor; on success the editor's clean state moves to what was written. */
export async function saveTab(key: string, force = false): Promise<void> {
  const h = editors.get(key);
  if (!h) return;
  const text = h.getText();
  if (await saveFile(key, text, force)) h.markSaved(text);
}

function FilePane({ tab, active }: { tab: FileTab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const seen = useRef(-1);
  const phone = useMedia('(max-width: 699.98px)');
  const [readOnly, setReadOnly] = useState(phone);
  // (a file in a folder of this computer added read-only: shown, never changed from here)
  const locked = useSel(store, () => readOnlyTopOf(tab.path));
  const [failed, setFailed] = useState<string | null>(null);
  // (Split needs two columns: on a phone it shows the preview)
  const view = !tab.preview ? 'source' : phone && tab.view === 'split' ? 'preview' : tab.view;
  const canMount = !tab.loading && !tab.binary && tab.saved !== null;
  // a search hit to show: once the editor is there (and again for each new request)
  const [mounted, setMounted] = useState(0);
  const revealed = useRef(0);
  useEffect(() => {
    const r = tab.reveal;
    const h = editors.get(tab.key);
    if (!r || !h || r.n === revealed.current || tab.version !== seen.current) return;
    revealed.current = r.n;
    requestAnimationFrame(() => h.reveal(r.line, r.col, r.len));
  }, [tab.reveal?.n, mounted, tab.version]);
  // the lines selected in the editor (its "Add to prompt" button)
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null);
  // the editor's text while it differs from the file (the preview shows your unsaved edits)
  const [live, setLive] = useState<string | null>(null);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChange = () => {
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      const h = editors.get(tab.key);
      if (h) setLive(h.getText());
    }, 250);
  };
  useEffect(() => () => void (liveTimer.current && clearTimeout(liveTimer.current)), []);

  useEffect(() => {
    // previews mount the editor when it is first shown (Source or Split)
    if (!canMount || view === 'preview' || editors.has(tab.key)) return;
    let dead = false;
    loadCm().then(
      (cm) => {
        if (dead || !host.current || editors.has(tab.key)) return;
        seen.current = tab.version;
        const h = cm.mountEditor(host.current, {
          text: tab.saved ?? '',
          path: tab.path,
          readOnly: readOnly || tab.truncated || !!locked,
          onDirty: (d) => markDirty(tab.key, d),
          onSave: () => void saveTab(tab.key),
          onCursor: (line, col) => setCursor({ line, col, lang: h.language }),
          onChange,
          onSelect: (l) => setSel((x) => (l === null ? null : x && x.from === l.from && x.to === l.to ? x : l)),
        });
        editors.set(tab.key, h);
        setCursor({ line: 1, col: 1, lang: h.language });
        setMounted((n) => n + 1);
      },
      () => setFailed('The editor could not be loaded. Reload the page to try again.'),
    );
    return () => {
      dead = true;
    };
  }, [canMount, tab.key, view === 'preview']);

  useEffect(
    () => () => {
      editors.get(tab.key)?.destroy();
      editors.delete(tab.key);
    },
    [tab.key],
  );

  useEffect(() => {
    const h = editors.get(tab.key);
    if (h && tab.version !== seen.current && tab.saved !== null) {
      seen.current = tab.version;
      h.setText(tab.saved);
    }
    setLive(null);
  }, [tab.version]);

  useEffect(() => {
    editors.get(tab.key)?.setReadOnly(readOnly || tab.truncated || !!locked);
  }, [readOnly, tab.truncated, locked]);

  useEffect(() => {
    const h = editors.get(tab.key);
    if (active && h && view !== 'preview') setCursor({ line: 1, col: 1, lang: h.language });
    else if (active) setCursor(null); // a preview: no cursor to show
  }, [active, view]);

  const compare = async () => {
    const mine = editors.get(tab.key)?.getText() ?? '';
    try {
      const disk = await api.fsRead(tab.path);
      openDiff(`cmp-${Date.now()}`, tab.path, disk.text ?? '', [], mine);
    } catch (e) {
      void e;
    }
  };

  return (
    <div class={`pane${active ? '' : ' hidden'}`} data-testid="file-pane" data-path={tab.path}>
      {tab.conflict && (
        <div class="banner warn" role="alert" data-testid="conflict">
          <Icon name="alert" size={15} />
          <span>{tab.conflict === 'disk' ? 'This file changed on disk since you opened it. Your save was not written.' : 'This file changed (Claude, or a command) while you had unsaved changes.'}</span>
          <span class="banner-actions">
            {tab.conflict === 'disk' && (
              <button type="button" class="btn small" onClick={() => void saveTab(tab.key, true)} data-testid="overwrite">
                Overwrite
              </button>
            )}
            <button type="button" class="btn small" onClick={() => reloadFile(tab.key)} data-testid="reload">
              {tab.conflict === 'disk' ? 'Reload from disk' : 'Take the new version'}
            </button>
            {tab.conflict === 'claude' && (
              <button type="button" class="btn small" onClick={() => void keepMine(tab.key)} data-testid="keep-mine">
                Keep mine
              </button>
            )}
            <button type="button" class="btn small ghost" onClick={() => void compare()}>
              Compare
            </button>
          </span>
        </div>
      )}
      {tab.truncated && view !== 'preview' && (
        <div class="banner">
          <Icon name="alert" size={15} />
          <span>Only the first part of this file ({bytes(tab.size)} in all) is shown, read-only.</span>
        </div>
      )}
      {locked && (
        <div class="banner subtle" data-testid="file-read-only">
          <Icon name="eye" size={15} />
          <span>Read-only: {label(locked, 200)} is a folder of this computer listed read-only (Settings › Claude Code › Project folders).</span>
        </div>
      )}
      {phone && canMount && !tab.truncated && !locked && view !== 'preview' && (
        <div class="banner subtle">
          <span>{readOnly ? 'Read-only on this screen.' : 'Editing.'}</span>
          <span class="banner-actions">
            <button type="button" class="btn small" onClick={() => setReadOnly(!readOnly)}>
              {readOnly ? 'Edit' : 'Done'}
            </button>
            {!readOnly && (
              <button type="button" class="btn small primary" onClick={() => void saveTab(tab.key)}>
                Save
              </button>
            )}
          </span>
        </div>
      )}
      {tab.loading && !editors.has(tab.key) ? (
        <div class="pane-msg">
          <Spinner /> Loading {basename(tab.path)}…
        </div>
      ) : tab.error ? (
        <div class="pane-msg err">
          <Icon name="alert" /> {tab.error}
          {tab.said && <SandboxSaid words={tab.said} />}
          <button type="button" class="btn small" onClick={() => reloadFile(tab.key)}>
            Retry
          </button>
        </div>
      ) : tab.binary && !tab.preview ? (
        <div class="pane-msg">
          <Icon name="file" size={28} />
          <div>
            <strong>{basename(tab.path)}</strong> is a binary file ({bytes(tab.size)}); it is not shown in the editor.
          </div>
          <a class="btn small" href={downloadUrl(tab.path)} download={basename(tab.path)} rel="noopener">
            <Icon name="download" size={14} /> Download
          </a>
        </div>
      ) : failed ? (
        <div class="pane-msg err">{failed}</div>
      ) : null}
      {tab.preview && !tab.loading && !tab.error && <PreviewBar tab={tab} phone={phone} />}
      <div class={`file-body v-${view}`}>
        {tab.preview && view !== 'source' && !tab.error && !(tab.loading && tab.saved === null) && (
          <div class="pv-host" data-testid="preview" data-kind={tab.preview.kind}>
            <Preview tab={tab} text={live ?? tab.saved} phone={phone} active={active} />
          </div>
        )}
        <div class={`cm-host${view === 'preview' ? ' hidden' : ''}`} ref={host} />
        {sel && view !== 'preview' && (
          <button
            type="button"
            class="btn small sel-mention"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => mentionSelection(tab.key)}
            title="Add the selected lines to the prompt as @path#L… (Alt+K): they go with your next prompt, quoted"
            data-testid="mention-selection"
          >
            <Icon name="at" size={13} /> {sel.from === sel.to ? `Line ${sel.from}` : `Lines ${sel.from}–${sel.to}`} to the prompt <kbd>Alt+K</kbd>
          </button>
        )}
      </div>
    </div>
  );
}

function DiffPane({ tab, active }: { tab: DiffTab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const phone = useMedia('(max-width: 699.98px)');
  const narrow = useMedia('(max-width: 1099.98px)');
  const prefInline = useSel(store, (s) => s.prefs.diffInline);
  // tablets show half a screen of editor: inline unless the page asks for side by side
  const inline = phone || (narrow ? !prefInline : prefInline);
  const { add, del } = tab.modified !== null && tab.hunks.length === 0 ? { add: 0, del: 0 } : countChanges(tab.hunks);

  useEffect(() => {
    if (tab.modified === null || !host.current) return;
    let handle: { destroy(): void } | null = null;
    let dead = false;
    loadCm().then((cm) => {
      if (dead || !host.current) return;
      handle = cm.mountMerge(host.current, { original: tab.original, modified: tab.modified ?? '', path: tab.path, inline });
    });
    return () => {
      dead = true;
      handle?.destroy();
    };
  }, [tab.key, inline]);

  return (
    <div class={`pane${active ? '' : ' hidden'}`} data-testid="diff-pane">
      <div class="diff-head">
        <Icon name="diff" size={15} />
        <span class="diff-path">{label(tab.path, 400)}</span>
        {(add > 0 || del > 0) && (
          <span class="chg">
            {add > 0 && <span class="chg-add">+{add}</span>}
            {del > 0 && <span class="chg-del">−{del}</span>}
          </span>
        )}
        <span class="diff-sides muted">{inline ? 'Inline' : 'Before │ After'}</span>
        <span class="banner-actions">
          {!phone && (
            <button type="button" class="btn small ghost" onClick={() => setPrefs((p) => ({ ...p, diffInline: !p.diffInline }))}>
              {inline ? 'Side by side' : 'Inline'}
            </button>
          )}
          <button type="button" class="btn small" onClick={() => void openFile(tab.path)}>
            <Icon name="file" size={14} /> Open file
          </button>
        </span>
      </div>
      {tab.modified === null ? (
        <div class="diff-fallback">
          <div class="banner subtle">The change no longer applies to the file as it was; showing the change itself.</div>
          <DiffLines lines={hunkLines(tab.hunks)} max={2000} />
        </div>
      ) : (
        <div class="cm-host" ref={host} />
      )}
    </div>
  );
}

function ReviewTitle() {
  const n = useReviewList().pending.length;
  return (
    <>
      <Icon name="diff" size={14} class="tab-diff" />
      <span class="tab-name">Review</span>
      {n > 0 && <span class="badge">{n}</span>}
    </>
  );
}

function TabTitle({ tab, all }: { tab: Tab; all: Tab[] }) {
  if (tab.kind === 'review') return <ReviewTitle />;
  if (tab.kind === 'gitdiff') {
    return (
      <>
        <Icon name="branch" size={14} class="tab-diff" />
        <span class="tab-name">{label(basename(tab.path), 120)}</span>
        <span class="tab-dir">{tab.scope === 'staged' ? 'staged' : tab.scope === 'untracked' ? 'new' : 'changes'}</span>
      </>
    );
  }
  if (tab.kind === 'devserver') {
    return (
      <>
        <Icon name="window" size={14} class="tab-preview" />
        <span class="tab-name">:{tab.port}</span>
        <span class="tab-dir">preview</span>
      </>
    );
  }
  const name = label(basename(tab.path), 120);
  const dup = all.filter((t) => basename(t.path) === name && t.kind === tab.kind).length > 1;
  return (
    <>
      <Icon name={tab.kind === 'diff' ? 'diff' : 'file'} size={14} class={tab.kind === 'diff' ? 'tab-diff' : ''} />
      <span class="tab-name">{name}</span>
      {tab.kind === 'diff' && <span class="tab-dir">diff</span>}
      {dup && dirname(tab.path) && <span class="tab-dir">{label(dirname(tab.path), 120)}</span>}
    </>
  );
}

export function EditorTabs() {
  const tabs = useSel(store, (s) => s.tabs);
  const active = useSel(store, (s) => s.activeTab);
  const bar = useRef<HTMLDivElement>(null);
  // the active tab is always in view (opening a file or switching to one off the edge of the strip)
  useEffect(() => {
    bar.current?.querySelector('.etab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);
  return (
    <div class="tabs-bar" role="tablist" aria-label="Open files" ref={bar}>
      {tabs.map((t) => (
        <div
          key={t.key}
          class={`etab${t.key === active ? ' on' : ''}${t.kind === 'file' && t.dirty ? ' dirty' : ''}`}
          role="tab"
          aria-selected={t.key === active}
          title={t.kind === 'devserver' ? `Preview of localhost:${t.port} in the sandbox` : t.kind === 'review' ? 'Review the changes' : t.path}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeTab(t.key);
            }
          }}
        >
          <button type="button" class="etab-main" onClick={() => setActiveTab(t.key)}>
            <TabTitle tab={t} all={tabs} />
          </button>
          <button type="button" class="etab-x" title="Close" aria-label={`Close ${t.kind === 'devserver' ? `the preview of :${t.port}` : t.kind === 'review' ? 'the review' : basename(t.path)}`} onClick={() => closeTab(t.key)}>
            <span class="etab-dot" aria-hidden="true" />
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function EditorPanes() {
  const tabs = useSel(store, (s) => s.tabs);
  const active = useSel(store, (s) => s.activeTab);
  if (!tabs.length) return <EditorWelcome />;
  return (
    <div class="panes">
      {tabs.map((t) =>
        t.kind === 'file' ? <FilePane key={t.key} tab={t} active={t.key === active} />
          : t.kind === 'devserver' ? <PreviewPane key={t.key} tab={t} active={t.key === active} />
            : t.kind === 'review' ? <ReviewPane key={t.key} active={t.key === active} />
              : t.kind === 'gitdiff' ? <GitDiffPane key={t.key} tab={t} active={t.key === active} />
                : <DiffPane key={t.key} tab={t} active={t.key === active} />,
      )}
    </div>
  );
}

export function saveActiveTab(): void {
  const k = store.get().activeTab;
  if (k && editors.has(k)) void saveTab(k);
}

export { MOD } from '../shortcuts';

function EditorWelcome() {
  const rows: [string, string][] = shortcuts().filter((k) => k.welcome).map((k) => [k.what, k.keys]);
  return (
    <div class="editor-welcome" data-testid="editor-welcome">
      <div class="welcome-mark big">
        <Icon name="code" size={34} />
      </div>
      <p class="muted">Open a file from the explorer, or let Claude change something and open its diff.</p>
      <dl class="keys">
        {rows.map(([a, b]) => (
          <div key={a}>
            <dt>{a}</dt>
            <dd>
              <kbd>{b}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
