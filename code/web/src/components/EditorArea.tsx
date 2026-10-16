// Editor tabs: files open in CodeMirror (save with Ctrl/⌘-S, guarded by the file's mtime: a file that changed on
// disk is not overwritten silently), and Claude's edits open as a diff (before │ after). Every tab keeps its
// editor alive while open, so switching tabs keeps undo history and scroll position.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, closeTab, setActiveTab, saveFile, reloadFile, markDirty, setCursor, openFile, openDiff, setPrefs, type Tab, type FileTab, type DiffTab } from '../app';
import * as api from '../api';
import { countChanges, hunkLines } from '../diff';
import { basename, bytes, dirname, label } from '../text';
import { downloadUrl } from '../api';
import type { EditorHandle } from '../editor/cm';
import { Icon, Spinner } from './icons';
import { DiffLines } from './ToolCard';
import { useMedia } from './ui';

let cmPromise: Promise<typeof import('../editor/cm')> | null = null;
function loadCm() {
  cmPromise ??= import('../editor/cm');
  return cmPromise;
}

/** The live editors by tab key (the save button and conflict actions need their text). */
const editors = new Map<string, EditorHandle>();

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
  const [failed, setFailed] = useState<string | null>(null);
  const canMount = !tab.loading && !tab.binary && tab.saved !== null;

  useEffect(() => {
    if (!canMount || editors.has(tab.key)) return;
    let dead = false;
    loadCm().then(
      (cm) => {
        if (dead || !host.current || editors.has(tab.key)) return;
        seen.current = tab.version;
        const h = cm.mountEditor(host.current, {
          text: tab.saved ?? '',
          path: tab.path,
          readOnly: readOnly || tab.truncated,
          onDirty: (d) => markDirty(tab.key, d),
          onSave: () => void saveTab(tab.key),
          onCursor: (line, col) => setCursor({ line, col, lang: h.language }),
        });
        editors.set(tab.key, h);
        setCursor({ line: 1, col: 1, lang: h.language });
      },
      () => setFailed('The editor could not be loaded. Reload the page to try again.'),
    );
    return () => {
      dead = true;
    };
  }, [canMount, tab.key]);

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
  }, [tab.version]);

  useEffect(() => {
    editors.get(tab.key)?.setReadOnly(readOnly || tab.truncated);
  }, [readOnly, tab.truncated]);

  useEffect(() => {
    const h = editors.get(tab.key);
    if (active && h) setCursor({ line: 1, col: 1, lang: h.language });
  }, [active]);

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
          <span>{tab.conflict === 'disk' ? 'This file changed on disk since you opened it. Your save was not written.' : 'Claude changed this file while you had unsaved changes.'}</span>
          <span class="banner-actions">
            {tab.conflict === 'disk' && (
              <button type="button" class="btn small" onClick={() => void saveTab(tab.key, true)} data-testid="overwrite">
                Overwrite
              </button>
            )}
            <button type="button" class="btn small" onClick={() => reloadFile(tab.key)} data-testid="reload">
              {tab.conflict === 'disk' ? 'Reload from disk' : "Take Claude's version"}
            </button>
            <button type="button" class="btn small ghost" onClick={() => void compare()}>
              Compare
            </button>
          </span>
        </div>
      )}
      {tab.truncated && (
        <div class="banner">
          <Icon name="alert" size={15} />
          <span>Only the first part of this file ({bytes(tab.size)} in all) is shown, read-only.</span>
        </div>
      )}
      {phone && canMount && !tab.truncated && (
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
          <button type="button" class="btn small" onClick={() => reloadFile(tab.key)}>
            Retry
          </button>
        </div>
      ) : tab.binary ? (
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
      <div class="cm-host" ref={host} />
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

function TabTitle({ tab, all }: { tab: Tab; all: Tab[] }) {
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
  return (
    <div class="tabs-bar" role="tablist" aria-label="Open files">
      {tabs.map((t) => (
        <div
          key={t.key}
          class={`etab${t.key === active ? ' on' : ''}${t.kind === 'file' && t.dirty ? ' dirty' : ''}`}
          role="tab"
          aria-selected={t.key === active}
          title={t.path}
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
          <button type="button" class="etab-x" title="Close" aria-label={`Close ${basename(t.path)}`} onClick={() => closeTab(t.key)}>
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
      {tabs.map((t) => (t.kind === 'file' ? <FilePane key={t.key} tab={t} active={t.key === active} /> : <DiffPane key={t.key} tab={t} active={t.key === active} />))}
    </div>
  );
}

export function saveActiveTab(): void {
  const k = store.get().activeTab;
  if (k && editors.has(k)) void saveTab(k);
}

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = mac ? '⌘' : 'Ctrl';

function EditorWelcome() {
  const rows: [string, string][] = [
    ['Send to Claude', 'Enter'],
    ['New line', 'Shift+Enter'],
    ['Stop Claude', 'Esc'],
    ['Cycle permission mode', 'Shift+Tab'],
    ['Save file', `${MOD}+S`],
    ['Toggle terminal', 'Ctrl+`'],
    ['Toggle explorer', `${MOD}+B`],
    ['Find in file', `${MOD}+F`],
  ];
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
