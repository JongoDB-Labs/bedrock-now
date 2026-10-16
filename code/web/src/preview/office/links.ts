// What a link in a Word document may become (office/htmlsafe.ts in the worker, DocView again on the page): http(s)
// and mailto: URLs (no credentials) open in a new tab; "#anchor" jumps inside the document; anything else (javascript:,
// data:, file:, relative paths …) is no link at all.
export function docHref(v: unknown): { href: string } | { anchor: string } | null {
  if (typeof v !== 'string' || v.length > 4000) return null;
  const h = v.trim();
  if (h.startsWith('#')) {
    const id = h.slice(1);
    return /^[\w.:-]{1,200}$/.test(id) ? { anchor: id } : null;
  }
  if (/^mailto:/i.test(h)) return /^mailto:[^\s<>"'`\\]{1,500}$/i.test(h) ? { href: h } : null;
  if (!/^https?:\/\//i.test(h)) return null;
  try {
    const u = new URL(h);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    return { href: u.href };
  } catch {
    return null;
  }
}
