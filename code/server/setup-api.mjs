// Bring your setup's routes (the Code page: Settings › Claude Code › Bring your setup…, a project's ⋯ › Bring your
// setup…, the Git panel's Use yours from this computer) — over import-setup.mjs: the last look at your Claude Code setup
// on the computer (names and sizes), the items opened (read on the computer: their contents, checked here), a preview of
// what copying one will do, and the copy into the sandbox. What needs the portal password — a look, an open, a copy that
// keeps a possible secret — the page asks the PORTAL (POST /.bn/sessions on this host: setup-scan, setup-fetch,
// setup-copy), which writes the update helper's request; this container never sees the password and follows the
// request by its id (GET /api/imports/request/<nonce>). A look and an open happen only on the computer itself; from
// another device the page shows the list of a look already made, and checks and copies what was opened there.
//
//   GET    /api/setup                                  the last look, the items opened, the helper, the requests
//   GET    /api/setup/preview?keys=K[,K…]&mode=replace|append&conflict=leave|replace
//                                                      a unit (an item; or the settings keys of one tool) as it would be
//                                                      copied: flags, findings, secrets, about how many tokens, the
//                                                      exact text of each write (every secret redacted or left out)
//   POST   /api/setup/copy {units: [{keys, mode, conflict, digest}]}   (nothing kept: every finding redacted, every
//                                                      secret-shaped value left out; a kept one goes through the portal —
//                                                      and from another device, a unit with grants: a whole tool allowed,
//                                                      a front matter's grant, hooks, a status line)
//   DELETE /api/setup/staged?key=K                     drop an item opened
import { ImportError } from './import-sessions.mjs';
import { KEY } from './setup-plan.mjs';

const ACTIONS = ['setup-scan', 'setup-fetch', 'setup-copy'];
const keysOf = (v) => String(v ?? '').split(',').filter(Boolean).slice(0, 5);

export function makeSetupApi({ setup, imports }) {
  function view(remote) {
    const ix = setup.index();
    return {
      local: !remote, helper: imports.helper(),
      index: ix ? { scan: ix.scan, at: ix.at, consent: ix.consent, fetchable: setup.fetchable(ix), project: ix.project, head: ix.head, rows: ix.rows } : null,
      staged: setup.staged(),
      requests: imports.requests().filter((r) => ACTIONS.includes(r.action)).slice(0, 10),
    };
  }
  return {
    view,
    async route({ m, p, q, remote, readJson, send }) {
      if (p === '/api/setup' && m === 'GET') return send(200, view(remote));
      if (p === '/api/setup/preview' && m === 'GET') {
        const keys = keysOf(q.get('keys'));
        if (!keys.length || !keys.every((k) => KEY.test(k))) throw new ImportError(400, 'bad items');
        return send(200, await setup.preview(keys, { mode: q.get('mode'), conflict: q.get('conflict') }));
      }
      if (p === '/api/setup/copy' && m === 'POST') {
        const b = await readJson();
        if (!Array.isArray(b?.units)) throw new ImportError(400, 'units: what to copy');
        // (keeping a possible secret needs the portal password: such a copy goes through the portal and the helper)
        if (b.units.some((u) => u && (u.keep === true || (Array.isArray(u.keep) && u.keep.length)))) throw new ImportError(403, 'Keeping a possible secret needs the portal password: the sheet asks for it.');
        // (from another device, a unit that lets something act without asking is refused too: that copy needs the password)
        return send(200, { results: await setup.copy(b.units.map((u) => ({ keys: Array.isArray(u?.keys) ? u.keys : [], mode: u?.mode, conflict: u?.conflict, digest: u?.digest, keep: [] })), { remote }) });
      }
      if (p === '/api/setup/staged' && m === 'DELETE') return send(200, setup.drop(q.get('key')));
      return false;
    },
  };
}
