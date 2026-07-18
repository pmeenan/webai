# Decision log

Newest first. Every entry: what was decided, why, and what would reopen it. Existing
entries are never edited into a different decision — reversing or amending one gets a
*new* entry that supersedes it (a status-line annotation on the old entry is fine).
Entries that rest on claims about current technology state (API availability, browser
support, tooling behavior) must be grounded in current sources or local experiments —
not training knowledge — and note what was checked and when (root AGENTS.md rule 4).

**Reading:** scan the D-NNN headings (or grep) and read only the entries your task
touches. Full read is for structural or cross-cutting work.

**Culling:** the log may be periodically pruned — superseded or moot entries whose
context no longer informs anything current are deleted outright; git history is the
archive. D-numbers are never reused.

Format:

```
## D-NNN: Title  (YYYY-MM-DD, status: accepted | proposed | superseded by D-MMM)
Decision / Context / Consequences / Reopen if
```

---

## D-016: Toolchain — Astro 7, React 19, pnpm, TS 6, Vitest+Playwright, ESLint+Biome  (2026-07-17, status: accepted)

**Decision:** The M1 scaffold uses:

- **Astro 7** (current stable line, static output, base `/webai/`), on **Node 24**
  (Astro 7 requires 22+).
- **React 19** via the official `@astrojs/react` integration for the interactive
  islands (chat, benchmark dashboards, model manager). Cross-island shared state via
  a small store library (nanostores is the Astro-docs-blessed default; final pick at
  M1).
- **pnpm 11**, pinned via the `packageManager` field. (pnpm 12 is a Rust-port alpha —
  not yet.)
- **TypeScript 6.0.x** (the bridge line to the native compiler; 6.0.3 stable since
  2026-04-16). The owner's first choice was TS 7 gated on a compatibility check; the
  check was run during M0 review (registry peer ranges, 2026-07-17) and failed:
  typescript-eslint@8.64.0 requires `typescript <6.1.0` and @astrojs/check@0.9.9
  requires `^5 || ^6` — TS 7 satisfies neither. 6.0.x is the newest stable line
  inside both ranges; TS 7 waits on the lint/check stack (see Reopen if).
- **Unit tests: Vitest 4**, with **browser mode** (stable since 4.0, Playwright
  provider, real Chromium) as the vehicle for worker/OPFS/isolation-dependent code —
  jsdom/happy-dom implement none of workers, OPFS, or WebGPU. Known caveats to design
  around: Vitest opens one Playwright `BrowserContext` per test file (storage is
  isolated *across* files) but a single page per file, so OPFS-mutating tests collide
  *within* a file — use per-test namespaces or cleanup in each file (Vitest browser
  docs checked 2026-07-17); response-header (COOP/COEP) support for
  `crossOriginIsolated` tests landed June 2026 — verify the exact config knob at
  scaffold time.
- **E2E: Playwright** (Apache-2.0), Chromium project in CI. WebGPU in headless
  Chromium needs launch flags, and GitHub-hosted runners have no GPU (SwiftShader
  fallback at best): CI e2e asserts functionality only, never performance numbers.
- **Lint: ESLint 10** (flat config; v9 EOL 2026-08-06) + typescript-eslint +
  eslint-plugin-astro. **Format: Biome 2.x** (MIT OR Apache-2.0), preferred over
  Prettier for speed and single-tool simplicity. Biome's full `.astro` template
  support is still experimental, so the scaffold-time fallback ladder is: if Biome
  mishandles `.astro` files, scope Biome to `.ts`/`.tsx` and format `.astro` with
  prettier-plugin-astro — stale (last release 2024-07-16) but published,
  non-deprecated, and still Astro's documented recommendation for CLI formatting
  (docs checked 2026-07-17); verify it against current Prettier before relying on
  it. Only if that also fails does `.astro` formatting go unenforced.
- **CI: GitHub Actions** on pull requests, golemine-shaped pipeline: lint →
  format-check → typecheck → unit → Playwright Chromium e2e → license audit; current
  action majors (`actions/checkout@v7`, `actions/setup-node@v7` with pnpm cache,
  `pnpm/action-setup@v6`).
- **License audit: SPDX-aware allowlist gate** (MIT, Apache-2.0, BSD-2/3, ISC, 0BSD,
  Zlib, …) that fails CI on anything else — `license-checker-evergreen` (maintained
  fork; SPDX-expression-aware `--onlyAllow`) or a small audit script as in golemine.
  Allowlist, not denylist, per D-002.

**Context:** Versions, licenses, and maintenance health were verified against
registry.npmjs.org, astro.build, vitest.dev, biomejs.dev, playwright.dev, and the
GitHub API on 2026-07-17 (root rule 4): Astro shipped two majors in 2026 (v6 March,
v7 June — Vite 8/Rolldown, Rust compiler with stricter HTML parsing), Vitest 4's
browser mode left experimental status, ESLint 10 made flat config mandatory, TS 7.0
(Go-based) became `latest`, and all four candidate island frameworks published
Astro-7-compatible integration majors in July 2026. Owner precedent was read from
pmeenan/golemine (React 19, ESLint 9, Playwright, custom license-audit CI gate,
pnpm/Vitest) and pmeenan/parallax (Biome, TS 7, pnpm/Vitest) the same day. The three
preference-level calls — React over Preact/Svelte/Solid, ESLint-lint + Biome-format
over either project's exact stack, TS 7 over conservative 5.x — were put to the owner
and confirmed in the M0 toolchain conversation (2026-07-17). The owner's TS 7 pick
carried a verify-first gate; running it during the same-day M0 review surfaced the
typescript-eslint/@astrojs/check peer conflicts above, so the recorded version is
6.0.x with TS 7 as a standing preference. React's ~55–65 KB versus
Preact's ~5 KB was judged irrelevant for a tool whose users download multi-GB models;
ecosystem depth for a polished chat UI (virtualized lists, Radix-class primitives)
and golemine familiarity dominated.

**Consequences:** M1 scaffolding is unblocked. Astro 7 + Vite 8 is a new-enough
stack that scaffold-time smoke checks are mandatory, not optional: base path
`/webai/` behavior, Biome-on-`.astro` formatting (with the prettier-plugin-astro
fallback ladder above), and the Vitest browser-mode header knob. Failures
there get logged to rough-edges.md and, where they force a substitution, a
superseding decision entry. The plan.md M1 toolchain task inherits this list.

**Reopen if:** typescript-eslint and @astrojs/check ship TS 7 support — move to TS 7
then, per the owner's standing preference; a scaffold-time gate fails (the Biome
`.astro` fallback ladder ends unenforced); Astro
7's Rust compiler or Rolldown proves unstable for the island-heavy app shape; React
islands fight the worker-centric architecture in a way a lighter framework would
not; or ESLint 10 + Biome duplication becomes friction that a matured
Biome-with-full-`.astro`-support (or stable type-aware Oxlint) would resolve better.

## D-015: Benchmark metrics carry source, scope, and support state  (2026-07-17, status: accepted)

**Decision:** Store raw per-iteration observations and make every benchmark metric an
evidence-labelled record: value/unit when available, phase, scope, source, collection
context, support state (`measured`, `estimated`, or `unavailable`), and caveats.
Missing values are never zero. Comparisons warn when their sources, scopes, effective
backends, token-count methods, concurrency, or cold/warm setup differ.

Standard timing uses monotonic timestamps and distinguishes first observable token
from first text chunk. Prefill/decode rates exist only when the adapter supplies a
reliable phase boundary and token count; post-hoc tokenizer counts are estimates.
`measureUserAgentSpecificMemory`, when available, is an app-attributed point-in-time
estimate; cadence-based runs report the maximum observed sample, not “peak memory.”
Wasm heap is its own scope. GPU memory and Prompt API model/process memory remain
unavailable unless an adapter/browser exposes a measurement with defined semantics.
Storage bytes and origin quota are never presented as runtime memory. Successful
iterations initially aggregate with median, nearest-rank p95, sample variance
(`n - 1`), and sample standard deviation. Variance/standard deviation are unavailable
below two successful samples; failures and raw attempts remain beside the summary.

“Cold” means a fresh adapter/session over already-local artifacts; “warm” means a
declared reused session/cache state. Clearing durable browser caches is separate,
explicit destructive preparation. Default comparison runs are sequential; concurrent
throughput is a separately labelled workload.

**Context:** Feature triage left benchmark honesty for the architecture draft because
browser runtimes expose materially different evidence. The WICG memory-measurement
spec and Chrome behavior were checked 2026-07-17 for D-010: the API estimates memory
at a point in time and may attribute workers/iframes, but does not expose a universal
GPU allocation or true peak. The runtime survey likewise found different token,
backend, and browser-managed surfaces. Converting unavailable dimensions into model-
size estimates would make precise-looking but non-comparable results.

**Consequences:** The M3 live metrics event shape is a subset of M8's observation
schema. Adapters report requested and effective configuration plus native metric
semantics. Exports retain environment, versions, run preparation, raw observations,
support states, and failures, allowing aggregates to be audited. UI comparisons may
show partial metric sets; honesty takes precedence over a full rectangular table.
Features question 4 is answered.

**Reopen if:** A standardized browser API provides attributable process/GPU/energy
measurements with stable semantics, runtime APIs converge on stronger common token
boundaries, or experiments show the initial aggregate method obscures the distributions
WebAI needs to report. New metrics extend the schema; they do not weaken provenance.

## D-014: One model control plane over hybrid physical storage  (2026-07-17, status: accepted)

**Decision:** Use one WebAI model manifest and management surface, backed by a hybrid
physical layout. App-managed source bytes, imports, and derived artifacts live under
versioned WebAI OPFS paths; IndexedDB holds manifests, acquisition checkpoints,
settings (including a dedicated HF credential record), chats, and results;
`localStorage` is reserved for tiny non-sensitive boot preferences. Runtime-native
caches remain adapter-owned only where a supported runtime integration requires them,
and browser-managed models are represented by availability/acquisition state rather
than fictitious file records. Adapters must inventory native entries and byte
confidence where observable. Local imports receive a computed WebAI SHA-256 content
identity before promotion; they do not invent HF revision fields.

A native-cache path does not waive M2's immutable identity, restart-safe resume, or
integrity guarantees: it must consume WebAI-verified bytes or demonstrate equivalent
behavior with a milestone-specific browser experiment. Byte reports always state scope
and confidence (`exact-file`, `adapter-reported`, `estimated-origin`, or `unknown`).
The manifest is the authoritative catalog but not proof that bytes still exist;
startup/error reconciliation turns missing data into an explicit evicted/missing
state.

The versioned runtime adapter contract uses discriminated artifact-set, native-cache,
and browser-managed model targets, and declares acquisition ownership, execution
context, structured backend configuration, model-scoped capability evidence, lifecycle,
streamed generation events, and inventory. Runtime sessions normally own isolated
worker lifecycles; adapters may own a library's worker directly instead of adding a
generic nesting layer. Prompt API remains D-007's sole main-thread exception. Heavy
runtimes are loaded only after capability gates.

**Context:** The 2026-07-17 runtime survey found four irreducible acquisition shapes:
app-managed files (wllama/LiteRT-LM), library caches (Transformers.js), app assets plus
library caches (WebLLM), and browser-managed storage (Prompt API). Pretending all bytes
fit one OPFS API would either reject selected runtimes or conceal their real cache
behavior; allowing fully independent caches would lose common provenance, integrity,
quota reporting, import, and eviction UX. D-012 also established that browser stores
and quota are origin-wide even though WebAI namespaces them.

**Consequences:** M2 builds the common manifest, OPFS layout, staged promotion, and
reconciliation for app-managed artifacts. M7 extends the same model manager with
adapter inventories and measured native-cache guarantees. Deduplication is available
for content-identified WebAI-owned bytes but is not promised across opaque caches.
Installed, partial, verifying, missing/evicted, corrupt, deleting, and failed states
are explicit. Features question 3 is answered. The detailed contracts and milestone
mapping live in [architecture.md](architecture.md).

**Reopen if:** A selected library exposes a supported external-byte/cache provider
that lets all model data move into the shared OPFS store; a required native cache
cannot expose enough identity or control to meet the M2 guarantees; or browser storage
semantics make the staged recovery protocol unsafe. Reopen the affected adapter or
data plane, not the common management requirement, unless product scope changes.

## D-013: Pin downloads to repo commits and LFS identity  (2026-07-17, status: accepted)

**Decision:** Use a two-stage Hugging Face discovery/acquisition flow and an immutable
download identity. Public model search supplies a bounded candidate set using the
server's model-ID substring, task, tag/library, gating, parameter-count, and sort
filters. WebAI enriches bounded candidate batches or selected repos with
revision-pinned file metadata; actual file bytes, shard totals, quant choices, and
local-runtime suitability are client-side filters because the public search API
cannot express them reliably.

Before offering a download, resolve the requested branch/tag to a commit and persist
`(repo ID, commit SHA, path, byte size, integrity kind + digest)` for every selected
file. Weight artifacts/shards require an LFS payload SHA-256. A selected non-LFS
companion instead records and verifies its Git-blob SHA-1 semantics; that identifier
must never be passed to plain file hashing or labeled SHA-256. Every initial or
resumed transfer requests `Range: bytes=N-` through a fresh immutable resolver URL,
including `N=0`; signed CDN URLs are transient and never persisted. A response is
appendable only when it is HTTP 206, its parsed `Content-Range` has the exact durable
start and expected total plus a valid end, and the body contains exactly the declared
interval without overrun. Completion requires worker verification against the
declared integrity kind before atomic promotion from partial to installed. `If-Range`
is not a validator in this design. M2 uses the LFS-compatible `/resolve/` byte path,
not native Xet CAS reconstruction; native Xet is reconsidered only as a measured
performance project.

Discovery follows exposed opaque `Link` cursors, debounces/coalesces requests, and
caches enrichment by repo SHA. On 429, browser code uses bounded exponential backoff
with jitter and visible retry/cancel state; it does not hard-code quotas or promise a
remaining-request counter because current HF rate-limit headers are not CORS-exposed.
Full evidence, API expressiveness, the resume protocol, and implementation gates are
recorded in [hugging-face-api.md](hugging-face-api.md).

**Context:** Official `huggingface_hub` documentation and direct HF API measurements
were checked 2026-07-17. Model search returned repo SHAs and exposed cursor pagination
but no per-file byte/hash metadata. Revision-pinned model-info and tree responses
returned exact file sizes plus LFS SHA-256 identities for GGUF/safetensors artifacts.
The hosting spike already proved API/resolver/range CORS from an isolated Chrome page.
RE-005 showed that resolver-issued Xet URLs expire, bind the requested Range, hide
intermediate identity headers from Fetch, and did not honor `If-Range` as a useful
resume validator. RE-006 showed that documented rate/reset headers are hidden by the
CORS response filter. Resolving a fresh range at the stored commit and checking both
metadata and final content closes those gaps without relying on CDN details.

**Consequences:** M2's manifest carries immutable source identity and partial-stage
state; a mutable branch name is provenance only. For ordinary file output, resume may
re-read durable partial bytes to reconstruct hash state and must reconcile actual
output length before fetching. M3's streaming splitter must checkpoint source offset,
durable split state, and resumable hash state together or use D-009's fallback.
Sharded models retain an integrity identity and size per shard. Weight artifacts
without an LFS SHA-256 fail closed; selected Git-managed companions use Git-blob
verification. A final Xet bridge `ETag` is not mistaken for the payload SHA-256. M5's
size and quant filters progressively enrich
candidates and explicitly represent “not inspected” rather than treating unknown as
incompatible. All remote metadata remains bounded, validated untrusted input under
D-006.

**Reopen if:** Hugging Face exposes a documented, durable browser download session
with equivalent commit/content binding; the file metadata ceases to expose a usable
content hash; immutable resolver URLs stop supporting range requests; or measured API
limits make visible-page enrichment impractical. Reopen the affected mechanism, not
the resumable/integrity requirement, unless the product scope changes explicitly.

## D-012: Isolate `/webai/` in place; keep the shared origin  (2026-07-17, status: accepted)

**Decision:** Keep `https://meenan.dev/webai/` and serve WebAI with
`Cross-Origin-Opener-Policy: same-origin` plus
`Cross-Origin-Embedder-Policy: require-corp`. Do not use `credentialless` and do not
split isolated and unisolated WebAI routes: multithreaded wasm and the memory API are
capabilities of the whole workbench, with individual features still gated on the
runtime `crossOriginIsolated` probe. The evidence and exact deployment constraints are
recorded in [hosting-constraints.md](hosting-constraints.md).

Explicitly accept D-010's shared-origin storage choice. `/webai/` is an organizational
and service-worker-scope boundary, not a storage or security boundary; WebAI uses
namespaced OPFS/IndexedDB/Cache Storage identifiers and `localStorage` keys plus its
own byte accounting, while quota, persistence, and same-origin access remain
origin-wide. A future service worker lives at `/webai/sw.js`, uses scope `/webai/`,
and is never granted a broader scope.

**Context:** A Chrome 150 browser experiment on 2026-07-17 loaded an isolated page
under `require-corp`, exposed `SharedArrayBuffer`, and successfully fetched the public
HF API, a small resolver artifact, and a ranged large LFS/Xet artifact across the
signed CDN redirect. Repeating the requests with an `Authorization` header also passed
CORS preflight on public files; the range returned the requested 16-byte HTTP 206
response. This did not test a valid token or gated artifact. Current HF responses to
`Origin: https://meenan.dev` expose the final range headers, while immutable commit
and linked identity headers occur on an intermediate redirect that browser Fetch does
not expose. The HF API spike must choose a separate browser-readable metadata path.
The fetch results prove `credentialless` is unnecessary for the allowed HF traffic;
M1 rechecks the deployed public path rather than treating external headers as a
timeless guarantee, and M5 tests valid gated access before shipping token support.

The actual target is owner-controlled nginx 1.30.2: `/webai/` maps directly below
`/var/www/meenan.dev/` and can be rsynced by the deploy user. nginx supports the
headers, but its current regex locations override an ordinary prefix location, so the
versioned M1 config must use `location ^~ /webai/` (or deliberately duplicate the
headers) and needs a one-time interactive admin install/reload. No hosting blocker was
found. Current web-platform storage specifications confirm that a URL path never
separates OPFS, IndexedDB, Cache Storage, quota, or persistence.

**Consequences:** Every WebAI document is isolated; cross-origin subresources must use
CORS or CORP, opener relationships cross a COOP boundary, and offline/cached navigation
responses must preserve COOP/COEP. D-005 already forbids arbitrary third-party assets,
so the stricter embedder policy reinforces the network design. M1's live deploy gate
checks headers, `crossOriginIsolated`, worker `SharedArrayBuffer`, root-path
non-interference, and HF API/redirect/range/preflight behavior from production.

**Reopen if:** Independently trusted/untrusted content must share `meenan.dev`; root
service-worker behavior cannot coexist; origin-wide quota/persistence/accounting
becomes unacceptable; required popup/opener behavior conflicts with COOP; or a
required resource cannot satisfy `require-corp`. A dedicated domain is the owner's
accepted fallback if evidence triggers any of these conditions.

## D-011: Runtime survey scope — replace MediaPipe with LiteRT-LM  (2026-07-17, accepted)

**Decision:** The evidence snapshot and complete comparison are recorded in
[runtime-survey.md](runtime-survey.md). Apply these roadmap verdicts:

- WebLLM remains confirmed for M7. Its Apache-2.0 license, active 0.2.84 release, and
  current development satisfy D-010's condition. Its default catalog is not allowed:
  although model data comes from HF, 0.2.84 fetches compiled model-library wasm from
  an MLC GitHub repository. WebAI uses a custom catalog with HF model URLs and
  revision-pinned, allowlisted records; mandatory WebLLM `integrity` hashes for the
  model-library/config/tokenizer artifacts supported by 0.2.84; a separate HF-metadata
  integrity path for parameter shards; and version-pinned, license-audited model
  libraries bundled or self-hosted under `/webai/`. If those binaries cannot be
  redistributed permissively, drop the affected catalog records or reopen the adapter
  rather than broadening D-005 or weakening D-006 silently.
- Reject MediaPipe LLM Inference as a new adapter. Google's current web guide marks
  it maintenance-only and directs new web projects to LiteRT-LM. Independently, the
  MediaPipe repository's 2026-06-05 privacy notice says MediaPipe Tasks send
  performance/utilization metrics to Google and require user consent; no web opt-out
  was found, which is incompatible with D-005 unless an experiment proves otherwise.
- Select LiteRT-LM JavaScript as the Google packaged-model candidate for M7. It is
  Apache-2.0, fully client-side, actively released, and adds `.litertlm` as a distinct
  model path. Selection is provisional because 0.14's web API is early preview,
  WebGPU/text-only with two documented Gemma 4 variants, and its worker and telemetry
  behavior are not yet documented. Its package exports tool orchestration and a
  constrained-decoding flag that the short web guide does not explain, so those also
  need a model-level experiment. At M7 start it must demonstrate dedicated-worker
  execution and no unexpected network traffic. Acquisition stays within D-005's
  existing HF/local path: WebAI supplies a stored `Blob`/`ReadableStream` rather than
  authorizing a new Google/CDN source. Otherwise drop the adapter rather than
  weakening D-005 or D-007.
- Keep direct ONNX Runtime Web parked under D-010. Transformers.js supplies its LLM
  application layer; direct ORT remains a debugging escape hatch.
- Park LiteRT.js for the same reason: it is an active, permissive `.tflite` graph
  engine, but LiteRT-LM supplies the selected LLM application layer. Reopen direct
  LiteRT.js for diagnostics or a distinct measured capability.
- Do not add Sipp (young and currently overlaps wllama's GGUF/WebGPU path), Gerbil
  (advertised source link was unavailable, so license/health cannot be verified), or
  a Prompt API polyfill (a facade over already selected runtimes or remote services).
- Do not add BrowserAI (facade over selected engines), torch-webgpu (browser execution
  is still future work), or `ruvllm-wasm` (published browser package lacks a
  demonstrated model-loading/token-generation inference path).

More generally, runtime code, worker scripts, wasm, and compiled model-library
binaries are application dependencies: pin, audit, content-hash, and serve them from
`/webai/`. Only user-selected model data may use D-005's HF network path. This also
forbids wllama's default jsDelivr fallback for Safari compatibility assets; install
and self-host `@wllama/wllama-compat` instead.

The Prompt API web surface is now recorded as available in stable Chrome from 148;
Chrome 138 was the extension surface. Chrome still describes the web API as under
development, with sampling parameters in an origin trial. This corrects stale feature
text without changing D-007's window-only exception; adapter capabilities are probed
rather than promised.

**Context:** D-010 deliberately left the MediaPipe verdict and WebLLM health/license
condition to current-source research. The survey checked official documentation,
tagged source/package metadata, releases, licenses, and maintenance activity on
2026-07-17. The selection gate was fixed in features.md: permissive, actively
maintained, fully client-side, and adding a distinct backend, format, or capability.

**Consequences:** Every runtime row in features.md now has a verdict. M7 contains
Transformers.js, WebLLM, and provisionally LiteRT-LM; wllama and Prompt API retain
their earlier M3/M4 positions. The adapter contract must expose acquisition
ownership, executable-asset provenance, execution context, real backend mode,
model-scoped modalities, and graded structured-output strength rather than a false
lowest common denominator. Library-owned caches do not waive M2's resume-after-tab-close
or HF-LFS integrity guarantees; the adapter must integrate WebAI's download manager or
demonstrate equivalent behavior. These requirements feed architecture.md; exact
versions and browser behavior are still re-verified when each adapter is built (root
rule 4).

**Reopen if:** WebLLM becomes unmaintained or non-permissive; LiteRT-LM cannot satisfy
D-005/D-007 or its preview is abandoned; MediaPipe removes both maintenance-only and
telemetry concerns while adding a capability LiteRT-LM lacks; direct ORT is needed to
isolate a Transformers.js defect; or a screened runtime matures and demonstrates a
distinct measured capability.

## D-010: M0 feature triage — scope verdicts  (2026-07-17, accepted)

**Decision:** Full walk of every `proposed` features.md row and open question with
the project owner (structured prompt session, 2026-07-17). Verdicts:

*Promoted to confirmed:* capability-report page (M1); resumable + integrity-checked
downloads, storage quota/persistence/eviction UX, and the model metadata inspector
(M2); HF token for gated models and pre-download license/gating surfacing (M5);
generation parameter controls incl. seed, stop/abort/regenerate/edit-and-resend,
chat history persistence + export/import, token/context-window display, and context
caching (M6 — context caching was owner scope that had no row; added); side-by-side
comparison and structured output testing (M7 — structured output is per-adapter
capability work, so it lands with runtime breadth); standard metric set, iterations
with median/p95/variance, results export + history, and the prompt library (M8 —
saved prompt sets and benchmark datasets share one design); tool/function-calling
harness (M9+, dependent on structured output landing first); shareable config
permalinks, diagnostics pane/export, and PWA/offline (M10 — PWA service-worker
design must respect the hosting-spike isolation outcome); long-context/KV-growth and
sustained-throughput stress tests (new post-launch M11, keeping M8 shippable).

*Conditional:* WebLLM is confirmed for M7 contingent on the M0 survey verifying its
license and maintenance health — a red flag there reopens the verdict. *(Resolved by
D-011: the condition passed, subject to its recorded D-005/D-006 deployment rules.)*

*Deferred to evidence:* MediaPipe LLM stays `proposed`; the M0 runtime survey's
evidence (license, health, capability added vs. the cost of a new .task/.litertlm
format pipeline) decides. *(Resolved by D-011: MediaPipe was rejected and LiteRT-LM
selected provisionally.)*

*Parked:* direct ONNX Runtime Web (not via transformers.js) — reopen if isolating
ORT behavior becomes necessary for debugging transformers.js issues.

*Rejected for now:* embeddings-model testing — keeps v1 tight on the chat/benchmark
loop; re-proposable post-launch.

*Open questions answered:* mobile is **best-effort** — nothing gated on it, failures
logged as rough edges, no v1 mobile UX investment (Q2). Prompt API surface
verification is **closed as process** — root rule 4 already mandates build-time
re-verification (Q5). **"WebAI" is the product name**, not a working title (Q6).
Benchmark datasets are **BYO JSON against a documented schema plus one small bundled
default set** with a verified-permissive license (Q7). Storage origin: the owner
prefers **staying at https://meenan.dev/webai/ and explicitly accepting the
shared-origin storage model**; the hosting spike verifies there is no blocker — a
blocker reopens this and would supersede D-001 (Q8). Questions 1 (isolation
strategy), 3 (storage layout), and 4 (benchmark honesty labeling) stay open, owned
by the M0 hosting spike and architecture draft.

**Context:** M0 exit criterion "every proposed row resolved and every open question
answered." Conducted as a direct prompt walk at the owner's request; the owner took
the recommended option on all items except PWA/offline, which they promoted outright
rather than parking pending the hosting spike.

**Consequences:** features.md statuses updated; plan.md ladder updated in the same
change — former *(triage)* markers resolved, M7 gains structured output, M9 gains
the tool-calling harness, M10 gains permalinks, and M11 (stress benchmarking) is
added. The remaining provisional ladder content is survey-owned: the MediaPipe
verdict and the WebLLM health check above. *Annotation (2026-07-17):* the M0 triage
checklist item was re-scoped with owner approval to "resolve all that don't require
experimental evidence, handing remnants to single owning M0 items" and checked; the
M0 exit criteria still gate on those remnants closing (survey, hosting spike,
architecture draft).

**Reopen if:** Individual verdicts reopen via their own new entries with new
evidence — notably WebLLM on a bad survey result, ORT-direct on a debugging need,
embeddings post-launch, and Q8 on a hosting-spike blocker.

## D-009: In-app GGUF splitting, streaming during download  (2026-07-17, accepted)

**Decision:** Ship a wasm build of llama.cpp's gguf-split as part of the app, and run
it as a stage of the download pipeline: monolithic GGUFs beyond wllama/wasm size
limits are split *while the download streams*, buffering as much of the stream as the
GGUF offset tables require, rather than materializing the whole file and splitting
afterward. Memory/storage headroom is assumed — this is a developer-targeted tool on
developer-class machines, not low-end consumer hardware (owner call, 2026-07-17).

**Context:** Popular quant repos — unsloth is the concrete case — publish monolithic
multi-GB GGUFs with no split variants, so the capability must exist on our side
regardless of any runtime's ability to *load* pre-split files. Evidence: the owner
hit exactly this with unsloth quants in parallax-web. Streaming split also avoids the
transient ~2× storage cost of split-after-download. *Annotation (2026-07-17):*
upstream `tools/gguf-split/gguf-split.cpp` was checked — it opens the complete input
file, seeks to tensor offsets, and buffers whole tensors, so the wasm streaming
stage is an I/O redesign of the tool, not a recompile; this is exactly what the M3
feasibility experiment gates.

**Consequences:** The download manager and splitter are one worker pipeline; if
resumable downloads are confirmed in triage, resume must be designed against split
output, not a single file. Streaming-during-download is the preferred path, not the
only one: the same splitter must also run on demand against already-stored
monolithic files (user imports, downloads made before the splitter existed). The
splitter parses untrusted GGUF headers → D-006 applies
in full (bounded reads, malformed-file fixtures). Streaming feasibility (how much
buffering the offset tables actually demand) is verified experimentally at M3 start —
measure, don't assert (root rule 3).

**Reopen if:** The M3 experiment shows streaming split is infeasible or pathological
(fallback: split-after-download — amend this entry, the *requirement* to split
stands); or wasm/runtime size limits move enough that monolithic files load directly.

## D-008: Milestone ladder: risk-first vertical slice (M1–M10)  (2026-07-17, accepted)

**Decision:** The plan.md ladder is ordered: shell + capability layer + live deploy
(M1) → manual model acquisition (M2) → first chat on wllama incl. streaming split
(M3) → Prompt API as the *second* runtime (M4) → model browsing (M5) → chat testing
depth (M6) → runtime breadth (M7) → benchmark harness (M8) → multimodal (M9) →
capability filtering + launch (M10). Live per-response metrics ship with the first
chat in M3, not with the benchmark harness.

**Context:** Agreed in a planning conversation with the owner (2026-07-17),
reshaping the provisional ladder. Rationale: front-load platform risk — deploy
headers/CORS at the real origin, OPFS, multi-GB downloads, wasm inference — and
defer conventional web dev (browse UI was M2 provisionally, now M5, behind manual
entry). Prompt API second forces the adapter contract to absorb its most divergent
case (main-thread D-007, browser-managed model, no download) before conventional
runtimes calcify assumptions. The benchmark harness follows runtime breadth because
cross-runtime comparability is its reason to exist; gguf-split moved from a late
"tooling" milestone into M3 because it is load-bearing for first chat (D-009).

**Consequences:** Milestone contents marked *(triage)* remain provisional until the
M0 feature triage; re-scoping happens in plan.md with new decision entries per its
header. Exit criteria are phrased as live-site user capabilities — every milestone
ends deployed.

**Reopen if:** Re-litigating the *order* needs new evidence (a milestone blocked on
a later one's output, or an M0 spike invalidating an assumption) — not taste.

## D-007: Our compute runs in workers; browser-managed inference is the exception  (2026-07-17, accepted)

**Decision:** All compute this app performs itself — in-page inference, tokenization,
model file parsing/splitting, hashing, downloads — runs in web workers; the UI thread
does UI only, and long operations stream progress. Browser-managed inference via
Chrome's Prompt API is an explicit, recorded exception: it is called from window
contexts because Chrome does not expose it in Web Workers, and its inference executes
out-of-process in the browser, so async main-thread calls do not block the UI.

**Context:** Checked 2026-07-17 against
https://developer.chrome.com/docs/ai/prompt-api: "The Prompt API isn't available in
Web Workers for now, due to the complexity of establishing a responsible document for
each worker." At the time this entry was written, Chrome 138 was the stable extension
surface; D-011 records the evolving web-page surface as available in stable Chrome
from 148. It is exposed to top-level windows, same-origin iframes, and delegated
cross-origin iframes, and runs only the browser-managed Gemini Nano model.

**Consequences:** The runtime adapter contract cannot assume worker execution for
every runtime; execution context is part of each adapter's capability declaration.
Benchmark methodology must note the context difference when comparing Prompt API
numbers against worker-hosted runtimes.

**Reopen if:** Chrome exposes the Prompt API in workers (move it), or another library
requires main-thread pieces beyond async calls into browser-managed services (that
needs its own exception entry, not silent extension of this one).

## D-006: Model files, remote metadata, and model output are untrusted input  (2026-07-17, accepted)

**Decision:** Treat everything that originates outside the app as hostile: Hugging
Face API metadata, model card content, model files (GGUF/ONNX/etc.), and model
output. None of it is ever interpolated into HTML — render as text nodes or through
an explicitly chosen sanitizing pipeline (that choice gets its own decision entry
when the chat UI lands). File parsers use bounded reads and skip-and-report on
malformed data; a hostile file may fail to load but must never crash the app or
corrupt stored state.

**Context:** The tool's core use case is pointing it at arbitrary third-party HF
repos and importing arbitrary local files; model output is attacker-influenceable by
construction.

**Consequences:** GGUF/ONNX metadata parsers are written defensively and tested
against malformed fixtures. Markdown rendering of chat output requires a vetted
sanitizer, not string concatenation.

**Reopen if:** Never, in principle; specific rendering/sanitizer technology choices
get their own entries.

## D-005: Everything runs locally; no telemetry  (2026-07-17, accepted)

**Decision:** All user state — downloaded models, chats, benchmark results, settings —
lives in the browser (OPFS / IndexedDB / Cache Storage). No telemetry, analytics, or
accounts. The only network traffic is what the user explicitly initiates: model
downloads (Hugging Face, Chrome's built-in model flow) and Hugging Face API queries
for search/metadata.

**Context:** Stated by the project owner at kickoff ("runs completely in the
browser"), consistent with the golemine/parallax predecessors. A measurement tool
that phones home undermines its own credibility.

**Consequences:** Debugging user reports requires user-carried diagnostics (export
features), not server logs. No aggregated results or leaderboard (vision non-goal).
Storage quota/eviction UX becomes a real product surface, since everything valuable
is evictable browser storage.

**Reopen if:** The owner adds an explicitly opt-in sharing/export-to-community
feature — which would be a new decision; the local-by-default boundary stays.

## D-004: Chrome-primary, cross-browser-friendly  (2026-07-17, accepted)

**Decision:** Target latest Chrome first and adopt its newest AI/platform capabilities
(Prompt API, WebNN, WebGPU features) without waiting for parity elsewhere, but keep the
app functional in other modern browsers: capability-probe every feature (never
UA-sniff), disable unsupported runtimes/backends per-browser with a clear explanation,
and log cross-browser differences as rough-edges findings.

**Context:** Stated by the project owner at kickoff. Differs deliberately from the
Chrome-*only* stance of the golemine/parallax predecessors: a testing tool is more
useful the more environments it can report on.

**Consequences:** No hard boot-time browser gate; instead a per-capability gating
layer and an environment/capability report surface. Cross-browser testing effort is
bounded — Chrome is the release gate; other browsers are best-effort.

**Reopen if:** Maintaining cross-browser paths measurably slows core development, or a
load-bearing capability (e.g., OPFS behavior) diverges so much that non-Chrome support
becomes fiction.

## D-003: AI-developed, human-gated workflow  (2026-07-17, accepted)

**Decision:** Adopt the golemine/parallax development model: AI agents do the
implementation and line-level review working from repo documentation; the human
directs, decides, and is the sole committer. Rules live in root AGENTS.md; operating
modes (tech lead, reviewer, fix-pass, verify-pass) in docs/workflow.md. Docs move with
code in the same unit of work.

**Context:** Proven across two prior projects by the same owner; this repo was
scaffolded to mirror that flow (owner request, 2026-07-17).

**Consequences:** Agents never commit/push. One stream of uncommitted work at a time.
Decision log and findings log are load-bearing project outputs.

**Reopen if:** The owner changes the collaboration model.

## D-002: Apache-2.0 license; permissive dependencies only  (2026-07-17, accepted)

**Decision:** The project is Apache-2.0. Dependencies and vendored/modified
third-party code must be permissive (MIT/BSD/Apache/ISC/zlib-class), recorded in
NOTICE where required. No GPL/AGPL; no copyleft code copied into app source. A
CI-enforced license audit lands with the M1 toolchain.

**Context:** Stated by the project owner at kickoff. The planned tooling builds on
llama.cpp — e.g., a wasm build of gguf-split — whose license is MIT (checked
2026-07-17 against https://github.com/ggml-org/llama.cpp/blob/master/LICENSE: "MIT
License, Copyright (c) 2023-2026 The ggml authors"), which is compatible.

**Consequences:** Every new dependency needs a license check before adoption. Runtime
libraries under consideration (wllama, transformers.js, WebLLM, MediaPipe, ONNX
Runtime Web) must be license-verified during the M0 survey.

**Reopen if:** N/A for the project license; per-dependency exceptions would need their
own decision entries (none exist yet).

## D-001: Static Astro site at https://meenan.dev/webai/  (2026-07-17, accepted)

**Decision:** Build the product as an Astro static site with base path `/webai/`,
deployed by rsync to owner-controlled hosting at https://meenan.dev/webai/. Local dev
via the standard npm/pnpm dev server. No server-side application code; all
functionality is client-side.

**Context:** Stated by the project owner at kickoff. Astro chosen for the static-first
model with islands for the interactive chat/benchmark surfaces.

**Consequences:** Everything must work from static hosting: model downloads come
directly from Hugging Face (CORS permitting), state lives in browser storage, and any
response-header needs (COOP/COEP) must be satisfiable by static-server config — the
M0 hosting spike settles that. The islands framework choice (React/Svelte/none) is an
open M0 toolchain decision, not settled here. Note that `/webai/` is a path, not a
boundary: OPFS, IndexedDB, Cache Storage, quota, and persistence are scoped to the
https://meenan.dev origin and shared with anything else ever hosted there (currently
only a "Coming soon" placeholder at the root — checked 2026-07-17). The M0 hosting
spike must either explicitly accept that shared storage/security model or move to a
dedicated origin, which would supersede this entry (features.md open question 8).

**Reopen if:** The shared-origin storage/header model proves unworkable and a
dedicated origin (e.g., webai.meenan.dev) is needed; a required feature provably
cannot work from static hosting; or Astro's
island model fights the app-like chat UI badly enough that a pure SPA framework would
serve better (that would still be a static build — the no-server constraint is firmer
than the framework choice).
