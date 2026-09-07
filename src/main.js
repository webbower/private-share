/**
 * Entry point.
 *
 * Deno Deploy discovers `Deno.cron` definitions by evaluating the module's
 * top-level scope at deploy time, so the registration below has to sit here,
 * outside any handler and before the server starts.
 */

import { appEnv, ENVS } from "~/config/env.js";
import { createContainer } from "~/deps.js";
import { createApp } from "~/app.js";
import { ready } from "~/render.js";
import { sweepOrphans } from "~/jobs/sweep.js";

const env = appEnv();
const container = await createContainer(env);

// Compile every template once at boot rather than on the first request.
await ready();

if (env === ENVS.PRODUCTION) {
	Deno.cron("sweep abandoned uploads", "0 4 * * *", async () => {
		await sweepOrphans({ ...container, appEnv: env });
	});
}

const app = createApp(container);

container.logger.info("listening", { env });

Deno.serve(app.fetch);
