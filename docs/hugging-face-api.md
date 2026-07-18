# Hugging Face API spike

**Status:** complete evidence snapshot, checked 2026-07-17 (America/New_York).
This closes the M0 API-spike input for D-013, M2 acquisition/downloads, and M5 model
browsing. Hugging Face is an external service, so the implementation milestones
repeat the focused checks called out below rather than treating this snapshot as a
permanent contract.

## Outcome

- Use a two-stage discovery flow. The public models API narrows candidates by model-ID
  substring, author, task, tags/library, gating, parameter count, and sort order.
  WebAI then enriches bounded candidate batches or selected repos at an immutable
  commit to learn actual file names, per-file bytes, shards, and integrity hashes.
  File-size and quant filters are client-side over that enriched data; the public
  search API cannot express them reliably.
- Resolve a requested branch or tag to the repo SHA before offering files. Persist
  `(repo ID, commit SHA, path, size, integrity kind + digest)` as the download
  identity. Weight files require LFS SHA-256; selected Git-managed companions use
  their Git-blob identity. Mutable `main` and a signed CDN URL are not identities.
- Download and resume through
  `/{repo}/resolve/{commit}/{path}`, requesting a fresh range through the resolver on
  every attempt. Append only after validating HTTP 206 and the exact
  `Content-Range`; verify completed bytes against the metadata's declared integrity
  kind (LFS SHA-256 is mandatory for weights).
- Treat API pagination and throttling as normal states. Follow the exposed `Link`
  cursor, debounce and deduplicate search, cache enrichment by repo SHA, and react to
  429 with bounded exponential backoff plus jitter. Browser code cannot currently
  read Hugging Face's otherwise-useful `RateLimit` reset value (RE-006).
- Every response remains untrusted input under D-006. In particular, model tags,
  filenames, card data, and expanded GGUF metadata are display data, never HTML; JSON
  body size, item count, strings, paths, numeric sizes, cursors, and redirects need
  bounds and validation.
- Use Hugging Face's LFS-compatible `/resolve/` byte path in M2, not the native Xet
  reconstruction protocol. Native Xet requires separate expiring auth, CAS
  reconstruction terms, ranged xorb retrieval, decompression/reassembly, and its own
  hashes; it is a later performance spike only if measured resolver performance makes
  that complexity worthwhile.

## Public model search: what it can express

Hugging Face documents open Hub endpoints plus official Python and JavaScript
clients. The current
[`list_models` reference](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.HfApi.list_models)
is the clearest public inventory of model-list parameters. Direct browser requests to
`GET https://huggingface.co/api/models` matched that surface in this spike.

| WebAI need | Server-side candidate query | What still needs client work |
| --- | --- | --- |
| Model ID/name substring | `search`; `author` | Search does not promise model-card or general full-text matching and is not a compatibility guarantee. |
| Task | `pipeline_tag`, or a task tag via `filter` | Validate missing/inconsistent publisher metadata; model/runtime compatibility is separate. |
| Format/library | One or more tag/library values via `filter` (for example `gguf`) | These are Hub metadata tags, not inspected file truth. Confirm the repo tree and file extension. |
| Gating | `gated` | M5 still needs a valid-token gated browser test before this path ships. |
| Parameter count | `num_parameters` range | Parameter count is not download bytes or runtime memory. |
| Ordering | `sort` by `created_at`, `downloads`, `last_modified`, `likes`, or `trending_score`; bounded `limit` | Validate and follow the opaque cursor URL from the response's `Link: ...; rel="next"`; never construct or decode it. |
| Response shape | `expand` for selected properties, or the larger `full` response | Ask only for fields the view uses and enforce response limits. Expansion data can itself contain large untrusted strings. |
| File bytes | None suitable for search filtering | Fetch revision-pinned file metadata and total the selected file/shard group. `usedStorage` is repo-wide; GGUF aggregate size is not a quant's size. |
| Quantization | No normalized typed filter | Publisher tags and filenames can seed a hint; derive the downloadable choices from the file list and confirm from defensively parsed model metadata after acquisition. |
| “Runs in this browser” | None | Combine format/files with WebAI's M1 capability report and per-runtime rules. Hub app/provider compatibility is not local-browser compatibility. |

The measured candidate query combined `search`, `filter=gguf`,
`pipeline_tag=text-generation`, download sorting, a limit, and `full=true`. It returned
HTTP 200, a repo SHA, tags, task, gating state, sibling names, and an exposed next-page
`Link`; sibling sizes and LFS hashes were intentionally absent from this list shape.
A narrower `expand=gguf` query exposed aggregate GGUF data but could also include a
full chat template, confirming that it is neither a small nor sufficient substitute
for file enrichment.

The current official
[filter taxonomy endpoint](https://huggingface.co/api/models-tags-by-type?type=library)
includes values such as `gguf`, `onnx`, `safetensors`, and `transformers.js`, but
classifies several format-like values as “library” tags. WebAI consequently treats the
taxonomy as a changing set of discovery hints rather than a stable format type system.

### Discovery request policy

M5 should use a small first page and minimal fields, debounce text input, cancel stale
queries, and coalesce identical in-flight requests. Enrich only the candidate batch
currently being evaluated (or a selected repo), with a low concurrency limit; cache
results by `(repo ID, SHA)` so back/forward navigation and repeated filters do not
spend API quota. When client-side filters reject most of a batch, progressively follow
search cursors and enrich further bounded batches until the display target is filled,
the user stops/loads more, or results end. The UI reports that progress and must
distinguish “not inspected yet” from “does not match” rather than silently dropping
unknowns or implying that a partially enriched result set is exhaustive.

`Link` itself is remote metadata. Parse it with the URL API and follow `rel="next"`
only when it remains HTTPS on the expected `huggingface.co` origin and models-list
path; reject credentials, fragments, unexpected relations/origins, malformed URLs,
and excessive pagination. The cursor stays opaque even after the surrounding URL is
validated.

## Revision and file metadata

The official [`model_info`](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.HfApi.model_info)
surface accepts a revision and `files_metadata=True`; its response supplies the
resolved repo SHA and sibling file metadata. The official
[`list_repo_tree`](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.HfApi.list_repo_tree)
surface is the paginated alternative for large/nested repositories. Direct REST
measurements used the corresponding model-info `blobs=true` and repo-tree endpoints:

```text
GET /api/models/{repo}/revision/{requested-revision}?blobs=true
GET /api/models/{repo}/tree/{resolved-commit}?recursive=true&expand=false
```

On `Qwen/Qwen2.5-1.5B-Instruct-GGUF`, the revision-pinned model-info response included
the same 40-hex repo SHA requested plus, for each GGUF, `rfilename`, byte `size`, Git
`blobId`, and `lfs.sha256`/`lfs.size`. On
`Qwen/Qwen2.5-0.5B-Instruct`, the tree response similarly returned file paths, byte
sizes, Git object IDs, and for the large safetensors file both an LFS SHA-256 and an
Xet hash. Both endpoints returned browser-compatible CORS for
`Origin: https://meenan.dev`.

The two endpoint shapes name the payload digest differently: model-info siblings use
`lfs.sha256`, while tree entries use `lfs.oid`. Their measured values were identical.
The boundary parser maps either spelling—never `blobId`/top-level `oid` or `xetHash`—
to one internal `{ kind: "lfs-sha256", digest }` identity after validating exactly 64
hex digits and matching LFS/file sizes. Endpoint field names do not leak into the
download manifest. For an entry with no `lfs` object, model-info `blobId` and tree
top-level `oid` are instead alternative spellings of the Git object ID; after
validating exactly 40 hex digits, normalize either to
`{ kind: "git-blob-sha1", digest }`. A tree top-level `oid` on an LFS entry identifies
the pointer blob and must never enter either payload-integrity path.

When candidate paths are already known, the official
[`get_paths_info`](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.HfApi.get_paths_info)
surface can avoid walking a huge tree. It silently omits nonexistent paths, so callers
must match every requested path in the response and reject missing/duplicate entries;
its form POST and browser preflight must be re-measured before adopting it. M2 can use
revision-pinned model info as the simpler initial path.

For a large model artifact, `lfs.sha256` is WebAI's expected raw-payload content
digest and `lfs.size` must equal the file size before acquisition starts. `xetHash`
identifies Xet storage but is not the content-integrity field WebAI verifies; the final
Xet bridge `ETag` matched this Xet ID in the experiment, not the payload SHA-256. A
non-LFS `oid` or `blobId` is a Git object ID, not a raw-file SHA-256; it must not be
mislabeled or fed to a plain SHA-256 comparison. M2 requires LFS SHA-256 for weight
files; a weight artifact without it fails closed. A selected Git-managed companion
records the normalized `git-blob-sha1` identity and verifies the Git object digest
`SHA-1("blob " + decimalByteLength + NUL + rawBytes)`. The algorithm discriminator is
mandatory: a Git object ID is never passed to plain-file SHA-1/SHA-256 or presented as
equivalent to LFS payload integrity.

Repo file lists can be paginated, unordered, nested, and hostile. The acquisition
layer validates that paths are relative repo paths (no traversal or control
characters), sizes are safe non-negative integers within product limits, hashes have
the expected encoding/length, and duplicate/conflicting paths reject the listing.
Already-sharded choices are represented by an explicit ordered file set; their total
size is the checked sum of individual sizes and every shard retains its own hash.

## Resumable integrity-checked download contract

D-013 fixes this protocol for the M2 download worker:

1. Resolve the user's repo and optional branch/tag through model metadata. Capture the
   returned immutable commit SHA, then obtain file metadata at that same SHA. Do not
   mix a file list from one revision with the SHA from another response.
2. Before bytes are written, persist a partial-download record containing repo ID,
   commit, path, expected byte size, discriminated integrity kind/digest, durable
   output target/stage, and completed byte count. Weight artifacts must carry LFS
   SHA-256. Never persist a signed redirect URL.
3. Start at byte zero or the verified durable length `N`. If `N` equals the expected
   size, skip transfer and run final integrity verification. Otherwise fetch the
   immutable resolver URL with `Range: bytes=N-` even when `N` is zero; let Fetch
   follow a newly issued signed redirect. This gives initial and resumed transfers
   one response contract.
4. For every transfer response, accept only HTTP 206 with a syntactically valid
   `Content-Range: bytes start-end/total`: `start` must equal `N`, `total` must equal
   the metadata size, and `start <= end < total`. Stream no more than
   `end - start + 1` bytes and require exactly that many before treating the response
   as complete; a readable `Content-Length` must agree too. A 200, malformed/missing
   range, wrong start/end/total, inconsistent 416, short/long body, or metadata
   mismatch must never promote or append bytes outside the validated interval. After
   an interrupted body, reconcile the durable prefix and re-resolve from its actual
   length. `If-Range` is not part of the protocol: the immutable commit plus expected
   integrity identity is the validator, and RE-005 measured ineffective `If-Range`
   behavior on this path.
5. Stream bytes to the recorded output stage in a worker, bounding every chunk and
   progress counter. After interruption, reconcile the manifest count with the actual
   durable output length before requesting more bytes. For M3's streaming splitter,
   that durable state is the split-stage checkpoint/output, not an assumed monolithic
   temporary file.
6. Hash the complete logical artifact in the worker using the declared integrity
   algorithm—raw payload SHA-256 for LFS, Git-blob SHA-1 semantics for a selected
   non-LFS companion—before atomically promoting the partial record to an installed
   model. A resume may re-read already-stored bytes to reconstruct hash state; it must
   not trust a persisted byte count as proof of content. On mismatch, retain a clear
   error state and never expose the artifact as verified.

For M2's ordinary file output, re-reading the durable prefix is a simple restart-safe
way to rebuild incremental hash state. M3's streaming splitter must instead checkpoint
source offset, durable split state, and resumable hash state as one consistent unit—or
use D-009's split-after-download fallback—because transformed split output cannot be
assumed to reproduce the original byte prefix cheaply. The current
[Web Cryptography digest method](https://w3c.github.io/webcrypto/#SubtleCrypto-method-digest)
accepts one complete `BufferSource` and exposes no incremental state, so M2 must select
and license-audit a worker-capable streaming SHA-256 implementation during
toolchain/implementation work.

The official Hub download client likewise keys cached snapshots by commit and blobs
by Git/LFS identity; see the
[`hf_hub_download` cache layout](https://huggingface.co/docs/huggingface_hub/en/package_reference/file_download#huggingface_hub.hf_hub_download).
WebAI is not adopting that filesystem layout, but the same separation of mutable refs,
immutable snapshots, and content-addressed blobs supports this protocol.

## CORS, pagination, and rate limits

The isolated-browser pass is recorded in
[hosting-constraints.md](hosting-constraints.md). This spike added direct CORS probes
for candidate search, revision-pinned model info, and repo tree. Responses allowed
`https://meenan.dev`; their expose policy allow-listed `Link`, request/error, range,
repo-commit, and linked-artifact header names if present. Search actually carried the
next-page `Link`, which was usable by following its opaque `rel="next"` URL. The
browser-readable commit, sizes, and hashes selected by D-013 come from the JSON
model-info/tree response—not the intermediate resolver headers hidden by Fetch
(RE-005).

Hugging Face's current
[rate-limit documentation](https://huggingface.co/docs/hub/main/rate-limits)
separates API and resolver buckets into five-minute fixed windows, returns HTTP 429,
and publishes current plan quotas while warning that anonymous/free values can change.
WebAI therefore never hard-codes a quota or promises a remaining-request counter.
RE-006 confirms that `RateLimit` and `RateLimit-Policy` are present on the network
response but absent from `Access-Control-Expose-Headers`, so browser JavaScript cannot
read the documented seconds-to-reset value.

The browser policy is consequently reactive: pause the affected request class on
429; retry idempotent GETs with bounded exponential full jitter and a finite automatic
retry budget; expose waiting/retry/cancel state; and honor a readable standards-based
delay header if Hugging Face exposes one in the future. Search debouncing, request
coalescing, cursor pagination, SHA-keyed caching, and resolver use for actual bytes
reduce API calls without weakening freshness or integrity.

## Reproducible measurements

These representative commands transfer only JSON or metadata. Add
`-H 'Origin: https://meenan.dev'`, save headers with `-D`, and inspect
`Access-Control-Allow-Origin`, `Access-Control-Expose-Headers`, and `Link` alongside
the bounded JSON fields:

```sh
curl 'https://huggingface.co/api/models?search=Qwen2.5-GGUF&filter=gguf&pipeline_tag=text-generation&sort=downloads&direction=-1&limit=2&full=true'

curl 'https://huggingface.co/api/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/revision/91cad51170dc346986eccefdc2dd33a9da36ead9?blobs=true'

curl 'https://huggingface.co/api/models/Qwen/Qwen2.5-0.5B-Instruct/tree/7ae557604adf67be50417f59c2c2f167def9a775?recursive=true&expand=false'

curl -L --range 0-15 -D - -o /dev/null \
  'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-fp16.gguf'
```

The commit-pinned range returned an intermediate 302 with matching
`X-Repo-Commit`, `X-Linked-Size: 3560416288`, and the metadata LFS SHA-256, followed
by exactly 16 bytes in HTTP 206 with
`Content-Range: bytes 0-15/3560416288`. Its final `ETag` was a different Xet ID. This
directly measures the immutable resolver mechanism selected by D-013 without storing
the transient signed URL.

The range/redirect/browser reproductions are kept in RE-005 and the hosting spike to
avoid duplicating transient signed URLs here. The spike deliberately did not exhaust
quota to manufacture a 429, did not have a valid gated-model token, and did not
download a complete large model. Those are unnecessary or inappropriate for the M0
design decision; M2 tests interrupted/full hashing against fixtures and a real public
artifact, while M5's exit gate repeats the authenticated browser path with a valid
token.

## Implementation gates

### M2 revalidation (2026-07-18)

The focused implementation pass rechecked revision-pinned model info and the resolver
with `ybelkada/tiny-random-llama-Q4_K_M-GGUF` at commit
`429fe92916dae4839bfefb46bd0f61f50cc02c73`. Model info returned the expected
1,627,808-byte LFS record and SHA-256
`f06746ef9696d552d3746516558d5e9f338e581fd969158a90824e24f244169c`. The actual M2
browser worker downloaded the complete Xet-backed payload through the commit-pinned
resolver, accepted the exact 206 range contract, matched that digest, promoted it,
and parsed its GGUF `llama` metadata. The opt-in Playwright reproduction is
`WEBAI_LIVE_HF=1 corepack pnpm exec playwright test tests/e2e/models.spec.ts --grep
'complete public'`; ordinary CI uses deterministic intercepted fixtures and does not
make external traffic.

A second model-info check used the realistic mixed repository
`bartowski/Llama-3.2-1B-Instruct-GGUF` at commit
`067b946cf014b7c697f3654f621d577a3e3afd1c`: its 21 siblings included GGUF weights,
Markdown, `.gitattributes`, and an imatrix. M2 filters to `.gguf` candidates before
requiring weight size/LFS identity, so an irrelevant or malformed companion cannot
hide otherwise valid quants. Unsafe, duplicate, malformed, or non-LFS GGUF candidates
still fail closed.

Deterministic tests cover hostile metadata/path/size/hash listings, complete/incomplete
shard grouping, an end-to-end wrong-status response plus a unit-level range/length
rejection matrix, Git-blob framing, finite jittered 429 backoff,
interruption after a one-MiB durable write, page/worker restart, resume from actual
OPFS length, final digest mismatch, local import/restart/delete, recoverable interrupted
deletion, idempotent install, and malformed/truncated/oversized/duplicate GGUF metadata.
GGUF metadata inspection is best-effort and repeatable from installed OPFS bytes;
remote size/LFS SHA-256 or local stored-copy equality gates installation instead.
Additional storage tests cover reconcile/delete overlap,
per-record oversized-partial degradation, orphan cleanup, and repair of a corrupt
content-addressed blob from its verified partial. Local imports re-hash stored OPFS
bytes before promotion.

The same-day Gemma 4 check used
`unsloth/gemma-4-E2B-it-qat-GGUF` at commit
`66a399f68ddd113b06dff02fca9523e55465d11d`. Model info exposed each sibling's path,
size, blob/LFS identity, plus repository-level `gguf` and `cardData`; none of those
fields associated an MTP sidecar with a primary quant. The unstructured README and
`MTP/README.md` state that root `mtp-gemma-4-E2B-it.gguf` is the recommended Q4_0
drafter and pairs with any E2B QAT quant. Current llama.cpp independently implements a
filename heuristic (checked at commit
`571d0d540df04f25298d0e159e520d9fc62ed121`): exclude known sidecars from primary choices, then select an MTP
in the same directory with the closest quantization bit width. M2 mirrors and labels
that runtime convention for LFS MTP files, offers model-only or model-plus-MTP, and
links the pinned repository for alternate precisions. It does not treat that heuristic
as API metadata or parse model-card prose. Other companion types and Git-managed
companions remain deferred to their runtime adapter contracts. The selected root MTP
is a normal GGUF v3 container with `general.architecture` `gemma4-assistant`; WebAI
uses the same bounded inspector but labels the file as an MTP speculative-decoding
companion. RE-014 records why its hyphenated architecture metadata required removing
WebAI's narrower, non-upstream key-character assumption.

- **M2:** recheck the model-info/tree response shape and CORS; fixture-test hostile
  metadata, pagination, shard grouping, and the format-aware classifier that separates
  weight artifacts/shards from known sidecar filename markers. Filenames/tags remain
  untrusted hints: MTP association is labelled as a llama.cpp convention, restricted
  to same-directory LFS files, and never presented as an HF-declared relationship.
  Also test missing/wrong integrity kinds, all range rejection cases, interruption
  after durable writes, resume after worker/page restart, final digest mismatch,
  Git-blob identity framing, and promotion visibility. Run at least one complete
  public LFS/Xet artifact through the measured path.
- **M5:** recheck search parameters, cursor behavior, current rate-limit/CORS policy,
  and quant/file naming assumptions. Test a valid-token gated repo and signed redirect
  in an isolated browser before token support ships.
- **M1/live deploy:** repeat the smaller HF CORS probe from the production origin as
  required by D-012; it remains the deployment check for external-policy drift.
