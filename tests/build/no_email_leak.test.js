/**
 * Pre-deploy verification: the uploader allowlist must not exist in anything
 * the browser downloads.
 *
 * This runs a real frontend build and greps the finished artifacts. It is
 * deliberately not a unit test of the bundler config — config can be correct
 * and the output still wrong, so this checks the output.
 *
 * Two modes, controlled by KEEP_BUILD:
 *
 *   KEEP_BUILD unset  the build directory is removed afterwards. Use for local
 *                     runs and PR checks, where the artifact is throwaway.
 *
 *   KEEP_BUILD=1      the verified artifact is left in `static/dist` so the
 *                     deploy can ship exactly the bytes that were checked,
 *                     rather than rebuilding and shipping something else.
 *                     `deno task preflight` sets this.
 */

import assert from "node:assert/strict";
import { build, clean } from "../../scripts/build.js";
import { ENVS } from "~/config/env.js";
import { allAllowedEmails, tenantsFor } from "~/config/tenants.server.js";

const KEEP = Deno.env.get("KEEP_BUILD") === "1";

const readOutputs = async (result) => {
	const files = {};
	for (const name of result.outputs) {
		files[name] = await Deno.readTextFile(`${result.dist}${name}`);
	}
	return files;
};

const withBuild = async (fn) => {
	const result = await build({ minify: true });
	try {
		await fn(result, await readOutputs(result));
	} finally {
		if (!KEEP) await clean();
	}
};

Deno.test({
	name: "the built bundle contains no address from any environment's allowlist",
	// esbuild keeps a worker alive across the run; the sanitizers would flag it.
	sanitizeOps: false,
	sanitizeResources: false,
	fn: async () => {
		const everyAddress = Object.values(ENVS).flatMap((env) => allAllowedEmails(env));
		assert.ok(everyAddress.length > 0, "there is nothing to check for");

		await withBuild((_result, files) => {
			const found = [];
			for (const [name, contents] of Object.entries(files)) {
				for (const address of everyAddress) {
					if (contents.includes(address)) found.push(`${address} in ${name}`);
					// Also catch a bundler that split the string or escaped the @.
					const [local, domain] = address.split("@");
					if (contents.includes(local) && contents.includes(domain)) {
						found.push(`${local} and ${domain} both in ${name}`);
					}
				}
			}
			assert.deepEqual(found, [], "allowlist addresses reached the browser bundle");
		});
	},
});

Deno.test({
	name: "the built bundle contains no tenant domain list or bucket prefix",
	sanitizeOps: false,
	sanitizeResources: false,
	fn: async () => {
		// Knowing the object-key prefixes would help someone guess storage paths.
		const prefixes = Object.values(ENVS)
			.flatMap((env) => tenantsFor(env).map((t) => t.bucketPrefix))
			.filter((p) => p.length > 2);

		await withBuild((_result, files) => {
			const bundle = files["upload.js"];
			const found = prefixes.filter((prefix) => new RegExp(`["'\`]${prefix}["'\`]`).test(bundle));
			assert.deepEqual(found, [], "tenant storage prefixes reached the browser bundle");
		});
	},
});

Deno.test({
	name: "the build refuses to bundle a server-only module",
	sanitizeOps: false,
	sanitizeResources: false,
	fn: async () => {
		const probe = new URL("../../client/__leak_probe.js", import.meta.url);
		await Deno.writeTextFile(
			probe,
			`import { allAllowedEmails } from "../src/config/tenants.server.js";\n` +
				`console.log(allAllowedEmails("production"));\n`,
		);

		try {
			// A build whose entry point reaches a .server.js module must fail. If
			// this ever starts passing, the guard in scripts/build.js is broken and
			// the two tests above are no longer load-bearing.
			await assert.rejects(
				() =>
					build({
						minify: true,
						entryPoints: [decodeURIComponent(probe.pathname)],
					}).then(() => {
						// The plugin errors on resolve, so reaching here is the failure.
					}),
				/server-only|Server-only|Build failed/,
			);
		} finally {
			await Deno.remove(probe).catch(() => {});
			if (!KEEP) await clean();
		}
	},
});

Deno.test({
	name: "the verified artifact is kept when KEEP_BUILD is set",
	sanitizeOps: false,
	sanitizeResources: false,
	ignore: !KEEP,
	fn: async () => {
		const result = await build({ minify: true });
		for (const name of result.outputs) {
			const stat = await Deno.stat(`${result.dist}${name}`);
			assert.ok(stat.isFile && stat.size > 0, `${name} was not written`);
		}
	},
});
