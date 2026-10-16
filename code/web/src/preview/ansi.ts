// Terminal colours in notebook output (streams, tracebacks): ANSI SGR sequences (ESC [ … m) → styled runs of text;
// every other escape sequence (cursor moves, OSC titles and links, …) is dropped, never shown or acted on. A carriage
// return rewrites its line as a terminal would (progress bars), a backspace removes the character before it. One pass,
// no regular expressions: linear in the text, whatever it holds (it runs on the page's main thread).

export interface Run {
  text: string;
  /** classes: ansi-b(old), ansi-i(talic), ansi-u(nderline), ansi-fg0..15, ansi-bg0..15 */
  cls: string;
  /** 256-colour and true-colour values (CSSOM, never a style attribute) */
  fg?: string;
  bg?: string;
}

const CUBE = [0, 95, 135, 175, 215, 255];
function color256(n: number): string | number {
  if (n < 16) return n;
  if (n < 232) {
    const k = n - 16;
    return `rgb(${CUBE[Math.floor(k / 36)]},${CUBE[Math.floor(k / 6) % 6]},${CUBE[k % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/** Apply carriage returns (a line's text after its last lone \r wins, as on a terminal) and backspaces. */
export function overwrite(s: string): string {
  if (s.indexOf('\r') < 0 && s.indexOf('\b') < 0) return s;
  const out: string[] = [];
  let line: string[] = [];
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') {
      out.push(line.join(''), '\n');
      line = [];
      col = 0;
    } else if (c === '\r') {
      if (s[i + 1] === '\n') continue;
      col = 0;
    } else if (c === '\b') {
      if (col > 0) col--;
    } else {
      line[col++] = c;
      // a write in the middle of a line keeps what lies after it (as on a terminal)
    }
  }
  out.push(line.join(''));
  return out.join('');
}

export function ansiRuns(input: string, maxRuns = 20_000): Run[] {
  const s = overwrite(input);
  const runs: Run[] = [];
  let bold = false;
  let italic = false;
  let under = false;
  let fg: string | number | null = null;
  let bg: string | number | null = null;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const cls = [bold && 'ansi-b', italic && 'ansi-i', under && 'ansi-u', typeof fg === 'number' && `ansi-fg${fg}`, typeof bg === 'number' && `ansi-bg${bg}`].filter(Boolean).join(' ');
    const last = runs[runs.length - 1];
    const r: Run = { text: buf, cls };
    if (typeof fg === 'string') r.fg = fg;
    if (typeof bg === 'string') r.bg = bg;
    if (last && last.cls === r.cls && last.fg === r.fg && last.bg === r.bg) last.text += buf;
    else if (runs.length < maxRuns) runs.push(r);
    else last.text += buf;
    buf = '';
  };
  const sgr = (params: number[]) => {
    if (!params.length) params = [0];
    for (let k = 0; k < params.length; k++) {
      const p = params[k];
      if (p === 0) [bold, italic, under, fg, bg] = [false, false, false, null, null];
      else if (p === 1) bold = true;
      else if (p === 3) italic = true;
      else if (p === 4) under = true;
      else if (p === 22) bold = false;
      else if (p === 23) italic = false;
      else if (p === 24) under = false;
      else if (p >= 30 && p <= 37) fg = p - 30;
      else if (p === 39) fg = null;
      else if (p >= 40 && p <= 47) bg = p - 40;
      else if (p === 49) bg = null;
      else if (p >= 90 && p <= 97) fg = p - 90 + 8;
      else if (p >= 100 && p <= 107) bg = p - 100 + 8;
      else if ((p === 38 || p === 48) && params[k + 1] === 5 && k + 2 < params.length) {
        const c = color256(Math.min(255, params[k + 2]));
        if (p === 38) fg = c;
        else bg = c;
        k += 2;
      } else if ((p === 38 || p === 48) && params[k + 1] === 2 && k + 4 < params.length) {
        const c = `rgb(${Math.min(255, params[k + 2])},${Math.min(255, params[k + 3])},${Math.min(255, params[k + 4])})`;
        if (p === 38) fg = c;
        else bg = c;
        k += 4;
      }
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 0x1b && c !== 0x9b) {
      // other C0 controls (bell …) are dropped; tabs and newlines stay
      if (c >= 0x20 || c === 0x09 || c === 0x0a) buf += s[i];
      i++;
      continue;
    }
    // CSI: ESC [ (or the 8-bit 0x9b) parameters intermediates final
    const csiStart = c === 0x9b ? i + 1 : s[i + 1] === '[' ? i + 2 : -1;
    if (csiStart >= 0) {
      let j = csiStart;
      while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
      const params = s.slice(csiStart, j);
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
      const fin = j < s.length ? s[j] : '';
      if (fin === 'm' && /^[0-9;]*$/.test(params) && params.length <= 64) {
        flush();
        sgr(params.split(';').filter((x) => x !== '').map((x) => Math.min(1000, Number(x))));
      }
      i = j + 1;
      continue;
    }
    // OSC: ESC ] … (BEL or ESC \)
    if (s[i + 1] === ']') {
      let j = i + 2;
      while (j < s.length && s.charCodeAt(j) !== 0x07 && !(s.charCodeAt(j) === 0x1b && s[j + 1] === '\\')) j++;
      i = j < s.length && s.charCodeAt(j) === 0x07 ? j + 1 : j + 2;
      continue;
    }
    // any other escape: ESC and the next character
    i += 2;
  }
  flush();
  return runs;
}
