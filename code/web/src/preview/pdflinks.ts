// What a PDF link annotation may become in the page: an http(s) URL (opened in a new tab, noopener, noreferrer;
// markdown.ts's safeHref: no credentials, no other scheme, nothing relative), a destination inside the document
// (scrolls there), or nothing at all — JavaScript, launch, submit-form, remote go-to, named actions, attachments,
// file:, javascript:, data:, blob:, mailto:, ftp: and protocol-relative or relative URLs never become an element.
import { safeHref } from '../markdown';

export type PdfLink = { kind: 'url'; href: string } | { kind: 'dest'; dest: string | unknown[] } | null;

export function pdfLink(a: Record<string, unknown>): PdfLink {
  if (a.subtype !== 'Link' || !Array.isArray(a.rect) || a.rect.length !== 4 || !a.rect.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const href = typeof a.url === 'string' ? safeHref(a.url) : null;
  if (href) return { kind: 'url', href };
  if (typeof a.dest === 'string' || Array.isArray(a.dest)) return { kind: 'dest', dest: a.dest };
  return null;
}
