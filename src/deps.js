/**
 * The one place in the app that decides between real IO and test doubles.
 *
 * Nothing else branches on `APP_ENV`. Services receive a container and call
 * methods on it; they cannot tell whether they are talking to R2 or to a Map,
 * which is what makes the whole app testable without any external dependency
 * being reachable.
 *
 * The wiring for each environment lives next to this file — `deps-test.js`,
 * `deps-development.js`, `deps-production.js` — and is pulled in with a dynamic
 * `import()` only for the environment actually running: a production boot never
 * loads the in-memory doubles or the local-disk dev clients, a test run never
 * loads the R2 signer or the Resend client, and so on. Tests that build a
 * container directly import `createTestContainer` from `./deps-test.js`.
 *
 * The client definitions themselves (`FileClient`, `Clock`, the doubles, …)
 * live in `io/`; this file and its `deps-*.js` siblings only choose which ones
 * to construct.
 */

import { appEnv, ENVS } from "~/config/env.js";

/**
 * @param {string} [env]
 * @param {object} [overrides] only honoured in TEST
 */
export const createContainer = async (env = appEnv(), overrides = {}) => {
	if (env === ENVS.TEST) {
		const { createTestContainer } = await import("./deps-test.js");
		return createTestContainer(overrides);
	}

	if (env === ENVS.DEVELOPMENT) {
		const { createDevContainer } = await import("./deps-development.js");
		return await createDevContainer(env);
	}

	const { createLiveContainer } = await import("./deps-production.js");
	return await createLiveContainer(env);
};
