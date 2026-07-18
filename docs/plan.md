# Plan

**This is a living document.** Milestones will be re-scoped, re-ordered, split, or
added as planning conversations and findings come in. That churn is expected; what is
*not* allowed is silent change. Scope changes get a decision-log entry; progress is
reflected here by checking boxes and updating status lines as work lands.

Check a box only when the item is done and verified; partially done items stay
unchecked, optionally with a note.

**Status legend:** `pending` · `in progress` · `done` · `parked`

## M0 — Plan the plan  `done`

Goal: turn the initial feature list into a settled vision, feature matrix,
architecture, and milestone ladder — through planning conversations with the project
owner plus targeted research/spikes where a decision needs evidence.

- [x] Repo scaffolding for the AI-directed workflow: AGENTS.md, CLAUDE.md, docs/
      (vision, features, plan, architecture, decisions, rough-edges, workflow).
- [x] Feature triage: walk every `proposed` [features.md](features.md) row and open
      question with the project owner; resolve all that don't require experimental
      evidence (confirm, park, or reject); record the calls in
      [decisions.md](decisions.md); hand each remnant to exactly one owning M0 item.
      *(Done 2026-07-17, verdicts in D-010. Deliberately re-scoped from "resolve
      every row" with owner approval so each remaining unknown has a single owner:
      MediaPipe verdict + WebLLM health check → runtime survey; open question 1 +
      question 8 validation → hosting spike; questions 3/4 → architecture draft.
      The exit criteria below still gate M0 on all of these closing.)*
- [x] Runtime/backend survey (current sources, not training knowledge — root rule 4):
      for each candidate runtime (wllama, transformers.js, WebLLM, MediaPipe,
      ONNX Runtime Web, Prompt API, others discovered), document version, formats,
      backends, threading/isolation requirements, multimodal and structured-output
      support, license, and maintenance health. Output: a comparison table feeding
      architecture.md and the runtime-adapter design.
      *(Done 2026-07-17: [runtime-survey.md](runtime-survey.md), scope verdicts in
      D-011. WebLLM's condition passed; maintenance-only MediaPipe was rejected and
      its successor LiteRT-LM selected provisionally for M7.)*
- [x] Hosting-constraints spike: COOP/COEP options on meenan.dev static hosting vs.
      Hugging Face CORS behavior (downloads + API), `/webai/` base path, header
      configuration for the rsync deploy target, and the shared-origin storage
      question (OPFS/IndexedDB/quota are origin-scoped — path vs. dedicated origin).
      Output: a decision on the isolation strategy (features.md open question 1)
      and validation of the accepted `/webai/` shared-origin preference (question 8,
      D-010) — the origin choice reopens only if the spike finds a blocker.
      *(Done 2026-07-17: D-012 keeps the shared path and selects COOP `same-origin` +
      COEP `require-corp`; the live-host inspection and Chrome HF API/resolver/range
      experiment are recorded in [hosting-constraints.md](hosting-constraints.md).)*
- [x] Hugging Face API spike: search/filter capabilities of the public REST API from
      a browser client (rate limits, CORS, what "browser-suitable" filters are
      actually expressible), LFS metadata for integrity/resume.
      *(Consumes RE-005: expiring, range-bound Xet URLs and a separate
      browser-readable metadata path for commit/linked size/hash; and RE-006:
      rate-limit headers are not CORS-exposed, so backoff must be reactive. Done
      2026-07-17: [hugging-face-api.md](hugging-face-api.md) and D-013 select
      commit-pinned metadata, fresh per-range resolution, strict range validation,
      final LFS SHA-256 verification, and two-stage suitability filtering.)*
- [x] First full draft of [architecture.md](architecture.md): runtime adapter
      abstraction, worker topology, storage layout, download manager, capability
      gating, benchmark harness design.
      *(Done 2026-07-17: D-014 selects one model control plane over hybrid physical
      storage and fixes the supervised adapter/worker boundary; D-015 defines
      evidence-labelled benchmark semantics. These close features questions 3/4.)*
- [x] Toolchain decisions: Astro version + islands framework (React? Svelte? none?),
      package manager, test stack (unit + e2e), lint/format, CI, license audit.
      Record in decisions.md.
      *(Done 2026-07-17: D-016 — Astro 7 + React 19 islands, pnpm 11, TS 6.0.x
      (TS 7 blocked by typescript-eslint/@astrojs/check peer ranges; move when they
      support it), Vitest 4 browser mode + Playwright, ESLint 10 lint with Biome
      formatting, GitHub Actions CI with an SPDX allowlist license gate. Versions
      verified against current registries/docs that day; the scaffold-time
      verification list lives in D-016 and lands with the M1 toolchain task.)*
- [x] UI/design direction: look-and-feel brief for the "slick chat UI", theming
      (light/dark), design-token approach; decide whether a Design.md (golemine-style
      design system doc) is warranted from M1.
      *(Done 2026-07-17: [design-brief.md](design-brief.md) and D-017 — "Neon
      horizon" direction (owner-picked from three mocked-up candidates),
      dark-default with a real light theme, OKLCH tokens via Tailwind v4 +
      vendored shadcn/Radix, mascot confirmed; a full Design.md lands with the
      M1 shell, seeded from the brief.)*
- [x] Rewrite the provisional ladder below into real milestones with exit criteria
      (D-008; the 2026-07-17 triage (D-010) then resolved the provisional
      *(triage)* markers, and the runtime survey closed its remaining MediaPipe and
      WebLLM conditions in D-011).

**Exit criteria:** every checklist item above is checked; every `proposed` row in
features.md is resolved **and every features.md open question answered**, with
decision-log entries for the significant calls; architecture.md first draft reviewed;
toolchain decided; M1+ milestones have scopes and exit criteria. Nothing on this list
is optional — M0 is not done while any item above remains open.

## Milestone ladder

Ordered by risk: platform substrate and one working end-to-end path before breadth
(rationale in D-008 — deploy and capability layer first, manual acquisition before
browse UI, the most divergent runtime second, benchmark harness after runtime
breadth). Every milestone ends deployed: its exit criterion is something a user on
the live site can do.

Scope is at deliverable granularity; the tech lead breaks a milestone into finer
tasks when work on it starts. The M0 feature triage (D-010) resolved the former
*(triage)* markers; the runtime survey then closed the remaining conditions and
selected the M7 runtime set (D-011).

### M1 — Shell, toolchain, live deploy  `pending`

Goal: a deployed, styled app shell with the capability layer and its first consumer.
Depends on M0: hosting spike (D-012), toolchain decisions (D-016), UI/design
direction ([design-brief.md](design-brief.md), D-017).

- [ ] Toolchain per the M0 decisions: Astro + islands framework, package manager,
      unit + e2e test stacks, lint/format, CI with license audit.
- [ ] App shell: navigation, look-and-feel foundation (theming, design tokens),
      project details/about page — includes writing Design.md from
      [design-brief.md](design-brief.md) with AA-validated OKLCH token tables for
      both themes, plus the Arachne-7 asset pipeline and "W" logomark development
      from the canonical character sheet (D-018; identity already decided).
- [ ] Capability layer (stable environment probes plus the evidence/invalidation
      framework and storage quota as its first volatile input, per architecture.md)
      and the capability-report page as the first real feature — it exercises the
      gating everything else consumes and starts feeding rough-edges.md.
- [ ] Deploy pipeline: build + rsync to https://meenan.dev/webai/ with the headers
      chosen by the hosting spike; verify base path, isolation state, and HF CORS
      from the real origin.

**Exit criteria:** a visitor to the live site sees the styled shell and an accurate
capability report for their browser; both themes are verified against Design.md's
definition of done (AA contrast, keyboard path, reduced motion, tokens only); CI
runs typecheck/lint/format-check/tests/license audit.

### M2 — Manual model acquisition  `pending`

Goal: model files travel reliably from Hugging Face (or local disk) into managed
local storage — verified via metadata inspection, before any inference exists.
Depends on M0: HF API spike.

- [ ] Model ID / URL entry → repo file and quant listing via the HF API.
- [ ] Download manager in a worker: streaming progress; resumable +
      integrity-checked per D-013 and the
      [HF API spike](hugging-face-api.md): commit-pinned identity, fresh resolver
      request per range, exact `Content-Range`, restart-safe partial state, and
      worker verification before promotion. Resume design must anticipate the M3
      streaming-split stage — a resumed download may target split output, not a
      single file (D-009).
- [ ] OPFS model store with manifest (source, revision, size, hashes, format
      metadata) + management UI: list, inspect, delete, storage usage and quota
      (incl. `persist()` and eviction awareness).
- [ ] User-provided model import (file picker / drag-drop, incl. already-sharded
      models).
- [ ] Defensive GGUF metadata parser (D-006, malformed-fixture tests) + inspector —
      the verification surface for downloads until M3 exists.

**Exit criteria:** a user can enter a repo ID (e.g., an unsloth GGUF repo), pick a
quant, download it with progress, see it in the model manager, and inspect its
metadata. A measured interruption survives a page/worker restart and resumes without
re-fetching the durable prefix; wrong range/size and final-integrity fixtures fail
closed and no unverified artifact is promoted. Malformed/hostile files fail with a
report, never a crash.

### M3 — First chat: wllama, with streaming split  `pending`

Goal: end-to-end text chat with a downloaded GGUF — including the monolithic
multi-GB quants that make splitting mandatory (D-009).

- [ ] wasm build of llama.cpp's gguf-split (upstream MIT, NOTICE entry) running in a
      worker as a download-pipeline stage: split while streaming, buffering only what
      the offset tables require (D-009). Verify streaming feasibility experimentally
      at milestone start; fallback is split-after-download (amend D-009 if so).
- [ ] Split-on-demand over already-stored files: user imports and any pre-split
      downloads run through the same splitter against OPFS — the streaming download
      stage is not the only path (D-009).
- [ ] wllama runtime adapter — the first `Runtime` implementation; one/many wasm
      threads plus optional partial/full WebGPU layer offload as independent axes
      (WebGPU is on by default since wllama v3.1 — README checked 2026-07-17). Verify
      current shard-size limits and split-output compatibility at build time; bundle
      and self-host every runtime/worker/wasm asset, including the compat package,
      rather than allowing its default jsDelivr fallback (D-005, RE-002).
- [ ] Streaming chat UI over the adapter.
- [ ] Live per-response metrics from the first message: model load time,
      time-to-first-token, prefill/decode tok/s — every chat is a measurement.

**Exit criteria:** on the live site, chat with a monolithic >2 GB GGUF quant
end-to-end — auto-split on download, or split on demand for an imported file — with
streaming output and live metrics.

### M4 — Second runtime: Prompt API  `pending`

Goal: prove the runtime adapter contract on the most divergent case — main-thread
(D-007), browser-managed model, no HF download — before conventional runtimes
calcify assumptions into it.

- [ ] Prompt API adapter: availability probing, browser-managed download flow with
      progress, session params it actually exposes (re-verify surface, root rule 4).
- [ ] Runtime/model selection UI; unavailable runtimes disabled with the reason.

**Exit criteria:** a user can switch the same chat surface between a downloaded
GGUF-on-wllama and Gemini Nano, on a browser with the API; on other browsers the
option is visibly gated with an explanation.

### M5 — Model browsing  `pending`

Goal: discovery without leaving the app.

- [ ] HF search/browse with D-013's two-stage in-browser-suitability filters (size,
      format, quant, task): server-filter candidate pages, then bounded/cached
      revision-pinned file enrichment with explicit pending/unknown states.
- [ ] Basic suitability hints (file size vs. quota/memory); full capability-based
      filtering stays in M10.
- [ ] Model license + gating status surfaced pre-download; HF token for gated models
      (stored locally only). Before this path ships, verify a valid-token gated model
      and its signed redirect in a browser; D-012 proved Authorization preflight only.

**Exit criteria:** a user finds, evaluates, and downloads a suitable model entirely
in-app; pagination/enrichment can find a size/quant match beyond the first candidate
page without presenting unknown candidates as incompatible; the manual-entry path
from M2 remains as the escape hatch.

### M6 — Chat testing depth  `pending`

Goal: the chat surface becomes a real testing instrument.

- [ ] System prompt configuration.
- [ ] Generation parameter controls incl. seed.
- [ ] Stop/abort, regenerate, edit-and-resend.
- [ ] Chat history persistence + export/import.
- [ ] Token count / context-window usage display; tokenizer inspector.
- [ ] Context caching (prefix/KV reuse) where the runtime supports it.

**Exit criteria:** a user can reproduce a configured chat (params + seed where
supported), manage histories, and see context usage while testing.

### M7 — Runtime breadth  `pending`

Goal: the adapter layer earns its keep. The M0 survey selected WebLLM and the
early-preview LiteRT-LM, rejected maintenance-only MediaPipe, and kept direct ONNX
Runtime Web parked (D-011).

- [ ] transformers.js adapter: wasm / WebGPU / WebNN backends, per-backend gating,
      native-cache inventory/accounting under D-014's shared control plane, and a
      download path that integrates or experimentally demonstrates M2's
      resume-after-tab-close and HF-LFS integrity guarantees — this is where
      cross-runtime cache accounting from the M2 storage UI becomes real.
- [ ] ONNX metadata parsing joins the model inspector (same D-006 discipline as the
      M2 GGUF parser; the ONNX side arrives with the format's first runtime).
- [ ] WebLLM adapter: custom MLC-compiled catalog with HF model data and
      version-pinned, license-audited, content-hashed model-library wasm served from
      `/webai/` (never the default GitHub binary URLs); allowlisted revision-pinned
      records and mandatory WebLLM `integrity` hashes for model-library/config/tokenizer
      artifacts; independently verify parameter shards against HF metadata because
      0.2.84's integrity type does not cover them, and preserve M2 resume-after-tab-close
      semantics; WebGPU-only gating, worker lifecycle, image/VLM and XGrammar
      capabilities (D-005, D-006, D-011, RE-004).
- [ ] LiteRT-LM adapter, contingent on milestone-start revalidation of its early
      preview, no-telemetry behavior, dedicated-worker viability, and the package's
      lightly documented tool/constrained-decoding surface with web model artifacts;
      drop it rather than violate D-005 or D-007 (D-011).
- [ ] Structured output testing (JSON schema / GBNF / Prompt API constraints) as
      per-adapter capability work — each adapter declares and demonstrates what it
      supports.
- [ ] Side-by-side comparison: same prompt across N model/runtime/backend combos.

**Exit criteria:** every adapter added in this milestone demonstrates a
representative model on each backend the browser supports; the same prompt runs
side-by-side across at least two runtimes (same model where formats allow,
equivalent models otherwise); every library-native model download demonstrates the
M2 resume/integrity guarantees; and every impossible combination is labeled with the
reason.

### M8 — Benchmark harness  `pending`

Goal: honest, comparable, exportable numbers — most valuable now that there are
multiple runtimes to compare.

- [ ] Dataset configuration — BYO JSON against a documented schema plus one small
      bundled permissively-licensed default set (D-010) — and run configuration over
      the same adapters chat uses.
- [ ] Prompt library: saved/named prompts and reusable test sets, sharing the
      dataset design (D-010).
- [ ] Standard metric set incl. memory, per the isolation decision; labeling for
      what each backend cannot measure under D-015's evidence-labelled schema.
- [ ] Iterations with median/p95 and variance.
- [ ] Results history + JSON/CSV export.

**Exit criteria:** a user runs a repeatable benchmark across ≥2 runtime/backend
combos and exports results that state their own measurement caveats.

### M9 — Multimodal & tool calling  `pending`

Goal: image input (audio later) where model + runtime support it, and the
tool-calling harness now that structured output (M7) exists to build on.

- [ ] Multimodal capability declaration in the adapter contract; per-combo gating.
- [ ] Image input in chat for supporting runtimes (survey says which); Prompt API
      multimodal (re-verify current surface, root rule 4).
- [ ] Tool/function-calling test harness where runtimes support it (D-010; depends
      on M7 structured output).

*Audio input stays confirmed scope but deliberately unscheduled — it gets a plan
slot once image multimodal has landed and proven the pipeline.*

**Exit criteria:** a user chats with images on a supporting model/runtime combo and
can exercise tool-calling where supported; unsupported combos say why.

### M10 — Capability filtering, polish, launch  `pending`

Goal: close the loop — discovery filtered by what *this* machine can actually run —
and ship.

- [ ] Model browsing filtered/annotated by local capability report ("runs here"
      badges tying M1's probes to M5's browse).
- [ ] Cross-browser pass; findings logged to rough-edges.md.
- [ ] Shareable config permalinks (model+runtime+params in the URL — config only,
      never results).
- [ ] Diagnostics pane / exportable diagnostic report.
- [ ] PWA/offline (service-worker design per the hosting-spike isolation outcome):
      verify root- and `/webai/`-scope registrations coexist and every cached/offline
      navigation preserves the isolation headers.
- [ ] Docs/guides, design polish, launch.

**Exit criteria:** a first-time visitor on any modern browser gets an honest,
filtered view of what they can run, and the launch checklist in this milestone is
green.

### M11 — Stress benchmarking  `pending`

Goal: post-launch — probe where in-browser inference actually falls over (D-010
placed these here to keep M8 shippable).

- [ ] Long-context / KV-cache growth stress test.
- [ ] Sustained-throughput degradation run (thermal/throttling proxy).

**Exit criteria:** a user can run both stress modes on any working model/runtime
combo and export results showing where and how performance degrades.
