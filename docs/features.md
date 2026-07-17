# Feature matrix

The scope ledger for the M0 planning conversations. Three tiers:

- **Confirmed** — stated project scope. Milestone assignment happens in
  [plan.md](plan.md) as the plan firms up.
- **Proposed** — candidate additions awaiting a yes/no from the project owner. Each
  gets promoted to Confirmed or moved to Rejected (with a decision-log entry when the
  reasoning is worth keeping).
- **Open questions** — things that shape architecture and need an answer during M0.

Status legend: `confirmed` · `proposed` · `rejected (D-NNN)`

## Model discovery & acquisition

| Feature | Status | Notes |
| --- | --- | --- |
| Hugging Face model search/browse with in-browser-suitability filters (size, format, quant, task) | confirmed | Uses the public HF REST API from the client |
| Direct model download from Hugging Face into local storage | confirmed | |
| Local model management in OPFS (list, inspect, delete, storage usage) | confirmed | |
| User-provided model import (file picker / drag-drop, incl. multi-file sharded models) | confirmed | |
| GGUF splitting via a wasm build of llama.cpp's gguf-split | confirmed | Modified tooling, upstream MIT |
| Resumable, integrity-checked downloads (HTTP Range + hash from HF LFS metadata, survive tab close) | proposed | Multi-GB files over flaky connections; re-downloading from zero is brutal |
| HF token support for gated models (Llama, Gemma; token stored locally only) | proposed | Many of the most-tested model families are gated |
| Surface model license + gating status before download | proposed | Low cost, keeps users out of accidental license trouble |
| Model file metadata inspector (GGUF/ONNX header: arch, context length, quant per-tensor, chat template) | proposed | Cheap to build once parsers exist; high tinkerer value |
| Storage quota display, `navigator.storage.persist()`, eviction awareness, cross-runtime cache accounting (transformers.js caches separately from raw GGUFs) | proposed | Users will hit quota walls; opaque failure here is fatal to trust |

## Runtimes & backends

| Feature | Status | Notes |
| --- | --- | --- |
| wllama (llama.cpp wasm; CPU, single/multi-thread) | confirmed | Multi-thread needs SharedArrayBuffer → COOP/COEP (see architecture open questions) |
| transformers.js (wasm / WebGPU / WebNN via ONNX Runtime Web) | confirmed | |
| Chrome built-in Prompt API, including model download flow | confirmed | Browser-managed Gemini Nano only — a separate acquisition path from HF downloads; window-only, not available in workers (D-007); Chrome 138+ stable (checked 2026-07-17). Availability/API state changes fast — re-verify when building (root rule 4) |
| Additional runtimes selected by the M0 survey | confirmed | Bounded scope: the M0 survey produces the candidate list against fixed criteria (permissive license, actively maintained, fully client-side, adds a distinct backend/format/capability); post-survey additions each need a decision entry |
| WebLLM (MLC) — the de-facto standard WebGPU LLM runtime | proposed | Arguably the biggest gap in the confirmed list |
| MediaPipe LLM Inference API | proposed | Google's packaged web LLM path; .task/.litertlm formats |
| ONNX Runtime Web used directly (not through transformers.js) | proposed | Isolates ORT behavior from transformers.js behavior |
| Runtime/backend capability report (WebGPU adapter+features+limits incl. shader-f16, wasm SIMD/threads, WebNN device types, crossOriginIsolated, quota) | proposed | The "why doesn't X work here" diagnostic; also the suitability-filter input |

## Chat & testing surface

| Feature | Status | Notes |
| --- | --- | --- |
| Text chat UI (slick; streaming responses) | confirmed | |
| System prompt configuration | confirmed | |
| Multimodal input (image, later audio) for models/runtimes that support it | confirmed | Phased after text-only |
| Generation parameter controls (temperature, top-p/k, max tokens, repeat penalty, seed, context size) per session | proposed | Table stakes for a testing tool; seed matters for reproducibility |
| Stop/abort generation, regenerate, edit-and-resend | proposed | |
| Side-by-side comparison: same prompt, N model/runtime/backend combos | proposed | Directly serves the core "pick a model" use case |
| Chat history persistence + conversation export/import (JSON/Markdown) | proposed | |
| Token count / context-window usage display; tokenizer inspector | proposed | |
| Structured output testing (JSON schema / GBNF grammars / Prompt API constraints) where runtimes support it | proposed | Increasingly the reason developers want local models |
| Tool/function-calling test harness | proposed | Later phase; depends on runtime support |
| Prompt library: saved/named prompts and reusable test sets | proposed | Pairs with benchmarking |

## Benchmarking & measurement

| Feature | Status | Notes |
| --- | --- | --- |
| Benchmark runs over configured datasets, capturing memory + performance | confirmed | |
| Standard metric set: model load (cold/warm), time-to-first-token, prefill tok/s, decode tok/s, memory via sampled `measureUserAgentSpecificMemory` (point-in-time estimate of app-attributed memory incl. workers/iframes; requires crossOriginIsolated; a "peak" requires a defined sampling cadence), storage footprint | proposed | Defines "comparable numbers" across runtimes; sampling, attribution, and comparability rules are part of the design ([spec](https://wicg.github.io/performance-measure-memory/), checked 2026-07-17) |
| Multiple iterations with median/p95 and variance reporting | proposed | Single-shot browser numbers are noise |
| Long-context / KV-cache growth stress test | proposed | Where in-browser setups actually fall over |
| Sustained-throughput degradation run (thermal/throttling proxy) | proposed | |
| Results export (JSON/CSV) + local results history | proposed | No server, so export is how numbers leave the machine |
| Shareable config permalinks (model+runtime+params encoded in URL — config only, not results) | proposed | "Try what I tried" without hosting user data |

## App platform

| Feature | Status | Notes |
| --- | --- | --- |
| Static Astro site, rsync-deployable, testable locally in dev mode | confirmed | |
| Chrome-primary, cross-browser where feasible | confirmed | |
| Diagnostics pane / downloadable diagnostic report (runtime logs, environment, errors) | proposed | Debugging user reports with no telemetry requires user-carried diagnostics |
| PWA/offline: the tool itself works offline once installed (models are already local) | proposed | Natural fit; adds service-worker complexity |
| Embeddings-model testing (feature-extraction pipelines) | proposed | Adjacent audience; explicitly later-phase if accepted |

## Open questions (answer during M0)

1. **Cross-origin isolation.** wllama multi-thread and `measureUserAgentSpecificMemory`
   need `crossOriginIsolated` (COOP/COEP headers), but COEP constrains cross-origin
   fetches (HF downloads/APIs) and any embedded content. Serve the whole app isolated,
   only some routes, or use `COEP: credentialless`? Needs a spike against real HF
   endpoints and the meenan.dev server config.
2. **Mobile.** Is Chrome-on-Android (and its memory ceilings) a supported target or
   explicitly best-effort?
3. **Model storage layout.** One shared OPFS store with per-runtime adapters, or let
   each runtime keep its native cache? Affects dedup, quota accounting, and import.
4. **Benchmark honesty.** What can we actually measure per backend (GPU memory is
   largely opaque; wasm heap vs JS heap), and how do we label what we can't?
5. **Prompt API surface.** Current availability (stable/origin-trial, web vs
   extension), download UX, and what parameters/multimodal it exposes — verify against
   current Chrome docs at build time.
6. **Naming.** Is "WebAI" the product name or a working title?
7. **Dataset format for benchmarks.** Bring-your-own JSON? Ship curated default sets?
   License implications of bundling datasets?
8. **Shared-origin storage.** OPFS, IndexedDB, Cache Storage, quota, and persistence
   are scoped to the https://meenan.dev origin, not to `/webai/` — shared with
   anything else ever hosted on that domain (currently only a placeholder page,
   checked 2026-07-17). Accept the shared storage/security model explicitly, or use a
   dedicated origin (e.g., webai.meenan.dev)? Fold into the M0 hosting spike; the
   answer annotates or supersedes D-001.
