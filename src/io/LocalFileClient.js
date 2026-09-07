/**
 * DEVELOPMENT ONLY. Stands in for `FileClient` (Cloudflare R2) when
 * `APP_ENV=development`.
 *
 * Objects are kept in a directory on disk (`.local-storage/` by default).
 * `presignUpload` / `presignDownload` hand back URLs pointing at this app's own
 * `/__local-storage/...` routes, which `src/app.js` mounts only in development.
 * The browser's direct-to-storage PUT and the download redirect then both work
 * with no bucket, no credentials and no CORS policy.
 *
 * The method surface mirrors the parts of `FileClient` the app actually calls,
 * plus `putObject` / `getObject` for the dev routes to move bytes through.
 */

import { dirname, join, relative } from "node:path";

/** Route prefix shared with `src/app.js`. Trailing slash included. */
export const LOCAL_STORAGE_PREFIX = "/__local-storage/";

const guardKey = (key) => {
	if (!key || key.startsWith("/") || key.split("/").includes("..")) {
		throw new Error(`unsafe object key: ${JSON.stringify(key)}`);
	}
	return key;
};

/** Percent-encode each path segment but keep the `/` separators literal. */
export const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

export const LocalFileClient = ({ root, logger } = {}) => {
	const log = logger?.scoped("files");
	const baseDir = root ?? join(Deno.cwd(), ".local-storage");

	const pathFor = (key) => join(baseDir, guardKey(key));

	/**
	 * Object storage has no real directories — R2 "folders" are just shared key
	 * prefixes that vanish when the last object under them is deleted. On local
	 * disk they are real, so an empty `d7/<tenant>/<shareId>/` would linger after
	 * a share is purged. Walk up from the deleted file and remove parents that
	 * became empty, stopping at the first non-empty one (or at `baseDir`).
	 */
	const pruneEmptyParents = async (fromDir) => {
		let dir = fromDir;
		while (true) {
			const rel = relative(baseDir, dir);
			if (rel === "" || rel === "." || rel.startsWith("..")) break;
			try {
				await Deno.remove(dir); // throws if the directory is not empty
			} catch {
				break;
			}
			dir = dirname(dir);
		}
	};

	const attachment = (filename) => {
		const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
		return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
	};

	return Object.freeze({
		/** Where R2 would live. Exposed so dev tooling can point at it. */
		baseDir,
		attachmentHeader: attachment,

		presignUpload(key, { contentLength, contentType } = {}) {
			const headers = {};
			if (contentLength !== null && contentLength !== undefined) {
				headers["content-length"] = String(contentLength);
			}
			if (contentType) headers["content-type"] = contentType;
			return Promise.resolve({
				url: `${LOCAL_STORAGE_PREFIX}${encodeKey(guardKey(key))}`,
				method: "PUT",
				headers,
			});
		},

		presignDownload(key, { filename, contentType } = {}) {
			const params = new URLSearchParams();
			if (filename) params.set("filename", filename);
			if (contentType) params.set("contentType", contentType);
			const query = params.toString();
			return Promise.resolve(
				`${LOCAL_STORAGE_PREFIX}${encodeKey(guardKey(key))}${query ? `?${query}` : ""}`,
			);
		},

		async head(key) {
			try {
				const info = await Deno.stat(pathFor(key));
				return {
					exists: true,
					size: info.size,
					etag: `"${info.mtime?.getTime() ?? 0}-${info.size}"`,
					contentType: undefined,
				};
			} catch (error) {
				if (error instanceof Deno.errors.NotFound) return { exists: false, size: 0, etag: null };
				throw error;
			}
		},

		async delete(key) {
			const path = pathFor(key);
			try {
				await Deno.remove(path);
			} catch (error) {
				if (!(error instanceof Deno.errors.NotFound)) throw error;
			}
			await pruneEmptyParents(dirname(path));
			log?.info("deleted object", { key });
			return true;
		},

		async deleteMany(keys) {
			const results = await Promise.allSettled(keys.map((key) => this.delete(key)));
			const failed = keys.filter((_, i) => results[i].status === "rejected");
			if (failed.length) log?.warn("some objects failed to delete", { keys: failed });
			return { deleted: keys.length - failed.length, failed };
		},

		// --- byte movers for the dev-only /__local-storage routes ------------

		/** Persist an object the browser just PUT. */
		async putObject(key, bytes) {
			const path = pathFor(key);
			await Deno.mkdir(dirname(path), { recursive: true });
			await Deno.writeFile(path, bytes);
			log?.debug("stored object", { key, size: bytes.byteLength });
			return { size: bytes.byteLength };
		},

		/** Read an object for a download redirect. `null` when absent. */
		async getObject(key) {
			try {
				return await Deno.readFile(pathFor(key));
			} catch (error) {
				if (error instanceof Deno.errors.NotFound) return null;
				throw error;
			}
		},
	});
};
