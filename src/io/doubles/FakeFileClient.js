/**
 * In-memory object store. `presignUpload` hands back a URL that no one will
 * ever call for real; tests simulate the browser finishing an upload by calling
 * `putObject`, which is exactly the state the server later verifies via `head`.
 */
export const FakeFileClient = () => {
	const objects = new Map();
	const presignedUploads = [];
	const presignedDownloads = [];
	const deleted = [];

	return Object.freeze({
		objects,
		presignedUploads,
		presignedDownloads,
		deleted,

		presignUpload(key, { contentLength, contentType, expiresIn = 1800 } = {}) {
			const headers = {};
			if (contentLength !== null && contentLength !== undefined) {
				headers["content-length"] = String(contentLength);
			}
			if (contentType) headers["content-type"] = contentType;
			const record = {
				key,
				contentLength,
				contentType,
				expiresIn,
				url: `https://fake-storage.test/upload/${encodeURIComponent(key)}`,
				method: "PUT",
				headers,
			};
			presignedUploads.push(record);
			return Promise.resolve(record);
		},

		presignDownload(key, { filename, expiresIn = 300 } = {}) {
			const url = `https://fake-storage.test/download/${encodeURIComponent(key)}` +
				(filename ? `?name=${encodeURIComponent(filename)}` : "");
			presignedDownloads.push({ key, filename, expiresIn, url });
			return Promise.resolve(url);
		},

		head(key) {
			const object = objects.get(key);
			return Promise.resolve(
				object ? { exists: true, ...object } : { exists: false, size: 0, etag: null },
			);
		},

		delete(key) {
			deleted.push(key);
			objects.delete(key);
			return Promise.resolve(true);
		},

		deleteMany(keys) {
			keys.forEach((k) => {
				deleted.push(k);
				objects.delete(k);
			});
			return Promise.resolve({ deleted: keys.length, failed: [] });
		},

		// --- test helpers ---
		/** Stand in for the browser having completed a direct-to-R2 upload. */
		putObject(key, { size = 0, contentType = "application/octet-stream" } = {}) {
			objects.set(key, { size, contentType, etag: `"fake-${key.length}-${size}"` });
			return objects.get(key);
		},
		has: (key) => objects.has(key),
		keys: () => [...objects.keys()],
		reset() {
			objects.clear();
			presignedUploads.length = 0;
			presignedDownloads.length = 0;
			deleted.length = 0;
		},
	});
};
