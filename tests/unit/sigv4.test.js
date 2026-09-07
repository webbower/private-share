import assert from "node:assert/strict";
import { amzDate, dateStamp, encodeKeyPath, presign, signRequest } from "~/lib/sigv4.js";

/**
 * Reference vector from the AWS documentation, "Example: Signature Calculation
 * for Presigned URL" (GET examplebucket/test.txt, 86400s). If this passes, the
 * canonical-request and string-to-sign construction is correct.
 */
Deno.test("presign reproduces the AWS reference signature", async () => {
	const url = await presign({
		method: "GET",
		endpoint: "https://examplebucket.s3.amazonaws.com",
		bucket: "",
		key: "test.txt",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		region: "us-east-1",
		service: "s3",
		expiresIn: 86400,
		date: new Date("2013-05-24T00:00:00Z"),
	});

	const signature = new URL(url).searchParams.get("X-Amz-Signature");
	assert.equal(signature, "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
});

Deno.test("presign uses path style when a bucket is supplied", async () => {
	const url = await presign({
		method: "PUT",
		endpoint: "https://acct.r2.cloudflarestorage.com",
		bucket: "private-share",
		key: "t1/d7/abc/file.txt",
		accessKeyId: "K",
		secretAccessKey: "S",
		date: new Date("2026-03-01T12:00:00Z"),
	});
	assert.ok(url.startsWith("https://acct.r2.cloudflarestorage.com/private-share/t1/d7/abc/file.txt?"));
});

Deno.test("signed headers are listed and enforceable", async () => {
	const url = await presign({
		method: "PUT",
		endpoint: "https://acct.r2.cloudflarestorage.com",
		bucket: "b",
		key: "k",
		accessKeyId: "K",
		secretAccessKey: "S",
		headers: { "content-length": "1024", "content-type": "text/plain" },
		date: new Date("2026-03-01T12:00:00Z"),
	});
	const signed = new URL(url).searchParams.get("X-Amz-SignedHeaders");
	assert.equal(signed, "content-length;content-type;host");
});

Deno.test("changing a signed header value changes the signature", async () => {
	const base = {
		method: "PUT",
		endpoint: "https://acct.r2.cloudflarestorage.com",
		bucket: "b",
		key: "k",
		accessKeyId: "K",
		secretAccessKey: "S",
		date: new Date("2026-03-01T12:00:00Z"),
	};
	const a = await presign({ ...base, headers: { "content-length": "1024" } });
	const b = await presign({ ...base, headers: { "content-length": "1025" } });
	const sig = (u) => new URL(u).searchParams.get("X-Amz-Signature");
	assert.notEqual(sig(a), sig(b));
});

Deno.test("object keys keep slashes but escape unsafe characters", () => {
	assert.equal(encodeKeyPath("a/b c/d+e.txt"), "a/b%20c/d%2Be.txt");
	assert.equal(encodeKeyPath("t1/d7/id/file(1).png"), "t1/d7/id/file%281%29.png");
});

Deno.test("date helpers produce AWS formats", () => {
	const d = new Date("2026-03-01T12:34:56.789Z");
	assert.equal(amzDate(d), "20260301T123456Z");
	assert.equal(dateStamp(d), "20260301");
});

Deno.test("signRequest returns an Authorization header for server-side calls", async () => {
	const { url, headers } = await signRequest({
		method: "DELETE",
		endpoint: "https://acct.r2.cloudflarestorage.com",
		bucket: "b",
		key: "t1/d7/x/y.bin",
		accessKeyId: "K",
		secretAccessKey: "S",
		date: new Date("2026-03-01T12:00:00Z"),
	});
	assert.equal(url, "https://acct.r2.cloudflarestorage.com/b/t1/d7/x/y.bin");
	assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=K\/20260301\/auto\/s3\/aws4_request/);
	assert.match(headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
	assert.equal(headers["x-amz-date"], "20260301T120000Z");
});
