// The explorer: the project's folder (the Workspace: /workspace) as a lazily loaded tree (a folder is listed when first
// opened; paths stay the workspace's), rendered virtually (only
// the rows in view exist in the DOM, so a 5,000-entry folder stays fast). Files Claude changed in this session are
// marked A/M. Drop files on a folder to upload them there. Names come from the sandbox: shown as text.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import {
  store,
  collapseAll,
  deletePath,
  loadDir,
  makeDir,
  mention,
  newFile,
  openFile,
  renamePath,
  selectPath,
  toggleDir,
  uploadFiles,
  activeView,
  currentProject,
} from '../app';
import { downloadUrl } from '../api';
import { changedFiles } from '../session';
import type { FsEntry } from '../types';
import { basename, bytes, joinPath, readOnlyTopOf, visible } from '../text';
import { Icon, Spinner } from './icons';
import { copyText, Dialog, Dropdown, MenuItem, useMedia } from './ui';

interface Row {
  path: string;
  name: string;
  depth: number;
  entry: FsEntry | null; // null: a "loading" or "error" placeholder
  note?: string;
}

const EXT_CLASS: Record<string, string> = {
  ts: 'ft-ts', tsx: 'ft-ts', js: 'ft-js', jsx: 'ft-js', mjs: 'ft-js', cjs: 'ft-js', json: 'ft-json', py: 'ft-py', md: 'ft-md',
  html: 'ft-html', css: 'ft-css', scss: 'ft-css', yml: 'ft-yaml', yaml: 'ft-yaml', sh: 'ft-sh', bash: 'ft-sh', rs: 'ft-rs', go: 'ft-go',
  java: 'ft-java', c: 'ft-c', h: 'ft-c', cpp: 'ft-c', toml: 'ft-yaml', sql: 'ft-json', txt: 'ft-txt', lock: 'ft-txt',
};
function extClass(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? EXT_CLASS[name.slice(i + 1).toLowerCase()] ?? '' : name === 'Dockerfile' || name === 'Makefile' ? 'ft-sh' : '';
}

type Edit = { kind: 'newFile' | 'newDir'; dir: string } | { kind: 'rename'; path: string } | null;

export function FileTree({ onOpen }: { onOpen?: () => void }) {
  const dirs = useSel(store, (s) => s.fs.dirs);
  const expanded = useSel(store, (s) => s.fs.expanded);
  const selected = useSel(store, (s) => s.fs.selected);
  const view = useSel(store, (s) => activeView(s));
  const project = useSel(store, (s) => currentProject(s));
  const root = project.root;
  // (a folder of this computer added read-only: nothing made, renamed, uploaded or deleted from here)
  const ro = useSel(store, () => readOnlyTopOf(root));
  const roTitle = 'Read-only: a folder of this computer added read-only';
  const coarse = useMedia('(pointer: coarse)');
  const rowH = coarse ? 36 : 24;
  const [edit, setEdit] = useState<Edit>(null);
  const [editVal, setEditVal] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ top: 0, height: 600 });
  const upload = useRef<HTMLInputElement>(null);

  const marks = useMemo(() => changedFiles(view), [view?.items]);
  const markedDirs = useMemo(() => {
    const s = new Set<string>();
    for (const p of Object.keys(marks)) {
      let d = p;
      while (d.includes('/')) {
        d = d.slice(0, d.lastIndexOf('/'));
        s.add(d);
      }
    }
    return s;
  }, [marks]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const d = dirs[dir];
      if (edit && edit.kind !== 'rename' && edit.dir === dir) out.push({ path: '\u0000edit', name: '', depth, entry: null });
      if (!d) return;
      if (d.loading && !d.entries.length) out.push({ path: `${dir}\u0000loading`, name: '', depth, entry: null, note: 'loading' });
      if (d.error) out.push({ path: `${dir}\u0000error`, name: '', depth, entry: null, note: d.error });
      for (const e of d.entries) {
        const p = joinPath(dir, e.name);
        out.push({ path: p, name: e.name, depth, entry: e });
        if (e.type === 'dir' && expanded[p]) walk(p, depth + 1);
        if (out.length > 50_000) return;
      }
      if (d.truncated) out.push({ path: `${dir}\u0000more`, name: '', depth, entry: null, note: 'more' });
    };
    walk(root, 0);
    return out;
  }, [dirs, expanded, edit, root]);
  // (the project's folder listed when it is shown first)
  useEffect(() => {
    if (!store.get().fs.dirs[root]) void loadDir(root);
  }, [root]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWin({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(win.top / rowH) - 10);
  const last = Math.min(rows.length, Math.ceil((win.top + win.height) / rowH) + 10);

  const targetDir = (): string => {
    if (selected === null || (root && selected !== root && !selected.startsWith(`${root}/`))) return root;
    return dirs[selected] || store.get().fs.expanded[selected] ? selected : selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '';
  };

  const commitEdit = () => {
    const v = editVal.trim();
    const e = edit;
    setEdit(null);
    if (!e || !v || v.includes('/') || v === '.' || v === '..') return;
    if (e.kind === 'rename') void renamePath(e.path, v);
    else if (e.kind === 'newFile') void newFile(e.dir, v);
    else void makeDir(e.dir, v);
  };

  const startNew = (kind: 'newFile' | 'newDir', dir: string) => {
    if (dir && !store.get().fs.expanded[dir]) toggleDir(dir);
    setEditVal('');
    setEdit({ kind, dir });
  };

  const onDropFiles = (e: DragEvent, dir: string) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    setDrop(null);
    void uploadFiles([...e.dataTransfer.files], dir);
  };

  return (
    <div
      class={`tree${drop !== null ? ' drop-on' : ''}`}
      data-testid="file-tree"
      onDragOver={(e) => {
        if (!ro && e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          if (drop === null) setDrop(root);
        }
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrop(null);
      }}
      onDrop={(e) => !ro && onDropFiles(e, drop ?? root)}
    >
      <div class="side-tools tree-tools">
        <span class="side-title" title={project.path} data-testid="tree-title">{project.name}</span>
        <button type="button" class="icon-btn tiny" title={ro ? roTitle : 'New file'} aria-label="New file" disabled={!!ro} onClick={() => startNew('newFile', targetDir())}>
          <Icon name="newFile" size={15} />
        </button>
        <button type="button" class="icon-btn tiny" title={ro ? roTitle : 'New folder'} aria-label="New folder" disabled={!!ro} onClick={() => startNew('newDir', targetDir())}>
          <Icon name="newFolder" size={15} />
        </button>
        <button type="button" class="icon-btn tiny" title={ro ? roTitle : 'Upload files'} aria-label="Upload files" disabled={!!ro} onClick={() => upload.current?.click()}>
          <Icon name="upload" size={15} />
        </button>
        <button
          type="button"
          class="icon-btn tiny"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => {
            for (const p of Object.keys(store.get().fs.dirs)) if (p === root || (store.get().fs.expanded[p] && (!root || p.startsWith(`${root}/`)))) void loadDir(p);
          }}
        >
          <Icon name="refresh" size={15} />
        </button>
        <button type="button" class="icon-btn tiny" title="Collapse folders" aria-label="Collapse folders" onClick={collapseAll}>
          <Icon name="collapse" size={15} />
        </button>
        <input
          ref={upload}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            const files = [...(el.files ?? [])];
            el.value = '';
            void uploadFiles(files, targetDir());
          }}
        />
      </div>
      <div class="tree-scroll" ref={scroller} role="tree" aria-label={`${project.name}: files`} onScroll={(e) => setWin({ top: (e.currentTarget as HTMLElement).scrollTop, height: (e.currentTarget as HTMLElement).clientHeight })}>
        <div class="tree-space" ref={(el) => {
            if (el) el.style.height = `${rows.length * rowH}px`;
          }}>
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            const place = (el: HTMLElement | null) => {
              if (!el) return;
              el.style.top = `${i * rowH}px`;
              el.style.height = `${rowH}px`;
              el.style.paddingLeft = `${8 + r.depth * 14}px`;
            };
            if (r.path === '\u0000edit' || (edit?.kind === 'rename' && edit.path === r.path)) {
              return (
                <form
                  key={r.path}
                  class="tree-row tree-edit"
                  ref={place}
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitEdit();
                  }}
                >
                  <Icon name={edit?.kind === 'newDir' ? 'folder' : 'file'} size={15} />
                  <input
                    value={editVal}
                    maxLength={255}
                    aria-label={edit?.kind === 'newDir' ? 'Folder name' : 'File name'}
                    ref={(el) => {
                      if (el && document.activeElement !== el) el.focus();
                    }}
                    onInput={(e) => setEditVal((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => e.key === 'Escape' && setEdit(null)}
                    onBlur={commitEdit}
                  />
                </form>
              );
            }
            if (!r.entry) {
              return (
                <div key={r.path} class={`tree-row tree-note${r.note === 'loading' || r.note === 'more' ? '' : ' err'}`} ref={place} data-testid={r.note === 'more' ? 'tree-truncated' : undefined}>
                  {r.note === 'loading' ? <Spinner size={12} /> : <Icon name="alert" size={13} />}
                  <span>{r.note === 'loading' ? 'Loading…' : r.note === 'more' ? 'More entries than shown here (the terminal lists them all)' : r.note}</span>
                </div>
              );
            }
            const e = r.entry;
            const isDir = e.type === 'dir';
            const open = isDir && expanded[r.path];
            const mark = marks[r.path];
            return (
              <div
                key={r.path}
                ref={place}
                class={`tree-row${selected === r.path ? ' sel' : ''}${drop === r.path ? ' drop' : ''}`}
                role="treeitem"
                aria-expanded={isDir ? !!open : undefined}
                aria-selected={selected === r.path}
                title={`${visible(r.path)}${e.size !== null && !isDir ? ` · ${bytes(e.size)}` : ''}`}
                data-path={r.path}
                onClick={() => {
                  if (isDir) toggleDir(r.path);
                  else {
                    selectPath(r.path);
                    void openFile(r.path);
                    onOpen?.();
                  }
                }}
                onDragOver={(ev) => {
                  if (isDir && ev.dataTransfer?.types.includes('Files')) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setDrop(r.path);
                  }
                }}
                onDrop={(ev) => isDir && onDropFiles(ev, r.path)}
              >
                <span class="tree-chev">{isDir ? <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} /> : null}</span>
                <Icon name={isDir ? (open ? 'folderOpen' : 'folder') : 'file'} size={15} class={isDir ? 'ft-dir' : extClass(r.name)} />
                <span class={`tree-name${mark ? ' marked' : ''}`}>{visible(r.name)}</span>
                {e.type === 'symlink' && <span class="tree-tag">link</span>}
                {mark && <span class={`tree-mark m-${mark}`} title={mark === 'A' ? 'Created by Claude in this session' : 'Changed by Claude in this session'}>{mark}</span>}
                {isDir && !mark && markedDirs.has(r.path) && <span class="tree-dot" title="Contains files Claude changed" />}
                <Dropdown title={`Actions for ${visible(r.name)}`} class="tree-more" align="right" trigger={<Icon name="more" size={14} />}>
                  {(close) => (
                    <>
                      {!isDir && (
                        <MenuItem icon="file" onSelect={() => (close(), void openFile(r.path), onOpen?.())}>
                          Open
                        </MenuItem>
                      )}
                      <MenuItem icon="at" onSelect={() => (close(), mention(isDir ? `${r.path}/` : r.path))}>
                        Mention in chat
                      </MenuItem>
                      {isDir && !ro && (
                        <>
                          <MenuItem icon="newFile" onSelect={() => (close(), startNew('newFile', r.path))}>
                            New file here
                          </MenuItem>
                          <MenuItem icon="newFolder" onSelect={() => (close(), startNew('newDir', r.path))}>
                            New folder here
                          </MenuItem>
                        </>
                      )}
                      {!ro && (
                        <MenuItem icon="pencil" onSelect={() => (close(), setEditVal(r.name), setEdit({ kind: 'rename', path: r.path }))}>
                          Rename
                        </MenuItem>
                      )}
                      <MenuItem icon="copy" onSelect={() => (close(), void copyText(r.path))}>
                        Copy path
                      </MenuItem>
                      {!isDir && (
                        <MenuItem
                          icon="download"
                          onSelect={() => {
                            close();
                            const a = document.createElement('a');
                            a.href = downloadUrl(r.path);
                            a.download = basename(r.path);
                            a.rel = 'noopener';
                            a.click();
                          }}
                        >
                          Download
                        </MenuItem>
                      )}
                      {!ro && (
                        <MenuItem icon="trash" danger onSelect={() => (close(), setConfirmDel(r.path))}>
                          Delete
                        </MenuItem>
                      )}
                    </>
                  )}
                </Dropdown>
              </div>
            );
          })}
        </div>
        {drop !== null && (
          <div class="drop-hint">
            <Icon name="upload" size={18} /> Drop to upload into /workspace/{drop}
          </div>
        )}
      </div>
      {confirmDel !== null && (
        <Dialog title="Delete?" onClose={() => setConfirmDel(null)}>
          <p>
            Move <code>{confirmDel}</code> to <code>{project.path}/.bedrock-now-trash/</code>?
          </p>
          <div class="dlg-buttons">
            <button type="button" class="btn ghost" onClick={() => setConfirmDel(null)}>
              Cancel
            </button>
            <button
              type="button"
              class="btn danger"
              onClick={() => {
                const p = confirmDel;
                setConfirmDel(null);
                void deletePath(p);
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
