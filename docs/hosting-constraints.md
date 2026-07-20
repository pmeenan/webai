# Hosting constraints spike

**Status:** original M0/M1 evidence checked 2026-07-17 through 2026-07-18; dedicated-
origin migration accepted in D-024 and direct deployment accepted in D-027 on
2026-07-18. Historical results below remain dated evidence, not proof of current
platform behavior.

## Selected outcome (D-024/D-027)

D-027 is implemented and verified locally and against the live host. Its first run
moved D-023's active release into a real `webai` directory and removed all seven
retained release directories after the public smoke checks passed.

- The canonical URL is `https://webai.meenan.dev/`; Astro, application routes,
  content-hashed assets, notices, and the future service worker are rooted at `/`.
- The deploy filesystem does not move. D-027 rsyncs directly into the real
  `/var/www/meenan.dev/webai/` directory and deletes stale files after transferring
  replacements. There are no retained release copies or automatic rollback.
- COOP `same-origin` and COEP `require-corp` remain required on successful HTML,
  assets/workers, and errors. The dedicated vhost owns those headers without affecting
  `www.meenan.dev`.
- WebAI now has a dedicated browser origin/storage trust boundary. Existing
  `meenan.dev` storage, persistence, permissions, and service-worker state do not
  migrate; the pre-M2 cutover deliberately accepts resetting the M1 theme preference.
- The cutover must repeat direct-route, asset, notice, error-header, page/worker
  isolation, shared-memory, OPFS, and HF CORS checks from the new origin.

## Original M0 outcome (origin choice superseded by D-024)

- The original decision kept the canonical URL at `https://meenan.dev/webai/`. The
  path mapped directly to the existing static document root, and no hosting,
  isolation, Hugging Face CORS, or service-worker constraint required a dedicated
  origin.
- Serve WebAI with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. This makes
  `crossOriginIsolated === true`, enabling `SharedArrayBuffer` for multithreaded wasm
  and `performance.measureUserAgentSpecificMemory()` where the browser implements it.
- Do not use `COEP: credentialless`. WebAI's permitted cross-origin traffic is
  explicit CORS-mode `fetch()` to Hugging Face, and that path works under the stricter
  `require-corp` policy. Allowing accidental no-CORS subresources adds no product
  capability and would make D-005's network boundary harder to enforce.
- The original decision explicitly accepted that `/webai/` was not a browser storage
  or security boundary. Namespacing prevented accidental collisions, but every same-
  origin application could reach the same storage and contributed to the same quota.

The current platform contract is described by the
[HTML cross-origin isolation model](https://html.spec.whatwg.org/multipage/document-sequences.html#bcg-cross-origin-isolation)
and [COEP processing model](https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-embedder-policies).
CORS-mode fetches remain permitted under `require-corp`; they must pass their normal
CORS check ([COOP/COEP deployment guide](https://web.dev/articles/coop-coep)).

## Actual deploy target

Read-only inspection of the production host established the following rather than
assuming a generic static server:

- nginx 1.30.2 on the SSH host alias `plex` serves `webai.meenan.dev` from
  `/var/www/meenan.dev/webai/`. The release parent is writable by the deploy user;
  the vhost is root-owned and needs an interactive admin/sudo step to change/reload.
- M1 initially created `/var/www/meenan.dev/webai/` as a direct rsync target. D-023
  temporarily replaced it with sibling `.webai-release-*` directories and symlink
  promotion. D-027 returns to direct rsync: its first run moves the active release
  directory back to the real `webai` path and, after successful smoke checks, removes
  the superseded releases and transaction pointers.
- The dedicated vhost has server-level isolation headers, an HTML regex that defines
  its own `add_header Cache-Control`, a static-extension regex, and root-level
  `try_files $uri $uri/ =404`. nginx does not inherit parent `add_header` directives
  into a child context that defines any `add_header`, so the HTML location must repeat
  both isolation headers. See nginx's
  [location selection rules](https://nginx.org/en/docs/http/ngx_http_core_module.html#location)
  and [`add_header` inheritance rules](https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header).

The relevant minimum is:

```nginx
server {
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    try_files $uri $uri/ =404;

    location ~* \.(html|htm)$ {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }
}
```

The static regex currently inherits the server headers; successful JS/font probes
confirmed that behavior. The explicit HTML duplication is load-bearing because its
cache header suppresses inheritance. Any future cache/location changes must preserve
both headers on documents, workers, assets, errors, and offline/synthetic navigation.

## Hugging Face CORS experiment

Environment: Google Chrome 150.0.7871.128, Linux 6.17.0-40, 2026-07-17. A temporary
localhost page sent both isolation headers, asserted `crossOriginIsolated` and
`SharedArrayBuffer`, then used normal browser `fetch()` calls. The browser, rather
than `curl`, was the pass/fail authority for COEP and CORS.

| Request from the isolated page | Result |
| --- | --- |
| `GET https://huggingface.co/api/models?limit=1` | CORS response, HTTP 200 |
| `GET https://huggingface.co/openai-community/gpt2/resolve/main/config.json?download=true` | CORS response, HTTP 200 after redirect to `/api/resolve-cache/` |
| `GET https://huggingface.co/openai-community/gpt2/resolve/main/model.safetensors` with `Range: bytes=0-15` | CORS response, HTTP 206 after redirect to a signed `us.aws.cdn.hf.co` URL; exactly 16 bytes and `Content-Range: bytes 0-15/548105171` |
| The same API/small-file/ranged-file requests with `Authorization: Bearer webai-spike-invalid-token` | Preflight and public fetch succeeded; the ranged response was HTTP 206 with the requested 16 bytes |

The compact browser-probe logic was:

```js
const requests = [
  ["api", "https://huggingface.co/api/models?limit=1", {}],
  ["small", "https://huggingface.co/openai-community/gpt2/resolve/main/config.json?download=true", {}],
  ["range", "https://huggingface.co/openai-community/gpt2/resolve/main/model.safetensors", {
    headers: { Range: "bytes=0-15" },
  }],
];

for (const [name, url, init] of requests) {
  const response = await fetch(url, init);
  console.log(name, response.status, response.type, response.url,
    (await response.arrayBuffer()).byteLength,
    response.headers.get("content-range"));
}
```

Repeat the array with the dummy `Authorization` header merged into each request. Serve
the page from a trustworthy localhost URL with the two selected COOP/COEP response
headers; verify `crossOriginIsolated` before running the fetches. The dummy token
deliberately proves that the header preflight and public redirect path are accepted;
it does **not** prove authenticated access to a gated model. D-042 later made this a
historical hosting measurement only: WebAI sends anonymous Hugging Face requests and
does not support gated/private acquisition.

The page reported `crossOriginIsolated: true` and exposed `SharedArrayBuffer` while
all four paths succeeded under `COEP: require-corp`. A separate response-header probe
with `Origin: https://meenan.dev` found matching `Access-Control-Allow-Origin` and an
expose list including `ETag`, `Accept-Ranges`, `Content-Range`, `X-Linked-Size`,
`X-Linked-ETag`, and `X-Xet-Hash`. The resolver also returned the immutable repo
commit and LFS/Xet identity metadata on its intermediate redirect. Normal Fetch does
not expose that followed redirect response; `redirect: "manual"` produces an opaque
redirect, so browser code can read the final `ETag`/`Content-Range` but must obtain
commit, linked size, and linked hash from a separate browser-readable HF metadata
endpoint. These results validate isolation compatibility; the separate M0 Hugging
Face API spike still owns that metadata path, API expressiveness, rate limits, resume
design, and integrity semantics.

The tested endpoint classes match Hugging Face's distinction between
[Hub API and resolver requests](https://huggingface.co/docs/hub/main/rate-limits).
M1 must rerun the browser probe from the deployed origin because CDN and CORS behavior
are external state, not a permanent guarantee.

## Root base and dedicated-origin storage

Astro builds with base `/` and produces root-relative routes and assets for
`https://webai.meenan.dev/`; nginx maps that origin root directly to the unchanged
rsync release symlink. Route output must work with static `try_files` behavior—there
is no server-side application fallback.

Browser storage keys do not contain a URL path. The
[Storage Standard](https://storage.spec.whatwg.org/#storage-keys),
[IndexedDB](https://w3c.github.io/IndexedDB/#database-construct), and
[OPFS](https://fs.spec.whatwg.org/#accessing-the-bucket-file-system) therefore make
these consequences explicit:

- OPFS, IndexedDB, Cache Storage, `localStorage`, permissions, quota estimates, and
  persistence belong to the `https://webai.meenan.dev` storage key rather than the
  former `https://meenan.dev` origin. Existing browser state cannot transfer through
  client code. Keep the top-level `webai` OPFS directory plus versioned/prefixed
  database, cache, and local-storage names for ownership and migration hygiene.
- `navigator.storage.estimate()` is an origin-level, implementation-defined estimate,
  not WebAI-only accounting. WebAI's own manifest must provide per-model/runtime byte
  accounting. `persist()` applies to the origin's default bucket, can be denied, and
  does not remove quota failure or user-clearing cases.
- Any same-origin script can read or alter WebAI data, including locally stored HF
  tokens once that feature lands. Do not host separately controlled or untrusted code
  on this subdomain.
- Put the future service worker at `/sw.js` with scope `/`. M10 must preserve
  isolation headers in every cached navigation response. Registrations and caches on
  the former origin do not migrate or coexist with this worker.

## D-024 dedicated-origin cutover gate

The canonical cutover is not complete until checks establish:

1. `/`, `/about/`, and `/capabilities/` load directly with root-relative assets,
   notices, and the capability module worker; `/webai/` does not appear in built URLs.
2. Successful HTML, application assets/workers, notices, and a representative 404
   carry COOP `same-origin` and COEP `require-corp`.
3. The page and worker are cross-origin isolated; page-created shared memory completes
   the worker atomic-sentinel round trip; OPFS opens without a write.
4. Anonymous and dummy-Authorization HF API, resolver, and exact range requests pass
   browser CORS from `https://webai.meenan.dev` under deployed COEP.
5. The deployment target is the expected real directory, no obsolete release or
   transaction residue remains, and `https://www.meenan.dev/` does not acquire
   WebAI's isolation headers.

The legacy `/webai/` path should redirect to the new origin with the suffix stripped
if link continuity is desired; it must not serve the root-base application as a second
origin.

## Original M1 deploy verification gate (pre-D-024)

The first live deploy is not complete until automated or recorded checks establish:

1. `/webai/` and a nested Astro route load with `/webai/`-rooted assets; direct route
   navigation does not depend on an SPA server fallback.
2. HTML and worker responses, plus representative success and error responses, carry
   `COOP: same-origin` and `COEP: require-corp`; `/` does not gain them accidentally.
3. The page and a dedicated worker both report `crossOriginIsolated`; a
   `SharedArrayBuffer` can be created, posted to the worker, and used there.
4. Browser fetches from the live origin repeat the public API, resolver, dummy-
   Authorization preflight, redirect, and ranged-download cases above.

The service-worker checks do not block M1 because WebAI's PWA is M10 scope. When M10
adds `/webai/sw.js`, its acceptance work must verify that root and `/webai/`
registrations do not interfere and that every cached/offline WebAI navigation retains
the isolation headers.

### Original M1 live verification result (pre-D-024)

Passed 2026-07-17 from Google Chrome 150.0.7871.128 on Linux after rsyncing the M1
static build to `plex:/var/www/meenan.dev/webai/`:

- `/webai/`, `/webai/about/`, and `/webai/capabilities/` loaded directly with
  `/webai/`-rooted hashed assets. The capability module worker loaded from the same
  base path.
- HTML, application JavaScript, the module worker, and a deliberate 404 all returned
  `COOP: same-origin` and `COEP: require-corp`. `https://meenan.dev/` retained neither
  header.
- The page and dedicated worker both reported `crossOriginIsolated: true`; a
  page-created `SharedArrayBuffer` sentinel changed from 41 to 42 through worker
  `Atomics.compareExchange`. The worker opened the OPFS root without writing.
- From the live isolated page, anonymous and dummy-Authorization requests each passed
  for the HF model API (200, CORS), small resolver file (200, CORS), and 16-byte model
  range (206, CORS, exactly 16 bytes, `Content-Range: bytes 0-15/548105171`).
- No console, page, or failed same-origin resource errors occurred. Headless Linux
  exposed the WebGPU page surface but returned no usable adapter, and did not expose
  WebNN; the report classified those measured environment results as unsupported
  without affecting other capabilities.

The repeatable browser script remained in the session scratchpad, not the repository;
the product's own capability evidence and Playwright tests exercise the same
page/worker isolation and shared-memory contract.

Historically, after adversarial review, D-023 hardened the deploy path: transfers
targeted a new release directory; a remote `flock` and durable transaction remained
active through the public smoke decision; ordinary promotion used an atomic symlink
rename; and the one-time legacy directory migration used the host's Python 3 wrapper around Linux
`renameat2(RENAME_EXCHANGE)`. Route, asset, header, remote-command, signal, and
controller-disconnect failures restored both the prior live target and rollback pointer.
D-027 later superseded that mechanism for this low-volume local server because retained
release copies and rollback machinery were not worth the operational complexity.

The first D-027 deploy on 2026-07-18 successfully migrated `webai` from the active
release symlink to a real directory, synced the new build, passed exact-200 HTML and
hashed-JavaScript smoke checks with isolation headers, and removed all seven legacy
release directories. The controller then appeared to hang because it had duplicated
the coprocess input descriptor and waited for a remote lock reader that could not see
EOF. Terminating that already-finished lock holder released the command; the controller
now uses the original coprocess descriptors directly, and a full mocked-deploy test
guards successful lock release.

The final reviewed deploy passed on 2026-07-18. It atomically exchanged the original
real `webai` directory for the staged-release symlink, retained that original build as
`.webai-previous`, and left no helper, swap, or transaction residue. Built-in smoke
checks passed the home route, capabilities route, hashed JavaScript, and isolation
headers. Follow-up curl checks passed Home, About, Capabilities, the deployed
third-party notice, and a deliberate 404 while `/` remained without COOP/COEP. Live
Chrome 150 then reached a terminal 17-card/four-group capability report with page
isolation and `SharedArrayBuffer` available, loaded the About route and shadcn notice,
and reported no console, page, or failed-resource errors.

### D-024 dedicated-origin cutover result

Passed 2026-07-18 after rebuilding with Astro base `/`, promoting the release through
D-023, and correcting nginx header inheritance in the HTML regex:

- `/`, `/about/`, `/capabilities/`, root-relative hashed assets, the module worker,
  notices, and a deliberate 404 returned from `https://webai.meenan.dev/` with COOP
  `same-origin` and COEP `require-corp`. The built artifact contained no `/webai/`
  URLs. `https://www.meenan.dev/` remained unisolated.
- Live Chrome 150 reported page and worker isolation, exposed `SharedArrayBuffer`,
  completed the worker atomic sentinel, opened OPFS without writing, and reached a
  terminal 17-card/four-group capability report with no console, page, or failed-
  resource errors.
- Anonymous and dummy-Authorization browser fetches each passed for the HF API (200,
  CORS), small resolver file (200, CORS), and model range (206, CORS, exactly 16 bytes,
  `Content-Range: bytes 0-15/548105171`).
- The new release and `.webai-previous` targets resolved to valid release directories;
  no helper, swap, or durable transaction residue remained.

## Reopen triggers

Reopen D-024 if the dedicated vhost cannot preserve isolation across successful,
error, and cached responses; another independently controlled application must share
the subdomain; a required opener flow conflicts with COOP; a required resource fails
CORS/CORP from the new origin; or the filesystem target changes. Reopen D-027 if
deploy frequency or traffic makes its observable mixed-version window unacceptable,
or if automatic rollback becomes operationally valuable.
