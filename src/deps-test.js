/**
 * TEST wiring. Every client is an in-memory double, so the suite runs with no
 * filesystem, no network and no configuration.
 *
 * `deps.js` pulls this in with a dynamic `import()` only when `APP_ENV=test`;
 * tests that build a container directly import it from here.
 *
 * (The `deps-` prefix rather than `deps.test.js` is deliberate: the latter
 * would be collected as a test file by Deno's default glob.)
 */

import { ENVS, settings } from "~/config/env.js";

import { FakeFileClient } from "./io/doubles/FakeFileClient.js";
import { FakeHttpClient } from "./io/doubles/FakeHttpClient.js";
import { FakeLogger } from "./io/doubles/FakeLogger.js";
import { FakeMailClient } from "./io/doubles/FakeMailClient.js";
import { FixedClock } from "./io/doubles/FixedClock.js";
import { MemoryKvClient } from "./io/doubles/MemoryKvClient.js";
import { SequentialIdClient } from "./io/doubles/SequentialIdClient.js";

/**
 * Build a container of test doubles.
 *
 * `overrides` lets an individual test replace one client — for example passing
 * a real `FileClient` wired to a `FakeHttpClient` in order to assert on the
 * signed URLs that would actually be produced.
 */
export const createTestContainer = (overrides = {}) => {
	const config = settings(ENVS.TEST);
	const clock = overrides.clock ?? FixedClock();
	const logger = overrides.logger ?? FakeLogger();
	const http = overrides.http ?? FakeHttpClient();

	return Object.freeze({
		appEnv: ENVS.TEST,
		config,
		clock,
		logger,
		http,
		ids: overrides.ids ?? SequentialIdClient(),
		kv: overrides.kv ?? MemoryKvClient({ clock }),
		files: overrides.files ?? FakeFileClient(),
		mail: overrides.mail ?? FakeMailClient(),
	});
};
