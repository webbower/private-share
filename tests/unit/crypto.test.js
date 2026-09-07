import assert from "node:assert/strict";
import {
	base64UrlDecode,
	base64UrlEncode,
	hmacSha256Hex,
	sha256Hex,
	sign,
	timingSafeEqual,
	unsign,
} from "~/lib/crypto.js";

Deno.test("sha256 matches the known digest of an empty string", async () => {
	assert.equal(
		await sha256Hex(""),
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	);
});

Deno.test("hmac-sha256 matches RFC 4231 test case 1", async () => {
	const key = new Uint8Array(20).fill(0x0b);
	assert.equal(
		await hmacSha256Hex(key, "Hi There"),
		"b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
	);
});

Deno.test("base64url round-trips and stays URL safe", () => {
	const bytes = new Uint8Array([251, 255, 190, 0, 1, 2]);
	const encoded = base64UrlEncode(bytes);
	assert.ok(!/[+/=]/.test(encoded));
	assert.deepEqual([...base64UrlDecode(encoded)], [...bytes]);
});

Deno.test("timingSafeEqual compares by value and rejects length mismatch", () => {
	assert.equal(timingSafeEqual("abc", "abc"), true);
	assert.equal(timingSafeEqual("abc", "abd"), false);
	assert.equal(timingSafeEqual("abc", "abcd"), false);
});

Deno.test("a signed value round-trips and rejects tampering", async () => {
	const secret = "s3cret";
	const signed = await sign(secret, "session-id-123");

	assert.equal(await unsign(secret, signed), "session-id-123");
	assert.equal(await unsign("wrong-secret", signed), null);
	assert.equal(await unsign(secret, signed.replace("session", "sessiox")), null);
	assert.equal(await unsign(secret, "no-signature-here"), null);
	assert.equal(await unsign(secret, ""), null);
});
