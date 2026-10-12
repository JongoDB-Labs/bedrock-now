# Changelog

All notable changes to bedrock-now are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Setup and `./stack up` print one line per phase with elapsed time (`==> LiteLLM ready (16s)`) instead of raw
  compose output; on failure they show the last output and service log lines plus a `./stack logs` hint.
  `BEDROCK_NOW_VERBOSE=1` restores the full compose output. Missing images are announced (with size) and
  downloaded up front with progress.
- Setup announces its decisions: each moved port in one line (`port 8080 is in use → using 8083 for Open WebUI`),
  the Open WebUI admin email and where it came from. The "use the AWS key from your environment?" prompt
  defaults to Yes for a long-lived (AKIA…) key.

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

[Unreleased]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v0.1.0
