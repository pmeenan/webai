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
each worker." The API is stable as of Chrome 138, exposed to top-level windows and
same-origin iframes, and runs only the browser-managed Gemini Nano model.

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
