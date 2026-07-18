# Architecture

**Status: skeleton.** The first full draft is an M0 exit criterion
([plan.md](plan.md)); the completed M0 runtime survey and pending hosting/HF-API
spikes feed it. What is written here now is the load-bearing shape that planning
conversations and the [runtime survey](runtime-survey.md) have already settled, so
drafting can build on it rather than re-derive it.

## Fixed points (from decisions)

- Static Astro site, base path `/webai/`, rsync deploy, no server code (D-001).
- All user state client-side: models and large artifacts in OPFS, settings/history in
  IndexedDB or localStorage as appropriate; no telemetry (root constraints).
- Chrome-primary with per-capability gating, not browser gating (D-004).
- Our compute stays off the UI thread (D-007): runtime adapters execute in dedicated
  workers; model file parsing, hashing, splitting, and downloads always do.
  Browser-managed inference (Chrome's Prompt API) is the one recorded exception —
  window-only and out-of-process, called from the main thread by design.

## Expected shape (to be validated in the M0 draft)

The 2026-07-17 feature triage (D-010) confirmed the rows these bullets lean on; the
runtime survey then closed the MediaPipe/WebLLM questions and selected LiteRT-LM as
the replacement Google packaged-model candidate (D-011).

- **Runtime adapter layer.** One `Runtime` interface (load model → session → stream
  tokens / abort → dispose, plus capability declaration and metric hooks) with
  adapters per library (wllama, transformers.js, Prompt API, …). The adapter contract
  is the heart of the design: it must be honest about per-runtime differences
  (tokenization, chat templating, sampling params, multimodal, structured output)
  without flattening them into a lying lowest common denominator.
- **Capability layer.** Two tiers: stable environment probes (WebGPU
  adapter/features/limits incl. shader-f16, wasm SIMD/threads, WebNN,
  crossOriginIsolated) computed once per session, and volatile state (storage quota,
  Prompt API model availability/downloadability, GPU device loss) re-read on defined
  invalidation events — downloads, imports, model deletion, model acquisition,
  `device.lost` — plus detection of external eviction: storage that disappears out
  from under the manifest is a defined, reported state, not a crash.
  Consumed by runtime gating and the model-suitability filters; the user-facing
  environment report built on it lands in M1 (D-010).
- **Model store.** Likely a single OPFS-backed store with its own manifest (source,
  revision, hashes, size, format metadata) — single store vs. per-runtime native
  caches is features.md open question 3 — plus a download manager (streaming progress,
  Range-resume, and integrity checking — confirmed, D-010). The wasm
  gguf-split tool runs as a stage of the download pipeline, splitting monolithic
  GGUFs as bytes arrive (D-009 — streaming is the preferred path, gated on the M3
  feasibility experiment; upstream's splitter is seek-based, so this is an I/O
  redesign, and split-after-download is the recorded fallback). The same splitter
  also runs on demand against already-stored files (user imports, pre-split
  downloads). Splitter and download manager share one worker pipeline.
- **Benchmark harness.** Drives the same runtime adapters as chat; owns dataset
  loading (BYO JSON schema + one bundled permissively-licensed default set — D-010),
  iteration/statistics, metric capture, and result persistence/export.
- **Chat surface.** Astro islands over the adapter layer; streaming UI; system
  prompt + generation params per session.

## Survey-validated runtime landscape

The evidence and per-version comparison live in
[runtime-survey.md](runtime-survey.md). Its architecture consequences are
load-bearing inputs to the full draft:

- The survey identifies four acquisition-ownership cases: app-managed file/stream
  (wllama, LiteRT-LM), library-managed caches (Transformers.js), a first-party
  compiled model-library app asset plus library-managed HF-weight cache (WebLLM), and
  browser-managed model (Prompt API). The architecture draft's still-open
  storage-layout decision determines whether/how one WebAI manifest indexes native
  caches; the survey does not silently settle that choice. D-005 requires every
  executable runtime/worker/wasm asset to be version-pinned, license-audited,
  content-hashed, and served from `/webai/`, never a library's default external CDN.
  Native/library caches must still preserve M2's resume-after-tab-close and HF-LFS
  integrity guarantees, either by accepting bytes from the shared download manager or
  by demonstrating equivalent behavior; the architecture draft decides the mechanism.
- Execution context is declared explicitly. Normal adapters run in a dedicated
  worker (including libraries with their own worker machinery); Prompt API remains
  the sole browser-managed, main-thread exception under D-007. LiteRT-LM does not
  ship until worker viability is demonstrated.
- Backend and model capability are separate. Each adapter publishes its real axes
  (for example wllama thread count and GPU layer offload are independent and form a
  matrix), while modality, tool templates, and constrained decoding are also checked
  against the selected model at load time.
- Structured output is graded, not boolean: none, prompt-and-validate, JSON
  Schema-constrained, grammar-constrained, and tool-template support are distinct.
  This prevents Transformers.js v4.2 tool templates from being mislabeled as
  constrained output and preserves WebLLM/wllama-specific grammar capabilities.
- Artifact identity includes runtime/version, source revision and integrity hash,
  architecture, quantization, tokenizer/processor or multimodal projector, and
  compiled model-library identity where applicable. Format name alone never proves
  load compatibility.
- Heavy adapters and catalogs are lazy-loaded. Capability probes include wasm SIMD,
  JSPI, Memory64, wasm threads, `crossOriginIsolated`, WebGPU features/limits, and
  WebNN device types; successful session creation remains the final per-model gate.

## Open architecture questions

Tracked as features.md "Open questions" plus:

- Worker topology per runtime: whether the adapter owns a library's internal worker or
  hosts the library inside WebAI's worker, plus lifecycle/recovery behavior. Prompt API
  is the only accepted main-thread path; any other main-thread requirement means
  rejecting that runtime or recording a new D-007 exception before implementation.
- Cross-origin isolation strategy (features.md Q1) — decides whether multi-threaded
  wasm and `measureUserAgentSpecificMemory` are available at all.
- How runtime adapters and their heavyweight deps are code-split so the landing
  experience stays light.
