# Rough edges — platform & library findings log

Browser bugs, spec gaps, library quirks, surprising limits, performance cliffs, and
missing capabilities encountered while building and using WebAI. This log is a
first-class project output (root AGENTS.md rule 2): the tool exists to probe exactly
this territory, and evidence-backed findings are useful to browser and library teams
beyond the tool itself.

**Before adding:** grep for the API/library involved to avoid duplicates; extend an
existing entry with new evidence rather than forking it. **Before debugging browser
weirdness:** check here first — it may be known.

Every entry needs: environment (browser + version, OS, hardware where relevant),
a minimal reproduction or measurement, and observed vs. expected behavior. Findings
grounded in a claim about what "should" work cite current documentation (root rule 4).

Format:

```
## RE-NNN: Title  (YYYY-MM-DD, status: open | fixed-upstream | worked-around | wontfix)
Environment / Repro or measurement / Observed / Expected / Impact on WebAI / Links
```

Newest first. RE-numbers are never reused.

---

## RE-004: WebLLM and wllama compatibility defaults fetch executable assets externally  (2026-07-17, status: open)

**Environment:** Tagged-source inspection of WebLLM npm 0.2.84 and wllama 3.5.1 on
2026-07-17; no browser required. **Repro or measurement:** Inspect WebLLM's
`prebuiltAppConfig` and wllama's compatibility-package default behavior. **Observed:**
WebLLM maps its HF model records to compiled model-library wasm under the mutable
`main` branch at `raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs`; wllama fetches
Safari/legacy compatibility wasm from jsDelivr unless the application installs and
maps the compat package locally. WebLLM's config supports optional `integrity` hashes
for the model library, config, and tokenizer, but not parameter shards, and its
default records do not make WebAI's trust decision.
**Expected:** D-005 permits no unlisted third-party runtime-asset traffic, and D-006
requires defensive provenance for downloaded artifacts. **Impact on WebAI:** Use an
allowlisted, revision-pinned custom WebLLM catalog with mandatory supported
`integrity` hashes, separate HF-metadata verification for parameter shards, and
license-audited first-party model libraries; install and self-host all wllama
runtime/compat assets. Tests must fail if either adapter resolves an executable asset
to a third-party origin. **Links:** [WebLLM 0.2.84 default catalog](https://github.com/mlc-ai/web-llm/blob/9e572d6ed95e248f29634996cd32cc8f3023d89d/src/config.ts),
[integrity surface](https://github.com/mlc-ai/web-llm/blob/9e572d6ed95e248f29634996cd32cc8f3023d89d/src/integrity.ts),
[wllama 3.5.1 compatibility defaults](https://github.com/ngxson/wllama/blob/3.5.1/compat/README.md#default-behaviour).

## RE-003: Transformers.js v4 docs and embedded ORT version can drift  (2026-07-17, status: open)

**Environment:** Documentation and tagged-source inspection on 2026-07-17; no browser
required. **Repro or measurement:** Compare the Transformers.js 4.2.0 release and
tagged `packages/transformers/package.json` with the public WebGPU guide and current
standalone `onnxruntime-web`. **Observed:** Some public guides still label their
examples as v3, while 4.2.0 is current and pins
`onnxruntime-web@1.26.0-dev.20260416-b7804b056c`; standalone ORT Web is 1.27.0.
**Expected:** Versioned docs make the wrapper and embedded engine version unambiguous.
**Impact on WebAI:** Record both versions in results, inspect tagged source for
capability claims, and never attribute a Transformers.js result to standalone ORT
without a matched experiment. **Links:** [4.2 release](https://github.com/huggingface/transformers.js/releases/tag/4.2.0),
[tagged package](https://github.com/huggingface/transformers.js/blob/4.2.0/packages/transformers/package.json),
[WebGPU guide](https://huggingface.co/docs/transformers.js/guides/webgpu).

## RE-002: wllama's default build and Safari require different wasm paths  (2026-07-17, status: open)

**Environment:** wllama 3.5.1 compatibility documentation inspected 2026-07-17; local
browser measurements pending. **Repro or measurement:** Compare the default package's
JSPI/Memory64 requirements with `@wllama/wllama-compat` presets. **Observed:** The
default high-performance build is Chromium-oriented; Safari needs the compatibility
package that removes Memory64 and uses Asyncify, which upstream describes as
significantly slower. **Expected:** One artifact would degrade across browsers without
a performance-changing build switch. **Impact on WebAI:** Capability gating must
select and label the build path; cross-browser benchmarks cannot compare them as the
same backend. Measure the actual penalty before making a performance claim.
**Links:** [wllama 3.5.1 README](https://github.com/ngxson/wllama/blob/3.5.1/README.md),
[compatibility matrix](https://github.com/ngxson/wllama/blob/3.5.1/compat/README.md).

## RE-001: MediaPipe Tasks documents utilization metrics with no web opt-out  (2026-07-17, status: open)

**Environment:** MediaPipe repository privacy notice (modified 2026-06-05) and
`@mediapipe/tasks-genai` 0.10.29 documentation inspected 2026-07-17; network capture
not yet run. **Repro or measurement:** Read the repository privacy notice and search
the web LLM configuration/public declarations for a telemetry control. **Observed:**
Google says MediaPipe Tasks send performance and utilization metrics and makes the app
responsible for consent; no web opt-out was documented. **Expected:** D-005 permits no
telemetry or uninitiated network traffic. **Impact on WebAI:** MediaPipe is rejected
in D-011; a future proposal needs a browser network capture proving that metrics are
absent or disableable. **Links:** [MediaPipe repository/privacy snapshot](https://github.com/google-ai-edge/mediapipe/blob/0ad5a71bcdff3d756dc5b07f93765aaeb4152538/README.md#privacy-notice),
[web LLM guide](https://developers.google.com/edge/mediapipe/solutions/genai/llm_inference/web_js).
