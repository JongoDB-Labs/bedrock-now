# Changelog

All notable changes to bedrock-now are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
