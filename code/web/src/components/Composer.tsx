// The prompt box, keyed like Claude Code: Enter sends, Shift+Enter is a new line, Esc stops Claude, Shift+Tab
// cycles the permission mode (Manual → Accept edits → Plan → Bypass → Auto, those two when allowed; the mode picker sits next to Send,
// as in the desktop app), ↑ in an empty box recalls the last prompt. "/" at the
// start opens the command palette (built-ins, skills, plugin commands from the session), "@" opens the file picker
// (what the explorer has listed, and from two characters on a search of the whole workspace). "# text" on one line
// adds a line to the project's CLAUDE.md. Images (paste, drop or 📎) become image blocks — scaled down to 1568 px on the long edge
// (what Claude reads anyway), at most as many as the backend takes; other files are uploaded into the workspace and
// @-mentioned. /clear, /reset and /new start a new session; /resume opens the session list.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, interrupt, sendPrompt, setMode, uploadFiles, knownPaths, loadDir, toast, promptWithComments, clearComments, removeComment, openReview, dropLinkDraft } from '../app';
import { commentLine } from '../review';
import { label } from '../text';
import { fsFind } from '../api';
import { findTrigger, mergeCommands, rankCommands, rankPaths, type Trigger } from '../palette';
import type { ImageBlock } from '../types';
import { nextMode } from '../modes';
import { bytes, cleanPath, dirname } from '../text';
import { Icon } from './icons';
import { ModePicker } from './Pickers';
import { Guards } from './Guards';
import { useMedia } from './ui';

interface Attachment {
  id: number;
  name: string;
  size: number;
  url: string;
  block: ImageBlock;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const history: string[] = [];
let attachId = 1;
/** Claude reads images at up to this many pixels on the long edge; larger ones only cost upload time */
export const MAX_EDGE = 1568;

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : '');
    };
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/** An image scaled down to MAX_EDGE on its long edge (same type; GIF becomes PNG), or the file itself. */
async function scaled(f: File): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return f;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(f);
  } catch {
    return f;
  }
  const long = Math.max(bmp.width, bmp.height);
  if (long <= MAX_EDGE) {
    bmp.close();
    return f;
  }
  const k = MAX_EDGE / long;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const type = f.type === 'image/gif' ? 'image/png' : f.type;
  return new Promise((resolve) => c.toBlob((b) => resolve(b ?? f), type, 0.9));
}

export function Composer({ footer }: { footer?: ComponentChildren }) {
  const view = useSel(store, (s) => (s.active ? s.views[s.active] : undefined));
  const conn = useSel(store, (s) => s.conn);
  const focusN = useSel(store, (s) => s.focusComposer);
  const insert = useSel(store, (s) => s.insert);
  const imageMax = useSel(store, (s) => s.server?.imageMax ?? 5 * 1024 * 1024);
  const maxImages = useSel(store, (s) => s.server?.maxImages ?? 4);
  const restore = useSel(store, (s) => s.restore);
  const allowBypass = useSel(store, (s) => s.server?.allowBypass === true);
  const allowAuto = useSel(store, (s) => s.server?.allowAuto === true);
  const narrow = useMedia('(max-width: 699.98px)');
  const dirs = useSel(store, (s) => s.fs.dirs);
  const comments = useSel(store, (s) => s.comments);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [pick, setPick] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hIndex, setHIndex] = useState(-1);
  // Enter pressed on a link's draft not yet read: the banner says again how to send it
  const [nudge, setNudge] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // the attachments as they are now (an await in addFiles must not count a stale list)
  const attsRef = useRef<Attachment[]>([]);
  attsRef.current = atts;

  // a prompt the backend refused (or a fork's prompt) comes back into an empty box — once: not again on a remount
  const restored = useRef(restore?.n ?? 0);
  useEffect(() => {
    if (!restore || restore.n === restored.current) return;
    restored.current = restore.n;
    setText((t) => (t.trim() ? t : restore.text));
  }, [restore?.n]);

  const busy = view?.state === 'busy' || view?.state === 'starting';

  useEffect(() => {
    if (focusN && matchMedia('(pointer: fine)').matches) ta.current?.focus();
  }, [focusN]);

  useEffect(() => {
    if (!insert) return;
    const el = ta.current;
    const at = el ? el.selectionStart : text.length;
    const before = text.slice(0, at);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    const next = before + sep + insert.text + text.slice(at);
    setText(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = (before + sep + insert.text).length;
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }, [insert?.n]);

  // autosize
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  }, [text]);

  const trigger: Trigger | null = useMemo(() => {
    const t = findTrigger(text, caret);
    return t && `${t.kind}:${t.from}` !== closedFor ? t : null;
  }, [text, caret, closedFor]);

  const commands = useMemo(() => mergeCommands(view?.commands ?? [], view?.init?.commands ?? []), [view?.commands, view?.init]);

  // for "@src/comp" make sure src/ is listed
  useEffect(() => {
    if (trigger?.kind !== 'mention') return;
    const slash = trigger.query.lastIndexOf('/');
    if (slash < 0) return;
    const dir = cleanPath(trigger.query.slice(0, slash));
    if (dir !== null && !store.get().fs.dirs[dir]) void loadDir(dir);
  }, [trigger?.kind, trigger?.query]);

  // from two characters on, the whole workspace is searched too (after a pause in typing)
  const [found, setFound] = useState<{ q: string; paths: string[]; error: string }>({ q: '', paths: [], error: '' });
  const mentionQuery = trigger?.kind === 'mention' ? trigger.query : '';
  useEffect(() => {
    if (mentionQuery.length < 2) return;
    let gone = false;
    const t = setTimeout(() => {
      fsFind(mentionQuery, 100).then(
        (r) => !gone && setFound({ q: mentionQuery, paths: r.paths, error: '' }),
        (e) => !gone && setFound({ q: mentionQuery, paths: [], error: e instanceof Error ? e.message : String(e) }),
      );
    }, 200);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [mentionQuery]);

  const options = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === 'slash') return rankCommands(commands, trigger.query).map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.argumentHint, desc: c.description }));
    const all = new Set(knownPaths(store.get()));
    if (trigger.query.length >= 2) for (const p of found.paths) all.add(p);
    return rankPaths([...all], trigger.query, 40).map((p) => ({ key: p, label: p, hint: '', desc: '' }));
  }, [trigger, commands, dirs, found]);

  useEffect(() => setPick(0), [trigger?.kind, trigger?.query]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o || !trigger) return;
    const ins = trigger.kind === 'slash' ? `/${o.key} ` : o.key.endsWith('/') ? `@${o.key}` : `@${o.key} `;
    const next = text.slice(0, trigger.from) + ins + text.slice(trigger.to);
    setText(next);
    const pos = trigger.from + ins.length;
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const addFiles = async (files: File[]) => {
    const images = files.filter((f) => IMAGE_TYPES.includes(f.type));
    const others = files.filter((f) => !IMAGE_TYPES.includes(f.type));
    for (const f of images) {
      if (attsRef.current.length >= maxImages) {
        toast(`At most ${maxImages} images per prompt.`, 'error');
        break;
      }
      try {
        const blob = await scaled(f);
        if (blob.size > imageMax) {
          toast(`${f.name || 'The image'} is over ${bytes(imageMax)} even scaled down; images are sent to Claude up to that size.`, 'error');
          continue;
        }
        const data = await readBase64(blob);
        const a = { id: attachId++, name: f.name || 'pasted image', size: blob.size, url: URL.createObjectURL(blob), block: { media_type: blob.type || f.type, data } };
        attsRef.current = [...attsRef.current, a];
        setAtts((x) => [...x, a]);
      } catch {
        toast('That image could not be read.', 'error');
      }
    }
    if (others.length) {
      const s = store.get();
      const sel = s.fs.selected;
      const dir = sel !== null && s.fs.dirs[sel] ? sel : sel ? dirname(sel) : '';
      const paths = await uploadFiles(others, dir);
      if (paths.length) setText((t) => `${t}${t && !/\s$/.test(t) ? ' ' : ''}${paths.map((p) => `@${p}`).join(' ')} `);
    }
  };

  const removeAtt = (id: number) =>
    setAtts((a) => {
      const x = a.find((y) => y.id === id);
      if (x) URL.revokeObjectURL(x.url);
      return a.filter((y) => y.id !== id);
    });

  const submit = async () => {
    const t = text.trim();
    if (!t && !atts.length && !comments.length) return;
    const blocks = atts.map((a) => a.block);
    // the Review pane's line comments go with a prompt for Claude ("path:line — comment"); they leave the box once sent
    const withNotes = promptWithComments(t || (atts.length ? 'What is in this image?' : ''));
    const ok = await sendPrompt(withNotes.text, blocks);
    if (!ok) return;
    if (withNotes.ids.length) clearComments(withNotes.ids);
    if (t) {
      history.push(t);
      if (history.length > 50) history.shift();
    }
    for (const a of atts) URL.revokeObjectURL(a.url);
    setAtts([]);
    setText('');
    setHIndex(-1);
    setClosedFor(null);
  };

  const onKey = (e: KeyboardEvent) => {
    const el = e.currentTarget as HTMLTextAreaElement;
    if (trigger && options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((p) => (e.key === 'ArrowDown' ? (p + 1) % options.length : (p - 1 + options.length) % options.length));
        return;
      }
      // Enter on a command already typed in full runs it (like the CLI); otherwise Enter/Tab complete
      const exact = e.key === 'Enter' && trigger.kind === 'slash' && options[pick]?.key === trigger.query;
      if ((e.key === 'Enter' || e.key === 'Tab') && !exact) {
        if (!(e.key === 'Enter' && e.shiftKey)) {
          e.preventDefault();
          choose(pick);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setClosedFor(`${trigger.kind}:${trigger.from}`);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // a held Enter repeats: it never sends (one prompt per press)
      if (e.repeat) return;
      // a link's draft: Enter does not send it until you said you read it ("I have read it") — the Send button does
      const ld = store.get().linkDraft;
      if (ld && !ld.ack) {
        setNudge((n) => n + 1);
        return;
      }
      void submit();
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault();
      interrupt();
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      // (from the store, not this render: presses in a row each see the mode the one before set; while a switch is
      // on its way the last one pressed goes next)
      const st = store.get();
      const cur = (st.active ? st.views[st.active]?.mode : undefined) ?? st.startWith ?? st.prefs.mode;
      setMode(nextMode(cur, allowBypass, allowAuto));   // (into Bypass: its confirmation first)
    } else if (e.key === 'ArrowUp' && (el.value === '' || hIndex >= 0) && history.length && el.selectionStart === 0) {
      e.preventDefault();
      const i = hIndex < 0 ? history.length - 1 : Math.max(0, hIndex - 1);
      setHIndex(i);
      setText(history[i]);
    } else if (e.key === 'ArrowDown' && hIndex >= 0) {
      e.preventDefault();
      const i = hIndex + 1;
      if (i >= history.length) {
        setHIndex(-1);
        setText('');
      } else {
        setHIndex(i);
        setText(history[i]);
      }
    }
  };

  return (
    <div
      class={`composer${dragging ? ' dragging' : ''}`}
      data-testid="composer"
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      {trigger && options.length > 0 && (
        <div class="palette" role="listbox" aria-label={trigger.kind === 'slash' ? 'Commands' : 'Files'} data-testid="palette">
          <div class="palette-head">
            {trigger.kind === 'slash' ? 'Commands, skills and plugin commands' : 'Files in /workspace'}
            {trigger.kind === 'mention' && found.error && found.q === trigger.query && <span class="muted"> · search failed: {found.error}</span>}
          </div>
          {options.map((o, i) => (
            <button
              key={o.key}
              type="button"
              role="option"
              aria-selected={i === pick}
              class={`palette-item${i === pick ? ' on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
              ref={(el) => {
                if (el && i === pick) el.scrollIntoView({ block: 'nearest' });
              }}
            >
              <span class="palette-label">{o.label}</span>
              {o.hint && <span class="palette-hint">{o.hint}</span>}
              {o.desc && <span class="palette-desc">{o.desc}</span>}
            </button>
          ))}
        </div>
      )}
      {comments.length > 0 && (
        <div class="cmt-chips" data-testid="comment-chips" aria-label="Comments on the changes, sent with your next prompt">
          {comments.map((c) => (
            <span class="chip cmt-chip" key={c.id} title={commentLine(c)} data-testid="comment-chip">
              <button type="button" class="cmt-chip-main" onClick={openReview} title="Show the Review pane">
                <Icon name="comment" size={12} />
                <span class="cmt-chip-text">{label(commentLine(c), 160)}</span>
              </button>
              <button type="button" class="att-x" aria-label={`Remove the comment on ${c.path}:${c.line}`} onClick={() => removeComment(c.id)} data-testid="comment-chip-remove">
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {atts.length > 0 && (
        <div class="atts">
          {atts.map((a) => (
            <div class="att" key={a.id} title={`${a.name} · ${bytes(a.size)}`}>
              <img src={a.url} alt={a.name} />
              <button type="button" class="att-x" aria-label={`Remove ${a.name}`} onClick={() => removeAtt(a.id)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <Guards onClear={() => setText('')} nudge={nudge} />
      <div class="composer-box">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={busy ? 'Claude is working — type to queue a message, Esc to stop' : 'Ask Claude to build, fix or explain…  / commands · @ files'}
          aria-label="Message Claude"
          data-testid="prompt"
          onInput={(e) => {
            const el = e.currentTarget as HTMLTextAreaElement;
            setText(el.value);
            // (a link's draft deleted by hand: put away)
            if (!el.value.trim() && store.get().linkDraft) dropLinkDraft();
            setCaret(el.selectionStart);
            setHIndex(-1);
          }}
          onKeyDown={onKey}
          onKeyUp={(e) => setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart)}
          onClick={(e) => setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart)}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
        />
        <div class="composer-bar">
          <button type="button" class="icon-btn" title="Attach images or upload files" aria-label="Attach" onClick={() => fileInput.current?.click()}>
            <Icon name="clip" />
          </button>
          <button
            type="button"
            class="icon-btn"
            title="Mention a file (@)"
            aria-label="Mention a file"
            onClick={() => {
              const el = ta.current;
              const at = el?.selectionStart ?? text.length;
              const pre = text.slice(0, at);
              const ins = (pre && !/\s$/.test(pre) ? ' ' : '') + '@';
              setText(pre + ins + text.slice(at));
              const pos = at + ins.length;
              requestAnimationFrame(() => {
                el?.focus();
                el?.setSelectionRange(pos, pos);
                setCaret(pos);
              });
            }}
          >
            <Icon name="at" />
          </button>
          <button
            type="button"
            class="icon-btn"
            title="Commands (/)"
            aria-label="Commands"
            onClick={() => {
              if (!text.startsWith('/')) setText('/' + text);
              setClosedFor(null);
              requestAnimationFrame(() => {
                ta.current?.focus();
                ta.current?.setSelectionRange(1, 1);
                setCaret(1);
              });
            }}
          >
            <Icon name="slash" />
          </button>
          <div class="composer-extra">{footer}</div>
          {conn !== 'open' && <span class="composer-conn">reconnecting…</span>}
          <ModePicker compact={narrow} />
          {busy ? (
            <button type="button" class="send stop" title="Stop (Esc)" aria-label="Stop" onClick={interrupt} data-testid="stop">
              <Icon name="stop" />
            </button>
          ) : null}
          <button
            type="button"
            class="send"
            title="Send (Enter)"
            aria-label="Send"
            disabled={!text.trim() && !atts.length && !comments.length}
            onClick={() => void submit()}
            data-testid="send"
          >
            <Icon name="send" />
          </button>
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(e) => {
          const el = e.currentTarget as HTMLInputElement;
          const files = [...(el.files ?? [])];
          el.value = '';
          void addFiles(files);
        }}
      />
    </div>
  );
}
