/**
 * Frontend build.
 *
 * Bundles `client/upload.js` and copies the stylesheet into `static/dist`,
 * which is what `src/static.js` serves and what the pre-deploy check inspects.
 *
 * The build refuses to bundle any module matching `*.server.js`. That is the
 * mechanical half of keeping the uploader allowlist off the wire; the other
 * half is `tests/build/no_email_leak.test.js`, which greps the finished output
 * for every address in the registry. Belt and braces, because a mistake here is
 * silent and permanent — once a bundle ships with those addresses in it, they
 * are public.
 */

import * as esbuild from "esbuild";

const ROOT = new URL("../", import.meta.url);
const DIST = new URL("static/dist/", ROOT);

const path = (url) => decodeURIComponent(new URL(url).pathname);

/**
 * Fails the build if anything in the browser graph imports a server-only
 * module, naming the importer so the mistake is obvious.
 */
const refuseServerModules = {
	name: "refuse-server-modules",
	setup(build) {
		build.onResolve({ filter: /\.server(\.js)?$/ }, (args) => ({
			errors: [{
				text: `Server-only module "${args.path}" cannot be bundled for the browser.`,
				notes: [{
					text: `Imported by ${args.importer}. Move whatever is needed into a ` +
						`module without the .server suffix, or keep the logic on the server.`,
				}],
			}],
		}));
	},
};

export const build = async ({ minify = true, sourcemap = false, entryPoints } = {}) => {
	await Deno.mkdir(path(DIST), { recursive: true });

	const result = await esbuild.build({
		entryPoints: entryPoints ?? [path(new URL("client/upload.js", ROOT))],
		outfile: path(new URL("upload.js", DIST)),
		bundle: true,
		format: "esm",
		target: ["es2022"],
		platform: "browser",
		minify,
		sourcemap,
		legalComments: "none",
		plugins: [refuseServerModules],
		// Resolve the handful of npm deps the browser bundle needs from the
		// local node_modules Deno populates.
		nodePaths: [path(new URL("node_modules", ROOT))],
		logLevel: "silent",
	});

	await Deno.copyFile(
		path(new URL("static/css/app.css", ROOT)),
		path(new URL("app.css", DIST)),
	);

	const outputs = ["upload.js", "app.css"];
	const sizes = {};
	for (const name of outputs) {
		sizes[name] = (await Deno.stat(path(new URL(name, DIST)))).size;
	}

	return { dist: path(DIST), outputs, sizes, warnings: result.warnings };
};

export const clean = async () => {
	await Deno.remove(path(DIST), { recursive: true }).catch(() => {});
};

if (import.meta.main) {
	const args = new Set(Deno.args);
	try {
		const result = await build({
			minify: !args.has("--no-minify"),
			sourcemap: args.has("--sourcemap"),
		});
		for (const name of result.outputs) {
			console.log(`  ${name.padEnd(12)} ${(result.sizes[name] / 1024).toFixed(1)} KB`);
		}
		console.log(`built to ${result.dist}`);
	} catch (error) {
		console.error(error.message ?? error);
		Deno.exit(1);
	} finally {
		await esbuild.stop();
	}
}
