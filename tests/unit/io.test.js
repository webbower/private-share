import assert from "node:assert/strict";
import { FakeHttpClient } from "~/io/doubles/FakeHttpClient.js";
import { FixedClock } from "~/io/doubles/FixedClock.js";
import { FakeLogger } from "~/io/doubles/FakeLogger.js";
import { MemoryKvClient } from "~/io/doubles/MemoryKvClient.js";
import { FileClient } from "~/io/FileClient.js";
import { MailClient } from "~/io/MailClient.js";
import { HttpError } from "~/io/HttpClient.js";
import { createTestContainer } from "~/deps-test.js";
import { settings } from "~/config/env.js";
import { ENVS } from "~/config/env.js";

/**
 * FileClient over a FakeHttpClient: exercises the real signing and the real
 * request shapes, with nothing leaving the process.
 */
const realFileClient = () => {
	const http = FakeHttpClient();
	const clock = FixedClock();
	const files = FileClient({
		http,
		clock,
		logger: FakeLogger(),
		config: settings(ENVS.TEST).storage,
	});
	return { http, clock, files };
};

Deno.test("presigned upload URLs point at the configured bucket and expire", async () => {
	const { files } = realFileClient();
	const { url, headers } = await files.presignUpload("t1/d7/abc/file.txt", {
		contentLength: 4096,
		contentType: "text/plain",
		expiresIn: 900,
	});

	const parsed = new URL(url);
	assert.equal(parsed.host, "test-account.r2.cloudflarestorage.com");
	assert.equal(parsed.pathname, "/test-bucket/t1/d7/abc/file.txt");
	assert.equal(parsed.searchParams.get("X-Amz-Expires"), "900");
	assert.match(parsed.searchParams.get("X-Amz-SignedHeaders"), /content-length/);
	assert.equal(headers["content-length"], "4096");
});

Deno.test("presigned downloads force an attachment with the display filename", async () => {
	const { files } = realFileClient();
	const url = await files.presignDownload("t1/d7/abc/x.bin", { filename: "Q3 résumé.pdf" });
	const disposition = new URL(url).searchParams.get("response-content-disposition");

	assert.match(disposition, /^attachment;/);
	// Non-ASCII names need the RFC 5987 form alongside an ASCII fallback.
	assert.match(disposition, /filename="Q3 r_sum_\.pdf"/);
	assert.match(disposition, /filename\*=UTF-8''Q3%20r%C3%A9sum%C3%A9\.pdf/);
});

Deno.test("head reports existence and size, and treats 404 as absence", async () => {
	const { http, files } = realFileClient();
	http.on("HEAD", /x\.bin$/, { status: 200, headers: { "content-length": "512", etag: '"e"' } });
	http.on("HEAD", /missing$/, { status: 404 });

	assert.deepEqual(
		await files.head("t1/d7/abc/x.bin"),
		{ exists: true, size: 512, etag: '"e"', contentType: null },
	);
	assert.equal((await files.head("t1/d7/abc/missing")).exists, false);
});

Deno.test("server-side requests carry a SigV4 Authorization header", async () => {
	const { http, files } = realFileClient();
	http.on("DELETE", /.*/, { status: 204 });
	await files.delete("t1/d7/abc/x.bin");

	const call = http.lastCall();
	assert.equal(call.method, "DELETE");
	assert.match(call.headers.authorization, /^AWS4-HMAC-SHA256 Credential=TESTACCESSKEY/);
	assert.equal(call.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
});

Deno.test("bulk delete reports failures without abandoning the rest", async () => {
	const { http, files } = realFileClient();
	http.on("DELETE", /bad$/, { status: 500 });
	http.on("DELETE", /.*/, { status: 204 });

	const result = await files.deleteMany(["ok-1", "bad", "ok-2"]);
	assert.equal(result.deleted, 2);
	assert.deepEqual(result.failed, ["bad"]);
});

Deno.test("the mail client posts to the provider with a bearer token", async () => {
	const http = FakeHttpClient();
	const config = settings(ENVS.TEST).mail;
	http.on("POST", config.endpoint, { status: 200, json: { id: "e_1" } });

	const mail = MailClient({ http, config, logger: FakeLogger() });
	const result = await mail.send({ to: "a@test.local", subject: "Hi", text: "body", html: "<p>b</p>" });

	assert.equal(result.id, "e_1");
	const call = http.lastCall();
	assert.equal(call.headers.authorization, "Bearer test-mail-key");
	assert.deepEqual(http.jsonBodyOf(call).to, ["a@test.local"]);
});

Deno.test("an unstubbed call fails loudly instead of reaching the network", async () => {
	const http = FakeHttpClient();
	await assert.rejects(() => http.get("https://example.com/nope"), HttpError);
});

Deno.test("memory KV honours TTL against the injected clock", async () => {
	const clock = FixedClock();
	const kv = MemoryKvClient({ clock });

	await kv.set(["a"], 1, { expireIn: 1000 });
	assert.equal(await kv.get(["a"]), 1);
	clock.advance(1001);
	assert.equal(await kv.get(["a"]), null);
});

Deno.test("take is a single-shot read", async () => {
	const kv = MemoryKvClient();
	await kv.set(["t"], "value");
	assert.equal(await kv.take(["t"]), "value");
	assert.equal(await kv.take(["t"]), null);
});

Deno.test("increment keeps its original window rather than extending it", async () => {
	const clock = FixedClock();
	const kv = MemoryKvClient({ clock });

	assert.equal(await kv.increment(["c"], { expireIn: 1000 }), 1);
	clock.advance(600);
	assert.equal(await kv.increment(["c"], { expireIn: 1000 }), 2);
	clock.advance(500);
	// A burst of attempts must not push the lockout further out.
	assert.equal(await kv.get(["c"]), null);
});

Deno.test("list filters by key prefix", async () => {
	const kv = MemoryKvClient();
	await kv.set(["share", "t1", "a"], 1);
	await kv.set(["share", "t1", "b"], 2);
	await kv.set(["share", "t2", "c"], 3);

	assert.equal((await kv.list(["share", "t1"])).length, 2);
	assert.equal((await kv.list(["share"])).length, 3);
});

Deno.test("the test container hands out doubles, never live clients", () => {
	const c = createTestContainer();
	assert.equal(c.appEnv, ENVS.TEST);
	assert.ok(Array.isArray(c.mail.sent), "mail is the fake");
	assert.ok(typeof c.files.putObject === "function", "storage is the fake");
	assert.ok(typeof c.clock.advance === "function", "clock is controllable");
	assert.ok(Array.isArray(c.logger.lines), "logger records rather than prints");
	// No configuration is required for a test run.
	assert.equal(c.config.storage.bucket, "test-bucket");
});

Deno.test("an individual client can be overridden for one test", () => {
	const clock = FixedClock(0);
	const c = createTestContainer({ clock });
	assert.equal(c.clock.now(), 0);
});

Deno.test("the logger records at levels and supports scoping", () => {
	const logger = FakeLogger();
	logger.info("plain");
	logger.scoped("files").warn("scoped");

	assert.deepEqual(logger.messagesAt("info"), ["plain"]);
	assert.equal(logger.lines.at(-1).scope, "files");
});
