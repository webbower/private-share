# Upload-summary download

After an upload finishes, the completion screen offers a **"Save a copy of these
details (.txt)"** button next to "Upload something else". It downloads a plain
`.txt` file recording the share link(s), delete link(s), PIN (when set), expiry,
and the file names — something the uploader can keep on disk and refer back to
when they hand the links out later.

The three example files in this folder are the exact body content for each case:

| File | Case |
|------|------|
| [`example-1-single-file.txt`](example-1-single-file.txt) | one file |
| [`example-2-multi-file.txt`](example-2-multi-file.txt) | several files, **Collection off** (one independent share per file) |
| [`example-3-collection.txt`](example-3-collection.txt) | several files, **Collection on** (one share) |

They are built from the `items` array the `/upload/complete` handler already
has — per share: `id`, `title`, `kind`, `hasPin`, `hasZip`, `fileCount`,
`displayTotalSize`, `createdAt`, `expiresAt`, `expiryDays`, `files[]` (`title`,
`filename`, `displaySize`), plus `shareUrl`, `deleteUrl`, and the plaintext
`pin`.

> When this is implemented, the generator should carry a comment pointing back
> here (`docs/upload-summary/`).

## Format

Plain text with light structure only: `#` / `##` / `###` headings, `-` bullets,
`1.` numbered lists, `---` dividers. **No** `**bold**`, **no** `` `backticks` ``.
In-sentence dashes are a plain hyphen (` - `), not an em dash.

## Saved file name

| Case | Pattern |
|------|---------|
| single / multi-file (no collection) | `{domain} Upload at {stamp}.txt` |
| collection | `{collectionTitle} Uploaded to {domain} at {stamp}.txt` |

- `{domain}` — `tenant.domain` (e.g. `share.bower.family`).
- `{collectionTitle}` — the "Collection name" the uploader typed, run through the
  app's existing `sanitizeFilename` (strip `/ \ : * ? " < > |`, collapse
  whitespace, cap length).
- `{stamp}` in the **file name** — `createdAt` as `MMM D, YYYY hhmmam/pm`,
  e.g. `Sep 7, 2026 0513pm`. Zero-padded 12-hour, lowercase meridiem, **no
  colon** (browsers rewrite `:` in download names) and no separator.

Worked examples:

- `share.bower.family Upload at Sep 7, 2026 0513pm.txt`
- `North Elevations Uploaded to share.bower.family at Sep 7, 2026 0513pm.txt`

## Timestamps in the body

`{stamp}` in headings and field values is the readable form: `MMM D, YYYY h:mmam/pm`
→ `Sep 7, 2026 5:13pm` (no zero-pad, real colon).

Both forms come from `createdAt` / `expiresAt` and are formatted in the
**uploader's local time zone** — the file is a personal reference. The browser
sends its IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) as a
hidden `tz` field on the `/upload/complete` POST; the route validates it and
passes it to `buildUploadSummary`. If it is missing or unrecognised, the
formatters fall back to the runtime's local zone (UTC on Deno Deploy). No zone
label is printed. Helpers live in `src/lib/dates.js` — `formatStamp`,
`formatStampForFilename`, `formatDateStamp` — each taking a `timeZone` argument,
separate from `src/render.js`'s `formatDate` / `relativeExpiry`, which the HTML
views keep using.

The worked examples in this folder are rendered as **US Eastern** (`5:13pm EDT`
for the sample instant).

## Body structure (all cases)

1. `# {H1}` — the saved file-name stem, but with the readable timestamp.
2. One summary line (file count / collection / expiry **date**).
3. `## Sharing this safely` — the five bullets from `SHARING_TIPS` in
   `src/render.js` (the same array the completion screen renders), em dash
   flattened to ` - `. Always all five.
4. `---`
5. One or more share blocks.

### Share block

```
## {heading}
Saved as {filename}                       <- only if {heading} != filename

- Share link: {shareUrl}
- Delete link: {deleteUrl}
- PIN: {pin}                              <- only when the upload has a PIN
- Uploaded: {stamp}
- Expires: {stamp} (N days after upload)
- Size: {displaySize}
```

`{displaySize}` is the file model's `displaySize` verbatim, so it follows
`formatBytes`: e.g. a 4 KB file reads `4.0 KB`, a 512 KB file reads `512 KB`.

- **Single file** — one block. `{heading}` = the file's display title.
- **Multi-file, no collection** — the block repeats once per file, in upload
  order. `{heading}` = each file's display title. PINs are **distinct** per
  file. `Size:` per block.
- **Collection** — one block. `{heading}` = the collection title,
  `Total size:` instead of `Size:`, followed by:

  ```
  ### Files in this collection

  1. {display title} ({filename}) - {displaySize}    <- "(filename)" only when it differs
  2. {filename} - {displaySize}
  ```

### Conditionals

- **PIN** is all-or-nothing per upload (the UI sets the choice once). So the
  `PIN:` line is either on every block in the file or on none — never a mix.
  When off, the line is simply absent.
- **`Saved as` / `(filename)`** appears only when a file's display title differs
  from its stored name.
- The summary line and per-block `Expires:` use the same expiry for every block
  today (one expiry choice per upload), but are rendered per block so they stay
  correct if that ever changes.

## Delivery

All the data is already in the completion template, so the simplest path is a
`data:text/plain;charset=utf-8,...` URL on an `<a download="{name}.txt">`
styled as a button — no new route, and nothing to persist (the pending record
is gone by the time this screen renders).
