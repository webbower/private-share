/**
 * Route-level tests. These drive the real Hono app over a container of doubles,
 * so every layer runs — middleware, services, models, templates — with nothing
 * reaching the network.
 */

import assert from "node:assert/strict";
import { parse } from "node-html-parser";
import { createApp } from "~/app.js";
import { createTestContainer } from "~/deps-test.js";

const HOST = "test.local";
const ORIGIN = `https://${HOST}`;

const setup = () => {
	const container = createTestContainer();
	return { container, app: createApp(container) };
};

/** Same-origin headers, so the CSRF guard sees what a real form would send. */
const post = (app, path, body, { cookie = "", host = HOST } = {}) =>
	app.request(`https://${host}${path}`, {
		method: "POST",
		headers: {
			host,
			origin: `https://${host}`,
			"sec-fetch-site": "same-origin",
			"content-type": "application/x-www-form-urlencoded",
			...(cookie ? { cookie } : {}),
		},
		body: new URLSearchParams(body).toString(),
	});

const postJson = (app, path, body, { cookie = "", host = HOST } = {}) =>
	app.request(`https://${host}${path}`, {
		method: "POST",
		headers: {
			host,
			origin: `https://${host}`,
			"sec-fetch-site": "same-origin",
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});

const get = (app, path, { cookie = "", host = HOST } = {}) =>
	app.request(`https://${host}${path}`, {
		headers: { host, ...(cookie ? { cookie } : {}) },
	});

const cookieFrom = (response) => (response.headers.get("set-cookie") ?? "").split(";")[0];

/** Sign in and return the session cookie. */
const signIn = async ({ app, container }, email = "allowed@test.local") => {
	await post(app, "/auth/request", { email });
	const token = new URL(container.mail.lastLink()).searchParams.get("token");
	const response = await get(app, `/auth/callback?token=${encodeURIComponent(token)}`);
	return cookieFrom(response);
};

/** Run a whole upload and return the completion page plus the share id. */
const uploadFiles = async (ctx, { files, asCollection = false, withPin = false, ...rest } = {}) => {
	const cookie = await signIn(ctx);
	const begin = await postJson(ctx.app, "/api/uploads", {
		files,
		asCollection,
		expiryDays: 7,
		...rest,
	}, { cookie });
	const plan = await begin.json();

	plan.uploads.forEach((upload, i) => {
		const key = decodeURIComponent(upload.url.split("/upload/")[1]);
		ctx.container.files.putObject(key, { size: files[i].size });
	});
	if (plan.zipUpload) {
		const key = decodeURIComponent(plan.zipUpload.url.split("/upload/")[1]);
		ctx.container.files.putObject(key, { size: 64, contentType: "application/zip" });
	}

	const complete = await post(ctx.app, "/upload/complete", {
		shareId: plan.shareId,
		withPin: withPin ? "1" : "0",
		zipSize: "64",
	}, { cookie });

	return { cookie, shareId: plan.shareId, plan, complete, html: await complete.text() };
};

/** Share ids linked from a completion page, in document order. */
const shareIdsFrom = (html) =>
	parse(html)
		.querySelectorAll('input[id^="share-url"]')
		.map((el) => el.getAttribute("value").split("/s/")[1]);

const ONE = [{ name: "notes.txt", size: 120, type: "text/plain" }];
const TWO = [
	{ name: "north.jpg", size: 200, type: "image/jpeg" },
	{ name: "south.jpg", size: 300, type: "image/jpeg" },
];

// --- host routing ---------------------------------------------------------

Deno.test("an unknown host gets a flat 404", async () => {
	const { app } = setup();
	const response = await get(app, "/", { host: "not-configured.example" });
	assert.equal(response.status, 404);
});

// --- auth -----------------------------------------------------------------

Deno.test("the upload page requires a session", async () => {
	const { app } = setup();
	const response = await get(app, "/");
	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), "/auth/sign-in");
});

Deno.test("signing in through a magic link reaches the upload page", async () => {
	const ctx = setup();
	const cookie = await signIn(ctx);
	assert.ok(cookie.startsWith("hoff_session="));

	const response = await get(ctx.app, "/", { cookie });
	assert.equal(response.status, 200);
	const root = parse(await response.text());
	assert.ok(root.querySelector("#dropzone"));
	assert.match(root.querySelector(".masthead__who").text, /allowed@test\.local/);
});

Deno.test("the sign-in response is the same for an address that is not allowed", async () => {
	const ctx = setup();
	const allowed = await post(ctx.app, "/auth/request", { email: "allowed@test.local" });
	const stranger = await post(ctx.app, "/auth/request", { email: "stranger@test.local" });

	assert.equal(allowed.status, stranger.status);
	// Both pages say "check your email"; only one address actually got one.
	assert.equal(ctx.container.mail.sent.length, 1);
});

Deno.test("a spent magic link is refused", async () => {
	const ctx = setup();
	await post(ctx.app, "/auth/request", { email: "allowed@test.local" });
	const token = new URL(ctx.container.mail.lastLink()).searchParams.get("token");

	await get(ctx.app, `/auth/callback?token=${token}`);
	const replay = await get(ctx.app, `/auth/callback?token=${token}`);
	assert.equal(replay.status, 400);
	assert.match(await replay.text(), /already been used or has expired/);
});

Deno.test("signing out ends the session", async () => {
	const ctx = setup();
	const cookie = await signIn(ctx);
	await get(ctx.app, "/auth/sign-out", { cookie });
	const after = await get(ctx.app, "/", { cookie });
	assert.equal(after.status, 302);
});

Deno.test("a cross-site post is rejected", async () => {
	const { app } = setup();
	const response = await app.request(`${ORIGIN}/auth/request`, {
		method: "POST",
		headers: {
			host: HOST,
			origin: "https://evil.example",
			"sec-fetch-site": "cross-site",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: "email=allowed@test.local",
	});
	assert.equal(response.status, 403);
});

// --- upload ---------------------------------------------------------------

Deno.test("the upload API needs a session", async () => {
	const { app } = setup();
	const response = await postJson(app, "/api/uploads", { files: ONE, expiryDays: 7 });
	assert.equal(response.status, 302);
});

Deno.test("a completed upload renders the slip with link, PIN and delete URL", async () => {
	const ctx = setup();
	const { html, shareId } = await uploadFiles(ctx, { files: ONE, withPin: true });
	const root = parse(html);

	assert.equal(
		root.querySelector("#share-url").getAttribute("value"),
		`${ORIGIN}/s/${shareId}`,
	);
	assert.equal(
		root.querySelector("#delete-url").getAttribute("value"),
		`${ORIGIN}/s/${shareId}/delete`,
	);
	assert.match(root.querySelector("#share-pin").getAttribute("value"), /^\d{6}$/);
	assert.match(root.querySelector(".notice--keep").text, /only time it will be shown/i);
});

Deno.test("an upload without a PIN shows no PIN field", async () => {
	const ctx = setup();
	const { html } = await uploadFiles(ctx, { files: ONE, withPin: false });
	const root = parse(html);
	assert.equal(root.querySelector("#share-pin"), null);
	assert.equal(root.querySelector(".notice--keep"), null);
});

Deno.test("an oversized file is refused with a readable message", async () => {
	const ctx = setup();
	const cookie = await signIn(ctx);
	const response = await postJson(ctx.app, "/api/uploads", {
		files: [{ name: "huge.bin", size: 99 * 1024 * 1024 }],
		expiryDays: 7,
	}, { cookie });

	assert.equal(response.status, 400);
	const body = await response.json();
	assert.equal(body.error, "file_too_large");
	assert.match(body.message, /huge\.bin/);
});

Deno.test("completion fails if the objects never arrived", async () => {
	const ctx = setup();
	const cookie = await signIn(ctx);
	const begin = await postJson(ctx.app, "/api/uploads", { files: ONE, expiryDays: 7 }, { cookie });
	const { shareId } = await begin.json();

	// Note: no putObject calls, so storage is empty.
	const response = await post(ctx.app, "/upload/complete", { shareId, withPin: "0" }, { cookie });
	assert.equal(response.status, 400);
	assert.match(await response.text(), /did not finish uploading/);
});

// --- share views ----------------------------------------------------------

Deno.test("a single-file share renders a download button", async () => {
	const ctx = setup();
	const { shareId } = await uploadFiles(ctx, { files: ONE });

	const response = await get(ctx.app, `/s/${shareId}`);
	assert.equal(response.status, 200);
	const root = parse(await response.text());
	assert.equal(root.querySelector("h1").text.trim(), "notes.txt");
	assert.equal(root.querySelectorAll('a[href*="/download"]').length, 1);
});

Deno.test("a collection renders a listing and a Download all button", async () => {
	const ctx = setup();
	const { shareId } = await uploadFiles(ctx, {
		files: TWO,
		asCollection: true,
		collectionTitle: "Site survey",
	});

	const root = parse(await (await get(ctx.app, `/s/${shareId}`)).text());
	assert.equal(root.querySelector("h1").text.trim(), "Site survey");
	assert.equal(root.querySelectorAll(".manifest__row").length, 2);
	assert.ok(root.querySelector(`a[href="/s/${shareId}/download-all"]`));
});

Deno.test("files uploaded without the collection box get a link and delete URL each", async () => {
	const ctx = setup();
	const { html } = await uploadFiles(ctx, { files: TWO, asCollection: false });
	const root = parse(html);

	const shareLinks = root.querySelectorAll('input[id^="share-url"]').map((el) => el.getAttribute("value"));
	const deleteLinks = root.querySelectorAll('input[id^="delete-url"]').map((el) => el.getAttribute("value"));
	const openLinks = root.querySelectorAll('.copyfield a[target="_blank"]').map((a) => a.getAttribute("href"));

	assert.equal(shareLinks.length, 2, "one share link per file");
	assert.equal(deleteLinks.length, 2, "one delete link per file");
	assert.notEqual(shareLinks[0], shareLinks[1], "the two shares are distinct");
	shareLinks.forEach((link, i) => assert.equal(deleteLinks[i], `${link}/delete`));
	assert.deepEqual([...openLinks].sort(), [...shareLinks].sort(), "an Open link points at each share");

	// Every listed share actually resolves on its own.
	for (const id of shareIdsFrom(html)) {
		assert.equal((await get(ctx.app, `/s/${id}`)).status, 200);
	}
});

Deno.test("deleting one ungrouped share leaves its siblings untouched", async () => {
	const ctx = setup();
	const { html } = await uploadFiles(ctx, { files: TWO, asCollection: false });
	const [firstId, secondId] = shareIdsFrom(html);

	const deleted = await post(ctx.app, `/s/${firstId}/delete`, {});
	assert.equal(deleted.status, 200);

	assert.equal((await get(ctx.app, `/s/${firstId}`)).status, 404);
	assert.equal((await get(ctx.app, `/s/${secondId}`)).status, 200);
});

Deno.test("a single-file upload still renders one slip with an Open link", async () => {
	const ctx = setup();
	const { html, shareId } = await uploadFiles(ctx, { files: ONE });
	const root = parse(html);

	assert.equal(root.querySelectorAll('input[id^="share-url"]').length, 1);
	assert.equal(root.querySelector("#share-url").getAttribute("value"), `${ORIGIN}/s/${shareId}`);
	const open = root.querySelector('.copyfield a[target="_blank"]');
	assert.equal(open.getAttribute("href"), `${ORIGIN}/s/${shareId}`);
});

Deno.test("downloads redirect to storage rather than proxying bytes", async () => {
	const ctx = setup();
	const { shareId } = await uploadFiles(ctx, { files: ONE });
	const root = parse(await (await get(ctx.app, `/s/${shareId}`)).text());
	const href = root.querySelector('a[href*="/download"]').getAttribute("href");

	const response = await get(ctx.app, href);
	assert.equal(response.status, 302);
	assert.match(response.headers.get("location"), /^https:\/\/fake-storage\.test\/download\//);
	assert.equal(await response.text(), "");
});

Deno.test("an expired share reads as gone", async () => {
	const ctx = setup();
	const { shareId } = await uploadFiles(ctx, { files: ONE });

	ctx.container.clock.advanceDays(8);
	const response = await get(ctx.app, `/s/${shareId}`);
	assert.equal(response.status, 404);
	assert.match(await response.text(), /This link has expired/);
});

Deno.test("a share is invisible from another tenant's domain", async () => {
	const ctx = setup();
	const { shareId } = await uploadFiles(ctx, { files: ONE });

	assert.equal((await get(ctx.app, `/s/${shareId}`)).status, 200);
	const cross = await get(ctx.app, `/s/${shareId}`, { host: "other.local" });
	assert.equal(cross.status, 404);
});

// --- PIN gate -------------------------------------------------------------

Deno.test("a PIN-protected share shows the gate and nothing else", async () => {
	const ctx = setup();
	const { shareId, html } = await uploadFiles(ctx, { files: ONE, withPin: true });

	const response = await get(ctx.app, `/s/${shareId}`);
	assert.equal(response.status, 401);

	const body = await response.text();
	assert.ok(parse(body).querySelector("#pin"));
	// A crawler landing here learns nothing about the contents.
	assert.ok(!body.includes("notes.txt"));
	assert.equal(parse(body).querySelector('a[href*="/download"]'), null);
	assert.ok(html.includes("share-pin"));
});

Deno.test("the correct PIN unlocks the share", async () => {
	const ctx = setup();
	const { shareId, html } = await uploadFiles(ctx, { files: ONE, withPin: true });
	const pin = parse(html).querySelector("#share-pin").getAttribute("value");

	const unlock = await post(ctx.app, `/s/${shareId}/unlock`, { pin });
	assert.equal(unlock.status, 302);
	const pinCookie = cookieFrom(unlock);

	const view = await get(ctx.app, `/s/${shareId}`, { cookie: pinCookie });
	assert.equal(view.status, 200);
	assert.match(await view.text(), /notes\.txt/);
});

Deno.test("a wrong PIN reports the tries remaining and eventually locks out", async () => {
	const ctx = setup();
	const { shareId } = await uploadFiles(ctx, { files: ONE, withPin: true });

	const first = await post(ctx.app, `/s/${shareId}/unlock`, { pin: "000000" });
	assert.equal(first.status, 401);
	assert.match(await first.text(), /7 tries left/);

	for (let i = 0; i < 7; i += 1) {
		await post(ctx.app, `/s/${shareId}/unlock`, { pin: "000000" });
	}
	const locked = await post(ctx.app, `/s/${shareId}/unlock`, { pin: "000000" });
	assert.equal(locked.status, 429);
	assert.match(await locked.text(), /Too many wrong tries/);
});

Deno.test("a download cannot bypass the PIN gate", async () => {
	const ctx = setup();
	const { shareId, html } = await uploadFiles(ctx, { files: ONE, withPin: true });
	assert.ok(html);

	const response = await get(ctx.app, `/s/${shareId}/f/anything/download`);
	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), `/s/${shareId}`);
});

// --- deletion -------------------------------------------------------------

Deno.test("the delete URL purges the share and every object", async () => {
	const ctx = setup();
	const { shareId } = await uploadFiles(ctx, {
		files: TWO,
		asCollection: true,
		collectionTitle: "Site survey",
	});
	assert.equal(ctx.container.files.keys().length, 3, "two files and a zip");

	const confirm = await get(ctx.app, `/s/${shareId}/delete`);
	assert.equal(confirm.status, 200);
	assert.match(await confirm.text(), /cannot be undone/);

	const deleted = await post(ctx.app, `/s/${shareId}/delete`, {});
	assert.equal(deleted.status, 200);
	assert.match(await deleted.text(), /Deleted/);

	assert.equal(ctx.container.files.keys().length, 0);
	assert.equal((await get(ctx.app, `/s/${shareId}`)).status, 404);
});

Deno.test("deleting a PIN-protected share requires the PIN", async () => {
	const ctx = setup();
	const { shareId, html } = await uploadFiles(ctx, { files: ONE, withPin: true });
	const pin = parse(html).querySelector("#share-pin").getAttribute("value");

	const refused = await post(ctx.app, `/s/${shareId}/delete`, { pin: "000000" });
	assert.equal(refused.status, 401);
	assert.equal(ctx.container.files.keys().length, 1, "nothing was deleted");

	const accepted = await post(ctx.app, `/s/${shareId}/delete`, { pin });
	assert.equal(accepted.status, 200);
	assert.equal(ctx.container.files.keys().length, 0);
});

// --- crawlers -------------------------------------------------------------

Deno.test("robots.txt disallows everything", async () => {
	const { app } = setup();
	const body = await (await get(app, "/robots.txt")).text();
	assert.match(body, /Disallow: \/$/m);
});
