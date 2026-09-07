import { Model } from "./Model.js";
import { formatBytes, StoredFile } from "./StoredFile.js";

export const SHARE_KIND = Object.freeze({ FILE: "file", COLLECTION: "collection" });

/**
 * A share is the unit addressed by `/s/:id`. It is either a single file or a
 * collection of files; the `kind` field is what the router uses to pick a view.
 *
 * `tenantId` is stored on the record as well as being part of the KV key, so a
 * lookup that somehow crossed tenants would still be caught on read.
 */
export const Share = Model.extend({
	name: "Share",
	ctor: ({
		id = "",
		tenantId = "",
		kind = SHARE_KIND.FILE,
		title = "",
		files = [],
		zipKey = null,
		zipSize = 0,
		pinHash = null,
		pinSalt = null,
		expiresAt = 0,
		createdAt = 0,
		expiryDays = 0,
		ownerEmail = "",
	}) => {
		const storedFiles = Object.freeze(
			files.map((f) => (typeof f?.toJSON === "function" ? f : StoredFile(f))),
		);
		const resolvedKind = kind === SHARE_KIND.COLLECTION ? SHARE_KIND.COLLECTION : SHARE_KIND.FILE;
		return {
			id,
			tenantId,
			kind: resolvedKind,
			title: String(title ?? "").trim() || (storedFiles[0]?.title ?? ""),
			files: storedFiles,
			zipKey: resolvedKind === SHARE_KIND.COLLECTION ? zipKey : null,
			zipSize: resolvedKind === SHARE_KIND.COLLECTION ? Number(zipSize) || 0 : 0,
			pinHash,
			pinSalt,
			expiresAt: Number(expiresAt) || 0,
			createdAt: Number(createdAt) || 0,
			expiryDays: Number(expiryDays) || 0,
			ownerEmail,
		};
	},
	proto: {
		get isCollection() {
			return this.kind === SHARE_KIND.COLLECTION;
		},
		get hasPin() {
			return Boolean(this.pinHash);
		},
		get hasZip() {
			return Boolean(this.zipKey);
		},
		get fileCount() {
			return this.files.length;
		},
		get totalBytes() {
			return this.files.reduce((sum, f) => sum + f.size, 0);
		},
		get displayTotalSize() {
			return formatBytes(this.totalBytes);
		},
		isExpiredAt(nowMs) {
			return this.expiresAt > 0 && nowMs >= this.expiresAt;
		},
		fileById(fileId) {
			return this.files.find((f) => f.id === fileId) ?? null;
		},
		/** Every object key this share owns, including the pre-built zip. */
		objectKeys() {
			const keys = this.files.map((f) => f.objectKey);
			return this.zipKey ? [...keys, this.zipKey] : keys;
		},
		/**
		 * The projection handed to templates. Deliberately omits `pinHash`,
		 * `pinSalt` and `ownerEmail` so a view can never render them by accident.
		 */
		toViewModel() {
			return {
				id: this.id,
				kind: this.kind,
				title: this.title,
				isCollection: this.isCollection,
				hasPin: this.hasPin,
				hasZip: this.hasZip,
				fileCount: this.fileCount,
				displayTotalSize: this.displayTotalSize,
				expiresAt: this.expiresAt,
				createdAt: this.createdAt,
				expiryDays: this.expiryDays,
				files: this.files.map((f) => ({
					id: f.id,
					title: f.title,
					filename: f.filename,
					displaySize: f.displaySize,
					contentType: f.contentType,
				})),
			};
		},
		toJSON() {
			return {
				id: this.id,
				tenantId: this.tenantId,
				kind: this.kind,
				title: this.title,
				files: this.files.map((f) => f.toJSON()),
				zipKey: this.zipKey,
				zipSize: this.zipSize,
				pinHash: this.pinHash,
				pinSalt: this.pinSalt,
				expiresAt: this.expiresAt,
				createdAt: this.createdAt,
				expiryDays: this.expiryDays,
				ownerEmail: this.ownerEmail,
			};
		},
	},
	stat: {
		fromJSON: (json) => Share(json ?? {}),
		KIND: SHARE_KIND,
	},
});
