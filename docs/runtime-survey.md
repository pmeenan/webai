# Runtime and backend survey

**Status: complete (2026-07-17).** This is the M0 evidence snapshot, not a
permanent compatibility promise. Versions and browser surfaces must be re-checked when
their adapters are built (AGENTS.md rule 4).

## Selection method

The feature ledger set four gates for an additional runtime: permissive license,
active maintenance, fully client-side operation, and a distinct format, backend, or
capability. The survey applies those gates to the named candidates and screens newly
discovered ones. A runtime version is the current stable package/release on the check
date; a browser API uses its current shipped surface.

"Fully client-side" also applies to acquisition under D-005. Runtime code, workers,
wasm, and compiled model-library binaries are version-pinned, license-audited WebAI
assets served from `https://webai.meenan.dev/`; an adapter may not use a library's
default third-party CDN or GitHub binary URL. User-selected model bytes may come from
Hugging Face or a local import, and Prompt API remains the browser-managed exception
already recorded.

"Structured" below distinguishes constrained decoding from prompt conventions. Tool
calling alone does not prove that arbitrary JSON Schema output is constrained.

## Comparison

| Runtime | Current version / status | Model and acquisition path | Execution backends | Worker and isolation requirements |
| --- | --- | --- | --- | --- |
| **wllama** | 3.5.1 (2026-06-15) | GGUF and split GGUF directly; a multimodal projector is another GGUF. App-managed download/import fits the shared model store. All runtime/worker/wasm assets, including `@wllama/wllama-compat`, must be bundled or self-hosted; WebAI never uses the compat package's default jsDelivr fallback. | wasm SIMD CPU, single- or multi-threaded; llama.cpp WebGPU layer offload is enabled by default when available and can be disabled or partial. Thread count and GPU offload are independent axes. | Inference uses an internal worker. Any configuration with more than one wasm thread needs `SharedArrayBuffer` through COOP/COEP, including one that also offloads layers to WebGPU; one thread does not. The default JSPI/Memory64 build is Chromium-oriented; the slower compatibility package covers browsers such as Safari. |
| **Transformers.js** | 4.2.0 (2026-04-23) | Hugging Face repositories containing ONNX graphs plus tokenizer, config, and processor assets; models can be converted with Optimum. Library-managed web caches are native to this path. | ONNX Runtime Web: wasm, WebGPU, and WebNN (`cpu`, `gpu`, or `npu` device types). v4 uses ORT's rewritten WebGPU runtime; 4.2.0 pins ORT `1.26.0-dev.20260416-b7804b056c`, not current standalone ORT. | Dedicated-worker use is documented and recommended. ORT wasm threads require `crossOriginIsolated`; one thread remains a fallback. WebGPU/WebNN do not require isolation. |
| **WebLLM** | npm 0.2.84 (2026-05-27; GitHub Releases trails at 0.2.83) | MLC-converted HF parameter shards/tokenizer/config plus an architecture/quantization-specific WebGPU model-library wasm. The default catalog fetches that wasm from an MLC GitHub repository's mutable `main` branch, so WebAI uses a custom allowlisted catalog with revision-pinned HF model URLs, version-pinned first-party model libraries, and mandatory `integrity` hashes for every artifact type the API supports (model library, config, tokenizer). Its integrity type does not cover parameter shards, so M7 must verify those against HF metadata separately or document a measured safe cache path. It cannot consume arbitrary GGUF or ONNX; conversion and compilation happen outside the browser. | WebGPU only for browser inference; no CPU or WebNN fallback is documented. | First-class dedicated-worker and service-worker engines. No COOP/COEP requirement is documented; verify header-free operation when built. Service-worker termination is a recoverable event, not persistence. |
| **MediaPipe LLM Inference** | `@mediapipe/tasks-genai` 0.10.29 (repository 0.10.35); **maintenance-only** | The current quickstart uses web-converted `.litertlm`; the current compatibility table also lists web-capable `.task` and `.bin` models. It is centered on Gemma. | WebGPU required. | The current web guide does not document worker compatibility, UI-thread behavior, or an isolation requirement. That missing D-007 evidence is another reason not to start a new adapter. |
| **ONNX Runtime Web (direct)** | npm 1.27.0 (2026-06-19; upstream release 1.27.1) | ONNX or ORT-format graphs. It supplies graph execution, not tokenization, chat templates, sampling, or a model catalog. | wasm, WebGPU, WebNN; WebGL remains available but is maintenance-only, and WebNN is still documented as experimental/actively developing. Accelerator providers support only subsets of ONNX operators. | Can be loaded directly inside a worker. The wasm proxy worker cannot host WebGPU, but direct worker use can. Multi-thread wasm requires `crossOriginIsolated`; single-thread does not. |
| **Chrome Prompt API** | Web pages: Chrome 148; extensions: Chrome 138 | Browser-managed Gemini Nano. The browser owns model selection, download, storage, update, and eviction; there is no HF model file. | Browser-selected CPU or GPU, not an app-selectable backend. | Window/document context only: top-level windows and same-origin iframes by default, or delegated cross-origin iframes; still unavailable in workers. No COOP/COEP requirement. This remains D-007's explicit main-thread exception. |
| **LiteRT-LM** | 0.14.0 (2026-07-08; JavaScript API early preview) | `.litertlm` accepted by URL, `Blob`, or `ReadableStream`. WebAI uses only HF/local acquisition already allowed by D-005 and passes stored bytes to the runtime; the web preview currently documents only web-converted Gemma 4 E2B/E4B models. | WebGPU, text-in/text-out only in the current web preview. | Worker support and isolation requirements are not documented. A milestone-start worker feasibility check gates an adapter because D-007 does not allow app-owned inference on the UI thread. |

| Runtime | Multimodal | Structured output and tools | License / maintenance | Roadmap verdict |
| --- | --- | --- | --- | --- |
| **wllama** | Image and audio input with a compatible model/projector. | Typed OpenAI-compatible `json_object` / `json_schema`, lower-level grammar sampling, and model/template-dependent tools. Exact schema dialect still needs tests. | MIT; frequent 2026 releases and current llama.cpp syncs. Healthy, with maintainer-concentration risk. | **Confirmed**: first downloaded-model runtime in M3. |
| **Transformers.js** | Broad image, audio, and multimodal model/pipeline coverage; actual chat modalities remain model-specific. | v4.2 adds tool calling. Arbitrary JSON-Schema-constrained generation is not present (the request remains open), so structured output is prompt-and-validate only unless a future release changes this. | Apache-2.0; active Hugging Face project with v4.2 current. | **Confirmed** for M7. |
| **WebLLM** | Image input for a small current set of VLM records; no audio path documented. | XGrammar-backed JSON schema, EBNF grammar, and structural tags. Function calling exists but is still described as preliminary/WIP. | Apache-2.0; active releases and development. The D-010 health/license condition is satisfied; each redistributed compiled model library still needs its own build-time license/provenance check. | **Confirmed with a deployment constraint** for M7: custom catalog and first-party model-library assets only. |
| **MediaPipe LLM Inference** | Gemma 3n image and audio input. | No constrained structured-output surface documented for web; function-calling documentation is native-platform focused. | Apache-2.0, but the web API is maintenance-only and subject to an additional Generative AI Prohibited Use Policy. The repository privacy notice also says MediaPipe Tasks send performance/utilization metrics; no web opt-out was found. | **Rejected** (D-011): superseded by LiteRT-LM and a poor fit for D-005's no-telemetry boundary. |
| **ONNX Runtime Web (direct)** | Format can represent multimodal graphs; all preprocessing and generation orchestration would be ours. | None at runtime level. | MIT; very active Microsoft project. | **Parked** (D-010): Transformers.js supplies the product-level adapter. Use direct ORT for diagnostics only if evidence reopens it. |
| **Chrome Prompt API** | Text, image, and audio input; text output. Audio requires a GPU. | JSON Schema and regular-expression constraints through `responseConstraint`. Sampling controls remain limited for web pages; capability probing must use the same options as session creation. | Browser API, so no library dependency license; actively shipped by Chrome. | **Confirmed**: deliberately the second runtime in M4. |
| **LiteRT-LM** | Native framework supports vision/audio, but the current JS preview documents text only. | The 0.14 JavaScript package exports tool declarations/calls, `AutoToolChat`, WebMCP conversion, and an `enableConstrainedDecoding` flag. The short web guide does not document that surface, the package exposes no arbitrary response-schema/grammar API, and compatibility with the two web Gemma artifacts needs an experiment. | Apache-2.0; active Google project, but the JS surface is early preview. | **Confirmed provisionally** for M7 (D-011): re-check maturity, require worker execution, and observe network traffic before implementation. |

Shipping in stable Chrome does not make Prompt API broadly available or finalized.
Chrome currently limits the foundation-model APIs to supported desktop operating
systems/Chromebook Plus (not Android, iOS, WebView, or ordinary Chromebooks), requires
either more than 4 GB VRAM or at least 16 GB RAM plus four CPU cores, and checks for at
least 22 GB free profile storage. The initial model download requires an unmetered
connection. Chrome says the web API is still being developed, with sampling parameters
in an origin trial; Edge still documents its implementation as an experimental
preview. The M4 adapter therefore
calls `availability()` with the exact requested modalities/languages and presents its
status string. Explanations come from the failed capability checks or `create()`
error—the availability call itself does not return a reason. It never gates on browser
name or Chrome version alone.

## Newly discovered candidates screened out

The same comparison fields were applied before rejecting newly discovered engines;
an undocumented field is an unknown, not an assumed capability.

| Candidate | Version, formats, acquisition | Backends, worker, isolation | Modalities and structured output | License and maintenance | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Sipp** | 0.1.1; GGUF from HF or local/OPFS storage. Its browser package wraps a Rust/wasm llama.cpp/ggml runtime. | WebGPU plus CPU; `auto`, worker, and main-thread execution modes. The bundled pthread build needs `SharedArrayBuffer`/cross-origin isolation; custom single-thread assets can avoid it. | Text and vision. The local request surface accepts llama grammar; no arbitrary JSON Schema or documented tool-template surface was found. | Apache-2.0; active but pre-1.0, with a repository created in March 2026. | **Rejected for now:** fully local, but overlaps wllama's GGUF, CPU/WebGPU, vision, and grammar path. Reconsider after measurements show a durable distinction. |
| **Gerbil** | npm 1.6.3; advertised HF-compatible safetensors/MLX 4-bit, GPTQ, and F32 artifacts. | Native WebGPU/WGSL; no CPU fallback. Worker topology and isolation requirements are not documented. | Advertises text, vision, embeddings, speech-to-text, text-to-speech, and tools. `generateObject` is extract/validate/retry, not constrained decoding. | npm metadata declares MIT and publishes actively, but its declared GitHub repository returned 404 on the check date. | **Rejected:** published claims are interesting, but implementation, source license, and project health cannot be independently verified. |
| **LiteRT.js** | npm 2.5.3; generic `.tflite` graph acquisition from HF/local fits D-005. | wasm CPU/XNNPACK, WebGPU, and experimental WebNN/NPU. Worker and isolation behavior need a browser feasibility check. | Graphs can represent multimodal models, but the runtime supplies no LLM tokenization, chat, sampling, tools, or constrained-output layer. | Apache-2.0; active Google project announced for web in July 2026. | **Parked:** this is the low-level graph-execution analogue to direct ORT. LiteRT-LM is the selected product-level LLM adapter; reopen direct LiteRT.js only for diagnostics or a measured capability LiteRT-LM cannot expose. |

- **Prompt API polyfills/providers** are adapter facades, not another execution
  runtime. Their local implementation delegates to Transformers.js, while cloud
  providers violate D-005.
- **BrowserAI 2.1.1** is an MIT facade over MLC, Transformers.js, Flare, and other
  engines, not a distinct execution runtime. Its UX/API can inform WebAI, but an
  adapter would duplicate selected engines and obscure their real capabilities.
- **torch-webgpu 0.0.1** currently runs through native Dawn/Python; its own FAQ says
  in-browser execution is a future step, so it is not a browser-runtime candidate.
- **`@ruvector/ruvllm-wasm` 2.0.2** exposes browser routing, cache, chat-template, and
  adaptation primitives, but its published browser surface did not demonstrate the
  GGUF loading/token generation/GPU path needed for an inference adapter. Reconsider
  when that path is released and measured.
- Raw llama.cpp browser builds and app-specific demos duplicate wllama rather than
  providing a separately maintained product-level runtime contract.

## Adapter-design consequences

The comparison rules out a single flattened "model + backend" abstraction. The
runtime contract needs these explicit dimensions:

1. **Acquisition ownership:** `app-file` (wllama, LiteRT-LM), `library-cache`
   (Transformers.js), `app-asset + library-cache` (WebLLM), or `browser-managed`
   (Prompt API). This is an input to the still-open storage-layout decision; the
   architecture draft decides whether and how one WebAI manifest indexes native
   caches rather than assuming all bytes live in OPFS. D-005 separately requires all
   executable runtime assets to be bundled/self-hosted and content-hashed; only model
   data comes from HF/local import.
2. **Execution context:** the adapter declares `worker` or the recorded
   `browser-managed-main-thread` exception. A library with its own worker may be owned
   directly by the adapter; nesting it inside a generic host worker is not assumed.
3. **Backend modes:** each runtime advertises only combinations it implements, with
   independent gates and metrics. In wllama, thread count (one or many) and GPU layer
   offload (none, partial, or full) form a matrix rather than three exclusive modes;
   the result records both requested and effective values.
4. **Model-scoped capabilities:** modality, chat-template/tool support, and structured
   decoding depend on both runtime and model. Declarations are verified again at load
   time and may degrade with an explanation.
5. **Structured-output strength:** distinguish `none`, `prompt-and-validate`,
   `json-schema-constrained`, `grammar-constrained`, and `tool-template`; retain
   runtime-specific extensions rather than claiming false parity.
6. **Artifact compatibility:** format alone is insufficient. The manifest records
   runtime/version, source revision and integrity hash, architecture, quantization,
   auxiliary projector/processor files, and any compiled model-library identity
   required to load an artifact.
7. **Lifecycle and failure:** model download/eviction, device loss, worker/service
   worker termination, abort, and disposal are adapter-visible state transitions.
8. **Download guarantees:** a library-owned cache is not an exemption from M2's
   resume-after-tab-close and HF-LFS integrity guarantees. Transformers.js, WebLLM,
   and future native-cache adapters must either route model bytes through WebAI's
   download manager or experimentally demonstrate equivalent behavior and expose it
   to the shared model manager. WebLLM 0.2.84 SRI covers its model library, config,
   and tokenizer—not parameter shards—so those shards need the separate HF-metadata
   path already assigned to M7.

Heavy runtime packages and model catalogs are lazy-loaded behind their capability
gates. Stable environment probes include wasm SIMD, JSPI, Memory64, wasm threads,
`crossOriginIsolated`, WebGPU features/limits, and current-spec WebNN default-context
and effective-acceleration evidence; volatile model availability and device loss remain
the second tier already described in [architecture.md](architecture.md).

Reproduction metadata records both wrapper and engine versions. In particular,
Transformers.js 4.2.0 embeds a development ORT build, so its behavior must not be
attributed to standalone ONNX Runtime Web 1.27.0 without a matching experiment.

## Primary sources checked

All sources were checked 2026-07-17.

- wllama: [3.5.1 package README](https://github.com/ngxson/wllama/blob/3.5.1/README.md),
  [v3 guide](https://github.com/ngxson/wllama/blob/3.5.1/guides/intro-v3.md),
  [compatibility package](https://github.com/ngxson/wllama/blob/3.5.1/compat/README.md),
  and [3.5.1 release](https://github.com/ngxson/wllama/releases/tag/3.5.1).
- Transformers.js: [4.2 release](https://github.com/huggingface/transformers.js/releases/tag/4.2.0),
  [tagged source](https://github.com/huggingface/transformers.js/tree/4.2.0), and
  [open JSON Schema request](https://github.com/huggingface/transformers.js/issues/1328).
- WebLLM: [documentation](https://webllm.mlc.ai/docs/),
  [0.2.84 source snapshot](https://github.com/mlc-ai/web-llm/tree/9e572d6ed95e248f29634996cd32cc8f3023d89d),
  [default catalog source](https://github.com/mlc-ai/web-llm/blob/9e572d6ed95e248f29634996cd32cc8f3023d89d/src/config.ts),
  [integrity type and verifier](https://github.com/mlc-ai/web-llm/blob/9e572d6ed95e248f29634996cd32cc8f3023d89d/src/integrity.ts),
  and [MLC deployment artifacts](https://llm.mlc.ai/docs/deploy/webllm.html).
- MediaPipe: [web LLM guide](https://developers.google.com/edge/mediapipe/solutions/genai/llm_inference/web_js),
  [repository/privacy snapshot](https://github.com/google-ai-edge/mediapipe/blob/0ad5a71bcdff3d756dc5b07f93765aaeb4152538/README.md#privacy-notice), and
  [0.10.35 release](https://github.com/google-ai-edge/mediapipe/releases/tag/v0.10.35).
- ONNX Runtime Web: [web tutorial](https://onnxruntime.ai/docs/tutorials/web/),
  [environment and worker flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html),
  and [1.27.1 upstream release](https://github.com/microsoft/onnxruntime/releases/tag/v1.27.1).
- Prompt API: [current Chrome documentation](https://developer.chrome.com/docs/ai/prompt-api),
  [structured output](https://developer.chrome.com/docs/ai/structured-output-for-prompt-api),
  and [Edge's experimental surface](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api).
- LiteRT-LM: [JavaScript preview](https://developers.google.com/edge/litert-lm/js),
  [0.14.0 conversation/tool types](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.14.0/js/packages/core/src/conversation_config.ts),
  [0.14.0 orchestration source](https://github.com/google-ai-edge/LiteRT-LM/tree/v0.14.0/js/packages/core/src/orchestration),
  and [0.14.0 release](https://github.com/google-ai-edge/LiteRT-LM/releases/tag/v0.14.0).
- Screened projects: [Sipp 0.1.1 browser guide](https://github.com/noumena-labs/Sipp/blob/sipp-v0.1.1/docs/en/packages/browser.md),
  [Sipp runtime options](https://github.com/noumena-labs/Sipp/blob/sipp-v0.1.1/docs/en/reference/runtime-options.md),
  [Gerbil 1.6.3 package](https://www.npmjs.com/package/@tryhamster/gerbil/v/1.6.3),
  [Gerbil's advertised source link](https://github.com/gethamster/gerbil),
  [LiteRT.js web guide](https://developers.google.com/edge/litert/web),
  [LiteRT.js announcement](https://developers.googleblog.com/litertjs-googles-high-performance-web-ai-inference/),
  [BrowserAI 2.1.1 source](https://github.com/Cloud-Code-AI/BrowserAI/tree/v2.1.1),
  [torch-webgpu snapshot](https://github.com/jmaczan/torch-webgpu/tree/a4369ff0f61f4e58cbffb048cee85047b33dacba),
  and [`ruvllm-wasm` 2.0.2 source](https://github.com/ruvnet/ruvector/tree/084954f4d273bfe6d30628219c22a47d7d49a793).
