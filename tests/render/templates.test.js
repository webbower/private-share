import assert from "node:assert/strict";
import { ready, render, TEMPLATES } from "~/render.js";

const VIEWS = new URL("../../src/views/", import.meta.url);

Deno.test("every template in the manifest exists and compiles", async () => {
	await ready();
	for (const name of TEMPLATES) {
		const source = await Deno.readTextFile(new URL(`${name}.eta`, VIEWS));
		assert.ok(source.length > 0, `${name}.eta is empty`);
	}
});

Deno.test("no .eta file is missing from the manifest", async () => {
	const found = [];
	const walk = async (dir, prefix = "") => {
		for await (const entry of Deno.readDir(dir)) {
			if (entry.isDirectory) await walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
			else if (entry.name.endsWith(".eta")) found.push(prefix + entry.name.replace(/\.eta$/, ""));
		}
	};
	await walk(VIEWS);
	assert.deepEqual(found.sort(), [...TEMPLATES].sort());
});

/**
 * Eta escapes `<%= %>` but not `<%~ %>`. The only legitimate use of the raw tag
 * in this app is composing templates via `include`; anything else would be an
 * unescaped interpolation of data. This locks that down so a future edit that
 * reaches for `<%~ someUserValue %>` fails the build rather than shipping.
 */
Deno.test("raw output is used only for includes", async () => {
	const offenders = [];
	for (const name of TEMPLATES) {
		const source = await Deno.readTextFile(new URL(`${name}.eta`, VIEWS));
		for (const match of source.matchAll(/<%~\s*([\s\S]*?)%>/g)) {
			if (!/^\s*include\s*\(/.test(match[1])) {
				offenders.push(`${name}.eta: <%~ ${match[1].trim().slice(0, 60)} %>`);
			}
		}
	}
	assert.deepEqual(offenders, [], "raw tags must only wrap include()");
});

Deno.test("templates render without leaving unresolved Eta tags", async () => {
	const html = await render("login", { tenantName: "Private Share" });
	assert.ok(!html.includes("<%"), "unrendered tag left in output");
	assert.ok(!html.includes("%>"), "unrendered tag left in output");
	assert.ok(html.trim().startsWith("<!DOCTYPE html>"));
	assert.ok(html.trim().endsWith("</html>"));
});
