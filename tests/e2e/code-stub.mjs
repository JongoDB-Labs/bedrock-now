// A hostile stand-in for bn-coded (tests/e2e/run.sh --code, after the browser suite; run inside the terminal container
// with its own node): what code in the sandbox could do, since it can take the spawn socket's path. It moves bn-coded's
// socket aside (bn-coded keeps listening on it), answers in its place with markup in every field, bogus ids, NaN and
// negative numbers, an answer over the frame limit, `claude plugin …` listings and an install "command" full of markup
// (with a hash that is not one), and a Claude Code that sends forged control requests and then an endless line; on
// SIGTERM it puts bn-coded's socket back.
//   node code-stub.mjs /run/bn-code/coded.sock
import net from 'node:net';
import fs from 'node:fs';

const SOCK = process.argv[2] || '/run/bn-code/coded.sock';
const REAL = SOCK.replace(/\.sock$/, '.real');
const M = '<img src=x onerror=alert(1)><script>alert(2)</script><svg onload=alert(3)>[x](javascript:alert(4))';
const T = { OPEN: 1, STDIN: 2, STDOUT: 0x12, EXIT: 0x14, RESULT: 0x15 };
const frame = (t, p) => { const b = Buffer.isBuffer(p) ? p : Buffer.from(JSON.stringify(p)); const h = Buffer.alloc(5); h[0] = t; h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };
const line = (o) => frame(T.STDOUT, Buffer.from(`${JSON.stringify(o)}\n`));

function claude(conn) {
  let buf = '';
  let prompted = false;
  return (data) => {
    buf += data.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.type === 'control_request' && m.request?.subtype === 'initialize') {
        conn.write(line({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id,
          response: { commands: [{ name: M, description: M, argumentHint: M }], models: [{ value: M, displayName: M, description: M }], account: {} } } }));
      } else if (m.type === 'user' && !prompted) {
        prompted = true;
        const sid = '../../etc';
        conn.write(line({ type: 'system', subtype: 'init', model: M, cwd: M, tools: [M], mcp_servers: [{ name: M, status: M }], plugins: [{ name: M, path: '/home/claude', version: M }],
          slash_commands: [M], permissionMode: 'bypassPermissions', claude_code_version: M, session_id: sid, uuid: 'x' }));
        conn.write(line({ type: 'assistant', message: { model: M, content: [{ type: 'text', text: M }, { type: 'tool_use', id: '../x', name: M, input: { command: M } }] }, parent_tool_use_id: null, session_id: sid }));
        conn.write(line({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback', callback_id: 'x', input: {} } }));
        conn.write(line({ type: 'control_request', request_id: 'h2', request: { subtype: 'mcp_message', server_name: 'x', message: {} } }));
        conn.write(line({ type: 'result', subtype: 'success', is_error: false, num_turns: -1, duration_ms: 'NaN', total_cost_usd: -1, usage: { input_tokens: -5 }, result: M }));
        // then a line that never ends (48 MiB): the code side must cut the connection
        const chunk = frame(T.STDOUT, Buffer.alloc(4 << 20, 120));
        (function more(n) { if (n > 0 && !conn.destroyed) conn.write(chunk, () => more(n - 1)); })(12);
      }
    }
  };
}

function serve(conn) {
  let head = Buffer.alloc(0), opened = false, onStdin = null;
  conn.on('error', () => {});
  conn.on('data', (d) => {
    head = Buffer.concat([head, d]);
    while (head.length >= 5) {
      const t = head[0], n = head.readUInt32BE(1);
      if (head.length < 5 + n) break;
      const p = head.subarray(5, 5 + n); head = head.subarray(5 + n);
      if (!opened) {
        opened = true;
        let req = {}; try { req = JSON.parse(p.toString('utf8')); } catch { /* nothing */ }
        if (req.op === 'claude') onStdin = claude(conn);
        else if (req.op === 'cli') {
          // `claude plugin …` as a process: markup everywhere, bogus ids, a "command" to confirm with a bogus hash
          const a = Array.isArray(req.args) ? req.args.join(' ') : '';
          const out = a.startsWith('plugin list') && a.includes('--available')
            ? { installed: [], available: [{ pluginId: 'evil@m', name: M, description: M, marketplaceName: M, version: M, source: { source: 'command', command: `${M}\u202e` } }, { pluginId: '../../etc', name: M }] }
            : a.startsWith('plugin list') ? [{ id: M }, { id: 'ok@m', name: M, version: M, scope: M, enabled: 'yes', errors: [M] }]
              : a.startsWith('plugin marketplace list') ? [{ name: M }, { name: 'm', source: M, path: M }]
                : { command: 'install', outcome: 'failed', failureCode: 'command_source_refused', message: M,
                  shownCommand: { kind: M, pluginId: '../x', command: `${M}\u202e`, sha256: 'not-a-sha' } };
          conn.write(frame(T.STDOUT, Buffer.from(`${M}\n${JSON.stringify(out)}\n`.replace(`${M}\n`, a.startsWith('plugin install') ? `${M}\n` : ''))));
          conn.end(frame(T.EXIT, { code: a.startsWith('plugin install') ? 1 : 0, signal: null }));
        }
        else if (req.op === 'sessions.list') {
          conn.end(frame(T.RESULT, { sessions: [
            { id: '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8', mtimeMs: Date.now(), size: 10, firstPrompt: M, customTitle: M },
            { id: '../../etc', mtimeMs: 1, firstPrompt: M }, { id: '00000000-0000-4000-8000-000000000000', mtimeMs: 'NaN' }] }));
        } else if (req.op === 'fs.list' && req.path === 'big') {
          const h = Buffer.alloc(5); h[0] = T.RESULT; h.writeUInt32BE(9 << 20, 1); conn.write(h); conn.end(Buffer.alloc(9 << 20, 32));
        } else if (req.op === 'fs.list') {
          conn.end(frame(T.RESULT, { path: M, entries: [{ name: M, type: M, size: -1, mtimeMs: 'NaN' }, { name: '../../etc', type: 'dir' }] }));
        } else conn.end(frame(T.RESULT, { path: '../../etc', size: -1, mtimeMs: 'NaN', trash: M }));
      } else if (t === T.STDIN && onStdin) onStdin(p);
    }
  });
}

fs.renameSync(SOCK, REAL);
const server = net.createServer(serve);
server.listen(SOCK, () => process.stderr.write(`code-stub: listening on ${SOCK} (bn-coded's socket is at ${REAL})\n`));
const restore = () => { server.close(); try { fs.unlinkSync(SOCK); } catch { /* gone */ } try { fs.renameSync(REAL, SOCK); } catch { /* gone */ } process.exit(0); };
process.on('SIGTERM', restore);
process.on('SIGINT', restore);
