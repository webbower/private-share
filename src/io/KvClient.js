/**
 * Deno KV wrapper. Kept deliberately small: get / set / delete / list / atomic
 * increment, all with a native TTL.
 *
 * TTL is the whole reason KV is a good fit here. A share record is written with
 * `expireIn` set to the retention window, so metadata deletes itself at the
 * exact moment the R2 lifecycle rule deletes the blob. There is no expiry
 * sweeper to get wrong.
 */
export const KvClient = ({ kv, logger }) => {
	const log = logger?.scoped("kv");

	return Object.freeze({
		async get(key) {
			const entry = await kv.get(key);
			return entry.value ?? null;
		},

		async set(key, value, { expireIn } = {}) {
			await kv.set(key, value, expireIn ? { expireIn } : undefined);
			log?.debug("set", { key, expireIn });
			return value;
		},

		async delete(key) {
			await kv.delete(key);
			log?.debug("delete", { key });
			return true;
		},

		async list(prefix, { limit = 100 } = {}) {
			const out = [];
			for await (const entry of kv.list({ prefix }, { limit })) {
				out.push({ key: entry.key, value: entry.value });
			}
			return out;
		},

		/**
		 * Increment a counter with a TTL, returning the new value. Used for PIN
		 * attempt limiting. Retries once on a commit conflict.
		 */
		async increment(key, { expireIn } = {}) {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const entry = await kv.get(key);
				const next = (entry.value ?? 0) + 1;
				const result = await kv.atomic()
					.check(entry)
					.set(key, next, expireIn ? { expireIn } : undefined)
					.commit();
				if (result.ok) return next;
			}
			throw new Error(`KV increment contended on ${JSON.stringify(key)}`);
		},

		/** Read-and-delete in one commit, so a magic link cannot be replayed. */
		async take(key) {
			const entry = await kv.get(key);
			if (entry.value === null || entry.value === undefined) return null;
			const result = await kv.atomic().check(entry).delete(key).commit();
			return result.ok ? entry.value : null;
		},

		close: () => kv.close?.(),
	});
};

/** Open the platform KV store. On Deno Deploy this needs no arguments. */
export const openKv = async (path) => await Deno.openKv(path);
