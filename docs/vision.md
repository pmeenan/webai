# Vision

## What this is

WebAI is a browser-based workbench for evaluating LLMs that run *in* the browser. A
developer considering on-device/in-browser AI faces a three-dimensional choice — which
model, at which quantization, on which runtime and execution backend — and today
answering "which combination actually works well on my target hardware?" means wiring
up each library by hand. WebAI turns that into a point-and-click loop: find a model on
Hugging Face, download it once, chat with it or benchmark it on the runtimes and
backends that support its format, and compare the results. Browser-managed models
(Chrome's built-in Gemini Nano via the Prompt API) are a separate path — nothing to
download from Hugging Face, and no choice of weights — but they plug into the same
chat and benchmark surfaces so they can be compared against downloaded models.

It grew out of platform-research work on in-browser LLMs (Project Parallax): the
libraries, formats, and browser APIs exist, but there is no good tool for exploring
the combinatorial space.

## Who it's for

- **Web developers** choosing a model/quant/runtime for a product feature — the
  primary audience.
- **Browser/platform engineers and researchers** probing what WebGPU, WebNN, and wasm
  inference can actually do, and where they fall over.
- **Model tinkerers** who want a zero-install way to try a GGUF/ONNX model they found
  (or made) against real browser constraints.

## Success criteria

- A developer can go from "never heard of this tool" to chatting with a
  browser-suitable Hugging Face model in minutes, with no install and no server.
- A downloaded model can be exercised on every runtime/backend combination that
  supports its format, the tool is explicit about which combinations are possible and
  why, and it reports honest, comparable numbers (load time, time-to-first-token,
  tokens/sec, memory) for each.
- Benchmark results are reproducible enough to base real decisions on, and exportable.
- The tool surfaces *why* something doesn't work (missing capability, quota, model too
  large, unsupported quant) instead of failing opaquely — its diagnostics are part of
  the product.
- Findings about browser/runtime rough edges accumulate into a public, evidence-backed
  log that is useful beyond the tool itself.

## Non-goals

- **Not a hosted inference service.** No server-side inference, no API keys to cloud
  LLMs, no proxying. If it doesn't run in the user's browser, it's out of scope.
- **Not a leaderboard.** Results are measured on the user's own hardware for the
  user's own decisions; we don't aggregate or publish rankings.
- **Not a model-quality eval suite.** Structured perf/memory benchmarking is in scope;
  large-scale accuracy evals (MMLU-style scoring) are not, beyond letting users run
  their own prompt sets and judge outputs.
- **Not a general chat product.** The chat UI is a first-class *testing surface*, not
  a consumer assistant; features are chosen for evaluation value.
