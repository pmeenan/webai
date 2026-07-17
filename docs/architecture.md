# Architecture

**Status: skeleton.** The first full draft is an M0 exit criterion
([plan.md](plan.md)); the M0 runtime survey and hosting/HF-API spikes feed it. What is
written here now is the load-bearing shape that planning conversations have already
settled, so drafting can build on it rather than re-derive it.

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
survey-dependent runtime items still pending are the MediaPipe verdict and the
WebLLM license/maintenance health check.

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

## Open architecture questions

Tracked as features.md "Open questions" plus:

- Worker topology per runtime: which libraries tolerate running fully in a dedicated
  worker vs. require main-thread pieces (WebGPU device sharing, DOM needs)?
- Cross-origin isolation strategy (features.md Q1) — decides whether multi-threaded
  wasm and `measureUserAgentSpecificMemory` are available at all.
- How runtime adapters and their heavyweight deps are code-split so the landing
  experience stays light.
