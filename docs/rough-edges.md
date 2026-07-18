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

## RE-006: Hugging Face rate-limit headers are not CORS-exposed  (2026-07-17, status: open)

**Environment:** Google Chrome 150.0.7871.128 on Linux 6.17.0-40, isolated localhost
page; direct response-header comparison with `Origin: https://meenan.dev`, checked
2026-07-17. **Repro or measurement:** Fetch
`https://huggingface.co/api/models?limit=1` in the browser and read
`response.headers.get("ratelimit")`; compare with the same response outside the CORS
filter. **Observed:** The network response includes `RateLimit` and
`RateLimit-Policy`, but HF's `Access-Control-Expose-Headers` list omits both, so
browser JavaScript receives `null`. Pagination `Link`, request ID, error, range, and
artifact-identity headers are exposed. **Expected:** A browser API client could inspect
the service's documented quota state and wait until reset before receiving a 429.
**Impact on WebAI:** The M0 HF API spike must design reactive 429/backoff behavior
without assuming the quota headers are readable; the UI cannot promise a proactive
remaining-request count. Recheck before implementation because this is an external
response policy. **Links:** [HF rate-limit documentation](https://huggingface.co/docs/hub/main/rate-limits),
[Access-Control-Expose-Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers).

## RE-005: Hugging Face Xet resume URLs are expiring and range-bound  (2026-07-17, status: open)

**Environment:** Google Chrome 150.0.7871.128 and curl 8.5.0 on Linux 6.17.0-40;
public HF resolver/Xet CDN, checked 2026-07-17. **Repro or measurement:** Request
`Range: bytes=0-0` for
`Qwen/Qwen2.5-0.5B-Instruct/resolve/main/model.safetensors`, follow the 302, inspect
the signed policy, then repeat through the resolver with matching and deliberately
bogus `If-Range` values. **Observed:** The resolver returns an expiring signed
`us.aws.cdn.hf.co` URL whose policy binds the expected Range header. Both matching and
bogus `If-Range` requests returned the same HTTP 206 rather than making the bogus
validator fall back to a complete response; the resolver `X-Linked-ETag` and final CDN
`ETag` also differ. Commit, linked-size, and linked-hash headers are exposed for CORS
but occur on the followed 302; Fetch exposes only the final response, while manual
redirect mode returns an opaque redirect with no readable headers. Browser CORS fetch
and Authorization preflight work, but HF's CDN hostname is not stable and no tested
response supplied CORP. **Expected:** A persisted resume target/validator would remain
reusable, distinguish changed content, and expose its identity to browser code.
**Impact on WebAI:** The HF API/download spike must design around these constraints:
a signed CDN Location is not a durable resume identity; `If-Range` did not provide a
working validator; and an append path must reject a non-206 or mismatched
`Content-Range`. Find a separate browser-readable HF metadata path for immutable
commit, linked size, and hash. Then verify whether an immutable resolver URL plus that
metadata and re-resolution per range is the right design, and record the choice in a
decision entry rather than treating this finding as the decision. Do not log signed
URLs or restrict a future CSP to today's single CDN host. HF access remains CORS-mode
fetch under D-012's `COEP: require-corp`.
**Links:** [HF file download guide](https://huggingface.co/docs/huggingface_hub/guides/download),
[HF download host list](https://huggingface.co/docs/hub/en/models-downloading),
[Range header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range),
[opaque-redirect filtered response](https://fetch.spec.whatwg.org/#concept-filtered-response-opaque-redirect).

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
