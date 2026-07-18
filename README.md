# WebAI

Test LLMs *in your browser*. WebAI is a fully client-side workbench for discovering,
downloading, and evaluating Hugging Face models across in-browser inference runtimes
(wllama, transformers.js, and more) and execution backends (WASM on CPU, WebGPU,
WebNN), alongside browser-managed models (Chrome's built-in Gemini Nano via the
Prompt API) as a separate no-download path — so developers can pick the right model,
quantization, and library for their needs with real numbers from their own hardware.

- **No server, no upload, no telemetry.** Models and results live in your browser
  (OPFS); the only network traffic is the model downloads and Hugging Face queries
  you initiate.
- **Chat and benchmark.** A streaming chat UI with a configurable system prompt, plus
  dataset-driven benchmarking that captures performance and memory results. (The
  full confirmed feature set is in [docs/features.md](docs/features.md).)
- **Chrome-first, cross-browser-friendly.** Newest Chrome capabilities are used where
  present; other browsers degrade gracefully, and the differences become published
  findings.

Hosted at https://webai.meenan.dev/. Licensed under
[Apache-2.0](LICENSE).

Almost all code in this repository is written by AI agents working from the project
documentation, directed and reviewed by a human.

## Status

**M0 and M1 are complete. M2 implementation is review-ready and awaiting live deploy
verification.** Manual Hugging Face/local acquisition, verified resumable downloads,
managed browser storage, and GGUF inspection pass locally — see
[docs/plan.md](docs/plan.md).

## Develop

Requirements: Node 24.16+ and Corepack.

```sh
corepack pnpm install
corepack pnpm dev
```

The development and preview servers emit the same COOP/COEP isolation headers used
in production. The full local gate is:

```sh
corepack pnpm exec playwright install chromium
corepack pnpm check
corepack pnpm build
```

`pnpm check` runs format-check, lint, strict Astro/TypeScript checking, Vitest browser
tests, Playwright end-to-end tests, and the full dependency-license audit, including
verification that the deployable third-party notice file matches the pinned production
closure. Regenerate that file after dependency changes with
`corepack pnpm license:notices`. The production deploy is intentionally explicit:
`corepack pnpm deploy` runs that full gate, rebuilds the release artifact, rsyncs
`dist/` into a staged remote release, atomically promotes it under a remote transaction
lock, and rolls back if public route, asset, isolation-header, or controller checks
fail. The deployment host requires `flock`, Python 3, and Linux
`renameat2(RENAME_EXCHANGE)` for the one-time legacy-directory migration.

## Start here

- [AGENTS.md](AGENTS.md) — project rules, constraints, and doc map (for agents and
  humans)
- [docs/vision.md](docs/vision.md) — what this is and what success means
- [docs/features.md](docs/features.md) — the feature matrix under discussion
- [docs/plan.md](docs/plan.md) — milestone ladder and current status
- [docs/workflow.md](docs/workflow.md) — how AI agents and the human collaborate here
- [docs/rough-edges.md](docs/rough-edges.md) — platform findings log
