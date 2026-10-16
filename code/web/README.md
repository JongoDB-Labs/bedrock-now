# The Code page (browser UI)

The IDE-like page on `code.<host>` that drives Claude Code: chat with streaming answers, tool cards, permission
prompts, an explorer and CodeMirror 6 editor over `/workspace`, Claude's edits as diffs, and the sandbox terminal
in a bottom panel. Preact + CodeMirror 6 + marked's lexer, bundled by esbuild. It talks to the code backend only
through the API in the design's §5; `src/api.ts` is the one module that knows that wire format.

## Build

```sh
cd code/web
npm ci            # exact versions from package-lock.json
npm run build     # → dist/: index.html, app.<hash>.js, app.<hash>.css, chunks/*.js, favicon.svg
```

`dist/` is what the code container serves (`index.html` with `Cache-Control: no-store`, everything else can be
cached for good: the names carry content hashes). The first load is `app.<hash>.js` (≈58 KB gzipped) and the CSS;
the editor (≈200 KB gzipped) and each language load when a file or diff is first opened.

No CDN, no inline script or style, no `eval`, no HTML strings: the page runs under the CSP in design §6 including
`require-trusted-types-for 'script'; trusted-types 'none'`. Styles need only `style-src 'self'`: CodeMirror lives in
shadow roots, where it mounts its styles as constructed stylesheets. (If the server injects
`<meta name="bn-style-nonce" content="…">`, that nonce is passed to CodeMirror as well; it is not required.)

## Develop with the mock backend

```sh
npm run dev       # esbuild watch + dev/mock-server.mjs on http://127.0.0.1:8095
npm run mock -- --port 8095 --hostile   # just the mock, with hostile file names, titles and models
```

`dev/mock-server.mjs` speaks §5 from memory (no stack, no Bedrock): sessions, streaming text and thinking, tool calls
and results (Edit with `originalFile` + `structuredPatch`), permission prompts that wait for the page, background
tasks, slash commands, interrupts, seq replay on re-attach, files (list/read/write with the mtime precondition,
upload, mkdir, rename, delete), `/.bn/models` with prices and `/.bn/spend`. It serves `dist/` with the §6 CSP.
A prompt picks the scenario by keyword: *fix … retry* (Read + Edit), *write/create* (Write), *run the tests* (Bash),
*background* (a background task), *agent/explore* (Task with nested calls), *fetch/web*, *mcp*, *todo/plan*, *long*,
*hostile*, or a slash command (`/context`, `/cost`, `/model sonnet`, `/compact`).

## Tests

```sh
npm test          # tsc --noEmit, then the unit tests (node:test, bundled by esbuild)
sh e2e/run.sh     # browser checks in Docker (needs dist/ and node_modules)
```

The unit tests cover the markdown renderer (raw HTML stays text, only http(s) links, no images), the wire
normaliser (ids, caps, bad shapes), the session reducer (streaming, tool pairing, replay and gaps, history merge),
cost attribution per turn, diffs, the pickers, permission sentences and stored-prefs validation.

`e2e/run.sh` runs `e2e/ui_check.py` in the Playwright image the e2e suite pins (`tests/e2e/run.sh` `PW_IMAGE`,
packages from `tests/e2e/Dockerfile`), with two mocks inside the container (normal and `--hostile`). It walks the
page on desktop (light and dark), tablet and phone — streaming, permission prompts (once / always / deny with a
message), diffs, the / and @ pickers, uploads and image attachments, modes, background tasks, interrupt, reconnect
and reload without duplicates, resume/fork/rename, editor save conflicts, remembered layout — and a hostile session
(markup in every field, `javascript:` links, bidi and control characters, giant strings, bad ids). Any CSP violation,
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
| `src/components/` | Shell (layouts, top bar, status bar, terminal), Chat, MessageList, ToolCard, PermissionCard, Composer, FileTree, EditorArea, SessionList, Pickers |
| `dev/` | the mock backend and `npm run dev` |
| `e2e/` | the browser checks |
