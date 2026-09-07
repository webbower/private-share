/**
 * Magic-link authentication for uploaders.
 *
 * Two properties matter here:
 *
 * 1. The allowlist is consulted on the server and nowhere else. `tenants.server.js`
 *    is never bundled for the browser, and `tests/build/no_email_leak.test.js`
 *    proves it on every build.
 * 2. The response to a login request is identical whether or not the address is
 *    on the list. An attacker cannot use the login form to enumerate who is
 *    allowed to upload.
 */

import { MAGIC_LINK_TTL_SECONDS, SESSION_TTL_SECONDS } from "~/config/limits.js";
import { MagicLink } from "~/models/MagicLink.js";
import { Session } from "~/models/Session.js";
import { keys } from "~/lib/keys.js";
import { sha256Hex } from "~/lib/crypto.js";

const LOGIN_MAX_PER_WINDOW = 5;
const LOGIN_WINDOW_SECONDS = 60 * 15;

export const AuthService = ({ kv, mail, ids, clock, logger }) => {
	const log = logger?.scoped("auth");

	const normalize = (email) => String(email ?? "").trim().toLowerCase();

	const renderEmail = ({ tenant, link }) => {
		const text = [
			`Sign in to ${tenant.name}`,
			"",
			"Use this link to sign in and upload files:",
			link,
			"",
			`The link works once and expires in ${Math.round(MAGIC_LINK_TTL_SECONDS / 60)} minutes.`,
			"If you did not ask to sign in, you can ignore this message.",
		].join("\n");

		const html = [
			`<p>Use this link to sign in to ${tenant.name} and upload files:</p>`,
			`<p><a href="${link}">Sign in to ${tenant.name}</a></p>`,
			`<p>The link works once and expires in ${Math.round(MAGIC_LINK_TTL_SECONDS / 60)} minutes.</p>`,
			`<p>If you did not ask to sign in, you can ignore this message.</p>`,
		].join("");

		return { text, html };
	};

	return Object.freeze({
		/**
		 * Issue a magic link if the address is allowed. Always resolves the same
		 * shape so the caller cannot leak the allowlist through timing or wording.
		 */
		async requestLink({ tenant, email, origin }) {
			const address = normalize(email);
			const attempts = await kv.increment(keys.loginAttempts(tenant.id, address), {
				expireIn: LOGIN_WINDOW_SECONDS * 1000,
			});
			if (attempts > LOGIN_MAX_PER_WINDOW) {
				log?.warn("login rate limited", { tenant: tenant.id });
				return { accepted: true, sent: false, reason: "rate_limited" };
			}

			if (!tenant.allowsEmail(address)) {
				log?.warn("login attempt for address not on allowlist", { tenant: tenant.id });
				return { accepted: true, sent: false, reason: "not_allowed" };
			}

			const token = ids.token();
			const tokenHash = await sha256Hex(token);
			const now = clock.now();

			const link = MagicLink({
				tokenHash,
				tenantId: tenant.id,
				email: address,
				createdAt: now,
				expiresAt: now + MAGIC_LINK_TTL_SECONDS * 1000,
			});

			await kv.set(keys.magic(tenant.id, tokenHash), link.toJSON(), {
				expireIn: MAGIC_LINK_TTL_SECONDS * 1000,
			});

			const url = `${origin}/auth/callback?token=${encodeURIComponent(token)}`;
			await mail.send({
				to: address,
				subject: `Sign in to ${tenant.name}`,
				...renderEmail({ tenant, link: url }),
			});

			log?.info("magic link sent", { tenant: tenant.id });
			return { accepted: true, sent: true, reason: "sent" };
		},

		/**
		 * Redeem a token. `kv.take` is a single atomic read-and-delete, so a link
		 * forwarded to someone else is already spent.
		 */
		async redeemToken({ tenant, token }) {
			if (!token) return { ok: false, reason: "missing" };
			const tokenHash = await sha256Hex(token);
			const stored = await kv.take(keys.magic(tenant.id, tokenHash));
			if (!stored) return { ok: false, reason: "invalid_or_used" };

			const link = MagicLink.fromJSON(stored);
			if (!link.isValidAt(clock.now())) return { ok: false, reason: "expired" };
			if (link.tenantId !== tenant.id) return { ok: false, reason: "wrong_tenant" };

			const now = clock.now();
			const session = Session({
				id: ids.sessionId(),
				tenantId: tenant.id,
				email: link.email,
				createdAt: now,
				expiresAt: now + SESSION_TTL_SECONDS * 1000,
			});

			await kv.set(keys.session(tenant.id, session.id), session.toJSON(), {
				expireIn: SESSION_TTL_SECONDS * 1000,
			});

			log?.info("session created", { tenant: tenant.id });
			return { ok: true, session };
		},

		/** Resolve a session id, re-checking the allowlist on every request. */
		async sessionFor({ tenant, sessionId }) {
			if (!sessionId) return null;
			const stored = await kv.get(keys.session(tenant.id, sessionId));
			if (!stored) return null;

			const session = Session.fromJSON(stored);
			if (!session.isValidAt(clock.now())) return null;
			if (!session.belongsTo(tenant.id)) return null;

			// Removing an address from the allowlist revokes live sessions too.
			if (!tenant.allowsEmail(session.email)) {
				await kv.delete(keys.session(tenant.id, sessionId));
				log?.warn("session revoked, address no longer allowed", { tenant: tenant.id });
				return null;
			}
			return session;
		},

		async signOut({ tenant, sessionId }) {
			if (sessionId) await kv.delete(keys.session(tenant.id, sessionId));
			return true;
		},
	});
};
