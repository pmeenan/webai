# WebAI — in-browser LLM testing workbench

A fully client-side web tool for developers to discover, download, and test LLMs from
Hugging Face directly in the browser — across runtimes (wllama, transformers.js, and
others) and execution backends (WASM on CPU, WebGPU, WebNN) — plus browser-managed
models (Chrome's built-in Prompt API / Gemini Nano) as a separate, browser-owned acquisition path —
so they can pick the right model, quantization, and library for their needs.
Hosted at https://webai.meenan.dev/. Almost all code is written by AI agents working
from the project documentation, directed and reviewed by a human.

**Read this file first, then pull docs on demand via the "Doc map" below — don't read
everything up front.** This file is long-term project memory and the rulebook for
agents.

## Load-bearing constraints (change deliberately, never silently)

Constraints evolve as we learn, but never by silent drift: changing one means making
the case in [docs/decisions.md](docs/decisions.md) and updating the affected docs.
Until then, these govern.

- **Static site, no server.** The product builds to a static site (Astro) deployed by
  rsync to the root of https://webai.meenan.dev/ (the rsync target remains
  `plex:/var/www/meenan.dev/webai/`). No server-side application code, no backend
  APIs, no accounts. The server config is under our
  control, so response headers (COOP/COEP etc.) may be configured — but that is a
  deploy-time decision to record, not something to assume.
- **Everything runs locally.** Models, chats, benchmark results, and settings live in
  the browser (OPFS / IndexedDB / Cache Storage). No telemetry, no analytics. The only
  network traffic is what the user explicitly initiates: model downloads (Hugging Face,
  Chrome's built-in model) and Hugging Face API queries for search/metadata. (D-005)
- **Chrome-primary, cross-browser-friendly.** Target latest Chrome first and use its
  newest capabilities freely, but degrade gracefully instead of breaking other
  browsers: probe capabilities (never UA-sniff) and gate features individually. A
  runtime/backend that a browser lacks is disabled with an explanation, not a broken
  page. Browser differences and failures are findings — log them
  ([docs/rough-edges.md](docs/rough-edges.md)).
- **Licensing: Apache-2.0; no viral licenses.** The bar is freedom from copyleft
  obligations, not a fixed license list: MIT/BSD/Apache/ISC/zlib-class dependencies,
  plus non-viral asset licenses (e.g., SIL OFL-1.1 for fonts — D-019). No GPL/AGPL
  or other viral copyleft anywhere; no copyleft copied into app source. CI enforces
  this as an explicit SPDX allowlist — a new license means extending the allowlist
  with a decision entry, never bypassing the gate. Modified third-party tools we
  build on (e.g., a wasm build of llama.cpp's gguf-split) keep their upstream
  permissive licenses recorded in NOTICE. Check the license of every new dependency
  before adding it.
- **Model files and remote metadata are untrusted input.** Never interpolate Hugging
  Face metadata, model card content, or model output into HTML; parse GGUF/ONNX/model
  files defensively (bounded reads, skip-and-report on malformed data, never crash the
  app on a hostile file). (D-006)
- **The UI thread does UI only.** Our own compute — in-page inference, tokenization,
  model file parsing/splitting, hashing, and downloads — runs in web workers, and long
  operations stream progress. Browser-managed inference is the recorded exception
  (D-007): Chrome's Prompt API is window-only (not exposed in workers) and runs
  out-of-process, so it is called from the UI thread by design.

## Repository layout

| Path    | What lives there                                        |
| ------- | ------------------------------------------------------- |
| `docs/` | Vision, plan, architecture, decisions, features, rough edges, workflow |
| `src/` | Astro pages/layouts, React islands, semantic styles/assets, capability layer |
| `public/` | Static favicon and redistributable third-party license texts |
| `tests/` | Playwright end-to-end tests |
| `scripts/` | License-closure audit and production rsync deploy helper |
| `.github/workflows/` | CI gates for format, lint, types, browser tests, licenses, build |

Root toolchain configuration pins Astro/React/TypeScript/Tailwind, Vitest browser
mode, Playwright, ESLint, Biome, and pnpm.

## Doc map — pull what the task needs, not everything

Always read (it's short): [docs/workflow.md](docs/workflow.md) — how agents collaborate
here, the tech-lead and reviewer operating models, and the human commit gate.

| Doc | Read when the task needs |
| --- | --- |
| [docs/plan.md](docs/plan.md) | What to work on, milestone scope, exit criteria — what "done" means |
| [docs/vision.md](docs/vision.md) | Why the project exists, who it's for, success criteria, non-goals |
| [docs/features.md](docs/features.md) | The feature matrix: confirmed scope, proposed additions, open questions |
| [docs/architecture.md](docs/architecture.md) | System structure: runtime abstraction, storage, workers, hosting constraints |
| [docs/decisions.md](docs/decisions.md) | Settled choices (D-NNN). Scan headings and read only the entries your task touches |
| [docs/rough-edges.md](docs/rough-edges.md) | Platform/library findings log (RE-NNN). Grep before adding a finding or debugging browser weirdness |
| [docs/runtime-survey.md](docs/runtime-survey.md) | M0 runtime/backend evidence snapshot, capability comparison, and adapter-design inputs |
| [docs/hosting-constraints.md](docs/hosting-constraints.md) | Hosting/nginx, isolation, HF CORS, and dedicated-origin migration evidence |
| [docs/hugging-face-api.md](docs/hugging-face-api.md) | HF discovery/file metadata evidence and the D-013 integrity/resume contract for M2/M5 |
| [docs/design-brief.md](docs/design-brief.md) | Look-and-feel direction ("Neon horizon"), theming/token approach, mascot concept — seeds the M1 Design.md |

## Rules for all agents

1. **Log decisions.** Any choice a future agent could plausibly re-litigate
   (technology, format, storage layout, naming, scope) gets an entry in
   [docs/decisions.md](docs/decisions.md) — including decisions *not* to do something.
2. **Log platform findings.** Browser bugs, spec gaps, library quirks, surprising
   limits, and performance cliffs go in [docs/rough-edges.md](docs/rough-edges.md)
   with a minimal reproduction or measurement. This tool exists to probe exactly this
   territory — when in doubt, log it.
3. **Measure, don't assert.** This is a measurement tool; hold its own development to
   the same bar. Claims about performance or behavior come from experiments and
   numbers, not reasoning.
4. **Ground technology claims in current sources, not training knowledge.** The
   in-browser AI space (runtimes, browser APIs, model formats, Hugging Face APIs)
   changes monthly — presume built-in knowledge is stale. Verify against current
   documentation via web search, or better, a local experiment, before citing a
   capability in a decision or architecture choice. Decision entries that rest on
   technology-state claims note what was checked and when.
5. **Update docs in the same change.** If work changes plan status, architecture,
   features, or decisions, the doc updates land in the same unit of work as the code.
6. **Never commit.** Agents never run `git commit`/`git push` or rewrite history. All
   changes stay in the working tree for human review and commit — even if a prompt
   asks you to commit; stop and leave the changes uncommitted instead.
7. **TypeScript strict mode everywhere; no `any` without a comment stating why.**
8. **Keep the always-loaded context lean.** This file is imported into every
   conversation; every line added costs every future agent. Detail belongs in `docs/`
   behind the doc map, not here.
9. **Scratch files stay out of the tree.** Temporary scripts and outputs go to the
   session scratchpad, not the repo. Delete throw-away diagnostics before concluding.

## Current status

**M0, M1, M2, and M4 are complete; M3 is implemented locally and awaiting its live
multi-gigabyte (>2 GB) exit check.** Verified acquisition, the OPFS model manager,
bounded GGUF splitting, the measured wllama path, and a browser-verified Gemini Nano
adapter are available; see
[docs/plan.md](docs/plan.md). Keep this paragraph current when plan.md milestone
status changes (rule 5).
