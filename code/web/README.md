# The Code page (browser UI)

The IDE-like page on `code.<host>` that drives Claude Code: chat with streaming answers, tool cards, permission
prompts (and AskUserQuestion as a form), an explorer and CodeMirror 6 editor over `/workspace`, Claude's edits as
diffs, file checkpoints ("Restore files to here" on a prompt), the CLAUDE.md memory files, plugins & marketplaces, MCP
servers, and the sandbox terminal in a bottom panel. Preact + CodeMirror 6 + marked's lexer, bundled by esbuild. It talks to the code backend only
through the API in `code/server/protocol.mjs`; `src/api.ts` is the one module that knows that wire format.

## Build

```sh
cd code/web
npm ci            # exact versions from package-lock.json
npm run build     # → dist/: index.html, app.<hash>.js, app.<hash>.css, chunks/*.js, favicon.svg
```

`dist/` is what the code container serves (`index.html` with `Cache-Control: no-store`, everything else can be
cached for good: the names carry content hashes). The first load is `app.<hash>.js` (≈58 KB gzipped) and the CSS;
the editor (≈200 KB gzipped) and each language load when a file or diff is first opened.

No CDN, no inline script or style, no `eval`, no HTML strings: the page runs under the CSP of `caddy/Caddyfile`'s
`code_page`, including
`require-trusted-types-for 'script'; trusted-types 'none'`. Styles need only `style-src 'self'`: CodeMirror lives in
shadow roots, where it mounts its styles as constructed stylesheets. (If the server injects
`<meta name="bn-style-nonce" content="…">`, that nonce is passed to CodeMirror as well; it is not required.)

## Develop with the mock backend

```sh
npm run dev       # esbuild watch + dev/mock-server.mjs on http://127.0.0.1:8095
npm run mock -- --port 8095 --hostile   # just the mock, with hostile file names, titles and models
```

`dev/mock-server.mjs` speaks `code/server/protocol.mjs` from memory (no stack, no Bedrock): sessions with an epoch
per process, streaming text and thinking, tool calls and results (Edit with `originalFile` + `structuredPatch`),
permission prompts that wait for the page (the rules Always applies, the workspace option, `complete`, `defaultNo`,
`noAlways`, the backend's caps), plan approval, background tasks, slash commands, interrupts, seq/epoch replay on
re-attach, prompts refused with a `reply`, `reset`, transcript tails with "load earlier", files (list with
`truncated`, read/write with the mtime precondition, upload, mkdir, rename, delete into the trash), `/.bn/models`,
`/.bn/spend` with the key's budget and the `/.bn/terminal` hand-off, the workspace search (`/api/fs/find`), the
CLAUDE.md files (`/api/memory`, with the mtime precondition) and file checkpoints (`rewind_files`, dry run and
restore, for the files the edit and write scenarios changed). It serves `dist/` with the code page's CSP.
A prompt picks the scenario by keyword: *fix … retry* (Read + Edit), *write/create* (Write), *run the tests* (Bash),
*background* (a background task), *agent/explore* (Task with nested calls), *fetch/web*, *mcp*, *todo*, *long*,
*ask me* (AskUserQuestion, one choice), *ask me two* (several choices + one), *huge command* (a prompt not shown in
full), *padded* (a command pushed out of sight), *risky* (default to no, no Always), *many edits* (MultiEdit),
*refuse this prompt*, *hostile*, or a slash command (`/context`, `/cost`, `/model sonnet`, `/compact`); in Plan mode
every prompt ends in a plan to approve. Test hooks: `POST /__mock/drop|close?code=|lock|unlock|budget?spend=&max=|
clear?session=|touch?path=|reset`. Plugins: one marketplace with a few plugins; adding any other
(`/workspace/name`, `owner/repo`) gives one plain plugin and one installed by a command, which answers
`needs_confirmation {command, sha256}` until that hash comes back; installs reload the open sessions' commands. MCP:
`bedrock-shared` plus servers you add (they load when a session starts), off/on per session, reconnect.

## Tests

```sh
npm test          # tsc --noEmit, then the unit tests (node:test, bundled by esbuild)
sh e2e/run.sh     # browser checks in Docker (needs dist/ and node_modules)
```

The unit tests cover the markdown renderer (raw HTML stays text, only http(s) links, no images, a newline is a
break), the wire normaliser (ids, caps, bad shapes, permission inputs capped as the backend caps them), the session
reducer (streaming, tool pairing, replay and gaps, history merge and "load earlier", prompts queued mid-turn),
cost attribution per turn, diffs, the pickers, permission sentences and stored-prefs validation, plugin outcomes
(a confirmation needs a real SHA-256), MCP statuses (no secrets), AskUserQuestion answers (keys exactly as sent, one
or several choices, Other), and the backend's message shapes (`code/server/protocol.mjs`) as the page reads them.

`e2e/run.sh` runs `e2e/ui_check.py` in the Playwright image the e2e suite pins (`tests/e2e/run.sh` `PW_IMAGE`,
packages from `tests/e2e/Dockerfile`), with two mocks inside the container (normal and `--hostile`). It walks the
page on desktop (light and dark), tablet and phone — streaming, permission prompts (once / always / in the
workspace's settings / deny with a message; armed after a moment, partially shown, padded commands, default to no,
MultiEdit), plan approval, prompts queued below the stream and refused ones taken back, /clear and a reset from the
CLI, fork from a prompt, "load earlier", close codes, an expired unlock, the budget banner, the to-do panel, the
Markdown export, the memory dialog and `#`, the @ picker's workspace search, file checkpoints, AskUserQuestion (one choice, several, Other, decline), diffs, the / and @ pickers, uploads and image
attachments, modes, background tasks, interrupt, reconnect and reload without duplicates, resume/fork/rename, an
already-open session, editor save conflicts, remembered layout, plugins (a marketplace from the workspace, install,
a command shown with its SHA-256 before it runs, on/off, update, uninstall, the palette after the reload), the MCP
panel (status, off/on, reconnect, a server of your own, restart) — and a hostile session (markup in every field,
`javascript:` links, bidi and control characters, giant strings, bad ids; a hostile plugin catalog and MCP list). Any CSP violation,
page error or dialog fails a check. Screenshots and `results.json` go to `e2e/out/` (`E2E_OUT=…` to change;
`E2E_ONLY=phone` to run one check; `KEEP_IMAGE=1` keeps the runner image `bn-code-web-e2e:local`).

## Layout

| | |
|---|---|
| `src/api.ts` | REST, `/.bn/*`, the WebSocket client (re-attach with `since`, backoff, queue); normalises everything inbound |
| `src/types.ts` | the page's own model of events, permissions, files, models |
| `src/session.ts` | the per-session reducer: events → timeline items; replay, gaps, history merge |
| `src/app.ts` | state and actions (sessions, files, tabs, layout) |
| `src/markdown.ts` | marked lexer → a node tree from fixed tags/attributes |
| `src/text.ts` | caps, visible bidi/control characters, id and path validation, formatting |
| `src/editor/` | CodeMirror (lazy chunk): editor, merge view, languages |
| `src/transcript.ts` | the latest to-do list, the conversation as Markdown |
| `src/questions.ts` | AskUserQuestion: questions from the tool's input, answers from your picks |
| `src/forms.ts` | small parsers for the MCP form (KEY=value, Name: value) |
| `src/components/` | Shell (layouts, top bar, status bar, terminal), Chat, MessageList, ToolCard, PermissionCard (incl. the question form), Composer, FileTree, EditorArea, SessionList, Pickers, Plugins (dialog), Mcp (panel), Memory (CLAUDE.md dialog) |
| `dev/` | the mock backend and `npm run dev` |
| `e2e/` | the browser checks |
