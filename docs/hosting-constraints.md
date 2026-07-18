# Hosting constraints spike

**Status:** complete evidence snapshot, checked 2026-07-17 (America/New_York).
This is the M0 input for D-012 and the M1 deploy pipeline, not a substitute for
rechecking the live deployment after its first build.

## Outcome

- Keep the canonical URL at `https://meenan.dev/webai/`. The path maps directly to
  the existing static document root and no hosting, isolation, Hugging Face CORS, or
  service-worker constraint requires a dedicated origin.
- Serve WebAI with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. This makes
  `crossOriginIsolated === true`, enabling `SharedArrayBuffer` for multithreaded wasm
  and `performance.measureUserAgentSpecificMemory()` where the browser implements it.
- Do not use `COEP: credentialless`. WebAI's permitted cross-origin traffic is
  explicit CORS-mode `fetch()` to Hugging Face, and that path works under the stricter
  `require-corp` policy. Allowing accidental no-CORS subresources adds no product
  capability and would make D-005's network boundary harder to enforce.
- Explicitly accept that `/webai/` is not a browser storage or security boundary.
  Namespacing prevents accidental collisions, but every same-origin application can
  reach the same storage and contributes to the same quota.

The current platform contract is described by the
[HTML cross-origin isolation model](https://html.spec.whatwg.org/multipage/document-sequences.html#bcg-cross-origin-isolation)
and [COEP processing model](https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-embedder-policies).
CORS-mode fetches remain permitted under `require-corp`; they must pass their normal
CORS check ([COOP/COEP deployment guide](https://web.dev/articles/coop-coep)).

## Actual deploy target

Read-only inspection of the production host established the following rather than
assuming a generic static server:

- `meenan.dev` is served by nginx 1.30.2 on the SSH host alias `plex` from
  `/var/www/meenan.dev/`. The directory is writable by the deploy user; the nginx
  vhost is root-owned and needs an interactive admin/sudo step to change and reload.
- `/var/www/meenan.dev/webai/` does not exist yet. The intended deploy shape is an
  Astro static build rsynced to `plex:/var/www/meenan.dev/webai/`; M1 creates and
  versions the deploy command.
- The current vhost has regex locations for HTML and static extensions followed by a
  generic `try_files $uri $uri/ =404`. A plain `location /webai/` is insufficient:
  nginx would select the regex location for files such as `.html` and `.js`, losing
  headers defined only on the prefix. The WebAI prefix must use `^~`, or every
  competing location must repeat the headers. See nginx's
  [location selection rules](https://nginx.org/en/docs/http/ngx_http_core_module.html#location)
  and [`add_header` inheritance rules](https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header).

The minimum isolation block is:

```nginx
location ^~ /webai/ {
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    try_files $uri $uri/ =404;
}
```

`^~` deliberately bypasses the vhost's existing regex cache rules. The versioned M1
configuration may add WebAI-specific HTML and hashed-asset caching inside this block,
but it must preserve both headers on every document and relevant worker response,
including errors and offline/synthetic navigations. Emitting both headers on every
`/webai/` response is a simple safe implementation. The root placeholder must remain
unaffected.

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
it does **not** prove authenticated access to a gated model. A valid-token gated
browser test remains an M5 gate because no credential was available for this spike.

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

## Base path and shared-origin storage

Astro must build with base `/webai` and produce URLs rooted below `/webai/`; the
server maps those URLs directly to the rsync subtree. Route output must work with the
existing static `try_files` behavior—there is no server-side application fallback.

Browser storage keys do not contain a URL path. The
[Storage Standard](https://storage.spec.whatwg.org/#storage-keys),
[IndexedDB](https://w3c.github.io/IndexedDB/#database-construct), and
[OPFS](https://fs.spec.whatwg.org/#accessing-the-bucket-file-system) therefore make
these consequences explicit:

- OPFS, IndexedDB, Cache Storage, `localStorage`, quota estimates, and persistence are
  shared by all content at `https://meenan.dev`. Use a top-level `webai` OPFS
  directory plus `webai`-prefixed database/cache names and `localStorage` keys for
  collision hygiene; those names are not a security boundary.
- `navigator.storage.estimate()` is an origin-level, implementation-defined estimate,
  not WebAI-only accounting. WebAI's own manifest must provide per-model/runtime byte
  accounting. `persist()` applies to the origin's default bucket, can be denied, and
  does not remove quota failure or user-clearing cases.
- Any same-origin script can read or alter WebAI data. This includes locally stored HF
  tokens once that feature lands, so all content on the origin remains in one trust
  boundary. A future independently controlled or untrusted app belongs on another
  origin.
- Put the future service worker at `/webai/sw.js` with scope `/webai/` and do not emit
  a broader `Service-Worker-Allowed` header. This contains normal request handling to
  the product path, although the Service Worker specification correctly warns that
  [path restriction is not a hard security boundary](https://w3c.github.io/ServiceWorker/#path-restriction).
  Cache names remain origin-global, and a future root-scoped worker can interact with
  this path, so M10 must integration-test both registrations and preserve isolation
  headers in cached navigation responses.

## M1 deploy verification gate

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

## Reopen triggers

Move WebAI to a dedicated origin only if evidence shows one of these is material:
independently trusted or untrusted content must share `meenan.dev`; a root service
worker cannot coexist safely; aggregate origin quota/persistence/accounting is
unacceptable; required popup/opener behavior conflicts with COOP; or a required
cross-origin resource cannot satisfy `require-corp`. The owner's 2026-07-17 direction
confirms that a dedicated domain is available if a trigger occurs.
