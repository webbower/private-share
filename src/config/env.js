/**
 * Environment resolution. `APP_ENV` is the single switch that decides whether
 * the container hands out real IO clients or test doubles.
 */

export const ENVS = Object.freeze({
	DEVELOPMENT: "development",
	TEST: "test",
	PRODUCTION: "production",
});

const readEnv = (key, fallback = "") => {
	try {
		return Deno.env.get(key) ?? fallback;
	} catch {
		// Permission-less contexts (e.g. a bundler pass) fall back to defaults.
		return fallback;
	}
};

export const appEnv = () => {
	const value = readEnv("APP_ENV", ENVS.DEVELOPMENT).toLowerCase();
	if (!Object.values(ENVS).includes(value)) {
		throw new Error(`APP_ENV must be one of ${Object.values(ENVS).join(", ")}; got "${value}"`);
	}
	return value;
};

export const isTest = () => appEnv() === ENVS.TEST;
export const isProduction = () => appEnv() === ENVS.PRODUCTION;

/**
 * Runtime settings. In test these are fixed so no `.env` file is required and
 * assertions can be written against known values.
 */
export const settings = (env = appEnv()) => {
	if (env === ENVS.TEST) {
		return Object.freeze({
			appEnv: env,
			appSecret: "test-secret-do-not-use-in-production",
			storage: Object.freeze({
				accountId: "test-account",
				bucket: "test-bucket",
				accessKeyId: "TESTACCESSKEY",
				secretAccessKey: "test-secret-access-key",
				endpoint: "https://test-account.r2.cloudflarestorage.com",
				region: "auto",
			}),
			mail: Object.freeze({
				apiKey: "test-mail-key",
				from: "Private Share <no-reply@test.local>",
				endpoint: "https://api.resend.com/emails",
			}),
			logLevel: "silent",
		});
	}

	const accountId = readEnv("R2_ACCOUNT_ID");
	return Object.freeze({
		appEnv: env,
		appSecret: readEnv("APP_SECRET"),
		storage: Object.freeze({
			accountId,
			bucket: readEnv("R2_BUCKET"),
			accessKeyId: readEnv("R2_ACCESS_KEY_ID"),
			secretAccessKey: readEnv("R2_SECRET_ACCESS_KEY"),
			endpoint: readEnv("R2_ENDPOINT", `https://${accountId}.r2.cloudflarestorage.com`),
			region: readEnv("R2_REGION", "auto"),
		}),
		mail: Object.freeze({
			apiKey: readEnv("RESEND_API_KEY"),
			from: readEnv("MAIL_FROM", "Private Share <no-reply@example.com>"),
			endpoint: readEnv("MAIL_ENDPOINT", "https://api.resend.com/emails"),
		}),
		logLevel: readEnv("LOG_LEVEL", env === ENVS.PRODUCTION ? "info" : "debug"),
	});
};

/** Fail fast at boot rather than at first upload. */
export const assertConfigured = (config) => {
	const missing = [];
	if (!config.appSecret) missing.push("APP_SECRET");
	if (!config.storage.bucket) missing.push("R2_BUCKET");
	if (!config.storage.accessKeyId) missing.push("R2_ACCESS_KEY_ID");
	if (!config.storage.secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
	if (!config.storage.accountId && !config.storage.endpoint) missing.push("R2_ACCOUNT_ID");
	if (!config.mail.apiKey) missing.push("RESEND_API_KEY");
	if (missing.length) {
		throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
	}
	return config;
};
