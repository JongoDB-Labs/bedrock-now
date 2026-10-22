// The Import sheet's routes (the Code page: a project's ⋯ › Import sessions from this computer…), the suggestions and
// Continue in this project — over import-sessions.mjs (the lists and the sessions read on the computer, how the
// requests to the update helper went) and import-copy.mjs (the preview, the copy into the sandbox, the fork into
// another project). What needs the portal password — a look, a read, suggestions, a copy that keeps a possible secret —
// the page asks the PORTAL (POST /.bn/sessions on this host: it checks the password, decides whether the request is
// remote, and writes the helper's request): this container never sees the password, and only follows the request by
// its id. Over remote access the portal refuses a look and suggestions; reading sessions of a look allowed on the
// computer, checking and copying them works everywhere.
//
//   GET    /api/imports?project=ID              the project's list, the sessions waiting, the helper, the requests
//   GET    /api/imports/request/<nonce>         how a request went (a copy's: its results)
//   GET    /api/imports/preview?project=&id=&thinking=   a waiting session as it would be copied (and its digest)
//   POST   /api/imports/copy     {project, items: [{id, thinking, digest}]}   (nothing kept: every finding redacted)
//   DELETE /api/imports/staged?project=&id=     drop a waiting session
//   GET    /api/imports/suggestions             folders your tools kept sessions for (not projects yet)
//   POST   /api/sessions/<id>/continue  {project}  Continue in this project
import { ImportError } from './import-sessions.mjs';
import { preview, copy, continueIn } from './import-copy.mjs';
import { isUuid } from './validate.mjs';

const NONCE = /^[0-9a-f]{32}$/;

export function makeImportsApi({ imports, call, projects, cwdFor, rootFor }) {
  const project = (id) => imports.project(id);
  function view(id, remote) {
    const p = project(id);
    const ix = imports.index(id);
    return {
      project: p.id, local: !remote, helper: imports.helper(),
      index: ix ? { scan: ix.scan, at: ix.at, consent: ix.consent, fetchable: imports.fetchable(ix), head: ix.head, rows: ix.rows } : null,
      staged: imports.staged(id),
      requests: imports.requests().filter((r) => r.project === id).slice(0, 10),
    };
  }
  function suggestions() {
    const s = imports.suggestions();
    if (!s) return { at: null, rows: [] };
    // (a folder that is a project already — at its own path in the sandbox — is no suggestion)
    let roots = [];
    try { roots = projects.list().filter((x) => x.host && !x.gone).map((x) => x.root); } catch { roots = []; }
    return { at: s.at, consent: s.consent, rows: s.rows.filter((r) => !roots.includes(r.path)) };
  }
  return {
    view,
    async route({ m, p, q, remote, readJson, send }) {
      if (p === '/api/imports' && m === 'GET') return send(200, view(q.get('project'), remote));
      let mm;
      if ((mm = /^\/api\/imports\/request\/([0-9a-f]{32})$/.exec(p)) && m === 'GET') {
        // (not heard of yet: sent — the helper says how it goes once it took it)
        const r = imports.requests().find((x) => x.id === mm[1] && NONCE.test(x.id));
        return send(200, r ?? { id: mm[1], state: 'unknown' });
      }
      if (p === '/api/imports/preview' && m === 'GET') {
        const th = q.get('thinking');
        return send(200, await preview(imports, q.get('project'), q.get('id'), { thinking: th === 'keep' || th === 'strip' ? th : null }));
      }
      if (p === '/api/imports/copy' && m === 'POST') {
        const b = await readJson();
        project(b.project);
        if (!Array.isArray(b.items)) throw new ImportError(400, 'items: the sessions to copy');
        // (keeping a possible secret needs the portal password: such a copy goes through the portal and the helper)
        if (b.items.some((it) => it && (it.keep === true || (Array.isArray(it.keep) && it.keep.length)))) throw new ImportError(403, 'Keeping a possible secret needs the portal password: the sheet asks for it.');
        return send(200, { results: await copy(imports, call, b.project, b.items.map((it) => ({ id: it?.id, keep: [], thinking: it?.thinking, digest: it?.digest }))) });
      }
      if (p === '/api/imports/staged' && m === 'DELETE') return send(200, imports.drop(q.get('project'), q.get('id')));
      if (p === '/api/imports/suggestions' && m === 'GET') return send(200, suggestions());
      if ((mm = /^\/api\/sessions\/([0-9a-f-]{36})\/continue$/.exec(p)) && m === 'POST') {
        const b = await readJson();
        if (!isUuid(mm[1])) throw new ImportError(400, 'bad session id');
        const root = rootFor(b.project);
        const to = root ? root.abs : '/workspace';
        return send(200, await continueIn(call, { id: mm[1], cwd: await cwdFor(mm[1]), to }, imports));
      }
      return false;
    },
  };
}
