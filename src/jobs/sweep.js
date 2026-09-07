/**
 * Orphan sweep.
 *
 * Expiry itself needs no job: KV `expireIn` removes the share record and an R2
 * lifecycle rule on the `d1/`..`d30/` prefixes removes the blob, both without
 * this app running. What lifecycle rules cannot see are *pending* uploads whose
 * objects landed but whose share record was never written — a tab closed
 * between the PUT and the completion POST.
 *
 * Those objects still sit under a retention prefix, so R2 deletes them on
 * schedule anyway. This job only shortens that window and keeps the pending
 * namespace tidy.
 */

import { ORPHAN_AGE_SECONDS } from "~/config/limits.js";
import { tenantsFor } from "~/config/tenants.server.js";

export const sweepOrphans = async ({ kv, files, clock, logger, appEnv }) => {
	const log = logger?.scoped("sweep");
	let removed = 0;

	for (const tenant of tenantsFor(appEnv)) {
		const pending = await kv.list(["pending", tenant.id], { limit: 500 });

		for (const { key, value } of pending) {
			// A pending record outlives its presigned URLs by a wide margin before
			// being considered abandoned.
			const age = clock.now() - (value?.createdAt ?? 0);
			if (age < ORPHAN_AGE_SECONDS * 1000) continue;

			const orphaned = [
				...(value.files ?? []).map((f) => f.objectKey),
				...(value.zipKey ? [value.zipKey] : []),
			];

			const result = await files.deleteMany(orphaned);
			await kv.delete(key);
			removed += result.deleted;
			log?.info("swept abandoned upload", { tenant: tenant.id, shareId: value.shareId });
		}
	}

	log?.info("sweep finished", { removed });
	return { removed };
};
