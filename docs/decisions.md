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

## D-025: M2 uses restart-safe OPFS checkpoints, transactional manifests, and bounded GGUF inspection  (2026-07-18, status: accepted)

**Decision:** M2 implements D-013/D-014 with a version-1 model control plane. The
`webai-v1` IndexedDB database owns `models`, `jobs`, and reference-counted `blobs`
records; OPFS `webai/v1/` owns content-addressed verified blobs and per-job partials.
An acquisition worker resolves HF input, downloads/imports, checkpoints, hashes,
inspects, promotes, reconciles, and deletes. The React island only renders state and
submits commands. A partial is durable only after an OPFS sync-handle flush; engines
without sync handles use a slower close-per-checkpoint writable-stream fallback.
Network responses and local imports checkpoint in 1 MiB batches, while an interrupted
batch may be re-fetched because it was never reported durable.

Verified staging files use `FileSystemFileHandle.move()` when the capability exists;
the fallback copies the verified bytes, validates the final size, and deletes staging.
Only the installed IndexedDB state is loadable, so either physical path remains
logically atomic to readers. Existing content-addressed blobs are re-hashed before a
new verified partial is deduplicated against them. Reconciliation reads OPFS before
opening its short write transaction, uses Web Locks to distinguish work active in
another tab from an abandoned job, pauses only abandoned remote work, and changes an
abandoned local import to `needs-source`. A fully verified local import remains
finalizable without the original `File` objects. Actual durable bytes win over a
checkpoint count, and installed records become missing when bytes or size disagree.
One unreadable/corrupt record degrades to `missing`/`failed` without hiding the rest of
inventory. Before reconciliation writes a changed snapshot, its final transaction
proves that the model still exists or that the job's `updatedAt` is unchanged; it
never recreates a concurrently deleted record or overwrites newer progress.
Per-job and manifest mutation locks prevent duplicate resumes and refcount races.
Deletion transactionally removes the model reference and leaves zero-reference blob
garbage tombstones; interrupted physical cleanup is retried during reconciliation.
The same pass removes content-addressed files that have neither a manifest nor a
verified resumable job, closing the crash window between per-file promotion and the
final manifest transaction.

Streaming SHA-256 and the legacy Git-blob SHA-1 identity use `@noble/hashes` 2.2.0
(MIT, zero runtime dependencies); SHA-1 exists only to reproduce HF Git object IDs,
not as a new security primitive. The M2 GGUF inspector accepts current GGUF v2/v3,
reads at most 16 MiB of header data, bounds strings, arrays, nesting, metadata count,
UTF-8, and displayed entries, and reports controlled failures. Imports accept one
GGUF or one complete conventionally named shard set, hash the selected source while
writing, then re-hash the stored OPFS bytes before promotion. A failed finalization
returns to `ready-to-install`; an active import can be stopped and becomes
`needs-source`. M3 remains responsible for
streaming splitting and can replace the ordinary-file sink behind the existing
durable-source-offset contract.

M2 deliberately lists and selects only LFS SHA-256-identified GGUF weight sets. It
skips non-GGUF siblings before interpreting their optional size/hash fields, treats a
valid `00001-of-00001` name as a single artifact, and does not infer runtime companion
files from names. It therefore does not yet download Git-managed companions. The
Git-blob hasher and framing tests establish the identity
primitive for the first runtime adapter that defines an explicit companion manifest
in M3/M7. HF 429 responses use three bounded exponential full-jitter retries; retry
state is visible, and an active transfer can be paused to cancel its wait.

**Context:** The implementation was measured 2026-07-18 in Playwright Chromium. Its
OPFS file handle exposed `move()`; a page/worker reload after exactly 1 MiB durable
caused the next immutable resolver request to begin at byte 1,048,576, with no request
for the durable prefix. An end-to-end wrong-status fixture and unit-level range/length
matrix, plus an end-to-end wrong-final-digest fixture, left no installed record. A
local import interrupted after its durable job appeared reconciled to `needs-source`
after reload. Injected physical-delete failure remained recoverable, repeated install
was idempotent, and malformed/large GGUF fixtures produced controlled results without
a page crash. Reconciliation/delete overlap did not resurrect a record; oversized
partials degraded individually; untracked and corrupt content-addressed blobs were
removed or repaired from verified partials.
The focused live-HF check downloaded all 1,627,808 bytes of
`ybelkada/tiny-random-llama-Q4_K_M-GGUF` at commit
`429fe92916dae4839bfefb46bd0f61f50cc02c73` through its LFS/Xet-backed resolver,
matched LFS SHA-256
`f06746ef9696d552d3746516558d5e9f338e581fd969158a90824e24f244169c`, promoted it,
and inspected `llama` metadata. Current upstream GGUF specification and noble-hashes
2.2.0 package documentation/license were checked the same day. A current model-info
check of `bartowski/Llama-3.2-1B-Instruct-GGUF` at commit
`067b946cf014b7c697f3654f621d577a3e3afd1c` returned 21 siblings spanning GGUF,
Markdown, `.gitattributes`, and imatrix files, grounding the weights-only parse path
against a realistic mixed repository. RE-011 records the
IndexedDB transaction-lifetime trap found by the restart/import tests.

**Consequences:** Signed resolver URLs never enter persisted state; mutable refs are
provenance only. M2's manager distinguishes exact model/partial bytes from origin-wide
quota estimates, makes persistence an explicit action, and exposes missing/failed/
paused state plus deletion/discard controls. The copy fallback can need temporary
headroom on engines without OPFS move; RE-012 records the repeated existing-data copy
semantics of close-per-checkpoint writable fallback and does not claim performance
equivalence with sync handles. Quota failures remain retryable and no partial
or unverified record becomes installed. A cross-tab Web Lock admits one disk-heavy
acquisition, promotion, deletion, or garbage-collection path at a time; a separate
per-job lock rejects duplicate resume/discard races. Later measured concurrency can
be added without changing the storage contract. Pause commands fan out to the worker
that owns an active job through an origin-local broadcast channel. `@noble/hashes`
joins the audited production license closure and notices.
Installed-model deletion is disabled while that acquisition lock is known busy in the
current inventory. Refresh exposes its waiting state and remains available to detect
an abandoned cross-tab job; local imports expose Stop and abort while queued or
copying instead of presenting an uninterruptible zero-percent operation.

Web Locks are the cross-tab coordination primitive in the Chrome-primary profile.
Where they are absent, the same module serializes operations within one worker realm;
cross-tab exclusion is unavailable and remains an explicitly degraded behavior rather
than an unrecorded equivalence claim.

**Reopen if:** OPFS move or sync handles regress in target Chrome; a measured engine
cannot make writable-stream checkpoints acceptably; current GGUF introduces a
structural version beyond v3; or M3 proves the sink/checkpoint contract insufficient
for transformed split output.

## D-024: Canonical site moves to the root of `webai.meenan.dev`; release target stays unchanged  (2026-07-18, status: accepted)

**Decision:** The canonical product URL is `https://webai.meenan.dev/`. Astro builds
for the origin root, so application routes, content-hashed assets, license files, and
the future service worker use `/`-rooted URLs. The static/no-server constraint and
D-023's release machinery do not change: builds still rsync to sibling releases under
`/var/www/meenan.dev/` and promote through the
`/var/www/meenan.dev/webai` symlink. Deployment smoke checks use the new public
origin.

COOP `same-origin` and COEP `require-corp` remain binding on successful HTML,
application assets/workers, and errors. D-012's isolation-policy evidence remains
accepted, but its canonical path, shared-origin storage model, and `/webai/` service-
worker scope are superseded. The dedicated origin is now WebAI's browser storage and
same-origin trust boundary. Internal OPFS, IndexedDB, Cache Storage, and local-storage
names remain `webai`-prefixed/versioned for ownership and migration hygiene, not to
isolate WebAI from unrelated `meenan.dev` applications. M10 places its worker at
`/sw.js` with `/` scope.

**Context:** Owner direction on 2026-07-18 promoted WebAI to a dedicated subdomain to
simplify project management and isolation ownership. Live inspection found DNS/TLS
healthy, nginx serving the existing filesystem target as the new vhost root, static
assets and 404s carrying COOP/COEP, and all anonymous plus dummy-Authorization HF
API/resolver/range CORS checks succeeding from the new origin. The first inspection
also caught two expected cutover defects before the root build was deployed: the old
artifact still emitted `/webai/` asset URLs, and successful HTML lost COOP/COEP because
its nginx regex defined its own `add_header`. The cutover gate therefore requires a
root-base rebuild plus live verification after duplicating the isolation headers in
that HTML location.

The final cutover verification on 2026-07-18 passed root/nested routes, root-relative
assets and worker, notices, success/404 isolation headers, page and worker isolation,
shared-memory atomics, OPFS, all six anonymous/dummy-Authorization HF CORS cases, and
parent-origin non-interference in Chrome 150. No console or failed-resource errors
occurred, and D-023 left valid current/previous release pointers without transaction
residue.

Origin-scoped browser state does not transfer from `https://meenan.dev` to
`https://webai.meenan.dev`. The theme preference is M1's only app-owned stored value;
the browser's origin persistence grant/status may also reset because M1 exposes an
explicit persistence request. Both resets are accepted before M2 stores models or
user work. This separation does not assert independent physical disk quota or eviction
grouping beyond what the browser actually reports. A route-preserving redirect from
the legacy `/webai/` path is recommended for link continuity, but the root-based build
is never served as a second live application origin.

**Consequences:** D-001 is superseded only for public origin/base; its static Astro,
client-only, and rsync decisions remain. D-010 question 8 and D-012's shared-origin
choice are superseded. D-016 keeps its toolchain but no longer fixes Astro's base to
`/webai/`. Capability copy now describes storage as belonging to the current origin.
The cutover verification covers root and nested routes, root-relative assets/workers,
notices, successful/error isolation headers, page/worker isolation and shared memory,
HF CORS, OPFS, deploy rollback pointers, and non-interference with the parent origin.

**Reopen if:** the dedicated vhost cannot preserve isolation on every application
response; a required cross-origin resource fails CORS/CORP from the new origin; the
project deliberately adds another application on the same subdomain; or the static
release target moves and requires a new atomic-promotion design.

## D-023: Production deploys use staged releases, an atomic symlink switch, and verified rollback  (2026-07-18, status: accepted)

**Decision:** `pnpm deploy` runs the complete local quality/license gate, rebuilds the
release artifact, rsyncs into a new sibling release directory under
`/var/www/meenan.dev/`, verifies the staged `index.html`, and only then promotes that
directory through the `/var/www/meenan.dev/webai` symlink. A
release-unique remote helper holds `flock` for the entire promote, public-smoke, and
commit exchange; controller EOF is failure, not success. Before changing the live
path it atomically writes `.webai-transaction`, including the prior live target and
prior rollback pointer. Ordinary symlink promotion is a same-filesystem `mv -T`.
The one-time real-directory migration uses Linux `renameat2(RENAME_EXCHANGE)` through
the host's Python 3 runtime, so the legacy directory and prepared symlink exchange in
one operation. Public smoke checks fetch the home route, a nested route, and a hashed
JavaScript asset and explicitly propagate route, COOP, and COEP failures. Curl
connect/total time limits and SSH connect/keepalive bounds turn a stalled network path
into controller failure.
Only then does the controller send `commit`; smoke failure, remote command failure,
signal, or SSH EOF restores both the live path and `.webai-previous` while the lock is
still held. A subsequent deploy recovers durable state left by an untrappable process
or host interruption before it starts a new transaction.

**Context:** The first M1 deploy used `rsync --delete` directly against the live
hashed-asset tree. Local rsync 3.2.7 documents its modern default as
`--delete-during`; interruption could therefore expose HTML and `_astro` assets from
different builds or remove an old hash before its replacement HTML was live. Staging
makes transfer interruption invisible. Adversarial review found that the initial
implementation returned from its promotion SSH command before smoke checks;
post-switch pointer or connection failure could therefore escape the local rollback
path, and the legacy directory migration had a two-rename availability gap. Keeping
the remote transaction and lock alive until an explicit decision closes both gaps.

**Consequences:** A release is immutable after staging and deployment failure is
recoverable without retransferring the previous build. The deployment host must
provide `flock`, Python 3, and Linux `renameat2` with `RENAME_EXCHANGE`; the deploy
helper fails closed before promotion if the atomic exchange is unavailable. Helpers
use release-unique hidden paths and unlink themselves after opening, so concurrent
staging cannot replace an active helper. Release cleanup is deliberately
not automated in M1, so it cannot accidentally remove a live or rollback target;
bounded retention can be added after measuring release growth. The smoke gate is a
deployment guard, not a replacement for the fuller live-browser/HF verification in
hosting-constraints.md.

**Reopen if:** the host moves releases across filesystems, loses the required
`flock`/Python/`renameat2` surface, nginx disables serving through these symlinks,
release accumulation becomes material, or a deployment orchestrator provides
stronger atomic promotion and rollback.

## D-022: M1 vendors the first shadcn primitive and treats generated hero art as a bounded-background exception  (2026-07-18, status: accepted)

**Decision:** The M1 component foundation includes a local, token-mapped Button
adapted from shadcn/ui and used by the capability report. Composite menu behavior
continues to come directly from Radix. More shadcn primitives are vendored when a
real screen needs them, rather than adding unused scaffolding.

The two opaque Arachne-7 hero WebPs are a deliberate exception to D-018's default of
rendering on the exact theme `--bg`. Perimeter sampling during adversarial review
found dark corner values ranging roughly from `#000415` to `#080E1E` versus
`#0E111B`, and light corners near `#F2F6FC` versus `#F6F8FE`. They therefore render
only as bounded, rounded illustrations whose backgrounds are visibly part of the
artwork; they must not be used as seamless page backgrounds. True-alpha or exact-token
regeneration remains preferred for any unbounded future placement.

**Context:** D-017 selected vendored shadcn plus Radix, but the first shell draft
hand-wrote its two buttons and could not demonstrate that the selected foundation was
present. D-018 made exact opaque backgrounds the safe default for reflective/glowing
generated art. The built-in generation workflow preserved the character well but did
not produce exact edge colors; the reviewed dark/light layouts remain coherent because
the asset is intentionally framed rather than blended into the page.

**Consequences:** The shadcn MIT notice is included in the generated deployed notice
artifact and the root NOTICE. Button variants consume semantic project classes; domain
surfaces remain bespoke. Any token change requires visual inspection of both hero
assets at 1x and 2x, and a distracting boundary requires regeneration or a validated
alpha workflow rather than color-keying.

**Reopen if:** multiple primitives need shared variant composition utilities, the
bounded hero treatment reads as an accidental seam, or a generation/export workflow
can reproducibly deliver exact backgrounds or clean alpha.

## D-021: Capability evidence is operational, failure-aware, and current-spec; WebNN device-type reporting is superseded  (2026-07-17, status: accepted)

**Decision:** M1 implements capability availability as versioned evidence, not feature
flags. A probe outcome is exactly one of: a measured value; conclusive absence of the
exact API/feature; or an indeterminate failure with a sanitized stable code. Missing,
stale, and indeterminate evidence all evaluate to `unknown`, never `unsupported`.
Gates are pure tri-state expressions: failure dominates `all`, success dominates
`any`, core failure is unsupported, core uncertainty is unknown, and failed or
inconclusive optional enhancements make an otherwise viable path degraded.

Cheap page-surface observations remain distinct from operational tests in disposable
module workers. Worker messages use a validated protocol and timeouts terminate the
worker. The page only attaches shared memory when it is cross-origin isolated, so a
non-isolated environment can still measure unrelated worker capabilities. Shared
memory requires an actual page-created `SharedArrayBuffer` whose sentinel a worker
changes with `Atomics`; WebAssembly SIMD, threads, JSPI, and Memory64 use pinned
Apache-2.0 `wasm-feature-detect@1.8.0`; WebGPU records a real adapter/device,
an allowlisted limit set, and whether `shader-f16` was both advertised and acquired;
OPFS opens the worker root without writing. Storage estimates and persistence state
are volatile, origin-wide, and automatically read. Each `estimate()`, `persisted()`,
worker OPFS-root observation, and explicit `persist()` request has a five-second
operation timeout; timeouts become sanitized indeterminate evidence, and late page-
promise settlements are ignored. The state-changing `persist()` call remains user-
initiated only.

The M0 phrase **“WebNN device types” is superseded**. The current WebNN specification
no longer exposes the old `deviceType: cpu | gpu | npu` selection. M1 records page and
worker surface availability, requests a default worker context with
`{ powerPreference: "default", accelerated: true }`, and records the context's
effective `accelerated` value. Unexpected platform value types become schema-valid,
probe-local indeterminate evidence before crossing the worker protocol. It does not
invent a CPU/GPU/NPU identity the API no longer reports. Runtime-specific WebNN
initialization remains authoritative in M7.

**Context:** This refines D-014's evidence registry while implementing its first
consumer. Sources checked 2026-07-17: the 26 June 2026 W3C WebNN Editor's Draft
defines `MLContextOptions` as `powerPreference` plus `accelerated`, exposes
`MLContext.accelerated`, contains no `deviceType`, and explicitly marks context
options under active development; the current W3C WebGPU Recommendation requires
optional features to be advertised and requested; and the npm registry/tagged
package exposes `wasm-feature-detect` 1.8.0 under Apache-2.0 with all four detectors.
Local browser verification in Playwright Chromium 149, under the configured COOP/COEP
headers, passed page/worker isolation, atomic shared-memory use, OPFS root access, and
schema-valid wasm results. The live deployed-origin repeat in Google Chrome
150.0.7871.128 passed the same isolation/shared-memory/OPFS contract and the six HF
CORS cases recorded in hosting-constraints.md. Browser tests cover the complete gate
truth table, malformed and semantically inconsistent protocol messages, platform-value
normalization, worker setup and insecure-context run-ID fallback, non-isolated
shared-memory omission, premature-completion failures, never-settling storage
observations and persistence requests, sanitization, and the no-automatic-persistence
contract.

**Consequences:** Consumers disable only proven-unsupported combinations. Unknown
remains retryable/pending because real adapter/session creation is authoritative.
Raw evidence is safe to display because worker data is schema-bounded and platform
exceptions lose messages/stacks. Memory64 passing is not presented as proof that a
model over 4 GiB will load; quota is not presented as free disk or WebAI-only usage;
and WebNN acceleration is not presented as a named device.

**Reopen if:** WebNN standardizes a new attributable device-selection/result surface;
the pinned wasm detector becomes stale or incorrect; a capability requires a
long-lived diagnostic worker; automatic persistence requests become both
side-effect-free and clearly preferable; or adapter initialization needs a verdict
not expressible by the four-state vocabulary.

## D-020: M1 license allowlist admits weak/file-level and attribution licenses without admitting viral copyleft  (2026-07-17, status: accepted)

**Decision:** M1's SPDX allowlist adds `BlueOak-1.0.0`, `CC-BY-3.0`,
`CC-BY-4.0`, `CC0-1.0`, `MPL-2.0`, and `Python-2.0` to the permissive licenses
already selected by D-016/D-019. This is a deliberate package-by-package expansion,
not a move to a denylist. The only copyleft license admitted is MPL-2.0, whose
requirements apply at file level: M1 consumes the unmodified `lightningcss` packages
through Tailwind/Vite's build pipeline and does not copy or modify their source files.
Astro's optional `sharp` dependency is excluded because M1 does not use Astro image
transforms; this keeps its LGPL-licensed native `libvips` package outside the installed
closure. CC-BY packages are data/tooling inputs and their attribution is retained in
the dependency metadata, WebAI NOTICE, and the deployable generated third-party
notice file.

**Context:** The first real pnpm 11.14.0 install and full dependency audit on
2026-07-17 found the following licenses beyond D-016's seed list: MPL-2.0 on
`lightningcss` and its platform binary; BlueOak-1.0.0 on small utility packages;
CC-BY-4.0 on `caniuse-lite`; CC0-1.0 on `mdn-data` and SPDX identifiers;
CC-BY-3.0 on SPDX metadata; and Python-2.0 on `argparse`. The same audit initially
found LGPL-3.0-or-later only through Astro's optional Sharp/libvips path; reinstalling
with `sharp` in pnpm's `ignoredOptionalDependencies` removed it while `astro build`
remained the required verification gate. Mozilla's MPL 2.0 FAQ, checked the same day,
describes its copyleft as file-level and explicitly permits combining unmodified MPL
files into a larger differently licensed work. The Blue Oak 1.0.0 text grants broad
copyright and patent permissions with a notice obligation. Creative Commons' current
CC-BY 4.0 deed requires credit, a license link, and change indication. Package names,
versions, and SPDX expressions came from the installed lockfile plus
`pnpm licenses list --json`, not memory.

**Consequences:** The CI gate remains strict and fails every unlisted SPDX expression.
It is a small repository script over `pnpm licenses list --json`, which measured 491
package-version installations grouped into 469 package records under pnpm's isolated
layout; scaffold testing showed
`license-checker-evergreen` saw only top-level packages and therefore could not serve
as the full-closure gate D-016 requires.
MPL files, if ever modified or redistributed separately, retain their MPL source and
notices; this decision does not admit LGPL, GPL, AGPL, or share-alike content. M1 adds
a NOTICE entry for the attributed build data, retains font licenses in full, and
generates `public/licenses/THIRD-PARTY-NOTICES.txt` from the pinned production tree.
The audit fails if that deployed file is stale or if a selected shipped package lacks
an evidenced license text.

**Reopen if:** a runtime dependency would ship MPL-covered source modifications; any
LGPL/GPL/AGPL package enters the non-optional closure; a CC asset becomes visible
product content rather than build metadata; or `sharp` becomes necessary for the
asset pipeline.

## D-019: License policy is anti-viral, not a fixed permissive list; OFL-1.1 allowed  (2026-07-17, status: accepted)

**Decision:** The dependency-license policy (D-002) is amended: the bar is **"no
viral licenses"** — nothing that imposes copyleft/share-alike obligations on the
app or its distribution — rather than membership in a fixed
MIT/BSD/Apache/ISC/zlib class. That class remains the expected common case;
non-viral special-purpose licenses are also acceptable, and **SIL OFL-1.1 joins
the D-016 CI SPDX allowlist now** (its share-alike reach is confined to the font
files themselves). Enforcement stays an explicit **allowlist** (per D-002's
allowlist-not-denylist rationale): a license not on the list fails CI until it is
deliberately added with a decision entry. OFL compliance is more than a NOTICE
line: the font assets ship alongside their **upstream copyright notices and the
full OFL license text** (per the OFL FAQ's redistribution guidance), with NOTICE
pointing to them.

**Context:** The M0 review found D-017's "font-assets-only exception" in
conflict with the AGENTS.md licensing constraint and D-002's no-exceptions
state — M1 could not follow both. The owner resolved it (2026-07-17): OFL is
fine, add it to the allowed list, and scope the restriction to preventing viral
licenses like GPL where possible. AGENTS.md's load-bearing constraint was
rewritten to match in the same change.

**Consequences:** D-017's font delivery-path fork loses its licensing dimension —
vendored `.woff2` and OFL-licensed font npm packages are both compliant; M1
picks on engineering merits. The CI license-audit allowlist (D-016) is seeded
with the permissive class plus OFL-1.1.

**Reopen if:** a needed dependency carries weak/file-level copyleft (MPL-class)
— that sits between "permissive" and "viral" and gets its own case-by-case
entry; or the allowlist model itself becomes friction.

## D-018: Mascot identity — Arachne-7, the web-weaving spider automaton  (2026-07-17, status: accepted; M1 bounded-background exception in D-022)

**Decision:** WebAI's mascot is **Arachne-7**: a chrome spider automaton with twin
neon-blue optics, articulated chrome legs with neon light strips, copper-gear
joints, and a holographic web spinner that weaves glowing cyan web filaments.
`docs/assets/arachne-7-character-sheet.jpg` (owner-generated, committed with this
entry) is the **canonical reference**: every subsequent Arachne-7 artwork is
generated with the sheet as image context, never from a text prompt alone. The
sheet's web-styled "W" logomark is the starting point for the WebAI logo work at
M1. The probe/scanner-drone concept sketched in D-017 is superseded by this
identity.

**Context:** D-017 confirmed mascot-yes and deferred the concrete identity to an
M1 decision entry; the owner settled it early by creating the character sheet with
external generation tools (2026-07-17). The originating prompt, kept for
provenance and for regenerating/evolving the sheet itself (new *artwork* still
requires the sheet as image context):

> Generate a character sheet for a mascot that I am going to use for a project
> called "WebAI". It should be of a futuristic robotic spider weaving a web with
> a strong blade-runner/tokyo neon vibe. The spider should be chrome and
> extremely reflective with a bit of a steampunk vibe.

Generation route: Google generative-AI tooling — the JPEG's C2PA manifest is
signed by Google LLC ("Google C2PA Media Services"; inspected 2026-07-17).

The identity fits better than the drone placeholder: a spider that weaves the
web is the product name made visual, and the sheet's palette — electric
blue/cyan glow, indigo night city, magenta/pink neon signage — is native to the
Neon horizon direction. The copper-gear joints add a warm metallic note that
exists in artwork only. Where the sheet's generated labels contradict
themselves, **this written spec governs**: Arachne-7 is 25 cm / 1.2 kg (the
sheet lists 1.2 kg twice and 1.8 kg once — a generation artifact).

**Consequences:** The brief's palette anchors were re-tuned to the sheet's
vibrancy in the same change (owner-approved 2026-07-17): darker near-black canvas
(`#0E111A`-class), accent shifted to the optics' electric blue-cyan
(`#40C4FF`-class, ~9.5:1), hotter neon data set incl. the signage magenta
(`#FF2E9E`-class, ~5.3:1) — while text neutrals stay low-chroma (saturated text
on near-black halates; the sheet's own labels are near-white). Contrast figures
are WCAG ratios computed against the anchor background; the light theme derives
its accents separately since the neon anchors collapse on white. D-017's
direction, accent-rarity, neon-for-data, and AA rules are unchanged — this tunes
values inside them. Additionally, M1's Design.md imagery section cites the sheet
as canonical and
inherits the golemine §12 rules recorded in
[design-brief.md](design-brief.md): placement limited to landing, major empty
states, and capability-gate explanations; decorative only; light/dark variants of
every in-app asset. The sheet is a JPEG (no alpha) and never ships in the app.
In-app assets **default to opaque per-theme renders on the exact token
background color**; transparent WebP is used only where a true-alpha workflow
(real alpha export, or validated edge decontamination) is demonstrated — naive
color-keying of glowing/reflective artwork fringes or destroys the glow (see
the brief's asset rules). Warm metallics stay artwork-only — UI chrome remains
on the Neon horizon tokens. Licensing of the sheet: Google's terms of service
(policies.google.com/terms, checked 2026-07-17) do not claim ownership of
generated content and place lawful-use responsibility on the user; the artwork
was owner-commissioned and supplied, so no NOTICE entry is required — revisit
if a future generation route's terms differ.

**Reopen if:** the character design proves unreproducible across generation tools
(sheet-as-context fails to hold the identity), the spider reads as unfriendly in
user-facing placements (a softer redesign would supersede this entry), or logo
development at M1 departs from the sheet's "W" mark.

## D-017: Design direction — "Neon horizon", dark-default, Tailwind v4 + vendored shadcn, mascot; full Design.md at M1  (2026-07-17, status: accepted)

**Decision:**

- **A full golemine-style `Design.md`** (binding design-system rulebook) is
  warranted and lands with the M1 app shell, seeded from
  [design-brief.md](design-brief.md) — the M0 look-and-feel deliverable.
- **Visual direction: "Neon horizon"** — Tokyo Night-family editor aesthetics
  crossed with Blade Runner/Tron instrument panels: indigo-storm dark neutrals,
  a rare electric-cyan accent, and a violet/magenta neon set **reserved for data
  visuals** (charts, metrics, mascot/brand imagery), never chrome. Functional
  status colors stay distinct from both. Subtle glow is permitted on data visuals
  and brand imagery only — a deliberate, bounded departure from golemine's
  no-decoration rule; AA contrast and reduced-motion remain non-negotiable.
- **Dark by default** for first-time visitors, with a persisted Dark/Light/System
  toggle and a real, AA-compliant light theme. (Differs from golemine's
  system-default: the identity is editor-native.)
- **Token approach:** semantic CSS custom properties in OKLCH, mapped into
  **Tailwind v4** (CSS-first `@theme`) via `@tailwindcss/vite`; **shadcn/ui
  vendored and restyled** on our tokens with Radix interaction primitives and
  lucide icons; domain surfaces (chat stream, virtualized lists, charts)
  hand-rolled. Inter + JetBrains Mono, self-hosted (D-005), under SIL OFL-1.1 —
  allowed by the anti-viral license policy (D-019, which also added OFL-1.1 to
  the CI allowlist). Delivery path (vendored `.woff2` vs. font npm packages) is
  an M1 engineering call; either way the assets ship with their upstream
  copyright notices and OFL text, with NOTICE pointing to them (D-019).
- **Mascot: yes** — concept: a holographic probe/scanner drone in the neon set;
  character-sheet-first pipeline and placement rules per the brief. Concrete
  identity gets its own M1 decision entry. *(Identity settled same day: the
  drone concept is superseded by Arachne-7 — see D-018.)*

**Context:** Closes the last open M0 checklist item. Owner direction (2026-07-17
conversation): a full brief but not golemine's gold/steampunk theming — a vibrant,
professional developer look styled off popular VS Code theme packs with neon
futuristic contrast; Tailwind + vendored shadcn/Radix confirmed; mascot confirmed.
Three directions were mocked up and put to the owner: **Phosphor**
(Matrix/terminal phosphor-green — rejected: accent collides with success-green
status semantics in a diagnostics-first tool, reads retro), **Neon horizon**
(chosen), and **Aurora** (Catppuccin/Dracula pastels — rejected: softer than the
futuristic-instrument brief). Dark-default was an explicit owner call.
Technology-state checks (root rule 4, 2026-07-17): Tailwind is at v4.3 with
`@tailwindcss/vite` as the blessed Astro path and `@astrojs/tailwind` archived
June 2026 (tailwindcss.com, docs.astro.build); shadcn/ui is fully updated for
Tailwind v4 + React 19 with OKLCH colors (ui.shadcn.com); VS Code theme
popularity (GitHub Themes 18.8M, One Dark Pro 12.2M, Dracula 5M+, Tokyo Night
2.7M+, Catppuccin trending) from 2026 marketplace roundups.

**Consequences:** M1's "look-and-feel foundation" task consumes the brief:
derive final OKLCH token tables (both themes, AA-validated), write `Design.md`
per the brief's required-contents list, add NOTICE entries when vendoring
(Tailwind/shadcn/Radix MIT, lucide ISC, fonts OFL-1.1 per D-019), and record the
mascot identity decision *(fulfilled early by D-018, same day)*. With this, every
M0 checklist item is closed.

**Reopen if:** scaffold-time smoke checks find Tailwind v4/`@tailwindcss/vite`
or vendored shadcn incompatible with the Astro 7 island setup (fallback ladder to
be recorded in a superseding entry); the cyan accent or neon set cannot reach AA
in a theme without losing the identity; or the mascot/glow direction proves
unworkable in generated assets at M1.

## D-016: Toolchain — Astro 7, React 19, pnpm, TS 6, Vitest+Playwright, ESLint+Biome  (2026-07-17, status: accepted; `/webai/` base superseded by D-024)

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

## D-012: Isolate `/webai/` in place; keep the shared origin  (2026-07-17, status: accepted for isolation policy; origin/base/storage scope superseded by D-024)

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
  rather than broadening D-005 or weakening D-006 silently. *(D-024 supersedes only
  the path: these assets now ship at the dedicated origin root.)*
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
and self-host `@wllama/wllama-compat` instead. *(D-024 moves the same-origin asset base
to `/` without changing this network boundary.)*

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

## D-010: M0 feature triage — scope verdicts  (2026-07-17, accepted; question 8 superseded by D-024)

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

## D-002: Apache-2.0 license; permissive dependencies only  (2026-07-17, accepted; amended by D-019 — the policy bar is "no viral licenses", and OFL-1.1 font assets are allowed)

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

## D-001: Static Astro site at https://meenan.dev/webai/  (2026-07-17, superseded by D-024 for origin/base; static/client-only/rsync retained)

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
