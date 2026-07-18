# Feature matrix

The scope ledger. The M0 feature triage (2026-07-17, owner walk — verdicts and
rationale in D-010) plus the runtime survey (D-011) resolved every `proposed` row.
The hosting spike (D-012) answered question 1 and validated question 8; the architecture
draft answered the final questions 3 and 4 (D-014, D-015).

- **Confirmed** — stated project scope. Milestone assignment lives in
  [plan.md](plan.md); milestone references in notes here are informative.
- **Proposed** — candidate additions awaiting a verdict.
- **Parked** — off the roadmap, but re-openable with evidence (see the decision entry).
- **Rejected** — out of scope; re-proposal needs new evidence (see the decision entry).

Status legend: `confirmed · proposed · parked (D-NNN) · rejected (D-NNN)`

## Model discovery & acquisition

| Feature | Status | Notes |
| --- | --- | --- |
| Hugging Face model search/browse with in-browser-suitability filters (size, format, quant, task) | confirmed | Two-stage browser flow: server-filter candidates by task/tags, then cache revision-pinned file enrichment for client-side size/quant/runtime suitability (D-013) |
| Direct model download from Hugging Face into local storage | confirmed | Immutable commit + per-file integrity identity (LFS SHA-256 required for weights; Git-blob identity for selected non-LFS companions); fresh resolver request for every range (D-013) |
| Local model management in OPFS (list, inspect, delete, storage usage) | confirmed | |
| User-provided model import (file picker / drag-drop, incl. multi-file sharded models) | confirmed | |
| GGUF splitting via a wasm build of llama.cpp's gguf-split | confirmed | Modified tooling, upstream MIT; runs as a streaming stage of the download pipeline (D-009) |
| Resumable, integrity-checked downloads (HTTP Range + hash from HF LFS metadata, survive tab close) | confirmed | M2 protocol fixed by D-013: commit-pinned identity, fresh per-range resolution, strict `Content-Range`, full LFS SHA-256 before promotion. M7 native caches must integrate the shared path or demonstrate equivalent behavior (D-010, D-011) |
| HF token support for gated models (Llama, Gemma; token stored locally only) | confirmed | M5. Many of the most-tested model families are gated (D-010) |
| Surface model license + gating status before download | confirmed | M5. Low cost, keeps users out of accidental license trouble (D-010) |
| Model file metadata inspector (GGUF/ONNX header: arch, context length, quant per-tensor, chat template) | confirmed | GGUF side lands M2 — doubles as the download-verification surface before inference exists; ONNX side lands M7 with the format's first runtime (D-010) |
| Storage quota display, `navigator.storage.persist()`, eviction awareness, cross-runtime cache accounting (transformers.js caches separately from raw GGUFs) | confirmed | Quota/persistence/eviction UX lands M2; cross-runtime cache accounting extends in M7 when the first non-OPFS native cache (transformers.js) arrives. Users will hit quota walls; opaque failure here is fatal to trust (D-010) |

## Runtimes & backends

| Feature | Status | Notes |
| --- | --- | --- |
| wllama (llama.cpp wasm; CPU single/multi-thread + WebGPU) | confirmed | Thread count and WebGPU layer offload are independent; every multi-thread combination needs SharedArrayBuffer → the app-wide COOP/COEP policy in D-012. WebGPU is on by default since wllama v3.1; v3.5.1 current, MIT. Runtime/compat wasm is self-hosted; the default jsDelivr fallback is forbidden by D-005 (surveyed 2026-07-17, D-011) |
| transformers.js (wasm / WebGPU / WebNN via ONNX Runtime Web) | confirmed | v4.2.0 current; WebNN exists in tagged source but remains per-model/browser experimental and must be measured (D-011) |
| Chrome built-in Prompt API, including model download flow | confirmed | Browser-managed Gemini Nano only — a separate acquisition path from HF downloads; window-only, not available in workers (D-007); available to web pages in stable Chrome from 148, but the web API remains under development and sampling parameters remain in an origin trial (Chrome 138 was the extension surface; corrected by D-011). Availability/API state changes fast — re-verify when building (root rule 4) |
| Additional runtimes selected by the M0 survey | confirmed | Survey closed (D-011): LiteRT-LM selected provisionally; WebLLM's condition passed. Post-survey additions each need a decision entry and the same fixed criteria (permissive, active, fully client-side, distinct capability) |
| WebLLM (MLC) — the de-facto standard WebGPU LLM runtime | confirmed | M7; Apache-2.0 and active at 0.2.84, so D-010's survey condition passed. D-005 requires a custom HF-only model catalog and version-pinned first-party model-library wasm instead of the default GitHub binary URLs (D-011) |
| LiteRT-LM JavaScript (`.litertlm`, WebGPU) | confirmed | M7, provisional because the 0.14 web API is early preview; revalidate no-telemetry behavior and dedicated-worker viability before implementation (D-011) |
| MediaPipe LLM Inference API | rejected (D-011) | Maintenance-only and superseded by LiteRT-LM; its documented Tasks metrics also conflict with D-005 unless proven disableable |
| ONNX Runtime Web used directly (not through transformers.js) | parked (D-010) | Reopen if isolating ORT behavior from transformers.js becomes necessary for debugging |
| Runtime/backend capability report (WebGPU adapter+features+limits incl. shader-f16, wasm SIMD/threads, WebNN device types, crossOriginIsolated, quota) | confirmed | M1 — the "why doesn't X work here" diagnostic; also the suitability-filter input (D-010) |

## Chat & testing surface

| Feature | Status | Notes |
| --- | --- | --- |
| Text chat UI (slick; streaming responses) | confirmed | |
| System prompt configuration | confirmed | |
| Multimodal input (image, later audio) for models/runtimes that support it | confirmed | Phased after text-only; image lands M9, audio is confirmed but deliberately unscheduled until image proves the pipeline |
| Generation parameter controls (temperature, top-p/k, max tokens, repeat penalty, seed, context size) per session | confirmed | M6. Table stakes for a testing tool; seed matters for reproducibility (D-010) |
| Stop/abort generation, regenerate, edit-and-resend | confirmed | M6 (D-010) |
| Side-by-side comparison: same prompt, N model/runtime/backend combos | confirmed | M7. Directly serves the core "pick a model" use case (D-010) |
| Chat history persistence + conversation export/import (JSON/Markdown) | confirmed | M6 (D-010) |
| Token count / context-window usage display; tokenizer inspector | confirmed | M6 (D-010) |
| Context caching (system-prompt / KV-prefix reuse) where the runtime supports it | confirmed | M6. Added at triage — owner's original scope, previously missing a row (D-010) |
| Structured output testing (JSON schema / GBNF grammars / Prompt API constraints) where runtimes support it | confirmed | M7 — inherently per-adapter capability work, lands with runtime breadth. Increasingly the reason developers want local models (D-010) |
| Tool/function-calling test harness | confirmed | M9+. Depends on structured output landing first (D-010) |
| Prompt library: saved/named prompts and reusable test sets | confirmed | M8 — saved prompt sets and benchmark datasets share one design (D-010) |

## Benchmarking & measurement

| Feature | Status | Notes |
| --- | --- | --- |
| Benchmark runs over configured datasets, capturing memory + performance | confirmed | |
| Standard metric set: model load (cold/warm), time-to-first-token, prefill tok/s, decode tok/s, memory via sampled `measureUserAgentSpecificMemory` (point-in-time estimate of app-attributed memory incl. workers/iframes; requires crossOriginIsolated; a "peak" requires a defined sampling cadence), storage footprint | confirmed | M8. Defines "comparable numbers" across runtimes; sampling, attribution, and comparability rules are part of the design ([spec](https://wicg.github.io/performance-measure-memory/), checked 2026-07-17) (D-010) |
| Multiple iterations with median/p95 and variance reporting | confirmed | M8. Single-shot browser numbers are noise (D-010) |
| Long-context / KV-cache growth stress test | confirmed | M11 (post-launch) — keeps M8 shippable while committing to the differentiator (D-010) |
| Sustained-throughput degradation run (thermal/throttling proxy) | confirmed | M11 (post-launch) (D-010) |
| Results export (JSON/CSV) + local results history | confirmed | M8. No server, so export is how numbers leave the machine (D-010) |
| Shareable config permalinks (model+runtime+params encoded in URL — config only, not results) | confirmed | M10. "Try what I tried" without hosting user data (D-010) |

## App platform

| Feature | Status | Notes |
| --- | --- | --- |
| Static Astro site, rsync-deployable, testable locally in dev mode | confirmed | |
| Chrome-primary, cross-browser where feasible | confirmed | |
| Diagnostics pane / downloadable diagnostic report (runtime logs, environment, errors) | confirmed | M10. Debugging user reports with no telemetry requires user-carried diagnostics (D-010) |
| PWA/offline: the tool itself works offline once installed (models are already local) | confirmed | M10. Service-worker design must respect the isolation-header outcome of the M0 hosting spike (D-010) |
| Embeddings-model testing (feature-extraction pipelines) | rejected (D-010) | Keeps v1 tight on the chat/benchmark loop; re-proposable post-launch |

## Open questions

Questions 2, 5, 6, 7, and 8 were answered at the 2026-07-17 triage (D-010), and the
hosting spike answered question 1 while validating question 8 (D-012). The M0
architecture draft answered questions 3 and 4 (D-014, D-015). The final `proposed`
runtime row was resolved by D-011.

1. **Cross-origin isolation.** *Answered (D-012):* isolate the whole WebAI app with
   `COOP: same-origin` and `COEP: require-corp`. Chrome 150 successfully fetched the
   HF API plus small and ranged LFS/Xet artifacts—including Authorization preflight
   and redirects—from an isolated page, so `credentialless` adds no needed
   capability. M1 repeats the probe from production.
2. **Mobile.** *Answered (D-010): best-effort.* Nothing is gated on mobile; it works
   where it works, failures are logged as rough-edges findings, and v1 makes no
   mobile-specific UX investment.
3. **Model storage layout.** *Answered (D-014):* one WebAI manifest and model manager
   over hybrid physical storage. App-owned artifacts use OPFS; unavoidable native and
   browser-managed caches stay adapter-owned but are inventoried where observable and
   must demonstrate the common resume/integrity guarantees. Byte counts state their
   scope and confidence.
4. **Benchmark honesty.** *Answered (D-015):* every metric carries source, scope,
   support state, and caveats. Unsupported token/memory dimensions are unavailable,
   not inferred; sampled attributed memory is “maximum observed sample,” never a
   claimed true peak; comparisons flag incompatible measurement contexts.
5. **Prompt API surface.** *Answered (D-010): closed as process.* Root rule 4 already
   mandates verifying the current API surface (availability, download UX, parameters,
   multimodal) against current Chrome docs at build time; no separate planning answer
   is needed.
6. **Naming.** *Answered (D-010):* **WebAI is the product name**, not a working
   title.
7. **Dataset format for benchmarks.** *Answered (D-010):* bring-your-own JSON against
   a documented schema, plus one small bundled default set with a verified-permissive
   license so benchmarking demos out of the box.
8. **Shared-origin storage.** *Answered (D-010), verified (D-012):* stay at
   https://meenan.dev/webai/ and explicitly accept the shared-origin storage/security
   model. Live nginx inspection, browser HF CORS measurements, and specification-based
   origin-storage/service-worker analysis found no blocker. A dedicated domain
   remains the owner-approved fallback if a D-012 reopen trigger appears.
