/**
 * SERVER ONLY. Never import this from anything under `client/`.
 *
 * The `.server.js` suffix is load-bearing: `scripts/build.js` refuses to bundle
 * any module matching `*.server.js`, and `tests/build/no_email_leak.test.js`
 * greps the built browser bundle for every address listed here.
 *
 * The allowlists are hard-coded per deploy environment on purpose. Uploading is
 * the only privileged action in this app, so the set of people who may upload
 * is a deploy-time decision, reviewed in a pull request, not runtime state.
 */

import { Model } from "~/models/Model.js";
import { isString } from "@webbower/stdlib/lang";

/**
 * A tenant is a domain. Files uploaded through a domain are readable only
 * through that same domain — the tenant id is part of every KV key and every
 * object key, so a share id from one tenant simply does not resolve on another.
 */
export const Tenant = Model.extend({
	name: "Tenant",
	ctor: ({
		id = "",
		domain = "",
		name = "",
		allowedEmails = [],
		maxFileBytes = 100 * 1024 * 1024,
		maxFilesPerUpload = 25,
		maxCollectionBytes = 250 * 1024 * 1024,
		bucketPrefix = "",
	}) => ({
		id: id || domain,
		domain,
		name: name || domain,
		allowedEmails: Object.freeze(allowedEmails.map((e) => String(e).trim().toLowerCase())),
		maxFileBytes,
		maxFilesPerUpload,
		maxCollectionBytes,
		bucketPrefix: bucketPrefix || id || domain,
	}),
	proto: {
		/** Case-insensitive, whitespace-tolerant allowlist check. */
		allowsEmail(email) {
			if (!isString(email)) return false;
			return this.allowedEmails.includes(email.trim().toLowerCase());
		},
		/** Object-key namespace for this tenant inside the shared bucket. */
		keyFor(...parts) {
			return [this.bucketPrefix, ...parts].join("/");
		},
	},
});

/**
 * Hard-coded registry, one block per deploy environment.
 *
 * To add an uploader: add their address to the right `allowedEmails` array,
 * open a PR, let `deno task test` prove it did not leak to the browser, deploy.
 */
const REGISTRY = {
	development: [
		{
			domain: "localhost:8000",
			name: "Private Share (local)",
			allowedEmails: ["webbower@gmail.com"],
			maxFileBytes: 25 * 1024 * 1024,
			maxFilesPerUpload: 10,
			maxCollectionBytes: 100 * 1024 * 1024,
			bucketPrefix: "local",
		},
	],

	test: [
		{
			domain: "test.local",
			name: "Private Share (test)",
			allowedEmails: ["allowed@test.local", "second@test.local"],
			maxFileBytes: 1024 * 1024,
			maxFilesPerUpload: 5,
			maxCollectionBytes: 4 * 1024 * 1024,
			bucketPrefix: "t1",
		},
		{
			domain: "other.local",
			name: "Other tenant (test)",
			allowedEmails: ["allowed@other.local"],
			maxFileBytes: 1024 * 1024,
			maxFilesPerUpload: 5,
			maxCollectionBytes: 4 * 1024 * 1024,
			bucketPrefix: "t2",
		},
	],

	production: [
		{
			domain: "share.bower.family",
			name: "Bower Family Share App",
			allowedEmails: [
				"webbower@gmail.com",
			],
			maxFileBytes: 200 * 1024 * 1024,
			maxFilesPerUpload: 25,
			maxCollectionBytes: 500 * 1024 * 1024,
			bucketPrefix: "bower-share",
		},
		{
			domain: "share.greenblatt.family",
			name: "Greenblatt Family Share App",
			allowedEmails: [
				"you@example.org",
			],
			maxFileBytes: 100 * 1024 * 1024,
			maxFilesPerUpload: 25,
			maxCollectionBytes: 250 * 1024 * 1024,
			bucketPrefix: "greenblatt-share",
		},
	],
};

const cache = new Map();

const buildTenants = (appEnv) => {
	const rows = REGISTRY[appEnv];
	if (!rows) throw new Error(`No tenant registry for APP_ENV=${appEnv}`);
	return Object.freeze(rows.map((row) => Tenant({ id: row.bucketPrefix, ...row })));
};

/** All tenants configured for an environment. */
export const tenantsFor = (appEnv) => {
	if (!cache.has(appEnv)) cache.set(appEnv, buildTenants(appEnv));
	return cache.get(appEnv);
};

/**
 * Resolve the tenant for an inbound request Host header. Returns `null` for an
 * unknown host, which the router turns into a 404 — an unrecognised domain sees
 * nothing at all, not even an error that confirms the app is here.
 */
export const tenantForHost = (appEnv, host) => {
	if (!isString(host)) return null;
	const normalized = host.trim().toLowerCase();
	const bare = normalized.replace(/:443$/, "").replace(/:80$/, "");
	return tenantsFor(appEnv).find((t) => t.domain === normalized || t.domain === bare) ?? null;
};

/** Every address across every tenant in an environment. Used by the leak test. */
export const allAllowedEmails = (appEnv) =>
	Object.freeze(tenantsFor(appEnv).flatMap((t) => [...t.allowedEmails]));
