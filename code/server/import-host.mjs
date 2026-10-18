// ./stack git-host import gh | glab (lib/githost.sh): a login of the GitHub CLI or the GitLab CLI on the computer
// running bedrock-now, read there from the CLI and handed to this script on its stdin (`docker compose exec -T`: never
// a command line, an environment variable, a file on the computer, the browser or the portal), added to Git hosts as
// an access token like any other (githosts.mjs addImport), with its source, account and scopes for the page — never
// renewed: gh's OAuth token does not expire; glab's is a personal access token (an OAuth login of glab's is refused
// before this runs: its single-use refresh tokens would break glab or this). Prints what was added as one JSON line —
// never the token. Node built-ins only (githosts.mjs).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GitHosts, HostError } from './githosts.mjs';

const MAX_INPUT = 64 << 10;
const out = (o, code = 0) => { process.stdout.write(`${JSON.stringify(o)}\n`); process.exit(code); };

export function importLogin(input, store = new GitHosts()) {
  let b;
  try { b = JSON.parse(input); } catch { throw new HostError(400, 'not the import\'s input (one JSON object on stdin)'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HostError(400, 'not the import\'s input (one JSON object on stdin)');
  const source = b.source === 'gh' || b.source === 'glab' ? b.source : null;
  if (!source) throw new HostError(400, 'source: gh or glab');
  const h = store.addImport({ source, host: b.host, label: b.label || undefined, token: b.token, account: b.account || null,
    scopes: Array.isArray(b.scopes) ? b.scopes : [], expiresAt: typeof b.expiresAt === 'number' ? b.expiresAt : null });
  store.event({ action: 'host', host: h.label, target: h.host, text: `connected with ${source}'s login${h.imported.account ? ` as ${h.imported.account}` : ''} (./stack git-host import)` });
  return { label: h.label, host: h.host, account: h.imported.account, scopes: h.imported.scopes, source };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { out({ ok: false, error: 'no input on stdin' }, 2); }
  if (input.length > MAX_INPUT) out({ ok: false, error: 'the input is too long' }, 2);
  try { out({ ok: true, host: importLogin(input) }); } catch (e) {
    out({ ok: false, error: e instanceof HostError ? e.message : 'the login could not be added' }, 1);
  }
}
