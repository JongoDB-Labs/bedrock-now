// Synthetic Claude Code transcripts for the import's tests (the reader, the scan, the copy): written by the tests in
// temporary folders, from the transcript format Claude Code 2.1 writes (one JSON object per line: user and assistant
// messages chained by uuid/parentUuid, each assistant content block an entry of its own, titles and summaries as entries
// of their own) — never anyone's real store. Secret-shaped values are made at run time, never written as literals.
import crypto from 'node:crypto';

let seq = 0;
export const uuid = () => crypto.randomUUID();
const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// rand(n, chars) -> n random characters of chars
export function rand(n, chars = alnum) {
  const b = crypto.randomBytes(n);
  return Array.from(b, (x) => chars[x % chars.length]).join('');
}
// secret-shaped fakes (the prefixes split so that no literal in this file has a token's shape)
export const fake = {
  awsKeyId: () => ['AK', 'IA'].join('') + rand(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
  awsSecret: () => rand(40, `${alnum}/+`),
  github: () => ['gh', 'p_'].join('') + rand(36),
  gitlab: () => ['gl', 'pat-'].join('') + rand(20),
  slack: () => ['xo', 'xb-'].join('') + rand(24),
  anthropic: () => ['sk', '-ant-'].join('') + rand(40),
  openai: () => ['sk', '-proj-'].join('') + rand(40),
  google: () => ['AI', 'za'].join('') + rand(35),
  stripe: () => ['sk', '_live_'].join('') + rand(24),
  npm: () => ['np', 'm_'].join('') + rand(36),
  jwt: () => `${['ey', 'J'].join('')}${rand(20)}.${['ey', 'J'].join('')}${rand(30)}.${rand(30)}`,
  pem: () => `-----BEGIN ${['RSA', 'PRIVATE KEY'].join(' ')}-----\n${rand(64, `${alnum}/+`)}\n${rand(64, `${alnum}/+`)}\n-----END ${['RSA', 'PRIVATE KEY'].join(' ')}-----`,
  bearer: () => rand(32, 'abcdef0123456789'),
  password: () => rand(16, `${alnum}!#%&`),
};

/** session({id, cwd, prompts, title, model, thinking, tool, version}) -> the entries of a session: a first prompt, an
 *  assistant answer per prompt (a thinking block when asked, a tool call reading a file in cwd and its result, a text),
 *  a custom title */
export function session({ id = uuid(), cwd = '/home/test/src/app', prompts = ['Fix the failing test'], title = null, model = 'claude-sonnet-4-5',
  thinking = false, version = '2.1.296', branch = 'main', sidechain = false, extra = [] } = {}) {
  const base = { isSidechain: sidechain, userType: 'external', cwd, sessionId: id, version, gitBranch: branch };
  const out = [];
  let parent = null, t = Date.parse('2026-10-01T10:00:00.000Z') + (seq++) * 1000;
  const ts = () => new Date(t += 1000).toISOString();
  const push = (e) => { const u = uuid(); out.push({ ...base, parentUuid: parent, ...e, uuid: u, timestamp: ts() }); parent = u; return u; };
  prompts.forEach((p, i) => {
    push({ type: 'user', message: { role: 'user', content: p } });
    const msg = `msg_${rand(12)}`;
    const a = (content, stop = null) => push({ type: 'assistant', requestId: `req_${rand(10)}`,
      message: { id: msg, type: 'message', role: 'assistant', model, content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } } });
    if (thinking) a([{ type: 'thinking', thinking: `Thinking about step ${i + 1}`, signature: rand(80, `${alnum}/+`) }]);
    const tool = `toolu_${rand(16)}`;
    a([{ type: 'tool_use', id: tool, name: 'Read', input: { file_path: `${cwd}/src/main.ts` } }], 'tool_use');
    push({ type: 'user', message: { role: 'user', content: [{ tool_use_id: tool, type: 'tool_result', content: 'export const main = () => 1;' }] },
      toolUseResult: { type: 'text', file: { filePath: `${cwd}/src/main.ts`, content: 'export const main = () => 1;' } } });
    a([{ type: 'text', text: `Done with step ${i + 1}.` }], 'end_turn');
  });
  for (const e of extra) push(e);
  if (title) out.push({ type: 'custom-title', customTitle: title, sessionId: id });
  return out;
}
export const jsonl = (entries) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
