# The Code page (browser UI)

The IDE-like page on `code.<host>` that drives Claude Code: chat with streaming answers, tool cards, permission
prompts (and AskUserQuestion as a form), an explorer and CodeMirror 6 editor over `/workspace`, Claude's edits as
diffs, previews of workspace files (Markdown with formulas and diagrams, images, SVG, audio, video, PDF, CSV/TSV, JSON,
YAML, Word, Excel, PowerPoint, Jupyter notebooks; HTML files and Mermaid diagrams in a sandboxed viewer), file checkpoints
("Restore files to here" on a prompt), the CLAUDE.md memory files, plugins & marketplaces, MCP
servers, the sandbox terminal in a bottom panel, the Review pane (every changed file — git's view or the session's
edits — with Keep / Undo and line comments for the next prompt), Search in files and a command palette. Preact + CodeMirror 6 + marked's lexer, bundled by esbuild. It talks to the code backend only
through the API in `code/server/protocol.mjs`; `src/api.ts` is the one module that knows that wire format.

## Build

```sh
cd code/web
npm ci            # exact versions from package-lock.json
npm run build     # → dist/: index.html, app.<hash>.js, app.<hash>.css, chunks/*.js, workers/*, assets/pdfjs-<v>/,
                  #   assets/katex-<v>/, artifact/ (the sandboxed viewer: html.html, mermaid.html, their scripts), favicon.svg
```

`dist/` is what the code container serves (`index.html` with `Cache-Control: no-store`, everything else can be
cached for good: the names carry content hashes, or pdf.js's version). The first load is `app.<hash>.js` and its
shared chunk (≈86 KB gzipped, of which the previews' part ≈8 KB) and the CSS; the editor (≈200 KB gzipped) and each language load when a file or diff is
first opened; the previews' viewers when a file of their kind is: the table and the tree ≈3 KB each, the PDF viewer
with pdf.js ≈150 KB, and the workers: CSV (papaparse) ≈8 KB, JSON/YAML/notebooks ≈36 KB, Word (mammoth, htmlparser2,
fflate) ≈100 KB, workbooks (SheetJS, our ODS reader) ≈130 KB, PowerPoint ≈30 KB, formulas (KaTeX) ≈80 KB, pdf.js's ≈390 KB (gzipped). pdf.js's standard fonts,
CMaps and JavaScript image decoders (`assets/pdfjs-<version>/`, ≈3 MB) are fetched only as a PDF needs them; KaTeX
(its chunk, and `assets/katex-<version>/`: its stylesheet and WOFF2 fonts) with the first formula. The artifact
viewer's pages (`artifact/`) are never served on the code host: the code container serves them only to the artifact
site (`caddy/artifact-on.caddy`), where the HTML runner is ≈0.5 KB and the diagram page carries Mermaid whole (one
classic script, ≈1.5 MB gzipped: the pages are sandboxed, an opaque origin, so modules and chunks would be CORS
requests), loaded only when a diagram is drawn; `static.html` loads the runner as `static.js`, a fixed name Caddy's
policy for that page names as its only script (an HTML file shows there first, without its own scripts).

No CDN, no inline script or style, no `eval`, no HTML strings: the page runs under the CSP of `caddy/Caddyfile`'s
`code_page`, including
`require-trusted-types-for 'script'; trusted-types bn-worker`. That one Trusted Types policy is created in
`src/preview/tt.ts` only; it turns exactly the worker paths `build.mjs` writes into the page (`__BN_WORKERS__`:
`workers/csv.<hash>.js`, `workers/data.<hash>.js`, `workers/docx.<hash>.js`, `workers/sheet.<hash>.js`,
`workers/deck.<hash>.js`, `workers/pdf.worker.<hash>.mjs`) into script URLs and refuses
anything else. Styles need only `style-src 'self'`: CodeMirror lives in
shadow roots, where it mounts its styles as constructed stylesheets; pdf.js loads a PDF's fonts with the FontFace
API and positions its text layer through the CSSOM. (If the server injects
`<meta name="bn-style-nonce" content="…">`, that nonce is passed to CodeMirror as well; it is not required.)

`pdfjs-dist` declares an optional native `@napi-rs/canvas` (for Node, ~30 MB per platform); `package.json`'s
`overrides` point it at `vendor/no-canvas`, an empty local package, so `npm ci` downloads no native binary. Likewise
`vendor/no-jszip` stands in for mammoth's JSZip (`build.mjs` resolves `jszip` to `src/preview/office/jszip-shim.ts`,
the page's bounded zip reader) and `vendor/no-argparse` for its command-line tool's argparse. mermaid's `katex` and
`lodash-es` are raised to fixed versions by `overrides`.

**SheetJS** (the Excel reader) is SheetJS Community Edition 0.20.3 from SheetJS's own CDN, vendored as
`vendor/xlsx-0.20.3.tgz` (`"xlsx": "file:vendor/xlsx-0.20.3.tgz"`; `package-lock.json` pins its SHA-512 and `npm ci`
checks it; a unit test compares the file with the lockfile). npm's registry stops at `xlsx` 0.18.5, which has known
vulnerabilities: never `npm install xlsx`. To update: download `https://cdn.sheetjs.com/xlsx-<v>/xlsx-<v>.tgz`, check
it against the version's published checksum, replace the file and the version in `package.json` and the test, and run
`npm install --ignore-scripts` to write the new integrity.

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
restore, for the files the edit and write scenarios changed). It serves `dist/` with the code page's CSP. Its
workspace has a folder `previews/` with every previewable format and hostile ones (`dev/preview-fixtures.mjs`: an
SVG with a script and external references, a PDF with JavaScript and launch actions, a PNG bomb, a billion-laughs
YAML, a line of 300,000 commas …); `GET /__mock/beacon` records any request such a file could make, `GET
/__mock/beacons` lists them.
A prompt picks the scenario by keyword: *fix … retry* (Read + Edit), *write/create* (Write), *run the tests* (Bash),
*background* (a background task), *agent/explore* (Task with nested calls), *fetch/web*, *mcp*, *todo*, *long*,
*ask me* (AskUserQuestion, one choice), *ask me two* (several choices + one), *huge command* (a prompt not shown in
full), *padded* (a command pushed out of sight), *risky* (default to no, no Always), *many edits* (MultiEdit),
*write … markdown* (a Write of a Markdown file: its card offers Preview),
*refuse this prompt*, *hostile*, or a slash command (`/context`, `/cost`, `/model sonnet`, `/compact`); in Plan mode
every prompt ends in a plan to approve. Test hooks: `POST /__mock/drop|close?code=|lock|unlock|budget?spend=&max=|
clear?session=|touch?path=|reset`. Plugins: one marketplace with a few plugins; adding any other
(`/workspace/name`, `owner/repo`) gives one plain plugin and one installed by a command, which answers
`needs_confirmation {command, sha256}` until that hash comes back; installs reload the open sessions' commands. MCP:
`bedrock-shared` plus servers you add (they load when a session starts), off/on per session, reconnect. Previews:
`/api/ports`, `/api/launch` (three entries, one broken) and `/.bn/preview`, whose links point at a fake preview site
on the mock's port + 100 (`p<port>-<capability>.localhost`: Chromium's loopback); a *vite* or *preview* prompt runs a
dev server that prints Vite's banner; `POST /__mock/port?port=&cmd=` adds a listening server (`&del=1` removes it).
Review and search: `/api/git/diff` compares the workspace with its state at the start (or at `POST /__mock/git?commit=1`;
`?repo=0` makes it no git repository: the page then reviews the session's edits), `PUT /api/fs/file` takes `create`,
`DELETE /api/fs` `ifMtimeMs`; a *… with sed* prompt changes two files and creates one by a Bash command (no edit event:
only git's view shows them; it also bumps `package.json`, a file of the watchlist); `watch_check` reports the watched
files that changed since the last turn; `/api/fs/grep` searches the in-memory files (literal or JavaScript regex, case,
globs); the hostile mock adds markup, bidi, `../` paths, counts that do not add up, a file named `.claude\settings.json`
and one with a newline in its name to both.
The artifact viewer: `/.bn/artifact` names `a<capability>.artifact.localhost` on that same port, which serves
`dist/artifact/*` with the viewer's policies (`/__mock/bypass?remote=1` makes it unavailable, as over remote access).
The previews' fixtures include Word, Excel, PowerPoint, notebooks, HTML, Mermaid and formulas, with their hostile ones
(`dev/office-fixtures.mjs`: zip bombs, a lying zip part, billion laughs and XXE in a Word part, HTML that tries every
way out …).

## Tests

```sh
npm test          # tsc --noEmit, then the unit tests (node:test, bundled by esbuild)
sh e2e/run.sh     # browser checks in Docker (needs dist/ and node_modules)
```

The unit tests cover the markdown renderer (raw HTML stays text, only http(s) links, no images, a newline is a
break), the wire normaliser (ids, caps, bad shapes, permission inputs capped as the backend caps them), the session
reducer (streaming, tool pairing, replay and gaps, history merge and "load earlier", prompts queued mid-turn or
folded into the running turn, a turn that went idle without a result, Stop with a prompt queued, the export's earlier
part), where an arriving permission card may take the focus (never from a field, the editor or the terminal),
cost attribution per turn, diffs, the pickers, permission sentences and stored-prefs validation, plugin outcomes
(a confirmation needs a real SHA-256), MCP statuses (no secrets), AskUserQuestion answers (keys exactly as sent, one
or several choices, Other), and the backend's message shapes (`code/server/protocol.mjs`) as the page reads them;
for the previews: what a file is by its bytes (and never by its name alone), the caps, image headers (decompression
bombs refused), CSV parsing on hostile input (a line of a million commas, row/cell/character caps, quotes, `__proto__`
headers), JSON/YAML trees (100,000 levels, wide lists, billion laughs, custom tags, merge keys, cycles, `__proto__`
keys), Markdown images (workspace paths only; fetched once, within a byte and pixel budget), PDF links (only http(s)
and inner destinations, against a list of hostile URIs), the workers (time budget, crash, cancel, CSP reports), timing
tests that every regular expression run on a file's text on the main thread stays linear on crafted input, and the
Trusted Types policy (one, named `bn-worker`, these workers only); the Review's reverse patches (400 random git-shaped
diffs undone exactly, CRLF files kept CRLF, a missing last newline kept, a moved change found, a changed file
refused), its files from git's view or the session's edits, stable ids, what is never undone, the comments' prompt
text, `/api/git/diff` and `/api/fs/grep` answers on hostile input; the palette's fuzzy matcher (ranking, linear
time on hostile candidates) and the shortcut list; and part 2 (`test/office.test.ts`): the zip reader's
caps (entries, declared and actual sizes, ratio, overlap, zip64, encryption; the 100 MB bomb, the liar), the HTML
allowlist on hostile markup, Word/Excel/PowerPoint/notebook readers on ordinary and hostile files, the ANSI and formula
scanners (timed on crafted input), formulas and diagrams in Markdown, Office kinds by bytes and name, the artifact
viewer's address, and the vendored SheetJS tarball against the lockfile; `test/math.test.ts`: formulas (the macro
blow-up refused, the tree's allowlist, timing); `test/memory.test.ts`: each reader just under its caps in a child
process with a 1 GB heap, and under a small device's caps with a 256 MB heap (`test/mem.child.ts`; a worker that runs
out of heap takes the page down), files over those refused with "on this device".

`e2e/run.sh` runs `e2e/ui_check.py` in the Playwright image the e2e suite pins (`tests/e2e/run.sh` `PW_IMAGE`,
packages from `tests/e2e/Dockerfile`), with two mocks inside the container (normal and `--hostile`). It walks the
page on desktop (light and dark), tablet and phone — streaming, permission prompts (once / always / in the
workspace's settings / deny with a message; armed after a moment, partially shown, padded commands, default to no,
the focus left in the prompt box and 1/2/3 only once you went to the card, a MultiEdit with more edits than a card
lists), plan approval, prompts queued below the stream and refused ones taken back, /clear and a reset from the
CLI, fork from a prompt, "load earlier", close codes, an expired unlock, the budget banner, the to-do panel, the
Markdown export (all of a long transcript), the memory dialog and `#`, the @ picker's workspace search, file
checkpoints (also after the session's process ended, and checked again after a later turn), AskUserQuestion (one choice, several, Other, decline), diffs, the / and @ pickers, uploads and image
attachments, modes, background tasks, interrupt, reconnect and reload without duplicates, resume/fork/rename, an
already-open session, editor save conflicts, remembered layout, plugins (a marketplace from the workspace, install,
a command shown with its SHA-256 before it runs, on/off, update, uninstall, the palette after the reload), the MCP
panel (status, off/on, reconnect, a server of your own, restart), file previews (every format with zero CSP
violations, Split following the editor, PDF find and links, CSV sort and filter, a Write card's Preview; hostile files
that do nothing — no request outside the page, no dialog, no popup; phone sheets; part 2: Word, Excel, PowerPoint,
notebooks, formulas, HTML and Mermaid in the sandboxed viewer, hostile Office files, zip bombs and pages that try every
way out — each request refused before it leaves the browser — over remote access, on a phone, and on a phone with
2 GB, whose smaller caps say the preview is limited there), the Review pane (two edits and a
Bash change, per-hunk Undo, Keep, a line comment reaching the next prompt, Undo all; without git, a changed file refused
and a new file trashed; a hostile diff and search as text), Search in files (case, regex, globs, a hit opening the
editor at its line), the command palette by keyboard alone and the shortcut sheet, and these on a phone — and a hostile session (markup in every field,
`javascript:` links, bidi and control characters, giant strings, bad ids; a hostile plugin catalog and MCP list). Any CSP violation,
page error or dialog fails a check. Screenshots and `results.json` go to `e2e/out/` (`E2E_OUT=…` to change;
`E2E_ONLY=phone` to run one check, `E2E_ONLY='review|search'` several; `KEEP_IMAGE=1` keeps the runner image
`bn-code-web-e2e:local`; `E2E_NAME=…` names the runner's image and container otherwise).

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
| `src/preview/` | file previews: `sniff.ts` (kinds by magic bytes, caps), `tt.ts` (the Trusted Types policy), `run.ts` (workers with a time budget), `csv.ts` / `tree.ts` / `notebook.ts` (parsers, run in `workers/`), `office/` (the bounded zip reader, its JSZip stand-in for mammoth, the HTML allowlist, the Word/Excel/PowerPoint readers, run in `workers/`), `images.ts` (a Markdown preview's images: once per path, within a budget), `pdflinks.ts` (what a PDF link may become), `ansi.ts` (terminal colours), `highlight.ts` (notebook code), `artifact.ts` (the sandboxed artifact viewer, seen from the page), `Preview.tsx` (bar, Markdown, images, media) and the lazily loaded `PdfView.tsx`, `TableView.tsx` (CSV and the grid), `SheetView.tsx`, `DocView.tsx`, `DeckView.tsx`, `NotebookView.tsx`, `TreeView.tsx`, `MathTex.tsx` (KaTeX), `ArtifactView.tsx` (HTML, Mermaid, notebook outputs) |
| `src/artifact/` | the artifact viewer's own pages' scripts (served only on the artifact site): `runner.ts` (an HTML file as its own document), `mermaid.ts` (diagrams → SVG) |
| `src/mathtext.ts` | `$…$` / `$$…$$` found in Markdown before lexing (linear), as placeholders markdown.ts turns into formulas |
| `src/transcript.ts` | the latest to-do list, the conversation as Markdown |
| `src/review.ts` | the Review pane's model: files from git's view or the session's edits, hunk ids, reverse patches, line comments |
| `src/fuzzy.ts` | the command palette's matcher (linear time: a greedy pass and KMP, inputs capped) |
| `src/shortcuts.ts` | every keyboard shortcut, in one list (the shortcut sheet, the empty editor, the palette's hints) |
| `src/questions.ts` | AskUserQuestion: questions from the tool's input, answers from your picks |
| `src/forms.ts` | small parsers for the MCP form (KEY=value, Name: value) |
| `src/components/` | Shell (layouts, top bar, status bar, terminal, global keys), Chat, MessageList, ToolCard, PermissionCard (incl. the question form), Composer (with the comment chips), FileTree, EditorArea, SessionList, Pickers, Plugins (dialog), Mcp (panel), Memory (CLAUDE.md dialog), Review (pane), Search (panel), CommandPalette |
| `dev/` | the mock backend and `npm run dev`; `preview-fixtures.mjs` (the previews' fixtures, also written to `tests/e2e/browser/fixtures/previews`; `office-fixtures.mjs`: part 2's, made byte by byte) |
| `e2e/` | the browser checks |
