// Small parsers for the page's forms (kept free of the DOM: unit-tested).

/** "KEY=value" (env) or "Name: value" (headers), one per line -> an object; null with the bad line's number. */
export function pairs(text: string, sep: '=' | ':'): { ok: Record<string, string> } | { bad: number } {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const at = l.indexOf(sep);
    const k = at > 0 ? l.slice(0, at).trim() : '';
    if (!k || (sep === '=' ? !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) : !/^[A-Za-z0-9-]{1,100}$/.test(k))) return { bad: i + 1 };
    out[k] = l.slice(at + 1).trim();
  }
  return { ok: out };
}
