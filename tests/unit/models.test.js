import assert from "node:assert/strict";
import { Share } from "~/models/Share.js";
import { formatBytes, sanitizeFilename, StoredFile } from "~/models/StoredFile.js";
import { tenantForHost, tenantsFor } from "~/config/tenants.server.js";
import { ENVS } from "~/config/env.js";
import { EXPIRY_OPTIONS, isAllowedExpiry, prefixForDays } from "~/config/limits.js";

Deno.test("models built via Model.extend are frozen and keep their name", () => {
	const share = Share({ id: "a", tenantId: "t1" });
	assert.equal(share.constructor.name, "ShareModel");
	assert.equal(Object.isFrozen(share), true);
	assert.throws(() => {
		"use strict";
		share.id = "b";
	});
});

Deno.test("merge returns a new instance and leaves the original alone", () => {
	const share = Share({ id: "a", tenantId: "t1", title: "First" });
	const renamed = share.merge({ title: "Second" });

	assert.equal(share.title, "First");
	assert.equal(renamed.title, "Second");
	assert.equal(renamed.id, "a");
	assert.notEqual(share, renamed);
});

Deno.test("a share round-trips through JSON", () => {
	const share = Share({
		id: "a",
		tenantId: "t1",
		kind: "collection",
		title: "Set",
		files: [{ id: "f1", filename: "a.txt", size: 10 }],
		zipKey: "z",
		pinHash: "h",
		pinSalt: "s",
		createdAt: 1,
		expiresAt: 2,
		expiryDays: 7,
		ownerEmail: "o@t.local",
	});
	const revived = Share.fromJSON(JSON.parse(JSON.stringify(share)));
	assert.deepEqual(revived.toJSON(), share.toJSON());
});

Deno.test("the view model omits every secret field", () => {
	const share = Share({
		id: "a",
		tenantId: "t1",
		pinHash: "h",
		pinSalt: "s",
		ownerEmail: "o@t.local",
		files: [{ id: "f1", filename: "a.txt", size: 10 }],
	});
	const vm = share.toViewModel();

	for (const field of ["pinHash", "pinSalt", "ownerEmail", "tenantId"]) {
		assert.ok(!(field in vm), `${field} must not reach a template`);
	}
	assert.ok(!("objectKey" in vm.files[0]), "storage keys must not reach a template");
	assert.equal(vm.hasPin, true);
});

Deno.test("filenames are stripped of path separators and control characters", () => {
	assert.equal(sanitizeFilename("../../etc/passwd"), "..-..-etc-passwd");
	assert.equal(sanitizeFilename("a\\b/c.txt"), "a-b-c.txt");
	assert.equal(sanitizeFilename(""), "file");
	assert.equal(sanitizeFilename("  spaced   out.txt  "), "spaced out.txt");
	assert.ok(sanitizeFilename("x".repeat(500)).length <= 180);
});

Deno.test("byte sizes render at a sensible precision", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(1023), "1023 B");
	assert.equal(formatBytes(1024), "1.0 KB");
	assert.equal(formatBytes(20480), "20 KB");
	assert.equal(formatBytes(1048576), "1.0 MB");
	assert.equal(formatBytes(1073741824), "1.0 GB");
});

Deno.test("a file with no title falls back to its filename", () => {
	const file = StoredFile({ filename: "raw.csv", size: 1 });
	assert.equal(file.title, "raw.csv");
	assert.equal(file.isRenamed, false);
});

Deno.test("every expiry option maps to a lifecycle prefix", () => {
	assert.deepEqual(EXPIRY_OPTIONS.map((o) => o.days), [1, 3, 7, 14, 30]);
	assert.deepEqual(EXPIRY_OPTIONS.map((o) => o.prefix), ["d1", "d3", "d7", "d14", "d30"]);
	assert.equal(prefixForDays(14), "d14");
	assert.throws(() => prefixForDays(90));
	assert.equal(isAllowedExpiry(7), true);
	assert.equal(isAllowedExpiry(90), false);
});

Deno.test("hosts resolve to tenants, with and without a port", () => {
	assert.equal(tenantForHost(ENVS.TEST, "test.local").id, "t1");
	assert.equal(tenantForHost(ENVS.TEST, "TEST.LOCAL").id, "t1");
	assert.equal(tenantForHost(ENVS.TEST, "test.local:443").id, "t1");
	assert.equal(tenantForHost(ENVS.TEST, "unknown.example"), null);
	assert.equal(tenantForHost(ENVS.TEST, undefined), null);
});

Deno.test("tenants namespace their own object keys", () => {
	const [first, second] = tenantsFor(ENVS.TEST);
	assert.equal(first.keyFor("d7", "abc", "file.txt"), "t1/d7/abc/file.txt");
	assert.equal(second.keyFor("d7", "abc", "file.txt"), "t2/d7/abc/file.txt");
	assert.notEqual(first.keyFor("x"), second.keyFor("x"));
});

Deno.test("every configured environment has at least one tenant with an allowlist", () => {
	for (const env of Object.values(ENVS)) {
		const tenants = tenantsFor(env);
		assert.ok(tenants.length > 0, `${env} has no tenants`);
		for (const tenant of tenants) {
			assert.ok(tenant.allowedEmails.length > 0, `${tenant.domain} has an empty allowlist`);
			assert.ok(tenant.domain.length > 0);
			assert.ok(tenant.maxFileBytes > 0);
		}
	}
});
