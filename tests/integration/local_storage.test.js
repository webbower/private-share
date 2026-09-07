/**
 * LocalFileClient — the development stand-in for R2. Exercises real disk IO, so
 * it needs write access; under the credential-free task runs it is skipped.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { LocalFileClient } from "~/io/LocalFileClient.js";
import { FakeLogger } from "~/io/doubles/FakeLogger.js";

const canWrite = (await Deno.permissions.query({ name: "write" })).state === "granted";

const withClient = async (fn) => {
	const root = await Deno.makeTempDir({ prefix: "private-share-storage-" });
	try {
		await fn(LocalFileClient({ root, logger: FakeLogger() }), root);
	} finally {
		await Deno.remove(root, { recursive: true }).catch(() => {});
	}
};

const dirExists = async (path) => {
	try {
		return (await Deno.stat(path)).isDirectory;
	} catch {
		return false;
	}
};

Deno.test({
	name: "delete removes the object and prunes the folders it emptied",
	ignore: !canWrite,
	fn: () =>
		withClient(async (files, root) => {
			const key = "d7/t1/shr123/f1-report.pdf";
			await files.putObject(key, new Uint8Array([1, 2, 3]));
			assert.ok(await dirExists(join(root, "d7/t1/shr123")));

			await files.delete(key);

			assert.equal((await files.head(key)).exists, false);
			// The whole now-empty chain is gone...
			assert.equal(await dirExists(join(root, "d7/t1/shr123")), false);
			assert.equal(await dirExists(join(root, "d7/t1")), false);
			assert.equal(await dirExists(join(root, "d7")), false);
			// ...but the storage root itself stays.
			assert.ok(await dirExists(root));
		}),
});

Deno.test({
	name: "delete keeps a folder that still holds another object",
	ignore: !canWrite,
	fn: () =>
		withClient(async (files, root) => {
			await files.putObject("d7/t1/shrA/f1-a.txt", new Uint8Array([1]));
			await files.putObject("d7/t1/shrB/f2-b.txt", new Uint8Array([2]));

			await files.delete("d7/t1/shrA/f1-a.txt");

			assert.equal(await dirExists(join(root, "d7/t1/shrA")), false);
			// d7/ and d7/t1/ survive because shrB is still there.
			assert.ok(await dirExists(join(root, "d7/t1/shrB")));
			assert.ok(await dirExists(join(root, "d7/t1")));
		}),
});

Deno.test({
	name: "deleteMany clears every object and the shared folder once it is empty",
	ignore: !canWrite,
	fn: () =>
		withClient(async (files, root) => {
			const keys = [
				"d3/t1/shrZ/f1-one.bin",
				"d3/t1/shrZ/f2-two.bin",
				"d3/t1/shrZ/collection.zip",
			];
			for (const key of keys) await files.putObject(key, new Uint8Array([0]));

			const result = await files.deleteMany(keys);

			assert.equal(result.deleted, 3);
			assert.deepEqual(result.failed, []);
			assert.equal(await dirExists(join(root, "d3")), false);
		}),
});
