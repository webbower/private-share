/**
 * DEVELOPMENT wiring. Real Clock, Logger, KV (Deno KV writes to a local SQLite
 * file) and id generation, but mail prints to the terminal and object storage
 * is a directory on disk — so `deno task dev` needs no R2 or Resend account.
 *
 * `deps.js` pulls this in with a dynamic `import()` only when
 * `APP_ENV=development`, so a production or test process never loads the
 * local-disk / console clients.
 */

import { settings } from "~/config/env.js";

import { Clock } from "./io/Clock.js";
import { ConsoleMailClient } from "./io/ConsoleMailClient.js";
import { HttpClient } from "./io/HttpClient.js";
import { IdClient } from "./io/IdClient.js";
import { KvClient, openKv } from "./io/KvClient.js";
import { LocalFileClient } from "./io/LocalFileClient.js";
import { Logger } from "./io/Logger.js";

/**
 * Build a container for local development with no external services.
 *
 * No R2 or Resend credentials are read, so `assertConfigured` is skipped; only
 * `APP_SECRET` matters, and a throwaway one is used if it is unset.
 */
export const createDevContainer = async (env) => {
	const resolved = settings(env);
	const config = resolved.appSecret
		? resolved
		: Object.freeze({ ...resolved, appSecret: "dev-insecure-app-secret-set-APP_SECRET-in-.env" });

	const clock = Clock();
	const logger = Logger({ level: config.logLevel });
	const http = HttpClient({ logger });

	if (!resolved.appSecret) {
		logger.warn("APP_SECRET is not set; using an insecure development default");
	}
	logger.warn(
		"development container: email prints to this terminal, files are stored under .local-storage/. " +
			"No R2 or Resend credentials are used.",
	);

	// `deno task test` builds and then deletes static/dist as part of the
	// leak check, which leaves a running dev server serving 404 for the upload
	// script — and the upload button silently never enables. Catch it at boot.
	try {
		await Deno.stat(new URL("../static/dist/upload.js", import.meta.url));
	} catch {
		logger.warn(
			"static/dist/upload.js is missing — the upload page will not work. Run `deno task build` " +
				"(the test suite removes this artifact unless run with KEEP_BUILD=1).",
		);
	}

	return Object.freeze({
		appEnv: env,
		config,
		clock,
		logger,
		http,
		ids: IdClient(),
		kv: KvClient({ kv: await openKv(), logger }),
		files: LocalFileClient({ logger }),
		mail: ConsoleMailClient({ logger }),
	});
};
