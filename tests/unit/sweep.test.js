import assert from "node:assert/strict";
import { createTestContainer } from "~/deps-test.js";
import { ShareService } from "~/services/shares.js";
import { sweepOrphans } from "~/jobs/sweep.js";
import { tenantForHost } from "~/config/tenants.server.js";
import { ENVS } from "~/config/env.js";

const setup = () => {
	const c = createTestContainer();
	return { ...c, shares: ShareService(c), tenant: tenantForHost(ENVS.TEST, "test.local") };
};

const session = { email: "allowed@test.local" };
const FILES = [{ name: "a.txt", size: 10, type: "text/plain" }];

Deno.test("an abandoned upload's objects are swept once it is old enough", async () => {
	const ctx = setup();
	const begin = await ctx.shares.beginUpload({
		tenant: ctx.tenant,
		session,
		files: FILES,
		expiryDays: 7,
	});
	const key = decodeURIComponent(begin.uploads[0].url.split("/upload/")[1]);
	ctx.files.putObject(key, { size: 10 });

	// Too recent: an upload still in flight must be left alone.
	assert.equal((await sweepOrphans({ ...ctx, appEnv: ENVS.TEST })).removed, 0);
	assert.equal(ctx.files.has(key), true);

	ctx.clock.advance(3 * 3600000);
	const result = await sweepOrphans({ ...ctx, appEnv: ENVS.TEST });
	assert.equal(result.removed, 1);
	assert.equal(ctx.files.has(key), false);
});

Deno.test("a completed upload is never swept", async () => {
	const ctx = setup();
	const begin = await ctx.shares.beginUpload({
		tenant: ctx.tenant,
		session,
		files: FILES,
		expiryDays: 7,
	});
	const key = decodeURIComponent(begin.uploads[0].url.split("/upload/")[1]);
	ctx.files.putObject(key, { size: 10 });
	await ctx.shares.completeUpload({
		tenant: ctx.tenant,
		session,
		shareId: begin.shareId,
		withPin: false,
	});

	ctx.clock.advance(3 * 3600000);
	assert.equal((await sweepOrphans({ ...ctx, appEnv: ENVS.TEST })).removed, 0);
	assert.equal(ctx.files.has(key), true);
});

Deno.test("a pending record outlives its presigned URLs so the sweeper can find it", async () => {
	const ctx = setup();
	const begin = await ctx.shares.beginUpload({
		tenant: ctx.tenant,
		session,
		files: FILES,
		expiryDays: 7,
	});
	const key = decodeURIComponent(begin.uploads[0].url.split("/upload/")[1]);
	ctx.files.putObject(key, { size: 10 });

	// Well past the 30-minute presign window, and past the orphan threshold.
	ctx.clock.advance(4 * 3600000);
	assert.equal((await sweepOrphans({ ...ctx, appEnv: ENVS.TEST })).removed, 1);
});
