// A stand-in for the Agent SDK's query(): reads the prompt stream like the real one and answers each user message with
// init (first turn), a streamed text, optionally a permission request through canUseTool, and a result.
export function fakeQuery(log = []) {
  return ({ prompt, options }) => {
    const out = [];
    let wake = null, closed = false, n = 0;
    const push = (m) => { out.push(m); wake?.(); wake = null; };
    const q = {
      options, calls: [],
      async interrupt() { q.calls.push('interrupt'); push({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 5 }); },
      async setModel(m) { q.calls.push(['setModel', m]); },
      async setPermissionMode(m) { q.calls.push(['setPermissionMode', m]); },
      async applyFlagSettings(s) { q.calls.push(['applyFlagSettings', s]); },
      async supportedCommands() { return [{ name: 'context', description: 'ctx <b>', argumentHint: '' }, { name: 7 }, null]; },
      async supportedModels() { return [{ value: 'haiku', displayName: 'Haiku', description: 'd', supportedEffortLevels: ['low', 'bogus'] }]; },
      mcp: { 'bedrock-shared': 'connected', 'mine': 'failed' },
      async mcpServerStatus() {
        return [{ name: 'bedrock-shared', status: q.mcp['bedrock-shared'], tools: [{ name: 'search' }, { name: 2 }], scope: 'dynamic', source: 'dynamic',
          config: { type: 'http', url: 'http://user:pw@gateway:8091/mcp?token=secret', headers: { Authorization: 'x' } } },
        { name: 'mine', status: q.mcp.mine, error: 'spawn ENOENT', scope: 'user', source: 'user', config: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { KEY: 'secret' } } },
        { name: '<img src=x>', status: 'bogus', tools: 'x' }];
      },
      async reconnectMcpServer(n) { q.calls.push(['reconnect', n]); if (q.mcp[n]) q.mcp[n] = 'connected'; else throw new Error(`no server ${n}`); },
      async toggleMcpServer(n, on) { q.calls.push(['toggle', n, on]); q.mcp[n] = on ? 'connected' : 'disabled'; },
      async getContextUsage() { return { totalTokens: 10, categories: [{ name: 'x' }] }; },
      async reloadPlugins() {
        q.calls.push('reloadPlugins');
        return { commands: [{ name: 'hello-local:hello', description: 'Say hello <b>' }], agents: [], error_count: 0,
          plugins: [{ name: 'hello-local', path: '/home/coder/.claude/plugins/cache/x', source: 'hello-local@bn-e2e', version: '1.0.0' }, { name: 7 }],
          mcpServers: [{ name: 'bedrock-shared', status: 'connected', tools: [] }] };
      },
      async stopTask(id) { q.calls.push(['stopTask', id]); },
      async rewindFiles(id, o) { q.calls.push(['rewindFiles', id, o]); return { canRewind: true, filesChanged: ['/workspace/a.txt', 7], insertions: 2, deletions: -1, extra: 'x' }; },
      close() { closed = true; q.calls.push('close'); wake?.(); },
      async *[Symbol.asyncIterator]() {
        (async () => {
          for await (const m of prompt) {
            log.push(m);
            n++;
            if (n === 1) push({ type: 'system', subtype: 'init', model: options.model || 'claude-sonnet-5-5', cwd: '/workspace', permissionMode: options.permissionMode, claude_code_version: '2.1.296', tools: ['Bash'], mcp_servers: [] });
            const text = typeof m.message.content === 'string' ? m.message.content : m.message.content.at(-1).text;
            // Claude Code starting a new conversation in this process (/clear, a plan approved with "clear context")
            if (text.startsWith('reset:')) push({ type: 'conversation_reset', new_conversation_id: text.slice(6), uuid: 'u', session_id: 's', trigger: 'clear' });
            if (text === 'cmds') push({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'new-skill', description: 'found' }], uuid: 'u', session_id: 's' });
            if (text.startsWith('mode:')) push({ type: 'system', subtype: 'status', status: null, permissionMode: text.slice(5) });
            if (text.startsWith('ask:')) {
              const r = await options.canUseTool('Bash', { command: text.slice(4) }, { signal: new AbortController().signal, suggestions: [] });
              push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: JSON.stringify(r) }] } });
            }
            push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'pon' } }, parent_tool_use_id: null });
            push({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: `pong:${text}` }] }, parent_tool_use_id: null });
            push({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 10, total_cost_usd: 99, usage: { input_tokens: 1, output_tokens: 2 } });
          }
          closed = true; wake?.();
        })();
        for (;;) {
          if (out.length) { yield out.shift(); continue; }
          if (closed) return;
          await new Promise((r) => { wake = r; });
        }
      },
    };
    return q;
  };
}
