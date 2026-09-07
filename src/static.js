/**
 * Static asset serving for the built browser bundle and stylesheet.
 *
 * Assets are read from `static/dist`, which is what `scripts/build.js` writes
 * and what the pre-deploy check verifies. Content is cached in memory after
 * first read; on Deploy the isolate is short-lived, so this is just a
 * per-isolate read amortiser rather than a real cache.
 */

const DIST = new URL("../static/dist/", import.meta.url);

const TYPES = {
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

const cache = new Map();

const contentType = (name) => {
	const dot = name.lastIndexOf(".");
	return TYPES[name.slice(dot)] ?? "application/octet-stream";
};

export const serveAsset = async (name) => {
	// Anything with a path separator or a traversal segment is refused outright.
	if (!/^[\w.-]+$/.test(name) || name.includes("..")) {
		return new Response("Not found", { status: 404 });
	}

	if (!cache.has(name)) {
		try {
			cache.set(name, await Deno.readFile(new URL(name, DIST)));
		} catch {
			cache.set(name, null);
		}
	}

	const body = cache.get(name);
	if (!body) return new Response("Not found", { status: 404 });

	return new Response(body, {
		headers: {
			"content-type": contentType(name),
			// The build fingerprints nothing, so keep this modest.
			"cache-control": "public, max-age=300",
		},
	});
};

/** Used by the dev watcher. */
export const clearAssetCache = () => cache.clear();
