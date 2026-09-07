/**
 * The upload lifecycle.
 *
 * Uploads are two-phase, because file bytes go browser -> R2 directly and never
 * touch this app:
 *
 *   1. `beginUpload` validates the request, mints ids, and returns presigned
 *      PUT URLs. Nothing is stored under the share key yet, only a short-lived
 *      "pending" record.
 *   2. The browser PUTs each file (and, for a collection, a zip it builds
 *      locally with fflate).
 *   3. `completeUpload` HEADs every object to confirm it arrived at the declared
 *      size, and only then writes the share record.
 *
 * A share that fails step 3 leaves orphaned objects rather than a broken link,
 * and orphans are swept by the weekly cron in `src/jobs/sweep.js`.
 */

import {
	DEFAULT_EXPIRY_DAYS,
	isAllowedExpiry,
	PENDING_TTL_SECONDS,
	prefixForDays,
	PRESIGN_DOWNLOAD_TTL_SECONDS,
	PRESIGN_UPLOAD_TTL_SECONDS,
	ZIP_FILENAME,
} from "~/config/limits.js";
import { Share, SHARE_KIND } from "~/models/Share.js";
import { sanitizeFilename, StoredFile } from "~/models/StoredFile.js";
import { keys } from "~/lib/keys.js";
import { createPin } from "./pin.js";

export class UploadError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = "UploadError";
		this.code = code;
		this.details = details;
	}
}

const DAY_MS = 86400000;

export const ShareService = ({ kv, files, ids, clock, logger }) => {
	const log = logger?.scoped("shares");

	/**
	 * Object keys lead with the retention window, then the tenant:
	 *
	 *     d7/t1/kx8s0mqf9d2wnvb4/9fj2ka-survey.pdf
	 *
	 * R2 lifecycle rule prefixes are anchored at the start of the key, so the
	 * retention segment has to come first: five rules (`d1/`..`d30/`) then cover
	 * every tenant, however many there are. Tenant-first would mean five rules
	 * *per tenant*, and one forgotten rule is files that silently never expire.
	 *
	 * Tenant isolation does not rest on this ordering — it is enforced by the KV
	 * key and re-checked on read. The segment is here for legibility when
	 * looking at the bucket.
	 */
	const objectKey = (tenant, days, shareId, name) =>
		`${prefixForDays(days)}/${tenant.bucketPrefix}/${shareId}/${name}`;

	const validate = ({ tenant, requested, expiryDays }) => {
		if (!Array.isArray(requested) || requested.length === 0) {
			throw new UploadError("no_files", "Choose at least one file to upload.");
		}
		if (requested.length > tenant.maxFilesPerUpload) {
			throw new UploadError(
				"too_many_files",
				`Up to ${tenant.maxFilesPerUpload} files at a time.`,
				{ limit: tenant.maxFilesPerUpload },
			);
		}
		if (!isAllowedExpiry(expiryDays)) {
			throw new UploadError("bad_expiry", "Choose one of the listed expiry options.");
		}

		let total = 0;
		for (const file of requested) {
			const size = Number(file?.size);
			if (!Number.isFinite(size) || size <= 0) {
				throw new UploadError("bad_size", `"${file?.name ?? "file"}" has no readable size.`);
			}
			if (size > tenant.maxFileBytes) {
				throw new UploadError("file_too_large", `"${file.name}" is over the size limit.`, {
					limit: tenant.maxFileBytes,
					size,
				});
			}
			total += size;
		}
		if (total > tenant.maxCollectionBytes) {
			throw new UploadError("upload_too_large", "That is more than one upload can hold.", {
				limit: tenant.maxCollectionBytes,
				size: total,
			});
		}
		return total;
	};

	return Object.freeze({
		/** Phase 1: validate, mint ids, hand back presigned PUT URLs. */
		async beginUpload({ tenant, session, files: requested, asCollection, collectionTitle, expiryDays }) {
			const days = Number(expiryDays) || DEFAULT_EXPIRY_DAYS;
			validate({ tenant, requested, expiryDays: days });

			const isCollection = Boolean(asCollection) && requested.length > 1;
			const shareId = ids.shareId();

			const planned = requested.map((file) => {
				const filename = sanitizeFilename(file.name);
				const fileId = ids.fileId();
				return {
					id: fileId,
					filename,
					title: String(file.title ?? "").trim() || filename,
					size: Number(file.size),
					contentType: file.type || "application/octet-stream",
					objectKey: objectKey(tenant, days, shareId, `${fileId}-${filename}`),
				};
			});

			const uploads = await Promise.all(
				planned.map(async (file) => ({
					fileId: file.id,
					filename: file.filename,
					...(await files.presignUpload(file.objectKey, {
						contentLength: file.size,
						contentType: file.contentType,
						expiresIn: PRESIGN_UPLOAD_TTL_SECONDS,
					})),
				})),
			);

			const pending = {
				shareId,
				tenantId: tenant.id,
				kind: isCollection ? SHARE_KIND.COLLECTION : SHARE_KIND.FILE,
				title: isCollection ? String(collectionTitle ?? "").trim() : "",
				files: planned,
				zipKey: isCollection ? objectKey(tenant, days, shareId, ZIP_FILENAME) : null,
				expiryDays: days,
				ownerEmail: session.email,
				createdAt: clock.now(),
			};

			await kv.set(keys.pending(tenant.id, shareId), pending, {
				expireIn: PENDING_TTL_SECONDS * 1000,
			});

			log?.info("upload started", {
				tenant: tenant.id,
				shareId,
				fileCount: planned.length,
				isCollection,
			});

			return {
				shareId,
				isCollection,
				uploads,
				zipUpload: isCollection
					? await files.presignUpload(pending.zipKey, {
						contentLength: null,
						contentType: "application/zip",
						expiresIn: PRESIGN_UPLOAD_TTL_SECONDS,
					})
					: null,
			};
		},

		/**
		 * Phase 2: verify every object landed, then write the share record(s).
		 *
		 * One upload produces one *pending* record but not necessarily one share:
		 *
		 *   - a collection, or a single file -> one share, addressed by the same
		 *     id the pending record used;
		 *   - several files with the collection box left unchecked -> one
		 *     independent single-file share per file, each with its own id, link,
		 *     delete URL and (if asked for) PIN. The objects still sit under the
		 *     original upload's key prefix, so deleting the last of them clears
		 *     the folder.
		 *
		 * The return is always `{ shares: [...], pins: [...] }` (aligned by
		 * index), plus `share` / `pin` as a convenience for the common
		 * single-share case. PINs are plaintext and returned exactly once.
		 */
		async completeUpload({ tenant, session, shareId, withPin, zipSize }) {
			const pending = await kv.get(keys.pending(tenant.id, shareId));
			if (!pending) throw new UploadError("expired", "This upload took too long. Start again.");
			if (pending.ownerEmail !== session.email) {
				throw new UploadError("not_owner", "That upload belongs to a different account.");
			}

			for (const file of pending.files) {
				const head = await files.head(file.objectKey);
				if (!head.exists) {
					throw new UploadError("missing_object", `"${file.filename}" did not finish uploading.`);
				}
				if (head.size !== file.size) {
					// The signed content-length should make this impossible; treat it
					// as tampering and refuse rather than publishing an unknown blob.
					await files.delete(file.objectKey);
					throw new UploadError("size_mismatch", `"${file.filename}" did not upload correctly.`);
				}
			}

			const isCollection = pending.kind === SHARE_KIND.COLLECTION;
			const now = clock.now();
			const ttlMs = pending.expiryDays * DAY_MS;

			const persist = async (share) => {
				await kv.set(keys.share(tenant.id, share.id), share.toJSON(), { expireIn: ttlMs });
				return share;
			};
			const mintPin = () => (withPin ? createPin({ ids }) : Promise.resolve(null));

			let shares;
			let pins;

			if (!isCollection && pending.files.length > 1) {
				// Ungrouped multi-file upload: fan out into one share per file.
				shares = [];
				pins = [];
				for (const file of pending.files) {
					const pin = await mintPin();
					shares.push(
						await persist(Share({
							id: ids.shareId(),
							tenantId: tenant.id,
							kind: SHARE_KIND.FILE,
							title: file.title,
							files: [StoredFile(file)],
							pinHash: pin?.hash ?? null,
							pinSalt: pin?.salt ?? null,
							createdAt: now,
							expiresAt: now + ttlMs,
							expiryDays: pending.expiryDays,
							ownerEmail: pending.ownerEmail,
						})),
					);
					pins.push(pin?.pin ?? null);
				}
			} else {
				let zipKey = null;
				let confirmedZipSize = 0;
				if (isCollection && pending.zipKey) {
					const head = await files.head(pending.zipKey);
					// The zip is signed without a content-length, so bound it here: a
					// zip of these files cannot legitimately exceed their combined size
					// by more than container overhead.
					const ceiling = pending.files.reduce((n, f) => n + f.size, 0) + 1024 * 1024;
					if (head.exists && head.size > ceiling) {
						await files.delete(pending.zipKey);
						log?.warn("collection zip over expected size, discarded", { shareId, size: head.size });
					} else if (head.exists) {
						zipKey = pending.zipKey;
						confirmedZipSize = head.size || Number(zipSize) || 0;
					} else {
						// A missing zip is survivable: the collection still lists every
						// file individually, only "Download all" disappears.
						log?.warn("collection zip missing", { shareId });
					}
				}

				const pin = await mintPin();
				const share = await persist(Share({
					id: shareId,
					tenantId: tenant.id,
					kind: pending.kind,
					title: pending.title,
					files: pending.files.map(StoredFile),
					zipKey,
					zipSize: confirmedZipSize,
					pinHash: pin?.hash ?? null,
					pinSalt: pin?.salt ?? null,
					createdAt: now,
					expiresAt: now + ttlMs,
					expiryDays: pending.expiryDays,
					ownerEmail: pending.ownerEmail,
				}));
				shares = [share];
				pins = [pin?.pin ?? null];
			}

			await kv.delete(keys.pending(tenant.id, shareId));

			log?.info("upload completed", {
				tenant: tenant.id,
				shareId,
				shares: shares.length,
				hasPin: pins.some(Boolean),
			});

			return { shares, pins, share: shares[0], pin: pins[0] ?? null };
		},

		/**
		 * Look up a share. The tenant is part of the key, so a share id from
		 * another domain simply is not found here.
		 */
		async find({ tenant, shareId }) {
			const stored = await kv.get(keys.share(tenant.id, shareId));
			if (!stored) return null;
			const share = Share.fromJSON(stored);
			if (share.tenantId !== tenant.id) return null;
			if (share.isExpiredAt(clock.now())) return null;
			return share;
		},

		async downloadUrlForFile({ share, fileId }) {
			const file = share.fileById(fileId);
			if (!file) return null;
			return await files.presignDownload(file.objectKey, {
				filename: file.title || file.filename,
				contentType: file.contentType,
				expiresIn: PRESIGN_DOWNLOAD_TTL_SECONDS,
			});
		},

		async downloadUrlForZip({ share }) {
			if (!share.hasZip) return null;
			const base = sanitizeFilename(share.title || "collection").replace(/\.zip$/i, "");
			return await files.presignDownload(share.zipKey, {
				filename: `${base}.zip`,
				contentType: "application/zip",
				expiresIn: PRESIGN_DOWNLOAD_TTL_SECONDS,
			});
		},

		/** Purge a share and every object it owns. */
		async destroy({ tenant, share }) {
			const result = await files.deleteMany(share.objectKeys());
			await kv.delete(keys.share(tenant.id, share.id));
			await kv.delete(keys.pinAttempts(tenant.id, share.id));
			log?.info("share deleted", { tenant: tenant.id, shareId: share.id, ...result });
			return result;
		},
	});
};
