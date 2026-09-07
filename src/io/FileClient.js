/**
 * Object storage. Wraps R2's S3-compatible API.
 *
 * The important property of this client is what it *does not* do: it never
 * moves file bytes. Uploads and downloads are handed to the browser as
 * presigned URLs, so the app's own bandwidth and memory are untouched no matter
 * how large the file is. Only HEAD and DELETE (a few hundred bytes each) go
 * through the app.
 */

import { presign, signRequest } from "~/lib/sigv4.js";

export const FileClient = ({ http, config, clock, logger }) => {
	const log = logger?.scoped("files");
	const { endpoint, bucket, accessKeyId, secretAccessKey, region } = config;
	const credentials = { endpoint, bucket, accessKeyId, secretAccessKey, region };

	/** Content-Disposition that survives non-ASCII filenames. */
	const attachment = (filename) => {
		const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
		return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
	};

	return Object.freeze({
		/**
		 * URL the browser PUTs to. `contentLength` is a *signed* header, so the
		 * browser cannot upload more bytes than the server agreed to.
		 */
		async presignUpload(key, { contentLength, contentType, expiresIn = 1800 }) {
			// A known length is signed, which caps the upload at exactly that many
			// bytes. The collection zip is built in the browser and has no known
			// length up front, so it is signed without one and size-checked on
			// completion instead.
			const headers = {};
			if (contentLength !== null && contentLength !== undefined) {
				headers["content-length"] = String(contentLength);
			}
			if (contentType) headers["content-type"] = contentType;
			const url = await presign({
				...credentials,
				method: "PUT",
				key,
				headers,
				expiresIn,
				date: clock.date(),
			});
			log?.debug("presigned upload", { key, contentLength });
			return { url, method: "PUT", headers };
		},

		/** Short-lived URL the visitor is redirected to. Forces a download. */
		async presignDownload(key, { filename, contentType, expiresIn = 300 } = {}) {
			const query = {};
			if (filename) query["response-content-disposition"] = attachment(filename);
			if (contentType) query["response-content-type"] = contentType;
			const url = await presign({
				...credentials,
				method: "GET",
				key,
				query,
				expiresIn,
				date: clock.date(),
			});
			log?.debug("presigned download", { key });
			return url;
		},

		/**
		 * Confirm an object landed and check its size. This is the server-side
		 * half of the upload contract: no share record is written until every
		 * object has been verified here.
		 */
		async head(key) {
			const signed = await signRequest({
				...credentials,
				method: "HEAD",
				key,
				date: clock.date(),
			});
			const response = await http.head(signed.url, { headers: signed.headers });
			if (response.status === 404) return { exists: false, size: 0, etag: null };
			if (!response.ok) {
				throw new Error(`HEAD ${key} returned ${response.status}`);
			}
			return {
				exists: true,
				size: Number(response.headers.get("content-length") ?? 0),
				etag: response.headers.get("etag"),
				contentType: response.headers.get("content-type"),
			};
		},

		async delete(key) {
			const signed = await signRequest({
				...credentials,
				method: "DELETE",
				key,
				date: clock.date(),
			});
			await http.del(signed.url, { headers: signed.headers });
			log?.info("deleted object", { key });
			return true;
		},

		/**
		 * Best-effort bulk delete: one failure must not strand the others.
		 *
		 * There is nothing to tidy up beyond the objects themselves. R2/S3 have
		 * no real directories — a "folder" like `d7/<tenant>/<shareId>/` is just
		 * the common prefix of its keys and stops existing the moment the last
		 * object under it is gone. This app never writes folder-marker objects,
		 * so deleting a share's keys leaves nothing behind. (The local dev client
		 * has real directories and prunes them in `LocalFileClient`.)
		 */
		async deleteMany(keys) {
			const results = await Promise.allSettled(keys.map((key) => this.delete(key)));
			const failed = keys.filter((_, i) => results[i].status === "rejected");
			if (failed.length) log?.warn("some objects failed to delete", { keys: failed });
			return { deleted: keys.length - failed.length, failed };
		},
	});
};
