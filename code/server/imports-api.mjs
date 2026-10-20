// The Import sheet's routes (the Code page: a project's ⋯ › Import sessions from this computer…), the suggestions and
// Continue in this project — over import-sessions.mjs (the lists and the sessions read on the computer, the requests to
// the update helper) and import-copy.mjs (the preview, the copy into the sandbox, the fork into another project).
// Over remote access (Caddy's remote sites say X-Bn-Remote: 1) nothing is asked of the computer that it has not
// allowed already: no look (its dialog would open on a screen nobody may be at), no suggestions; reading sessions of a
// look allowed there, checking and copying them works everywhere.
//
//   GET    /api/imports?project=ID              the project's list, the sessions waiting, the helper, the requests
//   POST   /api/imports/scan     {project, tool, password}        a look (the helper asks on the computer's screen)
//   POST   /api/imports/fetch    {project, ids, password}         read those sessions of the last look
//   GET    /api/imports/request/<nonce>         how a request went
//   GET    /api/imports/preview?project=&id=&thinking=   a waiting session as it would be copied
//   POST   /api/imports/copy     {project, items: [{id, keep, thinking}]}
//   DELETE /api/imports/staged?project=&id=     drop a waiting session
//   GET    /api/imports/suggestions             folders your tools kept sessions for (not projects yet)
//   POST   /api/imports/suggest  {password}     look for them (the helper asks on the computer's screen)
//   POST   /api/sessions/<id>/continue  {project}  Continue in this project
import { ImportError } from './import-sessions.mjs';
import { preview, copy, continueIn } from './import-copy.mjs';
import { isUuid } from './validate.mjs';
import { TOOLS } from './harness/claude.mjs';

const NONCE = /^[0-9a-f]{32}$/;
const REMOTE = 'Only on the computer running bedrock-now: a look at its sessions is allowed in a dialog on its screen (or ./stack sessions in a terminal there).';

export function makeImportsApi({ imports, call, projects, cwdFor, rootFor }) {
  const project = (id) => imports.project(id);
  const pw = (b) => (typeof b?.password === 'string' ? b.password : '');
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
      if (p === '/api/imports/scan' && m === 'POST') {
        const b = await readJson();
        if (remote) throw new ImportError(403, REMOTE);
        project(b.project);
        const tool = b.tool === undefined ? 'both' : b.tool;
        if (!['both', ...TOOLS].includes(tool)) throw new ImportError(400, 'tool: claude, claude-bedrock or both');
        return send(200, { request: imports.request('sessions-scan', { project: b.project, tool }, pw(b), 'local') });
      }
      if (p === '/api/imports/fetch' && m === 'POST') {
        const b = await readJson();
        project(b.project);
        const ix = imports.index(b.project);
        if (!ix) throw new ImportError(409, 'no list of this project\'s sessions yet: look first');
        if (!imports.fetchable(ix)) throw new ImportError(409, 'that look was allowed once, more than an hour ago: look again');
        if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 50 || !b.ids.every(isUuid)) throw new ImportError(400, 'ids: 1 to 50 sessions of the list');
        const rows = [...new Set(b.ids)].map((id) => ix.rows.find((r) => r.id === id)?.n);
        if (rows.some((n) => !n)) throw new ImportError(409, 'a session that is not in the last list: look again');
        return send(200, { request: imports.request('sessions-fetch', { project: b.project, scan: ix.scan, rows: rows.join(',') }, pw(b), remote ? 'remote' : 'local') });
      }
      let mm;
      if ((mm = /^\/api\/imports\/request\/([0-9a-f]{32})$/.exec(p)) && m === 'GET') {
        const r = imports.requests().find((x) => x.id === mm[1] && NONCE.test(x.id));
        if (!r) throw new ImportError(404, 'no such request');
        return send(200, r);
      }
      if (p === '/api/imports/preview' && m === 'GET') {
        const th = q.get('thinking');
        return send(200, await preview(imports, q.get('project'), q.get('id'), { thinking: th === 'keep' || th === 'strip' ? th : null }));
      }
      if (p === '/api/imports/copy' && m === 'POST') {
        const b = await readJson();
        project(b.project);
        return send(200, { results: await copy(imports, call, b.project, b.items) });
      }
      if (p === '/api/imports/staged' && m === 'DELETE') return send(200, imports.drop(q.get('project'), q.get('id')));
      if (p === '/api/imports/suggestions' && m === 'GET') return send(200, suggestions());
      if (p === '/api/imports/suggest' && m === 'POST') {
        const b = await readJson();
        if (remote) throw new ImportError(403, REMOTE);
        return send(200, { request: imports.request('sessions-suggest', {}, pw(b), 'local') });
      }
      if ((mm = /^\/api\/sessions\/([0-9a-f-]{36})\/continue$/.exec(p)) && m === 'POST') {
        const b = await readJson();
        if (!isUuid(mm[1])) throw new ImportError(400, 'bad session id');
        const root = rootFor(b.project);
        const to = root ? root.abs : '/workspace';
        return send(200, await continueIn(call, { id: mm[1], cwd: await cwdFor(mm[1]), to }));
      }
      return false;
    },
  };
}
