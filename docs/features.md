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
| Hugging Face model search/browse with in-browser-suitability filters (size, current runtime/format, nominal quant bits, declared capabilities, minimum context) | confirmed | M5 complete: up to 128 server-filter pages / 1,024 candidates, a 32-MiB retained-record budget, two-wide revision-pinned enrichment, explicit match/needs-verification/excluded/unknown states, and a bounded anonymous SQLite/OPFS detail catalog. Size/quant use exact choices; capabilities are AND requirements over declared evidence, with contradictory primary tasks excluded and incomplete supplemental evidence retained as unverified; context remains declared metadata, not runtime proof. Stopping a long or rate-limited pass publishes the fully processed partial snapshot instead of discarding it. Acquisition is anonymous and restricted candidates are excluded (D-013, D-031, D-032, D-035, D-036, D-040, D-042). |
| Local HF metadata catalog and hierarchical result browser | confirmed | D-032 stores bounded explicitly public-and-open anonymous revision snapshots in disposable worker-owned SQLite/OPFS with a nonblocking memory fallback, never gated/authenticated bodies or secrets. A same-height, independently scrolling four-column browser facets broad declared family/architecture metadata (not proof of genealogy) → explicit immediate base model → repository variant → sticky details/pinned model-card/downloads. Confirmed family/model tiers sort before verification-only tiers and then by exact, missing-aware aggregate 30-day Hub downloads; repository rows show their individual reported count (D-034), and every tier reports exact immutable-revision downloaded state. The selected detail lazily expands a 32-repository reported ancestry graph to terminal bases, displaying linked base-to-selected names with branches, shared ancestors, cycles, progress/Stop, and a separate short-lived public SQLite lineage cache (D-033, D-036). Missing architecture/lineage remains explicit and is not guessed from repository names; filters auto-collapse after a valid search and remain reopenable, safe Hub cursor pages load automatically with progress, and Stop stays visible. |
| Direct model download from Hugging Face into local storage | confirmed | Immutable commit + per-file integrity identity (LFS SHA-256 required for weights; Git-blob identity for selected non-LFS companions); fresh resolver request for every range (D-013). M2 optionally pairs a same-directory LFS MTP sidecar using llama.cpp's labelled filename heuristic; the HF API does not supply associations (D-025). |
| Local model management in OPFS (list, inspect, delete, storage usage) | confirmed | |
| User-provided model import (file picker / drag-drop, incl. multi-file sharded models) | confirmed | |
| GGUF splitting via a wasm build of llama.cpp's gguf-split | confirmed | Modified tooling, upstream MIT. M3 selected split-after-verification as explicit or runtime-driven preparation: acquisition preserves the source, Chat prepares just in time at wllama's 2,000,000,000-byte per-file boundary, and smaller eligible monoliths offer an optional action (D-028 supersedes D-009's streaming choice). |
| Resumable, integrity-checked downloads (HTTP Range + hash from HF LFS metadata, survive tab close) | confirmed | M2 protocol fixed by D-013: commit-pinned identity, fresh per-range resolution, strict `Content-Range`, full LFS SHA-256 before promotion. M7 native caches must integrate the shared path or demonstrate equivalent behavior (D-010, D-011) |
| HF token support for gated/private models | rejected (D-042) | WebAI deliberately supports only anonymous acquisition of public, ungated repositories. No token is requested or retained. |
| Surface model license + gating status before download | confirmed | M5 surfaces bounded publisher metadata on browse and manual paths before download and retains it as non-secret source provenance (D-010, D-031). |
| Model file metadata inspector (GGUF/ONNX header: arch, context length, quant per-tensor, chat template) | confirmed | GGUF side lands M2 as repeatable best-effort metadata over installed bytes; SHA/size integrity, not parser compatibility, gates promotion. ONNX side lands M7 with the format's first runtime (D-010, D-025). |
| Storage quota display, `navigator.storage.persist()`, eviction awareness, cross-runtime cache accounting (transformers.js caches separately from raw GGUFs) | confirmed | Quota/persistence/eviction UX lands M2; cross-runtime cache accounting extends in M7 when the first non-OPFS native cache (transformers.js) arrives. Users will hit quota walls; opaque failure here is fatal to trust (D-010) |

## Runtimes & backends

| Feature | Status | Notes |
| --- | --- | --- |
| wllama (llama.cpp wasm; CPU single/multi-thread + WebGPU) | confirmed | Thread count and WebGPU layer offload are independent; every multi-thread combination needs SharedArrayBuffer → the app-wide COOP/COEP policy in D-012. WebGPU is on by default since wllama v3.1; v3.5.1 current, MIT. Runtime/compat wasm is self-hosted; the default jsDelivr fallback is forbidden by D-005 (surveyed 2026-07-17, D-011) |
| MTP/speculative-decoding capability and acceleration testing | confirmed | wllama 3.5.1 cannot mount an MTP companion separately: every non-mmproj blob becomes a target shard, and no MTP selector is exposed. M3 reports that exact unavailable reason; M7 maintains a versioned matrix and M8 benchmarks controllable paths (D-026, D-028). |
| transformers.js (wasm / WebGPU / WebNN via ONNX Runtime Web) | confirmed | v4.2.0 current; WebNN exists in tagged source but remains per-model/browser experimental and must be measured (D-011) |
| Chrome built-in Prompt API, including model download flow | confirmed | M4 implemented locally (D-030). Browser-managed Gemini Nano only — a separate acquisition path from HF downloads; window-only, not available in workers (D-007); available to web pages in stable Chrome from 148. Stable web exposes availability, normalized download progress, stateful streaming, `initialPrompts` restoration, context usage/window and overflow, abort, and destroy, but no sampling controls or backend identity; sampling remains experimental/origin-trial-only (re-verified 2026-07-19). Availability remains a volatile probe, never a browser-version inference. |
| Additional runtimes selected by the M0 survey | confirmed | Survey closed (D-011): LiteRT-LM selected provisionally; WebLLM's condition passed. Post-survey additions each need a decision entry and the same fixed criteria (permissive, active, fully client-side, distinct capability) |
| WebLLM (MLC) — the de-facto standard WebGPU LLM runtime | confirmed | M7; Apache-2.0 and active at 0.2.84, so D-010's survey condition passed. D-005 requires a custom HF-only model catalog and version-pinned first-party model-library wasm instead of the default GitHub binary URLs (D-011) |
| LiteRT-LM JavaScript (`.litertlm`, WebGPU) | confirmed | M7, provisional because the 0.14 web API is early preview; revalidate no-telemetry behavior and dedicated-worker viability before implementation (D-011) |
| MediaPipe LLM Inference API | rejected (D-011) | Maintenance-only and superseded by LiteRT-LM; its documented Tasks metrics also conflict with D-005 unless proven disableable |
| ONNX Runtime Web used directly (not through transformers.js) | parked (D-010) | Reopen if isolating ORT behavior from transformers.js becomes necessary for debugging |
| Runtime/backend capability report (WebGPU adapter+features+limits incl. shader-f16, wasm SIMD/threads/JSPI/Memory64, current-spec WebNN default-context acceleration, crossOriginIsolated, OPFS, quota/persistence) | confirmed | M1 — the "why doesn't X work here" diagnostic; also the suitability-filter input (D-010). D-021 supersedes the obsolete WebNN CPU/GPU/NPU `deviceType` wording. |

## Chat & testing surface

| Feature | Status | Notes |
| --- | --- | --- |
| Text chat UI (slick; streaming responses) | confirmed | |
| System prompt configuration | confirmed | M6 maps the system role into every wllama transcript and Prompt API creation-time `initialPrompts`; changing it invalidates an already-created Prompt session (D-043). |
| Multimodal input (image, later audio) for models/runtimes that support it | confirmed | Phased after text-only; image lands M9, audio is confirmed but deliberately unscheduled until image proves the pipeline |
| Generation parameter controls (temperature, top-p/k, max tokens, repeat penalty, seed, context size) per session | confirmed | M3 defaults context size from bounded GGUF trained-context metadata; D-037 presents it in K-token units and rounds positive fractional entry upward. M6 forwards and snapshots every remaining wllama control, keeps EOS/context and random seed available as explicit blank states, and labels stable Prompt API sampling/seed unsupported (D-044). |
| Streamed reasoning/channel presentation and per-prompt thinking request | confirmed | M3 parses explicit model channels incrementally, keeps the active channel open, collapses completed intermediate channels, and leaves final text visible. Chat sends wllama's On/Off Thinking selection to compatible model templates for each prompt without claiming unsupported templates honored it; the Prompt API exposes no equivalent control. Model-declared special tokens outside the active dialect appear in a bounded, copyable “Unrecognized model output” disclosure for user-carried feedback (D-028, D-029, D-038, RE-022, RE-027). |
| Stop/abort generation, regenerate, edit-and-resend | confirmed | M3 exposes stop/abort for the active generation. Prompt API preserves its browser session; wllama 3.5.1 emergency Stop terminates the worker and requires reload (D-039, RE-028). M6 regenerate replaces the latest attempt with its snapshotted controls; edit-and-resend is a confirmed linear truncation, and either operation rebuilds Prompt API hidden state from the retained `initialPrompts` prefix (D-043). |
| Side-by-side comparison: same prompt, N model/runtime/backend combos | confirmed | M7. Directly serves the core "pick a model" use case (D-010) |
| Chat history persistence + conversation export/import (JSON/Markdown) | confirmed | M6 adds a bounded IndexedDB v4 chat store, safe reload/history management, lossless versioned JSON, and readable Markdown carrying the same importable payload. A saved chat can seed an empty manual replay with the same system/configuration: the user chooses and adapts source prompts in any order, with immutable original prompts/answers beside the new branch and no original-answer injection. Import assigns fresh IDs and never runs or loads anything (D-043). |
| Token count / context-window usage display; tokenizer inspector | confirmed | M6 shows wllama full/evaluated/cached/completion counts against configured context, Prompt API browser context units, and a bounded exact sampled-output token inspector. Standalone wllama input tokenization and all Prompt token identities are honestly unavailable (D-044, RE-029). |
| Context caching (system-prompt / KV-prefix reuse) where the runtime supports it | confirmed | M6 requests wllama `cache_prompt` and displays validated `cache_n` evidence; Prompt API is labelled browser-managed retained state without claiming controllable/measured KV reuse. Cache state is never serialized (D-044). |
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
8. **Storage origin.** *Superseded by owner direction (D-024):* host at the root of
   https://webai.meenan.dev/. D-012 verified that the original shared-origin path was
   viable, but the dedicated origin makes project operations, isolation ownership,
   storage boundaries, and the future root-scoped service worker simpler.
