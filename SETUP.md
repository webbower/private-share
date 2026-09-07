# Setting up Private Share

Everything needed to get from an empty repository to a running deployment.

If you only want the short version: you need **two** external accounts besides Deno Deploy — Cloudflare (for
R2 object storage) and an email provider (Resend by default) — plus a domain you control. All three have free
tiers that cover this app comfortably.

---

## 1. What you need to sign up for

| Service                                           | What it does here                                                   | Free tier                                                         | Card needed |
| ------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------- |
| [Cloudflare](https://dash.cloudflare.com/sign-up) | R2 object storage: holds the actual files, expires them on schedule | 10 GB storage, 1M writes/mo, 10M reads/mo, **egress always free** | Yes, for R2 |
| [Resend](https://resend.com/signup)               | Sends the magic-link sign-in emails                                 | 3,000/month, capped at 100/day, one verified domain               | No          |
| A domain registrar                                | The domain(s) you serve from, and the domain you send email from    | —                                                                 | —           |
| [Deno Deploy](https://console.deno.com)           | Runs the app, and provides Deno KV for metadata                     | 1M requests, 20 GiB egress, 1 GiB KV, 10 apps                     | No          |

Deno KV is **not** a separate signup — it comes with Deno Deploy and needs no configuration beyond the app
running there.

### Notes on the free tiers

R2 requires a payment card even for the free allowance. Egress being free is the reason this app is cheap to
run: every download is served by R2, not by your app, so the 20 GiB Deno Deploy egress allowance is
essentially untouched.

Resend's binding constraint is **100 emails per day**, not the monthly 3,000. For this app one email equals
one sign-in, and sessions last 30 days, so a handful of uploaders will never come close. Free also allows
**one verified sending domain** — see the multi-tenant note in section 3 if you plan to serve several domains.

### Substituting providers

Nothing is locked in. Storage needs an S3-compatible API — Backblaze B2, Wasabi, MinIO and AWS S3 all work by
changing `R2_ENDPOINT`, though only R2 gives you free egress. Email needs any JSON HTTP API; Postmark, Brevo
and SES fit in about ten lines in `src/io/MailClient.js`. Avoid SMTP-only providers, since Deno Deploy
restricts raw outbound TCP.

---

## 2. Cloudflare R2

### 2.1 Create the bucket

1. In the Cloudflare dashboard, go to **R2 Object Storage** and enable it.
2. **Create bucket**. Name it `private-share`. Location: Automatic.
3. Leave public access **disabled**. Every download goes through a presigned URL your app mints; the bucket
   must never be publicly readable.

### 2.2 Create an API token

1. **R2 → API → Manage API Tokens → Create API Token**.
2. Permission: **Object Read & Write**.
3. Scope it to the `private-share` bucket specifically, not all buckets.
4. TTL: forever, or set a reminder to rotate.

You get three values, shown once:

| Shown as                                                      | Environment variable   |
| ------------------------------------------------------------- | ---------------------- |
| Access Key ID                                                 | `R2_ACCESS_KEY_ID`     |
| Secret Access Key                                             | `R2_SECRET_ACCESS_KEY` |
| Account ID (top right of the R2 page, or in the endpoint URL) | `R2_ACCOUNT_ID`        |

`R2_ENDPOINT` defaults to `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, so you can usually leave it
blank. `R2_REGION` is always `auto` for R2.

### 2.3 CORS — required, and the most common thing to get wrong

The browser uploads **directly to R2**, cross-origin, using a presigned `PUT`. Without a bucket CORS policy
the browser's preflight fails and every upload dies with a 403 before a single byte moves. Nothing in the app
can work around this; it is bucket configuration.

The policy is version-controlled at [`infra/r2-cors.json`](infra/r2-cors.json). **Edit `AllowedOrigins` to
list your real domains** — every domain in the `production` block of `src/config/tenants.server.js`, plus
`http://localhost:8000` if you want uploads to work in local development.

Apply it either way:

**Dashboard:** R2 → your bucket → **Settings → CORS Policy → Edit**, and paste the JSON.

**AWS CLI** (`aws configure` first, using the R2 keys above and region `auto`):

```bash
aws s3api put-bucket-cors \
  --bucket private-share \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com \
  --cors-configuration file://infra/r2-cors.json
```

Verify it took:

```bash
aws s3api get-bucket-cors --bucket private-share \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
```

Two details that cause silent failures:

- `AllowedHeaders` must list `content-type` explicitly. R2 has historically not honoured `"*"` here the way
  AWS S3 does.
- `AllowedOrigins` entries must match the browser's origin **exactly**, including scheme and port.
  `https://share.example.com` does not cover `https://www.share.example.com`.

You do **not** need `content-length` in `AllowedHeaders`. The app signs it so R2 enforces the exact upload
size, but browsers set that header themselves and never list it in a preflight.

### 2.4 Lifecycle rules — this is what actually deletes files

Deno KV expires the share _record_; R2 lifecycle rules expire the _file_. Without these rules, uploads become
unreachable on schedule but sit in your bucket forever, quietly consuming the free allowance.

Object keys are laid out retention-first precisely so this needs five rules total, regardless of how many
tenants you add:

```
d7/t1/kx8s0mqf9d2wnvb4/9fj2ka-survey.pdf
│  │  │                └── file id + sanitised filename
│  │  └── share id (cuid2)
│  └── tenant prefix
└── retention window
```

The rules are at [`infra/r2-lifecycle.json`](infra/r2-lifecycle.json):

| Rule             | Prefix | Delete after |
| ---------------- | ------ | ------------ |
| `expire-1-day`   | `d1/`  | 1 day        |
| `expire-3-days`  | `d3/`  | 3 days       |
| `expire-7-days`  | `d7/`  | 7 days       |
| `expire-14-days` | `d14/` | 14 days      |
| `expire-30-days` | `d30/` | 30 days      |

Apply via **R2 → your bucket → Settings → Object lifecycle rules → Add rule**, one per row, or:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket private-share \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com \
  --lifecycle-configuration file://infra/r2-lifecycle.json
```

The file also includes a rule aborting incomplete multipart uploads after a day, which is good hygiene and
costs nothing.

If you ever add a retention option to `EXPIRY_OPTIONS` in `src/config/limits.js`, **add the matching lifecycle
rule at the same time.** A new prefix with no rule means files that never expire. There is nothing in the test
suite that can catch this, because it is remote configuration.

---

## 3. Resend (email)

Magic-link sign-in is the only email this app sends.

### 3.1 Verify a sending domain

You cannot send to arbitrary addresses from an unverified domain. Resend's `onboarding@resend.dev` sandbox
address only delivers to the address that owns the Resend account, which is enough to test but not to add a
second uploader.

1. **Domains → Add Domain**, e.g. `example.com`, or a subdomain such as `mail.example.com` to keep the DNS
   tidy.
2. Resend gives you DNS records to add at your registrar: a **DKIM** `TXT` record, an **SPF** `TXT` record,
   and usually a `MX` record for the return path. Add all of them.
3. Wait for verification (minutes to an hour) and confirm the domain shows as **Verified**.

Skipping this is the usual reason magic links go to spam or vanish.

### 3.2 Create an API key

**API Keys → Create API Key**, permission **Sending access**. Shown once.

| Value                           | Environment variable |
| ------------------------------- | -------------------- |
| API key (`re_…`)                | `RESEND_API_KEY`     |
| Sender, on your verified domain | `MAIL_FROM`          |

`MAIL_FROM` takes a display name: `Private Share <no-reply@example.com>`. The address must be on the verified
domain. `MAIL_ENDPOINT` stays `https://api.resend.com/emails` unless you swap providers.

### 3.3 Multi-tenant note

`MAIL_FROM` is currently a single global value, and Resend's free tier allows one verified domain anyway, so
all tenants send from the same address. That is usually fine — the email body names the tenant.

If you want per-tenant senders, add a `mailFrom` field to the `Tenant` model in
`src/config/tenants.server.js`, pass it through `AuthService.requestLink`, and have `MailClient.send` accept a
`from` override. It is a small change, but note it needs a paid Resend plan for the second verified domain.

---

## 4. Domains and DNS

### 4.1 Serving domains

Every domain you serve from must appear in **both** places or the app returns a flat 404:

1. The `production` array in `src/config/tenants.server.js`.
2. Deno Deploy's custom domain settings for the app.

Add the domain in Deno Deploy, follow its DNS instructions (usually a `CNAME`, or an `A`/`AAAA` for an apex),
and let it provision the TLS certificate.

Tenancy is resolved from the `Host` header, so `share.example.com` and `files.example.org` are fully separate:
a share created on one is invisible on the other, and an unlisted host sees nothing at all.

### 4.2 A caveat on R2 custom domains

Do **not** put a custom domain in front of the R2 bucket and point `R2_ENDPOINT` at it. Presigned URLs only
work against the S3 API domain (`<account>.r2.cloudflarestorage.com`). A custom domain on the bucket would
also make objects publicly readable, which defeats the PIN and expiry entirely.

---

## 5. Application configuration

### 5.1 Generate `APP_SECRET`

This signs session and PIN cookies. Rotating it logs everyone out and invalidates outstanding PIN unlocks,
which is a reasonable emergency lever.

```bash
deno eval "console.log(crypto.randomUUID() + crypto.randomUUID())"
```

### 5.2 Set the uploader allowlist

Open `src/config/tenants.server.js` and edit the `production` block: real domains, real addresses in
`allowedEmails`, and per-tenant size limits.

This file is the only place uploader identity lives, and it is server-only. The build refuses to bundle any
`*.server.js` module, and `deno task test` greps the finished browser bundle for every address in it. Adding
an uploader is a pull request, not a runtime action.

### 5.3 Full environment variable list

Copy `.env.example` to `.env` for local work. On Deno Deploy set these in the app's environment variable
settings — never commit `.env`.

| Variable               | Required | Notes                                  |
| ---------------------- | -------- | -------------------------------------- |
| `APP_ENV`              | yes      | `development`, `test`, or `production` |
| `APP_SECRET`           | yes      | 32+ random chars; signs cookies        |
| `R2_ACCOUNT_ID`        | yes      | Cloudflare account id                  |
| `R2_BUCKET`            | yes      | `private-share`                        |
| `R2_ACCESS_KEY_ID`     | yes      | R2 API token                           |
| `R2_SECRET_ACCESS_KEY` | yes      | R2 API token                           |
| `R2_ENDPOINT`          | no       | Defaults from `R2_ACCOUNT_ID`          |
| `R2_REGION`            | no       | `auto`                                 |
| `RESEND_API_KEY`       | yes      | Resend sending key                     |
| `MAIL_FROM`            | yes      | Must be on the verified domain         |
| `MAIL_ENDPOINT`        | no       | `https://api.resend.com/emails`        |
| `LOG_LEVEL`            | no       | `silent`/`error`/`warn`/`info`/`debug` |

The app validates all required variables at boot via `assertConfigured` and refuses to start with a list of
what is missing, rather than failing at the first upload.

---

## 6. Running locally

```bash
cp .env.example .env      # fill in the values from sections 2, 3 and 5
deno install
deno task build           # writes static/dist
deno task dev             # http://localhost:8000
```

`deno.json` maps `localhost:8000` to a development tenant, so no DNS work is needed to sign in locally. Put
your own address in the `development` block's `allowedEmails` so you can actually receive a link.

For local uploads to reach R2 you need `http://localhost:8000` in the bucket's CORS `AllowedOrigins` (section
2.3).

The whole test suite runs with no credentials and no network — every external dependency has a test double:

```bash
deno task test            # 125 tests
deno task test:unit       # no build step, fastest loop
```

---

## 7. Deploying

1. Push the repository to GitHub.
2. At [console.deno.com](https://console.deno.com), **New App**, select the repo.
3. Configure the build:
   - Install: `deno install`
   - Build: `deno task build`
   - Entry point: `src/main.js`
4. Add every environment variable from section 5.3, with `APP_ENV=production`.
5. Add your custom domains (section 4.1).
6. Deploy.

Deno Deploy Classic was shut down in July 2026 — make sure you are on the current platform, at
`console.deno.com`.

### Pre-deploy verification

Run this in CI before shipping:

```bash
KEEP_BUILD=1 deno task preflight
```

It runs everything, including a real frontend build that is grepped for every allowlisted address, and
**keeps** the verified artifact in `static/dist` so you deploy exactly the bytes that were checked rather than
rebuilding afterwards. Use the plain `deno task test` in PR checks, where the artifact is throwaway.

### The daily cron

`src/main.js` registers a `Deno.cron` job that sweeps abandoned uploads. Deno Deploy discovers it by
evaluating the module's top level at deploy time; it needs no configuration, but it only registers when
`APP_ENV=production`.

---

## 8. Verifying a live deployment

Work through these in order — each failure has a distinct cause.

1. **Visit the domain.** You should be redirected to `/auth/sign-in`. A 404 here means the `Host` is not in
   `tenants.server.js`.
2. **Request a sign-in link** with an allowlisted address. It should arrive within a minute. Nothing arriving
   means the Resend domain is unverified, the API key is wrong, or the address is not on the allowlist — the
   page looks identical in all three cases, by design.
3. **Upload one small file.** Watch the network tab: you should see a `POST` to `/api/uploads`, then a `PUT`
   straight to `r2.cloudflarestorage.com`. A CORS error here means section 2.3 is not done.
4. **Open the share link** in a private window. The file should download from an `r2.cloudflarestorage.com`
   redirect, not from your domain.
5. **Upload with a PIN**, and confirm the PIN gate appears before any filename is visible.
6. **Upload two files with the collection box ticked**, and confirm the folder listing and the "Download all"
   zip.
7. **Use the delete link** and confirm the share 404s afterwards.
8. **Check the bucket** in the Cloudflare dashboard and confirm keys look like `d7/<tenant>/<shareId>/<file>`.
9. **Confirm lifecycle rules are listed** on the bucket. This is the step most easily forgotten, and its
   failure is invisible for a week.

---

## 9. Troubleshooting

**CORS error on upload, or a 403 on the `PUT` to R2.** Section 2.3. Check the origin matches exactly, and that
`content-type` is in `AllowedHeaders`.

**`SignatureDoesNotMatch` on upload.** The browser sent a different `Content-Type` than the one signed, or a
proxy altered the request. The app signs `content-type` and `content-length`; both must arrive unchanged.

**Files never disappear.** Lifecycle rules are missing or their prefixes do not match. Confirm keys begin with
`d1/`, `d3/`, `d7/`, `d14/` or `d30/`.

**Shares 404 immediately after upload.** Usually a clock or TTL issue in KV, or the share is being opened on a
different tenant domain than it was created on.

**Sign-in emails never arrive.** Verify the Resend domain, confirm `MAIL_FROM` is on it, and check the Resend
logs. Remember the 100/day free cap.

**404 on every route including `/`.** The `Host` header does not match any tenant. Check `tenants.server.js`
against the domain in the address bar, including `www.` and port.

**Build fails with "Server-only module cannot be bundled".** Working as intended: something under `client/`
imported a `*.server.js` module. The error names the importer.
