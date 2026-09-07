import assert from "node:assert/strict";
import { createTestContainer } from "~/deps-test.js";
import { ShareService, UploadError } from "~/services/shares.js";
import { tenantForHost } from "~/config/tenants.server.js";
import { ENVS } from "~/config/env.js";
import { ZIP_FILENAME } from "~/config/limits.js";

const setup = () => {
	const c = createTestContainer();
	return {
		...c,
		shares: ShareService(c),
		tenant: tenantForHost(ENVS.TEST, "test.local"),
		other: tenantForHost(ENVS.TEST, "other.local"),
		session: { email: "allowed@test.local" },
	};
};

/** Stand in for the browser having PUT every presigned URL successfully. */
const finishBrowserUploads = (files, begin, sizes) => {
	begin.uploads.forEach((upload, i) => {
		const key = decodeURIComponent(upload.url.split("/upload/")[1]);
		files.putObject(key, { size: sizes[i] });
	});
};

const oneFile = [{ name: "notes.txt", size: 120, type: "text/plain" }];

Deno.test("begin returns one presigned upload per file", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({
		tenant,
		session,
		files: oneFile,
		expiryDays: 7,
	});

	assert.equal(begin.uploads.length, 1);
	assert.equal(begin.isCollection, false);
	assert.equal(begin.zipUpload, null);
	assert.equal(files.presignedUploads.length, 1);
});

Deno.test("object keys are namespaced by tenant and retention window", async () => {
	const { shares, tenant, session, files } = setup();
	await shares.beginUpload({ tenant, session, files: oneFile, expiryDays: 14 });

	// `d14/` leads because R2 lifecycle prefixes anchor at the start of the key;
	// `t1/` is the tenant namespace within that window.
	assert.match(files.presignedUploads[0].key, /^d14\/t1\/[^/]+\/[^/]+-notes\.txt$/);
});

Deno.test("the presigned upload pins content-length to the declared size", async () => {
	const { shares, tenant, session, files } = setup();
	await shares.beginUpload({ tenant, session, files: oneFile, expiryDays: 7 });
	assert.equal(files.presignedUploads[0].headers["content-length"], "120");
});

Deno.test("completing an upload writes a retrievable share", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({ tenant, session, files: oneFile, expiryDays: 7 });
	finishBrowserUploads(files, begin, [120]);

	const { share, pin } = await shares.completeUpload({
		tenant,
		session,
		shareId: begin.shareId,
		withPin: false,
	});

	assert.equal(pin, null);
	assert.equal(share.kind, "file");
	assert.equal(share.fileCount, 1);
	assert.equal(share.files[0].title, "notes.txt");

	const found = await shares.find({ tenant, shareId: begin.shareId });
	assert.equal(found.id, begin.shareId);
});

Deno.test("a share is not visible from another tenant's domain", async () => {
	const { shares, tenant, other, session, files } = setup();
	const begin = await shares.beginUpload({ tenant, session, files: oneFile, expiryDays: 7 });
	finishBrowserUploads(files, begin, [120]);
	await shares.completeUpload({ tenant, session, shareId: begin.shareId, withPin: false });

	assert.ok(await shares.find({ tenant, shareId: begin.shareId }));
	assert.equal(await shares.find({ tenant: other, shareId: begin.shareId }), null);
});

Deno.test("a share stops resolving once its retention window passes", async () => {
	const { shares, tenant, session, files, clock } = setup();
	const begin = await shares.beginUpload({ tenant, session, files: oneFile, expiryDays: 1 });
	finishBrowserUploads(files, begin, [120]);
	await shares.completeUpload({ tenant, session, shareId: begin.shareId, withPin: false });

	clock.advanceDays(1);
	clock.advance(1000);
	assert.equal(await shares.find({ tenant, shareId: begin.shareId }), null);
});

Deno.test("an object that never arrived blocks completion", async () => {
	const { shares, tenant, session } = setup();
	const begin = await shares.beginUpload({ tenant, session, files: oneFile, expiryDays: 7 });

	await assert.rejects(
		() => shares.completeUpload({ tenant, session, shareId: begin.shareId, withPin: false }),
		(e) => e instanceof UploadError && e.code === "missing_object",
	);
	assert.equal(await shares.find({ tenant, shareId: begin.shareId }), null);
});

Deno.test("an object whose size does not match is rejected and purged", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({ tenant, session, files: oneFile, expiryDays: 7 });
	finishBrowserUploads(files, begin, [999999]);

	await assert.rejects(
		() => shares.completeUpload({ tenant, session, shareId: begin.shareId, withPin: false }),
		(e) => e instanceof UploadError && e.code === "size_mismatch",
	);
	assert.equal(files.deleted.length, 1);
});

Deno.test("a PIN is returned once and never stored in the clear", async () => {
	const { shares, tenant, session, files, kv } = setup();
	const begin = await shares.beginUpload({ tenant, session, files: oneFile, expiryDays: 7 });
	finishBrowserUploads(files, begin, [120]);

	const { share, pin } = await shares.completeUpload({
		tenant,
		session,
		shareId: begin.shareId,
		withPin: true,
	});

	assert.match(pin, /^\d{6}$/);
	assert.equal(share.hasPin, true);
	const dump = JSON.stringify([...kv.store.values()]);
	assert.ok(!dump.includes(pin), "plaintext PIN must not be persisted");
});

Deno.test("files uploaded without the collection box become one share each", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({
		tenant,
		session,
		files: [
			{ name: "a.txt", size: 10, type: "text/plain" },
			{ name: "b.txt", size: 20, type: "text/plain" },
		],
		asCollection: false,
		expiryDays: 7,
	});
	finishBrowserUploads(files, begin, [10, 20]);

	const { shares: made, pins, share, pin } = await shares.completeUpload({
		tenant,
		session,
		shareId: begin.shareId,
		withPin: false,
	});

	assert.equal(made.length, 2);
	assert.notEqual(made[0].id, made[1].id);
	assert.deepEqual(made.map((s) => s.kind), ["file", "file"]);
	assert.deepEqual(made.map((s) => s.fileCount), [1, 1]);
	assert.deepEqual(made.map((s) => s.title), ["a.txt", "b.txt"]);
	assert.equal(made.some((s) => s.isCollection || s.hasZip), false);
	assert.deepEqual(pins, [null, null]);

	// The convenience aliases point at the first share.
	assert.equal(share.id, made[0].id);
	assert.equal(pin, null);

	// Each is an independently retrievable share, and the pending record is gone.
	for (const s of made) {
		assert.ok(await shares.find({ tenant, shareId: s.id }));
	}
	await assert.rejects(
		() => shares.completeUpload({ tenant, session, shareId: begin.shareId, withPin: false }),
		UploadError,
	);
});

Deno.test("an ungrouped multi-file upload gets a distinct PIN per file", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({
		tenant,
		session,
		files: [
			{ name: "a.txt", size: 10, type: "text/plain" },
			{ name: "b.txt", size: 20, type: "text/plain" },
		],
		asCollection: false,
		expiryDays: 7,
	});
	finishBrowserUploads(files, begin, [10, 20]);

	const { shares: made, pins } = await shares.completeUpload({
		tenant,
		session,
		shareId: begin.shareId,
		withPin: true,
	});

	assert.equal(pins.length, 2);
	pins.forEach((p) => assert.match(p, /^\d{6}$/));
	assert.notEqual(pins[0], pins[1]);
	made.forEach((s) => assert.equal(s.hasPin, true));
});

Deno.test("the collection checkbox produces a collection with a prebuilt zip", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({
		tenant,
		session,
		files: [
			{ name: "a.txt", size: 10, type: "text/plain" },
			{ name: "b.txt", size: 20, type: "text/plain" },
		],
		asCollection: true,
		collectionTitle: "Holiday photos",
		expiryDays: 3,
	});
	finishBrowserUploads(files, begin, [10, 20]);

	assert.ok(begin.zipUpload, "a collection gets a zip upload slot");
	const zipKey = decodeURIComponent(begin.zipUpload.url.split("/upload/")[1]);
	assert.ok(zipKey.endsWith(ZIP_FILENAME));
	files.putObject(zipKey, { size: 26, contentType: "application/zip" });

	const { share } = await shares.completeUpload({
		tenant,
		session,
		shareId: begin.shareId,
		withPin: false,
	});

	assert.equal(share.isCollection, true);
	assert.equal(share.title, "Holiday photos");
	assert.equal(share.fileCount, 2);
	assert.equal(share.hasZip, true);
	assert.ok(await shares.downloadUrlForZip({ share }));
});

Deno.test("a collection with one file falls back to a single-file share", async () => {
	const { shares, tenant, session } = setup();
	const begin = await shares.beginUpload({
		tenant,
		session,
		files: oneFile,
		asCollection: true,
		expiryDays: 7,
	});
	assert.equal(begin.isCollection, false);
});

Deno.test("an oversized zip is discarded but the collection survives", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({
		tenant,
		session,
		files: [
			{ name: "a.txt", size: 10, type: "text/plain" },
			{ name: "b.txt", size: 20, type: "text/plain" },
		],
		asCollection: true,
		expiryDays: 7,
	});
	finishBrowserUploads(files, begin, [10, 20]);
	const zipKey = decodeURIComponent(begin.zipUpload.url.split("/upload/")[1]);
	files.putObject(zipKey, { size: 50 * 1024 * 1024 });

	const { share } = await shares.completeUpload({
		tenant,
		session,
		shareId: begin.shareId,
		withPin: false,
	});
	assert.equal(share.hasZip, false);
	assert.equal(share.fileCount, 2);
});

Deno.test("custom titles override filenames for display only", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({
		tenant,
		session,
		files: [{ name: "IMG_4021.HEIC", size: 40, title: "Front of the house", type: "image/heic" }],
		expiryDays: 7,
	});
	finishBrowserUploads(files, begin, [40]);
	const { share } = await shares.completeUpload({
		tenant,
		session,
		shareId: begin.shareId,
		withPin: false,
	});

	assert.equal(share.files[0].title, "Front of the house");
	assert.equal(share.files[0].filename, "IMG_4021.HEIC");
	assert.equal(share.files[0].isRenamed, true);
});

Deno.test("upload validation rejects bad input", async () => {
	const { shares, tenant, session } = setup();
	const reject = (args, code) =>
		assert.rejects(
			() => shares.beginUpload({ tenant, session, expiryDays: 7, ...args }),
			(e) => e instanceof UploadError && e.code === code,
			code,
		);

	await reject({ files: [] }, "no_files");
	await reject({ files: oneFile, expiryDays: 90 }, "bad_expiry");
	await reject({ files: [{ name: "big", size: 5 * 1024 * 1024 }] }, "file_too_large");
	await reject({ files: [{ name: "x", size: 0 }] }, "bad_size");
	await reject(
		{ files: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, size: 10 })) },
		"too_many_files",
	);
});

Deno.test("deleting a share removes every object it owns", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({
		tenant,
		session,
		files: [
			{ name: "a.txt", size: 10 },
			{ name: "b.txt", size: 20 },
		],
		asCollection: true,
		expiryDays: 7,
	});
	finishBrowserUploads(files, begin, [10, 20]);
	const zipKey = decodeURIComponent(begin.zipUpload.url.split("/upload/")[1]);
	files.putObject(zipKey, { size: 26 });

	const { share } = await shares.completeUpload({
		tenant,
		session,
		shareId: begin.shareId,
		withPin: false,
	});
	await shares.destroy({ tenant, share });

	assert.equal(files.keys().length, 0);
	assert.equal(files.deleted.length, 3, "two files and the zip");
	assert.equal(await shares.find({ tenant, shareId: share.id }), null);
});

Deno.test("a download URL is issued per file and carries the display title", async () => {
	const { shares, tenant, session, files } = setup();
	const begin = await shares.beginUpload({
		tenant,
		session,
		files: [{ name: "raw.csv", size: 12, title: "Q3 numbers.csv" }],
		expiryDays: 7,
	});
	finishBrowserUploads(files, begin, [12]);
	const { share } = await shares.completeUpload({
		tenant,
		session,
		shareId: begin.shareId,
		withPin: false,
	});

	const url = await shares.downloadUrlForFile({ share, fileId: share.files[0].id });
	assert.match(url, /name=Q3%20numbers\.csv/);
	assert.equal(await shares.downloadUrlForFile({ share, fileId: "nope" }), null);
});
