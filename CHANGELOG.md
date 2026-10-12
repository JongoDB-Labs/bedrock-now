# Changelog

All notable changes to bedrock-now are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- A stopped install keeps its Compose project name. Before, once one checkout ran `./stack down`, another
  set-up checkout with the same name could start on its data volumes (wrong database password) or delete them
  with `./stack uninstall`. The first checkout that uses a project now records itself in an empty Docker volume
  `<project>_bedrock-now-owner`; other folders are refused while that install still has data. Existing volumes
  are claimed by the first checkout that runs a command after the upgrade. A record whose folder is gone
  (moved or deleted checkout) is replaced. The data volumes are not labelled: Compose would offer to recreate
  them, deleting the data, whenever a volume label changes.
- `./stack uninstall` lists the data volumes it will delete, refuses when they belong to another folder (also
  without a `.env`), and removes the ownership record afterwards.
- Clash messages only suggest `COMPOSE_PROJECT_NAME=<name>-2 ./setup.sh` on a first setup, where it works. A
  checkout that is already set up is told to keep only one of the two installs. A clash with a Compose project
  that is not bedrock-now is named as such ("another Compose project in <dir>").
- `./stack status` shows the clash as a warning and still prints its table.
- `./stack update` checks for local changes to tracked files before it takes (or prunes) a backup.
- After a failed `./stack update` on a branch, the way back is `git -C <dir> switch -C <branch> <commit>`, so you
  stay on your branch; release-tag installs keep `git -C <dir> checkout <commit>`.

## [0.1.2] - 2026-10-12

### Fixed

- Two checkouts can no longer share one Docker Compose project. Every `./stack` command refuses when another
  folder already runs the same project name, and a first setup refuses to start on existing data volumes of
  that name (their database password would not match). Before, a second install with the default name reused
  the first one's volumes (LiteLLM failed with `P1000 Authentication failed`) and recreated its containers.
- `./stack update` takes the backup **before** changing the code (steps 1/4 backup, 2/4 code, 3/4 images,
  4/4 setup). If a later step fails it prints the exact way back (`git -C <dir> checkout <commit> &&
  ./stack restore <backup>`), and it keeps `--yes` when it continues with the new code.
- The newest release tag ignores pre-releases (`v0.2.0-rc1`) in both `./stack update` and the installer, and
  `./stack update` without `--to` never moves to an older version than you have.
- A failed checkout shows git's own error message.
- Installer: a bad `BEDROCK_NOW_REF` explains how to recover (`git -C <dir> checkout <ref>` or `rm -rf <dir>`),
  paths in its hints are shell-quoted, and `BEDROCK_NOW_REPO` is documented.

## [0.1.1] - 2026-10-12

### Added

- One-line installer: `curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash`
  checks prerequisites (with per-OS install hints), clones the latest release into `~/bedrock-now`
  (`BEDROCK_NOW_DIR`, `BEDROCK_NOW_REF`), never overwrites an existing folder, and starts setup.
- `./stack models` prints the model table from the last check without calling Bedrock; `--recheck` re-probes.
  Results are saved to `litellm/probe-results.tsv`.
- A third LiteLLM virtual key, `setup` (`BUDGET_SETUP`, default $5), pays for the model probe and the paid
  `./stack test` calls. `./stack test` checks the other keys with free `/key/info` calls.
- `./stack costs` lists the `setup` key and a total across all keys (last 30 days, from `/global/spend`).
- `./stack update` also updates the code: a release-tag install moves to the newest tag
  (`updating v0.1.0 → v0.1.1`), a branch checkout gets `git pull --ff-only`, and `--to <tag|branch>` picks a
  version. Local changes to tracked files stop the update; they are never discarded.
- `NO_COLOR` turns all colours off.

### Changed

- Setup and `./stack up` print one line per phase with elapsed time (`==> LiteLLM ready (16s)`) instead of raw
  compose output; on failure they show the last output and service log lines plus a `./stack logs` hint.
  `BEDROCK_NOW_VERBOSE=1` restores the full compose output. Missing images are announced (with size) and
  downloaded up front with progress.
- Setup announces its decisions: each moved port in one line (`port 8080 is in use → using 8083 for Open WebUI`),
  the Open WebUI admin email and where it came from. The "use the AWS key from your environment?" prompt
  defaults to Yes for a long-lived (AKIA…) key.
- The model table fits 100 columns (MODEL, KIND, coloured STATUS, PRICE, short WHY) with one footnote per
  reason and its action. Marketplace denials show as "no Marketplace access", other "no access to the model"
  denials as "no model access"; when LiteLLM reports a bare AccessDenied (e.g. for rerank), a free direct
  Bedrock check finds the precise cause.
- `./stack status` is a compact SERVICE / STATE / HEALTH / URL table instead of raw `docker compose ps`.
- `./stack help` marks the commands that call Bedrock and what they cost; `claude-bedrock --help` starts with a
  six-line header about the wrapper, and `--help`/`--version` no longer print the launch cost line or need
  LiteLLM running.
- Budgets are described the same way everywhere: monthly budget (resets on the date shown by `./stack costs`).
- The setup summary shows a `claude-bedrock` command that works as typed (absolute path when the
  `~/.local/bin` link is missing or not on PATH) and a "Try it" line with Haiku (~$0.02).
- `./stack status` says "the Docker daemon is not running" instead of showing every service as not created.

### Fixed

- Tables and the setup summary no longer write colour codes when stdout is piped (colours are chosen per stream).
- `./stack costs` shows $0.00 when nothing has been spent yet and the HTTP status when LiteLLM refuses the
  total.
- `claude-bedrock --help` before setup says "not set up yet" instead of printing an empty port and price.
- Temporary files from bring-up and the model probe are removed on Ctrl-C.
- `./stack models` skips incomplete lines in `litellm/probe-results.tsv` with one warning.

## [0.1.0] - 2026-10-12

Initial public release.

- `./stack` CLI (bash 3.2-compatible): `setup`, `up`/`down`, `status`, `logs`, `test`, `costs`,
  `backup`/`restore`, `update`, `rotate-aws`, `uninstall`.
- Docker Compose stack bound to 127.0.0.1: LiteLLM (Bedrock proxy, virtual keys with monthly budgets),
  Open WebUI, Postgres (pgvector), RustFS object store, and a shared MCP server.
- Setup probes which catalog models your AWS key can use (1-token requests, free checks for images)
  and renders the LiteLLM config from `catalog/models.tsv` and `catalog/prices.tsv`.
- `bin/claude-bedrock`: runs Claude Code against Bedrock through LiteLLM without touching plain `claude`.
- Cost transparency: Bedrock prices in `./stack costs` and the Open WebUI model picker, spend per key.

[Unreleased]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v0.1.0
