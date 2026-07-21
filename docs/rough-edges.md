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

## RE-031: Prompt abort does not define a reusable canonical session boundary  (2026-07-20, status: worked-around)

**Environment:** Prompt API Community Group draft dated 2026-06-22 and current Chrome
Prompt API/session-management documentation, inspected 2026-07-20. **Repro or
measurement:** Follow the draft's `promptStreaming()` algorithms through prefill,
generation, and an `AbortSignal` firing after prefill. **Observed:** Prefill updates the
model's internal state and context usage before generation. The shared abort algorithm
rejects the stream and stops production, but neither the draft nor Chrome's stop
example states whether an interrupted prompt/partial response is rolled back from a
reused session. This is a specification-evidence gap, not a claim that Chrome retains
the turn. **Expected:** A stateful chat replay contract needs an explicit post-abort
session boundary. **Impact on WebAI:** After any failed or aborted Prompt generation,
WebAI destroys the ephemeral browser session and requires reload from its canonical
visible transcript before another turn. **Links:** [Prompt API draft](https://webmachinelearning.github.io/prompt-api/),
[Chrome session management](https://developer.chrome.com/docs/ai/session-management).

## RE-030: Prompt overflow does not expose a replayable eviction boundary  (2026-07-19, status: worked-around)

**Environment:** Stable-web Prompt API documentation and Community Group draft,
checked 2026-07-19. **Repro or measurement:** Create a stateful session, append prompt/
response pairs until `contextoverflow`, retain the complete visible transcript, then
attempt to reconstruct it by passing every visible turn as `initialPrompts` to a new
session. **Observed:** Chrome evicts oldest ordinary prompt/response pairs as needed but
does not report which pairs were removed. `initialPrompts` are not eligible for that
runtime eviction and `create()` rejects when they do not fit. **Expected:** Exact
restoration would require either an exposed eviction boundary or a browser-owned saved
session. **Impact on WebAI:** The transcript and overflow warning remain portable and
readable, but WebAI refuses reload/edit/regenerate replay after an overflow instead of
reviving discarded turns or risking a non-evictable oversized prefix. A new
conversation is required; automatic summarization would be a separate, lossy feature
decision. **Links:** [Chrome session compacting](https://developer.chrome.com/docs/ai/session-compacting),
[Prompt API draft](https://webmachinelearning.github.io/prompt-api/).

## RE-029: wllama 3.5.1 exposes completion usage but no standalone tokenizer  (2026-07-19, status: worked-around)

**Environment:** `@wllama/wllama` 3.5.1 / bundled llama.cpp
`b9640-dd4623a`, package guide/declaration/source inspection plus controlled Chrome for
Testing 149.0.7827.55 on Ubuntu 24.04.4 LTS/Linux, 2026-07-19. **Repro or
measurement:** Inspect `guides/intro-v3.md`, the exported `Wllama` methods, and chat
completion types; run a captured streaming completion with usage, timings, and
logprobs. **Observed:** The v3 guide explicitly lists low-level `tokenize()` and
`detokenize()` among removed APIs. The wrapper exposes completion usage/timing records
and per-sampled-token logprob records, but no supported arbitrary text-to-token call.
`cache_prompt` and `timings.cache_n` are exposed through the native completion request
and result. **Expected:** A general tokenizer inspector would ideally inspect arbitrary
prompt text without generating. **Impact on WebAI:** M6 does not ship a fake or
main-thread tokenizer. It reports exact post-response prompt/completion/cache evidence
and retains at most 512 validated sampled output IDs/pieces, while labelling prompt
token breakdown unavailable. A future separate tokenizer must run in a worker and be
measured against the loaded runtime/template before its counts can be called
equivalent (D-006, D-007, D-044). **Links:** [wllama v3 migration guide](https://github.com/ngxson/wllama/blob/3.5.1/guides/intro-v3.md),
[wllama completion source](https://github.com/ngxson/wllama/blob/3.5.1/src/wllama.ts).

## RE-028: wllama abort polling cannot interrupt an in-flight native result request  (2026-07-19, status: worked-around)

**Environment:** `@wllama/wllama` 3.5.1 / bundled llama.cpp
`b9640-dd4623a`, source-inspected and exercised with a non-cooperative completion in
Chrome for Testing 149.0.7827.55 on Ubuntu 24.04.4 LTS/Linux on 2026-07-19.
**Repro or measurement:** Start streaming, return one partial chunk, then keep the next
result request pending without observing its `AbortSignal`; press Chat's Stop button.
Inspect the pinned wrapper's completion loop and worker proxy shutdown. **Observed:**
The completion loop checks `abortSignal.aborted` only before each awaited `get_result`,
so an in-flight request must finish before cooperative abort is observed. `wllamaExit()`
terminates the worker but leaves both queued and callback-waiting proxy promises
unsettled. The controlled request remained pending indefinitely under the original
path. **Expected:** An emergency Stop should settle promptly even when generation or a
native result request does not cooperate. **Impact on WebAI:** The adapter races the
stream against abort and terminates/invalidates the wllama session. WebAI's pinned ESM
patch rejects proxy queues during termination, preventing the abandoned stream from
retaining a promise that can never receive a worker response. Browser coverage verifies
prompt Stop settles, preserves partial text, exposes `No session`, and enables reload
(D-039). **Links:** [wllama 3.5.1 completion loop](https://github.com/ngxson/wllama/blob/3.5.1/src/wllama.ts),
[worker proxy](https://github.com/ngxson/wllama/blob/3.5.1/src/worker.ts).

## RE-027: A thinking template argument has no runtime acknowledgement  (2026-07-19, status: worked-around)

**Environment:** `@wllama/wllama` 3.5.1 / bundled llama.cpp
`b9640-dd4623a`, source-inspected and exercised through controlled Chrome for Testing
149.0.7827.55 on Ubuntu 24.04.4 LTS/Linux on 2026-07-19. **Repro or measurement:** Send
consecutive chat completions with
`chat_template_kwargs.enable_thinking` set to true or false and inspect the wrapper
source plus captured request. **Observed:** wllama types and forwards the arbitrary
template-argument object, but returns no capability or acknowledgement that the loaded
model's template read `enable_thinking`. Current llama.cpp maintainers confirm that
templates without relevant support can ignore it. **Expected:** A user-facing toggle
would ideally have loaded-template support evidence and an effective value, not only a
requested value. **Impact on WebAI:** Chat calls the control a model-template request,
warns that unsupported templates may ignore it, and continues displaying any reasoning
that is generated. The switch is unavailable for the Prompt API, which exposes no such
request. WebAI does not infer effective support from model-family names or suppress
reasoning output to simulate success (D-038). **Links:**
[wllama 3.5.1 completion source](https://github.com/ngxson/wllama/blob/3.5.1/src/wllama.ts),
[llama.cpp #20196](https://github.com/ggml-org/llama.cpp/issues/20196),
[D-038](decisions.md).

## RE-026: Hugging Face lineage metadata exposes only immediate, unpinned parents  (2026-07-19, status: worked-around)

**Environment:** Hugging Face public model API and official `huggingface_hub`/model-card
documentation, queried from Linux on 2026-07-19. **Repro or measurement:** Request
`sha`, `baseModels`, and `cardData` expansions for
`unsloth/gemma-4-E2B-it-qat-GGUF`, then repeat for each returned parent. Probe a merge
model and the plausible `/model-tree`, `/base-models`, `/ancestors`, and `/tree` model
API routes. **Observed:** Each model-info response returned only immediate parent repo
IDs and one relation, with no parent commit. Three additional calls were required to
reach the Gemma root. A merge returned two immediate parents. No documented recursive
lineage route was found; plausible routes returned 404, and documented `recursive`
options concern repository files. **Expected:** A website-style full ancestry graph
would ideally have a bounded endpoint or pinned parent edges. **Impact on WebAI:**
D-033/D-036 reconstruct only the selected result's ancestry, retain independently
resolved parent commits as current internal observations, deduplicate/cycle-check the
graph, and follow branches to terminal ancestors within 32 repositories using two
concurrent requests and 256-KiB responses. The UI reverses those immediate-parent
edges into a base-first linked-name tree. Public/open minimal snapshots are cached for
24 hours. **Links:**
[Hugging Face model cards](https://huggingface.co/docs/hub/model-cards),
[`HfApi` reference](https://huggingface.co/docs/huggingface_hub/main/en/package_reference/hf_api),
[D-033 and D-036](decisions.md).

## RE-025: sqlite-wasm's documented `opfs` namespace probe can disagree with `OpfsDb`  (2026-07-19, status: worked-around)

**Environment:** `@sqlite.org/sqlite-wasm` 3.53.0-build1, Astro/Vite production build,
Playwright Chromium 150 on Linux, cross-origin-isolated dedicated model worker with
SharedArrayBuffer and `navigator.storage.getDirectory`. **Repro or measurement:**
Initialize the package's direct module API in the worker, then require both
`"opfs" in sqlite3` and `sqlite3.oo1.OpfsDb`; report the selected catalog backend.
Repeat with only the documented OO1 class probe and perform create/write/page reload/
worker reload/read against an OPFS database. **Observed:** The combined test selected
the memory fallback because the top-level `opfs` property was absent, even though
`oo1.OpfsDb` existed. The class-only probe then persisted a row across reload and
served it without a second network detail request. **Expected:** The package README's
sample treats `"opfs" in sqlite3` as the persistence-availability test. **Impact on
WebAI:** Feature detection uses the API actually consumed—`oo1.OpfsDb`—and still
falls back to memory on construction or SQL failure. A deterministic production-build
browser test guards the persistence round trip. **Links:**
[`@sqlite.org/sqlite-wasm` README](https://github.com/sqlite/sqlite-wasm#readme),
[SQLite wasm OPFS persistence](https://sqlite.org/wasm/doc/tip/persistence.md).

## RE-024: Prompt API presence does not imply a usable browser-managed model  (2026-07-19, status: worked-around)

**Environment:** Stable Google Chrome 150.0.7871.128 on Linux, a fresh headless
Playwright profile, and a secure top-level page. **Repro or measurement:** Inspect own
properties on `LanguageModel` and its prototype, then call `availability()` with
English text in both `expectedInputs` and `expectedOutputs`. **Observed:** The global
existed and its only own static operations were `availability` and `create`, but the
probe returned `unavailable`. The session prototype used current
`contextUsage`/`contextWindow` names and exposed no legacy usage/quota aliases or
sampling parameters. **Expected:** API presence proves only that the entry point
exists; Chrome's documented hardware, storage, profile, policy, and model state still
determine whether the requested session can run. **Impact on WebAI:** Runtime gating
uses the asynchronous availability result as volatile evidence and keeps unavailable
or failed states distinct. Automated chat coverage injects a deterministic fake for
download/session behavior, while the real-browser capability test accepts
`unavailable` as a valid measured result. WebAI exposes no stable-web sampling
controls and never UA-sniffs Chrome eligibility. **Links:** [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api),
[Chrome built-in AI requirements](https://developer.chrome.com/docs/ai/get-started#requirements),
[D-030](decisions.md).

## RE-023: wllama leaves a terminal stream result for the next request  (2026-07-18, status: worked-around)

**Environment:** `@wllama/wllama` 3.5.1 / bundled llama.cpp `b9640-dd4623a`,
Chromium 149.0.7827.55 on Linux, one CPU thread, and the immutable 16,309,120-byte
tiny-random Qwen3 Q2_K GGUF used by RE-017. **Repro or measurement:** On one loaded
runtime, stream two consecutive six-token chat completions and retain every choice's
text and `finish_reason`. Repeat once with `timings_per_token: false` and once with it
enabled. **Observed:** In both variants, the first iterator returned its role chunk and
six content chunks but no terminal chunk. The second iterator began with the first
request's empty `finish_reason: "length"` chunk, then returned its role chunk and only
five of its six generated content chunks. The pinned glue computes `has_more` by
running the task loop, dequeues one result, and returns both; the JavaScript response
loop exits on that task-loop flag after processing only the one dequeued result.
**Expected:** Each iterator drains all results belonging to its own request, including
its terminal record, before it completes. **Impact on WebAI:** Consecutive turns can
consume a previous turn's terminal result and leave part of the current turn queued
for the following request. Per-token timing is not the trigger. WebAI's pinned ESM
transformation removes the premature non-empty-result break and continues until the
native call reports both no payload and no active task. The transformer asserts one
exact source match, receives its own content hash, and is covered by the runtime asset
gate. A post-patch run loaded the real local Gemma 4 from five shards and issued two
consecutive two-token chats; each iterator returned both sampled token IDs and its own
`finish_reason: "length"` record (D-029). **Links:** [wllama 3.5.1 native result glue](https://github.com/ngxson/wllama/blob/3.5.1/cpp/wllama-context.h),
[JavaScript response loop](https://github.com/ngxson/wllama/blob/3.5.1/src/wllama.ts),
[D-028](decisions.md).

## RE-022: wllama exposes sampled token IDs through undeclared logprob data  (2026-07-18, status: worked-around)

**Environment:** `@wllama/wllama` 3.5.1 / bundled llama.cpp `b9640-dd4623a`,
Chromium 149.0.7827.55 on Linux, the RE-017 tiny-random Qwen3 GGUF, and local
`gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf` (2,620,370,976 bytes, SHA-256
`e531007218dfab990486a5de7676a6932d6ea8dea233d1f698d7c21cf8a16889`). **Repro or
measurement:** Compare streamed `createChatCompletion` and raw-prompt
`createCompletion` with `return_tokens: true`, then repeat with logprobs enabled.
Split the Gemma file into five upstream-compatible temporary shards, load it through
the pinned browser runtime with `reasoning_format: "none"`, and generate 512 tokens
from a medieval-blacksmith prompt. **Observed:** `return_tokens` alone added neither a
`tokens` field nor token IDs to either API's chunks. Logprobs added an `id`, decoded
`token`, bytes, and score for every sampled token in both APIs. The declared chat
logprob type omits `id`, while the raw API returned the same content-array shape rather
than its declared legacy raw-logprob shape. In the real Gemma run, the exact streamed
boundary chunk was `{ delta.content: "<channel|>", logprob.id: 101,
logprob.token: "<channel|>" }`; all 512 sampled tokens had IDs. GGUF metadata classifies
vocabulary item 101 as user-defined token type 4, not control type 3. **Expected:** A
token-return option should have a documented, typed result shape, and runtime values
should match the declarations. **Impact on WebAI:** wllama's raw-prompt completion API
does not provide better token visibility than its chat API. Chat plus validated
logprob payloads preserve exact sampled IDs while retaining chat templating and
structured deltas. WebAI validates IDs against a bounded GGUF-declared special-token
index, filters its known channel dialect, and exposes the remainder in a bounded
copyable disclosure. The pinned compatibility test and asset hash guard the undeclared
shape; logprob overhead and tool-call token coverage remain unmeasured (D-029). **Links:**
[wllama 3.5.1 OAI-compatible types](https://github.com/ngxson/wllama/blob/3.5.1/src/types/oai-compat.ts),
[llama.cpp server completion options](https://github.com/ggml-org/llama.cpp/blob/dd4623a74f0c85e6b1dd9ee99a92b9c67cac3708/tools/server/README.md),
[RE-021](#re-021-gemma-4-closes-reasoning-with-a-bare-channel-token).

## RE-021: Gemma 4 closes reasoning with a bare channel token  (2026-07-18, status: worked-around)

**Environment:** `@wllama/wllama` 3.5.1 / bundled llama.cpp `b9640-dd4623a` and
`unsloth/gemma-4-E2B-it-qat-GGUF`, live browser chat observed 2026-07-18. **Repro or
measurement:** Generate a reasoning response with `reasoning_format: "none"` and inspect
the visible channel boundary. **Observed:** The stream used `<channel|>` between the
thinking trace and user-facing response. WebAI recognized only named `<|channel>...`
and `<|channel|>...<|message|>` openings, so it displayed the separator and final answer
inside the Thinking disclosure. llama.cpp's Gemma 4 logs independently identify
`<channel|>` as a reserved generated token at the transition out of reasoning.
**Expected:** The intermediate channel completes at the reserved closing token and the
following text remains visible as final output. **Impact on WebAI:** The bounded parser
recognizes fragmented `<channel|>`, completes the active channel, and starts a final
channel without rendering the marker. The live example also emitted its reasoning
preamble before any named opening marker; when the bare boundary later arrives, WebAI
retroactively classifies that implicit text as Thinking rather than joining it to the
visible answer. Unit and controlled browser tests cover both shapes. **Links:** [llama.cpp Gemma 4 trace](https://github.com/ggml-org/llama.cpp/issues/22786),
[RE-019](#re-019-wllamas-declared-chat-chunk-type-omits-parsed-reasoning-output),
[D-028](decisions.md).

## RE-020: Per-token cumulative channel renders can starve the page  (2026-07-18, status: worked-around)

**Environment:** React 19.2.7, headless Chromium, WebAI's wllama channel path, and a
live `unsloth/gemma-4-E2B-it-qat-GGUF` run observed 2026-07-18. **Repro or
measurement:** The live run completed a long thinking channel and then left the page
main thread unresponsive. A controlled adapter emitted 50,000 Gemma-style special-token
chunks followed by a final channel; each cumulative channel snapshot previously queued
its own `setMessages` update. The Send click did not return before the 45-second test
timeout. As a control, completing and collapsing one synthetic 2,000,000-character
thinking snapshot took 191 ms, so channel collapse alone did not reproduce the hang.
**Observed:** Rendering frequency, rather than retained response size, allowed a fast or
runaway stream to starve the page. The exact post-thinking tokens from the live run were
not captured, so whether the model, llama.cpp, or wllama initiated that sequence remains
open. **Expected:** Response text remains complete and inspectable without model token
rate determining React render rate. **Impact on WebAI:** Chat retains only the latest
cumulative channel snapshot pending between animation frames, while the adapter batches
raw chunks to a 16 ms cadence before parsing. Incomplete channel-marker suffixes are
bounded to 256 bytes, and completion or failure flushes synchronously. A controlled
browser regression keeps the 50,000-chunk stream responsive without imposing an
output-token ceiling.
**Links:** [RE-019](#re-019-wllamas-declared-chat-chunk-type-omits-parsed-reasoning-output),
[D-028](decisions.md).

## RE-019: wllama's declared chat chunk type omits parsed reasoning output  (2026-07-18, status: worked-around)

**Environment:** `@wllama/wllama` 3.5.1 / bundled llama.cpp `b9640-dd4623a` and
`unsloth/gemma-4-E2B-it-qat-GGUF`, observed 2026-07-18. **Repro or measurement:**
Generate with the default Gemma 4 chat template, stream `delta.content`, and retain
the final usage/timings chunk. **Observed:** The terminal record reported 98 prompt
tokens and the configured 64 completion tokens, but ordinary `delta.content` remained
empty, so WebAI displayed metrics without response text and could not measure TTFT.
The pinned llama.cpp binary contains the Gemma 4 reasoning parser, while wllama's
`ChatCompletionChunkDelta` declaration exposes `content` but not llama.cpp's
`reasoning_content` extension. **Expected:** Generated text must remain observable
through the wrapper's declared streaming API. **Impact on WebAI:** Models load with
`reasoning_format: "none"`, which leaves reasoning and answer text in declared
`content`. Generation uses llama.cpp's `max_tokens: -1` with context shifting disabled,
so EOS or the configured context—not an arbitrary response cap—ends output. A bounded
incremental parser recognizes fragmented channel markers, keeps the active channel
open, collapses intermediate channels when they complete, and leaves final text
visible. A controlled browser test verifies these transitions and observed TTFT.
**Links:** [llama.cpp
reasoning format](https://github.com/ggml-org/llama.cpp/blob/dd4623a74f0c85e6b1dd9ee99a92b9c67cac3708/tools/server/README.md),
[wllama 3.5.1 response types](https://github.com/ngxson/wllama/blob/3.5.1/src/types/oai-compat.ts),
[D-028](decisions.md).

## RE-018: wllama local-Blob model loads expose no progress callback  (2026-07-18, status: worked-around)

**Environment:** `@wllama/wllama` 3.5.1 npm source and WebAI's verified OPFS
`File`/`Blob[]` load path, inspected 2026-07-18. **Repro or measurement:** Compare
`loadModelFromUrl(..., { progressCallback })` with `loadModel(Blob[], params)` and trace
the latter through `prepareBlobs()`, worker/wasm initialization, and the blocking
`wllamaAction("load")`. **Observed:** Download options report transferred bytes, but
`LoadModelParams` has no progress callback and the local load resolves only after
engine initialization, GGUF parsing, backend setup, weight loading, and context
allocation. Default JSPI reads may be lazy, overlapping, or non-sequential, so counting
internal reads would not yield an honest overall percentage. **Expected:** A local
multi-gigabyte model load should expose stable phase or byte progress independently of
network acquisition. **Impact on WebAI:** Chat reports determinate progress only for
WebAI-owned split preparation, then visible indeterminate phases for opening verified
files, loading bundled runtime assets, and loading weights. It reports elapsed time but
never fabricates a percentage or scrapes unstable native logs. **Links:** [wllama 3.5.1
load parameters](https://github.com/ngxson/wllama/blob/3.5.1/src/types/types.ts),
[local load implementation](https://github.com/ngxson/wllama/blob/3.5.1/src/wllama.ts),
[D-028](decisions.md).

## RE-017: wllama streaming omits final timings unless per-token timings are requested  (2026-07-18, status: worked-around)

**Environment:** wllama 3.5.1 / llama.cpp `b9640-dd4623a`, headless Chromium on
Linux, one CPU thread, immutable 16,309,120-byte tiny-random Qwen3 Q2_K GGUF,
2026-07-18. **Repro or measurement:** Stream a 64-token chat completion first with
`stream_options.include_usage`, then with both that option and
`timings_per_token: true`; inspect every chunk's optional `usage` and `timings`.
**Observed:** The first run streamed text and completed but exposed neither usage nor
timings. The second exposed running/final llama.cpp timing records, including prompt
and predicted token counts and rates; the measured path reported 1,475.41 prefill and
148.70 decode tok/s. **Expected:** The typed optional final `timings` member suggests
that a completed stream may report aggregate timings without requesting every token's
timing. **Impact on WebAI:** The adapter explicitly requests per-token timings and
uses the latest record for token counts and throughput, while TTFT/end-to-end remain
page timestamps. This is a path check, not a performance claim or a measurement of
the option's overhead. **Links:** [wllama 3.5.1 response types](https://github.com/ngxson/wllama/blob/3.5.1/src/types/oai-compat.ts),
[llama.cpp streaming timing test](https://github.com/ggml-org/llama.cpp/blob/dd4623a74f0c85e6b1dd9ee99a92b9c67cac3708/tools/server/tests/unit/test_chat_completion.py),
[D-028](decisions.md).

## RE-016: wllama cannot assign a non-mmproj companion a separate model role  (2026-07-18, status: open)

**Environment:** `@wllama/wllama` 3.5.1 npm contents and bundled llama.cpp
`b9640-dd4623a`, inspected 2026-07-18; paired Gemma 4 target/MTP artifacts from M2.
**Repro or measurement:** Trace `loadModel(blobs, params)` through `prepareBlobs()` and
the worker load request. Supply a target plus an MTP GGUF and compare with mmproj
handling. **Observed:** `prepareBlobs()` detects mmproj as the only separate role. It
renames every other blob `model-NNNNN-of-NNNNN.gguf` and sends all of them in target
`model_paths`. Load parameters forward generic `spec_draft_*` values, but there is no
separate draft/MTP path or llama.cpp MTP-method selector. **Expected:** A browser
wrapper claiming controllable MTP would mount target and companion under distinct
roles and select the engine's MTP path. **Impact on WebAI:** The M3 adapter excludes
the installed companion from target shards and reports `unsupported` with reason
`companion-mount-not-exposed`; upstream engine support and artifact availability are
not mislabeled as acceleration. No target-only/MTP A/B is valid on this wrapper.
**Links:** [wllama 3.5.1 blob preparation](https://github.com/ngxson/wllama/blob/3.5.1/src/utils.ts),
[wllama 3.5.1 load request](https://github.com/ngxson/wllama/blob/3.5.1/src/wllama.ts),
[D-026](decisions.md), [D-028](decisions.md).

## RE-015: upstream gguf-split has no resumable streaming sink  (2026-07-18, status: worked-around)

**Environment:** llama.cpp commit
`dd4623a74f0c85e6b1dd9ee99a92b9c67cac3708`, Emscripten 4.0.20, and M2's one-MiB
restart-safe acquisition contract, inspected and built on Linux 2026-07-18.
**Repro or measurement:** Build `tools/gguf-split`, trace its input I/O, and compare
the state it retains with D-025's durable source-offset checkpoint. The tool opens a
completed file, reads the GGUF table, builds output metadata, and seeks to each tensor
body; it exposes neither a stream consumer nor serializable parser, output-hash, and
split-writer state. **Observed:** A wasm recompile cannot consume a resumable network
stream safely. Advancing the durable download offset would lose corresponding derived
state on worker/page loss. **Expected:** A download transformation sink must checkpoint
source offset, split outputs, splitter state, and resumable hashes atomically.
**Impact on WebAI:** D-028 uses the recorded fallback: verify and promote the monolith,
then run a bounded wasm planner plus TypeScript OPFS copier. This costs an extra full
source read and temporary source-plus-output storage, but leaves M2's resume and
integrity contract unchanged. **Links:** [pinned upstream tool](https://github.com/ggml-org/llama.cpp/blob/dd4623a74f0c85e6b1dd9ee99a92b9c67cac3708/tools/gguf-split/gguf-split.cpp),
[D-009](decisions.md), [D-028](decisions.md).

## RE-014: Gemma 4 MTP exposes a hyphenated architecture namespace  (2026-07-18, status: worked-around)

**Environment:** `mtp-gemma-4-E2B-it.gguf` from
`unsloth/gemma-4-E2B-it-qat-GGUF` revision
`66a399f68ddd113b06dff02fca9523e55465d11d`; llama.cpp commit
`571d0d540df04f25298d0e159e520d9fc62ed121`; WebAI TypeScript inspector on Linux,
2026-07-18. **Repro or measurement:** Read the MTP file's first 16 MiB. Its GGUF v3
header declares 49 tensors and 43 metadata pairs. The first architecture-specific key
at byte 316 is `gemma4-assistant.block_count`; subsequent keys use the same
hyphenated namespace. All 43 keys are unique and metadata ends at byte 15,783,265.
Compare with llama.cpp's constants, which define the architecture string as
`gemma4-assistant`, and its GGUF reader, which rejects empty and duplicate keys but
does not impose WebAI's former `[a-z0-9_.]` character allowlist. **Observed:** WebAI
reported “invalid or duplicate key” even though the upstream runtime accepts and
defines the namespace. **Expected:** Defensive inspection should enforce byte, UTF-8,
control-character, and uniqueness bounds without inventing a format restriction that
rejects an upstream architecture. **Impact on WebAI:** Metadata keys are now limited
to 1,024 bytes, non-empty, unique, valid UTF-8, and control-free, while punctuation is
otherwise accepted and safely rendered as text. The MTP uses the ordinary bounded
GGUF parser but is separately labelled as a speculative-decoding companion in the
manager. A regression fixture covers the hyphenated namespace, and the pinned real
header parses as `gemma4-assistant`. **Links:** [pinned MTP file](https://huggingface.co/unsloth/gemma-4-E2B-it-qat-GGUF/blob/66a399f68ddd113b06dff02fca9523e55465d11d/mtp-gemma-4-E2B-it.gguf),
[llama.cpp architecture constants](https://github.com/ggml-org/llama.cpp/blob/571d0d540df04f25298d0e159e520d9fc62ed121/gguf-py/gguf/constants.py#L1036-L1042),
[llama.cpp GGUF reader](https://github.com/ggml-org/llama.cpp/blob/571d0d540df04f25298d0e159e520d9fc62ed121/ggml/src/gguf.cpp#L544-L570),
[D-025](decisions.md).

## RE-013: Current Gemma 4 GGUF tokenizer metadata exceeds small array-count assumptions  (2026-07-18, status: worked-around)

**Environment:** Revision `66a399f68ddd113b06dff02fca9523e55465d11d` of
`unsloth/gemma-4-E2B-it-qat-GGUF`, measured through its immutable Hugging Face
resolver and WebAI's TypeScript inspector on Linux, 2026-07-18. **Repro or
measurement:** Fetch bytes 0–16,777,215 of the 2,620,370,976-byte
`gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf` and walk its GGUF v3 metadata. Its tokenizer
arrays contain 262,144 tokens, 262,144 scores, 262,144 token types, and 514,906
merges—1,301,338 items total. Metadata ends at byte 15,783,435. The API-advertised
LFS SHA-256 is
`e531007218dfab990486a5de7676a6932d6ea8dea233d1f698d7c21cf8a16889`.
**Observed:** M2's initial 100,000-per-array/250,000-total limits rejected the
integrity-verified artifact before installation. **Expected:** Contemporary tokenizer
metadata that fits the byte ceiling should remain inspectable without materializing
every value, and inspector lag should not override content integrity. **Impact on
WebAI:** D-025 permits one million items per array and two million overall, previews
only bounded values, and structurally advances undisplayed tails. The real prefix
parsed in 68 ms in the local Vitest/Vite environment; this is a development-machine
measurement, not a cross-browser performance claim. Inspection is now best-effort,
records a warning on failure, and can be re-run from installed OPFS bytes after code
updates. Synthetic tests retain controlled rejection above the new ceiling. **Links:**
[pinned model revision](https://huggingface.co/unsloth/gemma-4-E2B-it-qat-GGUF/tree/66a399f68ddd113b06dff02fca9523e55465d11d),
[GGUF specification](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md),
[D-025](decisions.md).

## RE-012: Writable-stream durability fallback repeats existing-data copy semantics  (2026-07-18, status: open)

**Environment:** File System Living Standard last updated 2026-03-15, inspected
2026-07-18; implementation timing remains unmeasured. **Repro or measurement:** For a
worker without `createSyncAccessHandle()`, close a
`createWritable({ keepExistingData: true })` stream after every one-MiB checkpoint.
The standard says each new writable starts by copying the existing file into its
temporary file. The logical existing-data volume over a 4 GiB download is therefore
`sum(0..4095) MiB`, about 8 TiB before implementation-level copy-on-write
optimizations. **Observed:** The fallback's durability contract necessarily repeats
existing-data copy semantics at every checkpoint; wall-clock and physical-write costs
vary by engine and have not been measured. **Expected:** A large resumable append path
would durably commit new chunks without revisiting the entire prefix. **Impact on
WebAI:** Chrome's measured worker sync-handle path avoids this cliff. The writable
fallback is correctness-preserving but is not presented as performance-equivalent;
measure target engines before enabling multi-GiB acquisition there, and consider
durable chunk files if the cost is material. **Links:** [File System Standard,
`createWritable`](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createwritable),
[D-025](decisions.md).

## RE-011: IndexedDB transactions auto-close across unrelated asynchronous OPFS work  (2026-07-18, status: worked-around)

**Environment:** Playwright Chromium used by M2 browser/e2e tests on Linux,
2026-07-18. **Repro or measurement:** Start an IndexedDB read-write transaction, then
await one or more OPFS `getFile()` operations before queueing any IDB request; also
attach a transaction-completion listener only after awaiting the final fast request.
Exercise both paths with a page/worker restart over a durable 1 MiB partial and with a
152-byte local GGUF import. **Observed:** The transaction became inactive while OPFS
was awaited, so reconciliation failed; independently, attaching terminal listeners
late could miss completion and leave an otherwise committed import promise pending.
**Expected:** Treating the transaction as a general async critical section would keep
it usable until the surrounding function returned. **Impact on WebAI:** All terminal
listeners are installed immediately after transaction creation. Reconciliation does
every OPFS read first, computes the changes in memory, then opens a short IDB-only
write transaction and queues its requests synchronously. Code must never hold an IDB
transaction across network, OPFS, hashing, or parsing awaits. Browser tests cover
both the worker-restart and fast-import cases. **Links:**
[MDN transaction lifetime](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction),
[D-025](decisions.md).

## RE-010: WebNN removed named device-type selection while M1 architecture still expected it  (2026-07-17, status: worked-around)

**Environment:** W3C WebNN Editor's Draft dated 26 June 2026, inspected
2026-07-17; M1 implementation and Playwright Chromium 149 browser probes on Linux.
**Repro or measurement:** Search the current draft WebIDL for `deviceType`, then
inspect `MLContextOptions`, `ML.createContext()`, and `MLContext.accelerated`. Compare
that surface with the M0 feature/architecture phrase “WebNN device types.”
**Observed:** The draft contains no `deviceType`; context options are
`powerPreference` and `accelerated`, and the created context reports only effective
`accelerated` state. The draft explicitly says these options remain under active
development. **Expected:** The architecture's promised CPU/GPU/NPU capability rows
would have a current standards surface that can select and verify those identities.
**Impact on WebAI:** D-021 and M1 now probe a default worker context, requested and
effective acceleration, without inventing device identity. M7 adapter initialization
must record the actual backend evidence its runtime exposes and recheck the spec.
**Links:** [current WebNN specification](https://webmachinelearning.github.io/webnn/),
[D-021](decisions.md).

## RE-009: Hugging Face's OpenAPI schema omits core model discovery routes  (2026-07-17, status: open)

**Environment:** Live Hugging Face schema and API plus official `huggingface_hub`
client documentation/source, checked 2026-07-17; no browser required. **Repro or
measurement:** List `.paths` from the
[published schema](https://huggingface.co/.well-known/openapi.json)
and search for `GET /api/models` plus model-info
`GET /api/models/{namespace}/{repo}`; compare with successful live calls and the
official `list_models`/`model_info` wrappers. **Observed:** The published schema
contains many repo operations, including tree and paths-info, but omits both core GET
routes even though they are live and wrapped by the official client. **Expected:** A
generated client from the advertised Hub API schema would cover the read endpoints
needed for model discovery. **Impact on WebAI:** Do not select or generate an OpenAPI
client as the sole HF integration. Implement the measured read calls behind local
types/validators and recheck their official client mapping at M2/M5. **Links:**
[HF API spike](hugging-face-api.md),
[Hub API endpoints](https://huggingface.co/docs/hub/main/api),
[`huggingface_hub` API reference](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api).

## RE-008: Public missing-repo lookup reports a misleading authentication error  (2026-07-17, status: open)

**Environment:** curl 8.5.0 on Linux against the public HF model API with
`Origin: https://meenan.dev`, checked 2026-07-17. **Repro or measurement:** GET model
detail for
`webai-spike-definitely-not-a-real-user/webai-spike-definitely-not-a-real-repo`
without an Authorization header. Then GET
`Qwen/Qwen2.5-0.5B-Instruct/revision/webai-spike-invalid-revision` the same way.
**Observed:** The missing repo returned HTTP 401; both its JSON `error` and
`X-Error-Message` were `Invalid username or password.`. The invalid revision returned
HTTP 404 with JSON `error` `Invalid rev id: webai-spike-invalid-revision` and the
distinct `X-Error-Code: RevisionNotFound` header. The CORS response allow-listed that
header for browser access. **Expected:** A missing public resource would be
distinguishable from bad credentials. **Impact on WebAI:** A 401/404 model lookup must
say “not found, private/gated, or unauthorized” until an authenticated request or
other evidence narrows the cause; never tell an anonymous user that a password is
wrong. M2/M5 fixtures assert status, JSON error, and exposed error headers separately
rather than conflating their values.
**Links:** [HF API spike](hugging-face-api.md),
[`model_info` error contract](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.HfApi.model_info).

## RE-007: Hugging Face GGUF aggregate size is unsafe for per-quant suitability  (2026-07-17, status: open)

**Environment:** Live public model search/info/tree API with curl 8.5.0 on Linux,
checked 2026-07-17. **Repro or measurement:** Compare expanded
`gguf.totalFileSize`, repo `usedStorage`, and the sum of revision-pinned GGUF tree
entries from
`GET /api/models/Qwen/Qwen3-4B-GGUF?blobs=true` at returned commit
`bc640142c66e1fdd12af0bd68f40445458f3869b`. The expanded value was 2,497,280,256
bytes—exactly the Q4_K_M file—while five GGUF files and `usedStorage` totaled
15,797,169,824 bytes.
**Observed:** The aggregate has no associated filename/variant and cannot drive a
quota or download choice. **Expected:** A size exposed in search metadata would have
documented scope or identify the files it covers. **Impact on WebAI:** D-013 uses it
only as an untrusted discovery hint. Actual size/quant filtering totals the explicit
revision-pinned file/shard set; UI never labels `gguf.totalFileSize` as download size.
**Links:** [HF API spike](hugging-face-api.md),
[`list_models` expansion reference](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.HfApi.list_models).

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
remaining-request count. D-013 now selects debouncing/coalescing, SHA-keyed caching,
and bounded reactive backoff with visible retry/cancel state. Recheck before
implementation because this is an external response policy. **Links:** [HF API spike](hugging-face-api.md),
[HF rate-limit documentation](https://huggingface.co/docs/hub/main/rate-limits),
[Access-Control-Expose-Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers).

## RE-005: Hugging Face Xet resume URLs are expiring and range-bound  (2026-07-17, status: open)

**Environment:** Google Chrome 150.0.7871.128 and curl 8.5.0 on Linux 6.17.0-40;
public HF resolver/Xet CDN, checked 2026-07-17. **Repro or measurement:** Request
`Range: bytes=0-0` for
`Qwen/Qwen2.5-0.5B-Instruct/resolve/main/model.safetensors`, follow the 302, inspect
the signed policy, then repeat through the resolver with matching and deliberately
bogus `If-Range` values. For the complete/past-end measurement, use the immutable URL
`https://huggingface.co/hf-internal-testing/tiny-random-gpt2/resolve/71034c5d8bde858ff824298bdedc65515b97d2b9/model.safetensors`:
download it with `curl -L --range 0- -D headers -o model URL`, run `sha256sum model`,
then run `curl -L --range 453864-453864 -D headers-416 -o body URL` and inspect the
final headers/body length. **Observed:** The resolver returns an expiring signed
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
URLs or restrict a future CSP to today's single CDN host. D-013 selects the separate
revision-pinned model/tree metadata path, a fresh immutable resolver request per
range, strict `Content-Range` validation, and full LFS SHA-256 verification. A complete
download of
`hf-internal-testing/tiny-random-gpt2/resolve/71034c5d8bde858ff824298bdedc65515b97d2b9/model.safetensors`
was 453,864 bytes and hashed to the tree's LFS SHA-256
`8111d5afb0715dbf5a31396d31432cb56370ba23f6650a035ea0fc8a20b4e500`;
the final CDN `ETag` was the different Xet ID
`f8accece953fd366d4ce30597b97acc1ccedc3c785187a5ef6ecb4a8e1755122`.
The open-ended initial range returned HTTP 206 with
`Content-Range: bytes 0-453863/453864` and the exact 453,864-byte body.
Requesting `Range: bytes=453864-453864` at that pinned URL returned 416, a zero-byte
body, and no unsatisfied `Content-Range`. HF access remains CORS-mode fetch under
D-012's `COEP: require-corp`.
**Links:** [HF API spike](hugging-face-api.md),
[HF file download guide](https://huggingface.co/docs/huggingface_hub/guides/download),
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
