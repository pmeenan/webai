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
  exact feature set beyond that is being triaged — see
  [docs/features.md](docs/features.md).)
- **Chrome-first, cross-browser-friendly.** Newest Chrome capabilities are used where
  present; other browsers degrade gracefully, and the differences become published
  findings.

Hosted at https://meenan.dev/webai/ (once launched). Licensed under
[Apache-2.0](LICENSE).

Almost all code in this repository is written by AI agents working from the project
documentation, directed and reviewed by a human.

## Status

Pre-code: **M0 (plan the plan)** — see [docs/plan.md](docs/plan.md). Application
scaffolding lands in M1; until then there is nothing to build or run.

## Start here

- [AGENTS.md](AGENTS.md) — project rules, constraints, and doc map (for agents and
  humans)
- [docs/vision.md](docs/vision.md) — what this is and what success means
- [docs/features.md](docs/features.md) — the feature matrix under discussion
- [docs/plan.md](docs/plan.md) — milestone ladder and current status
- [docs/workflow.md](docs/workflow.md) — how AI agents and the human collaborate here
- [docs/rough-edges.md](docs/rough-edges.md) — platform findings log
