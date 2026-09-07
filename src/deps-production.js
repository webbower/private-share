/**
 * PRODUCTION wiring. Every client talks to a real service: Cloudflare R2 for
 * blobs, Resend for mail, Deno KV for metadata.
 *
 * `deps.js` pulls this in with a dynamic `import()` only when
 * `APP_ENV=production`, so a dev or test process never loads the R2 signer or
 * the Resend client.
 */

import { assertConfigured, settings } from "~/config/env.js";

import { Clock } from "./io/Clock.js";
import { FileClient } from "./io/FileClient.js";
import { HttpClient } from "./io/HttpClient.js";
import { IdClient } from "./io/IdClient.js";
import { KvClient, openKv } from "./io/KvClient.js";
import { Logger } from "./io/Logger.js";
import { MailClient } from "./io/MailClient.js";

/** Build a container of real clients. */
export const createLiveContainer = async (env) => {
	const config = assertConfigured(settings(env));
	const clock = Clock();
	const logger = Logger({ level: config.logLevel });
	const http = HttpClient({ logger });

	return Object.freeze({
		appEnv: env,
		config,
		clock,
		logger,
		http,
		ids: IdClient(),
		kv: KvClient({ kv: await openKv(), logger }),
		files: FileClient({ http, config: config.storage, clock, logger }),
		mail: MailClient({ http, config: config.mail, logger }),
	});
};
