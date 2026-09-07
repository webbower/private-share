/**
 * Map-backed KV with the same surface as `KvClient`, including real TTL
 * behaviour driven by the injected clock. Avoids needing `--unstable-kv` (or a
 * SQLite file) in the test run.
 */
const encode = (key) => JSON.stringify(key);

export const MemoryKvClient = ({ clock } = {}) => {
	const now = () => (clock ? clock.now() : Date.now());
	const store = new Map();

	const live = (encoded) => {
		const row = store.get(encoded);
		if (!row) return null;
		if (row.expiresAt > 0 && now() >= row.expiresAt) {
			store.delete(encoded);
			return null;
		}
		return row;
	};

	return Object.freeze({
		store,

		get: (key) => Promise.resolve(live(encode(key))?.value ?? null),

		set(key, value, { expireIn } = {}) {
			store.set(encode(key), {
				key,
				value,
				expiresAt: expireIn ? now() + expireIn : 0,
			});
			return Promise.resolve(value);
		},

		delete(key) {
			store.delete(encode(key));
			return Promise.resolve(true);
		},

		list(prefix, { limit = 100 } = {}) {
			const out = [];
			for (const encoded of [...store.keys()]) {
				const row = live(encoded);
				if (!row) continue;
				const matches = prefix.every((part, i) => row.key[i] === part);
				if (matches) out.push({ key: row.key, value: row.value });
				if (out.length >= limit) break;
			}
			return Promise.resolve(out);
		},

		increment(key, { expireIn } = {}) {
			const encoded = encode(key);
			const next = (live(encoded)?.value ?? 0) + 1;
			const existing = live(encoded);
			store.set(encoded, {
				key,
				value: next,
				// Keep the original window; a burst of guesses must not extend it.
				expiresAt: existing?.expiresAt || (expireIn ? now() + expireIn : 0),
			});
			return Promise.resolve(next);
		},

		take(key) {
			const encoded = encode(key);
			const row = live(encoded);
			if (!row) return Promise.resolve(null);
			store.delete(encoded);
			return Promise.resolve(row.value);
		},

		close: () => {},
		reset: () => store.clear(),
		size: () => store.size,
	});
};
