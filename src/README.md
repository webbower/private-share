# Private Share

A small file-sharing app for Deno Deploy. Upload files, get a link, the link expires. Multi-tenant by domain,
magic-link sign-in for uploaders, optional PIN gate on shares.

Built to sit inside free tiers: Deno Deploy for compute and KV, Cloudflare R2 for blobs.

> **Setting this up for the first time? Read [SETUP.md](SETUP.md).** It covers the two external accounts you
> need (Cloudflare R2 and Resend), every credential, the bucket CORS policy that direct-to-storage uploads
> depend on, the lifecycle rules that actually delete files, and a verification checklist.

---

## The one architectural decision

**File bytes never pass through the app.**

Uploads go from the browser straight to R2 using presigned `PUT` URLs the server mints. Downloads are a `302`
to a short-lived presigned `GET`. The app only ever handles a few hundred bytes of JSON per share.

This matters because Deno Deploy's free tier allows 20 GiB of egress a month and caps an isolate at 512 MB.
Proxying downloads would exhaust the egress allowance in a few dozen shares and fight the memory ceiling on
any large file. Redirecting instead makes bandwidth a non-issue — R2 charges nothing for egress at all.

Two consequences follow, and most of the design below is downstream of them:

- The server can't measure an upload as it happens, so it verifies afterwards (`HEAD` on every object) before
  writing a share record.
- The collection zip is built in the browser, not on the server. Zipping server-side would mean pulling every
  file _back down_ into the isolate.

---

## Expiry runs without a cron job

Two independent mechanisms fire at the same moment, and neither needs this app to be running:

**Metadata** — the share record is written to Deno KV with `expireIn` set to the retention window. KV deletes
it.

**Blobs** — the object key leads with the retention window:

```
d14/t1/kx8s0mqf9d2wnvb4/9fj2ka-survey.pdf
│   │  │                └── file id + sanitised filename
│   │  └── share id (cuid2)
│   └── tenant prefix
└── retention window
```

An R2 lifecycle rule per window deletes the object. Retention comes first because lifecycle prefixes are
anchored at the start of the key: five rules then cover every tenant, however many you add. Tenant-first would
need five rules _per tenant_, and one forgotten rule means files that silently never expire.

The rules are version-controlled at `infra/r2-lifecycle.json`; [SETUP.md](SETUP.md) covers applying them,
along with the bucket CORS policy that browser uploads require.

The only thing lifecycle rules can't see is an _abandoned_ upload — objects that landed but whose share record
was never written, because a tab closed between the `PUT` and the completion `POST`. Those still sit under a
retention prefix, so R2 removes them on schedule anyway; `src/jobs/sweep.js` runs daily to shorten that window
and tidy the pending namespace.

---

## Multi-tenancy

A tenant is a domain. Tenancy is _structural_, not a permission check: the tenant id is the second element of
every KV key and the first segment of every object key.

```js
keys.share(tenantId, shareId); // ["share", "t1", "kx8s0..."]
```

There is no code path that reads another domain's share, because the tenant is part of the lookup rather than
a field compared afterwards. A share id from `files.example.org` simply does not resolve on
`share.example.com`. An unrecognised `Host` gets a flat 404 — the app doesn't confirm it's listening there.

---

## The uploader allowlist never reaches the browser

Uploading is the only privileged action, and who may do it is a deploy-time decision reviewed in a pull
request, not runtime state. The list lives in `src/config/tenants.server.js`, hard-coded per environment.

Three things keep it server-side:

1. **Naming.** The `.server.js` suffix is load-bearing.
2. **The build refuses it.** `scripts/build.js` installs an esbuild plugin that errors on resolving any
   `*.server.js` module, naming the importer.
3. **The output is inspected.** `tests/build/no_email_leak.test.js` runs a real build and greps the finished
   artifacts for every address in every environment's registry — plus the local part and domain separately, to
   catch a bundler that split the string.

Check 3 exists because a bundler config can be correct while the output is still wrong, and this mistake is
silent and permanent: once a bundle ships with those addresses in it, they are public.

```bash
deno task test:leak                 # build, verify, delete the artifact
KEEP_BUILD=1 deno task test:leak    # build, verify, keep it for the deploy
```

Use the first form in PR checks. Use the second as a deploy preflight, so you ship exactly the bytes that were
verified rather than rebuilding afterwards and shipping something else.

To add an uploader: add the address to the right `allowedEmails` array, open a PR, let the suite prove it
didn't leak, deploy.

---

## The PIN

The PIN is an anti-scraper measure, not a password, and the interface says so. Its job is to stop link-preview
crawlers and mail scanners from fetching a share the moment its URL is posted somewhere public. A crawler sees
a form and no content; it doesn't fill in forms.

Six digits is a small space, so the rate limiter is what actually protects a share: eight attempts per share,
then a fifteen-minute lockout, counted in KV with a TTL. The PBKDF2 hash only ensures a leaked metadata dump
isn't a list of live PINs.

The PIN is generated at completion, shown once, and never stored in the clear. There is a test asserting that
the plaintext appears nowhere in KV.

---

## Deletion

The delete URL is the share URL plus `/delete`, as specified. **This means anyone holding the share link can
also destroy the share.** When a PIN is set, deletion requires it. If you'd rather the delete URL be
unguessable, add a random token to the share record and require it as a query parameter — it's a few lines in
`src/app.js` and `src/services/shares.js`.

There is no management screen. Once the slip is shown, a share can only be viewed or deleted, through those
two URLs.

---

## Running it

```bash
cp .env.example .env     # values come from SETUP.md sections 2, 3 and 5
deno install
deno task build          # writes static/dist
deno task dev            # http://localhost:8000
```

`deno.json` maps `localhost:8000` to a development tenant, so the app resolves a tenant locally without any
DNS work. For local uploads to reach R2, add `http://localhost:8000` to the bucket's CORS origins.

### Tests

```bash
deno task test           # everything
deno task test:unit      # no build, no filesystem writes
deno task preflight      # everything, keeping the verified build artifact
```

### Deploying

Full walkthrough in [SETUP.md](SETUP.md). In short: create the app at
[console.deno.com](https://console.deno.com) with build command `deno task build` and entry point
`src/main.js`, set the environment variables, add your custom domains, and make sure the R2 bucket has both a
CORS policy and lifecycle rules.

Deno Deploy Classic was shut down in July 2026; make sure you're on the current platform.

---

## Layout

```
src/
  config/
    limits.js           shared with the browser — nothing secret
    tenants.server.js   SERVER ONLY: domains, allowlists, per-tenant limits
    env.js              APP_ENV resolution and runtime settings
  models/               built on Model.extend (Model.js is unmodified)
  io/                   one wrapper per external dependency
    doubles/            a test double for each
  services/             auth, shares, pin — pure logic over the container
  lib/                  crypto and SigV4; pure functions, no IO
  views/                Eta templates
  jobs/sweep.js         daily orphan sweep
  app.js                Hono routes
  deps.js               the only module that branches on APP_ENV
  deps-{test,development,production}.js   per-env client wiring, loaded on demand
  main.js               entry point; registers Deno.cron
client/upload.js        browser bundle: drag-and-drop, direct PUTs, zip
static/css/app.css      one stylesheet
scripts/build.js        esbuild bundle + the server-module guard
infra/                  R2 CORS and lifecycle configuration (see SETUP.md)
```

### Testing approach

Every external dependency sits behind a wrapper with a matching double, and `src/deps.js` is the only place
that chooses between them — dispatching to `deps-test.js`, `deps-development.js` or `deps-production.js` with a
dynamic `import()` so only the running environment's wiring is loaded. Nothing else branches on `APP_ENV`, so
services can't tell whether they're talking to R2 or to a `Map`.

`MemoryKvClient` implements real TTL semantics against an injected clock, so expiry tests advance time rather
than sleeping, and the suite needs no `--unstable-kv` flag. `FakeHttpClient` throws on any unstubbed call, so
a test that forgets a stub fails loudly instead of quietly reaching the network.

View tests render templates to strings and assert against parsed DOM with `node-html-parser`. Because they
describe what the HTML _is_ rather than snapshotting it, they survived swapping the entire template engine
(EJS → Eta) without a single edit.

`src/lib/sigv4.js` is verified against the published AWS reference vector, so the signing is provably correct
rather than hopefully correct.
