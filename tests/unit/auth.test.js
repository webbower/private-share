import assert from "node:assert/strict";
import { createTestContainer } from "~/deps-test.js";
import { AuthService } from "~/services/auth.js";
import { tenantForHost } from "~/config/tenants.server.js";
import { ENVS } from "~/config/env.js";

const setup = () => {
	const c = createTestContainer();
	return {
		...c,
		auth: AuthService(c),
		tenant: tenantForHost(ENVS.TEST, "test.local"),
		other: tenantForHost(ENVS.TEST, "other.local"),
	};
};

const origin = "https://test.local";

Deno.test("an allowlisted address receives a magic link", async () => {
	const { auth, tenant, mail } = setup();
	const result = await auth.requestLink({ tenant, email: "allowed@test.local", origin });

	assert.equal(result.sent, true);
	assert.equal(mail.sent.length, 1);
	assert.equal(mail.last().to, "allowed@test.local");
	assert.match(mail.lastLink(), /^https:\/\/test\.local\/auth\/callback\?token=/);
});

Deno.test("an address off the allowlist is silently ignored", async () => {
	const { auth, tenant, mail } = setup();
	const result = await auth.requestLink({ tenant, email: "stranger@test.local", origin });

	// The caller-visible shape is identical to the accepted case, so the login
	// form cannot be used to enumerate who is allowed to upload.
	assert.equal(result.accepted, true);
	assert.equal(result.sent, false);
	assert.equal(mail.sent.length, 0);
});

Deno.test("allowlists do not leak across tenants", async () => {
	const { auth, other, mail } = setup();
	// Valid for test.local, but not for other.local.
	await auth.requestLink({ tenant: other, email: "allowed@test.local", origin });
	assert.equal(mail.sent.length, 0);
});

Deno.test("email matching ignores case and surrounding whitespace", async () => {
	const { auth, tenant, mail } = setup();
	await auth.requestLink({ tenant, email: "  ALLOWED@Test.Local  ", origin });
	assert.equal(mail.sent.length, 1);
	assert.equal(mail.last().to, "allowed@test.local");
});

Deno.test("redeeming a token creates a session", async () => {
	const { auth, tenant, mail } = setup();
	await auth.requestLink({ tenant, email: "allowed@test.local", origin });
	const token = new URL(mail.lastLink()).searchParams.get("token");

	const result = await auth.redeemToken({ tenant, token });
	assert.equal(result.ok, true);
	assert.equal(result.session.email, "allowed@test.local");
	assert.equal(result.session.tenantId, tenant.id);
});

Deno.test("a magic link works exactly once", async () => {
	const { auth, tenant, mail } = setup();
	await auth.requestLink({ tenant, email: "allowed@test.local", origin });
	const token = new URL(mail.lastLink()).searchParams.get("token");

	assert.equal((await auth.redeemToken({ tenant, token })).ok, true);
	const replay = await auth.redeemToken({ tenant, token });
	assert.equal(replay.ok, false);
	assert.equal(replay.reason, "invalid_or_used");
});

Deno.test("a magic link expires", async () => {
	const { auth, tenant, mail, clock } = setup();
	await auth.requestLink({ tenant, email: "allowed@test.local", origin });
	const token = new URL(mail.lastLink()).searchParams.get("token");

	clock.advance(16 * 60 * 1000);
	const result = await auth.redeemToken({ tenant, token });
	assert.equal(result.ok, false);
});

Deno.test("a token issued for one tenant cannot be redeemed on another", async () => {
	const { auth, tenant, other, mail } = setup();
	await auth.requestLink({ tenant, email: "allowed@test.local", origin });
	const token = new URL(mail.lastLink()).searchParams.get("token");

	const result = await auth.redeemToken({ tenant: other, token });
	assert.equal(result.ok, false);
});

Deno.test("sessions resolve, expire, and are revoked on removal from the allowlist", async () => {
	const { auth, tenant, mail, clock } = setup();
	await auth.requestLink({ tenant, email: "allowed@test.local", origin });
	const token = new URL(mail.lastLink()).searchParams.get("token");
	const { session } = await auth.redeemToken({ tenant, token });

	assert.ok(await auth.sessionFor({ tenant, sessionId: session.id }));

	// A tenant whose allowlist no longer contains the address invalidates it.
	const narrowed = tenant.merge({ allowedEmails: ["someone-else@test.local"] });
	assert.equal(await auth.sessionFor({ tenant: narrowed, sessionId: session.id }), null);

	clock.advance(31 * 86400000);
	assert.equal(await auth.sessionFor({ tenant, sessionId: session.id }), null);
});

Deno.test("repeated login requests are rate limited", async () => {
	const { auth, tenant, mail } = setup();
	for (let i = 0; i < 8; i += 1) {
		await auth.requestLink({ tenant, email: "allowed@test.local", origin });
	}
	assert.equal(mail.sent.length, 5);
	const last = await auth.requestLink({ tenant, email: "allowed@test.local", origin });
	assert.equal(last.reason, "rate_limited");
});
