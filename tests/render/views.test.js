import assert from "node:assert/strict";
import { parse } from "node-html-parser";
import { render } from "~/render.js";
import { Share } from "~/models/Share.js";
import { DEFAULT_EXPIRY_DAYS } from "~/config/limits.js";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const IN_A_WEEK = NOW + 7 * 86400000;

const dom = async (view, data) => parse(await render(view, data));

const singleFile = Share({
	id: "shr1",
	tenantId: "t1",
	kind: "file",
	title: "Q3 numbers.csv",
	files: [{ id: "f1", filename: "raw-export.csv", title: "Q3 numbers.csv", size: 20480 }],
	createdAt: NOW,
	expiresAt: IN_A_WEEK,
	expiryDays: 7,
});

const collection = Share({
	id: "shr2",
	tenantId: "t1",
	kind: "collection",
	title: "Site survey",
	files: [
		{ id: "f1", filename: "north.jpg", title: "North elevation", size: 1048576 },
		{ id: "f2", filename: "south.jpg", title: "South elevation", size: 2097152 },
		{ id: "f3", filename: "notes.pdf", title: "notes.pdf", size: 51200 },
	],
	zipKey: "t1/d7/shr2/collection.zip",
	zipSize: 3100000,
	createdAt: NOW,
	expiresAt: IN_A_WEEK,
	expiryDays: 7,
});

// --- upload screen --------------------------------------------------------

Deno.test("upload screen renders every configured expiry option", async () => {
	const root = await dom("upload", {
		tenantName: "Private Share",
		currentEmail: "allowed@test.local",
		maxFileBytes: 1048576,
		maxTotalBytes: 4194304,
		maxFiles: 5,
		maxFileLabel: "1 MB",
		defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
		clientScript: "/assets/upload.js",
	});

	const options = root.querySelectorAll("#expiry option").map((o) => ({
		value: o.getAttribute("value"),
		label: o.text.trim(),
	}));

	assert.deepEqual(options, [
		{ value: "1", label: "1 day" },
		{ value: "3", label: "3 days" },
		{ value: "7", label: "1 week" },
		{ value: "14", label: "2 weeks" },
		{ value: "30", label: "1 month" },
	]);
	assert.equal(root.querySelector("#expiry option[selected]").getAttribute("value"), "7");
});

Deno.test("the collection checkbox starts hidden, for the browser to reveal", async () => {
	const root = await dom("upload", {
		maxFileBytes: 1,
		maxTotalBytes: 1,
		maxFiles: 5,
		maxFileLabel: "1 MB",
		defaultExpiryDays: 7,
		clientScript: "/assets/upload.js",
	});
	// Only shown once more than one file is staged; see client/upload.js.
	assert.ok(root.querySelector("#collection-toggle").hasAttribute("hidden"));
	assert.ok(root.querySelector("#collection-title-field").hasAttribute("hidden"));
	assert.ok(root.querySelector("#as-collection"));
});

Deno.test("upload limits reach the browser as data attributes", async () => {
	const root = await dom("upload", {
		maxFileBytes: 1048576,
		maxTotalBytes: 4194304,
		maxFiles: 5,
		maxFileLabel: "1 MB",
		defaultExpiryDays: 7,
		clientScript: "/assets/upload.js",
	});
	const form = root.querySelector("#upload-form");
	assert.equal(form.getAttribute("data-max-file-bytes"), "1048576");
	assert.equal(form.getAttribute("data-max-total-bytes"), "4194304");
	assert.equal(form.getAttribute("data-max-files"), "5");
});

Deno.test("the signed-in address appears once the session is known", async () => {
	const root = await dom("upload", {
		currentEmail: "allowed@test.local",
		maxFileBytes: 1,
		maxTotalBytes: 1,
		maxFiles: 5,
		maxFileLabel: "1 MB",
		defaultExpiryDays: 7,
	});
	assert.match(root.querySelector(".masthead__who").text, /allowed@test\.local/);
});

// --- completion screen ----------------------------------------------------

Deno.test("completion screen shows share, PIN and delete fields with copy buttons", async () => {
	const root = await dom("complete", {
		share: singleFile.toViewModel(),
		shareUrl: "https://test.local/s/shr1",
		deleteUrl: "https://test.local/s/shr1/delete",
		pin: "482913",
		now: NOW,
		clientScript: "/assets/upload.js",
	});

	assert.equal(root.querySelector("#share-url").getAttribute("value"), "https://test.local/s/shr1");
	assert.equal(root.querySelector("#share-pin").getAttribute("value"), "482913");
	assert.equal(
		root.querySelector("#delete-url").getAttribute("value"),
		"https://test.local/s/shr1/delete",
	);

	const copyTargets = root.querySelectorAll("[data-copy-for]").map((b) => b.getAttribute("data-copy-for"));
	assert.deepEqual(copyTargets.sort(), ["delete-url", "share-pin", "share-url"]);
});

Deno.test("the delete URL is the share URL plus /delete", async () => {
	const root = await dom("complete", {
		share: singleFile.toViewModel(),
		shareUrl: "https://test.local/s/shr1",
		deleteUrl: "https://test.local/s/shr1/delete",
		pin: null,
		now: NOW,
	});
	const shareUrl = root.querySelector("#share-url").getAttribute("value");
	assert.equal(root.querySelector("#delete-url").getAttribute("value"), `${shareUrl}/delete`);
});

Deno.test("the unrecoverable-PIN warning appears only when a PIN was set", async () => {
	const withPin = await dom("complete", {
		share: singleFile.toViewModel(),
		shareUrl: "https://test.local/s/shr1",
		deleteUrl: "https://test.local/s/shr1/delete",
		pin: "482913",
		now: NOW,
	});
	assert.match(withPin.querySelector(".notice--keep").text, /only time it will be shown/i);

	const withoutPin = await dom("complete", {
		share: singleFile.toViewModel(),
		shareUrl: "https://test.local/s/shr1",
		deleteUrl: "https://test.local/s/shr1/delete",
		pin: null,
		now: NOW,
	});
	assert.equal(withoutPin.querySelector(".notice--keep"), null);
	assert.equal(withoutPin.querySelector("#share-pin"), null);
});

Deno.test("completion screen always offers sharing guidance", async () => {
	const root = await dom("complete", {
		share: singleFile.toViewModel(),
		shareUrl: "https://test.local/s/shr1",
		deleteUrl: "https://test.local/s/shr1/delete",
		pin: null,
		now: NOW,
	});
	assert.equal(root.querySelectorAll(".tips li").length, 5);
});

Deno.test("completion screen offers the details as a .txt download when one is supplied", async () => {
	const withDownload = await dom("complete", {
		share: singleFile.toViewModel(),
		shareUrl: "https://test.local/s/shr1",
		deleteUrl: "https://test.local/s/shr1/delete",
		pin: null,
		now: NOW,
		summaryDownload: {
			filename: "test.local Upload at Mar 1, 2026 1200pm.txt",
			href: "data:text/plain;charset=utf-8,hello%20world",
		},
	});
	const link = withDownload.querySelector(".actions a[download]");
	assert.ok(link, "a download link is rendered");
	assert.equal(link.getAttribute("download"), "test.local Upload at Mar 1, 2026 1200pm.txt");
	assert.match(link.getAttribute("href"), /^data:text\/plain;charset=utf-8,/);
	assert.match(link.text, /Save a copy of these details/);

	// Absent when the local is not provided (e.g. the collection/one-file paths
	// that render `complete` directly in other tests).
	const without = await dom("complete", {
		share: singleFile.toViewModel(),
		shareUrl: "https://test.local/s/shr1",
		deleteUrl: "https://test.local/s/shr1/delete",
		pin: null,
		now: NOW,
	});
	assert.equal(without.querySelector(".actions a[download]"), null);
});

Deno.test("completion screen states the expiry date", async () => {
	const root = await dom("complete", {
		share: singleFile.toViewModel(),
		shareUrl: "https://test.local/s/shr1",
		deleteUrl: "https://test.local/s/shr1/delete",
		pin: null,
		now: NOW,
	});
	assert.match(root.querySelector(".lede").text, /in 7 days/);
	assert.match(root.querySelector(".lede").text, /8 Mar 2026/);
});

Deno.test("the share link carries an Open button next to Copy", async () => {
	const root = await dom("complete", {
		share: singleFile.toViewModel(),
		shareUrl: "https://test.local/s/shr1",
		deleteUrl: "https://test.local/s/shr1/delete",
		pin: null,
		now: NOW,
	});
	const open = root.querySelector('.copyfield a[target="_blank"]');
	assert.ok(open, "an Open link is present");
	assert.equal(open.getAttribute("href"), "https://test.local/s/shr1");
	assert.equal(open.getAttribute("rel"), "noopener");
});

Deno.test("completion screen lists one slip per file when files are shared separately", async () => {
	const slip = (id, title, size, pin = null) => {
		const share = Share({
			id,
			tenantId: "t1",
			kind: "file",
			title,
			files: [{ id: "f1", filename: title, title, size }],
			createdAt: NOW,
			expiresAt: IN_A_WEEK,
			expiryDays: 7,
		});
		return {
			share: share.toViewModel(),
			shareUrl: `https://test.local/s/${id}`,
			deleteUrl: `https://test.local/s/${id}/delete`,
			pin,
		};
	};

	const root = await dom("complete", {
		items: [slip("aaa", "one.txt", 100, "100000"), slip("bbb", "two.txt", 200, "100001")],
		now: NOW,
	});

	assert.equal(root.querySelectorAll(".slip").length, 2);
	assert.equal(root.querySelector("#share-url-0").getAttribute("value"), "https://test.local/s/aaa");
	assert.equal(root.querySelector("#share-url-1").getAttribute("value"), "https://test.local/s/bbb");
	assert.equal(
		root.querySelector("#delete-url-1").getAttribute("value"),
		"https://test.local/s/bbb/delete",
	);
	// One PIN field and one Open link per file.
	assert.equal(root.querySelectorAll('input[id^="share-pin"]').length, 2);
	assert.equal(root.querySelectorAll('.copyfield a[target="_blank"]').length, 2);
	assert.match(root.querySelector(".notice--keep").text, /only time they will be shown/i);
});

// --- share screens --------------------------------------------------------

Deno.test("a single-file share renders one download button", async () => {
	const root = await dom("file", { share: singleFile.toViewModel(), now: NOW });

	assert.equal(root.querySelector("h1").text.trim(), "Q3 numbers.csv");
	const buttons = root.querySelectorAll('a[href*="/download"]');
	assert.equal(buttons.length, 1);
	assert.equal(buttons[0].getAttribute("href"), "/s/shr1/f/f1/download");
	assert.equal(root.querySelector(".manifest"), null);
});

Deno.test("a renamed file still shows the filename it will save as", async () => {
	const root = await dom("file", { share: singleFile.toViewModel(), now: NOW });
	assert.match(root.querySelector(".muted").text, /raw-export\.csv/);
});

Deno.test("a collection renders a row and a download button per file", async () => {
	const root = await dom("collection", { share: collection.toViewModel(), now: NOW });

	const rows = root.querySelectorAll(".manifest__row");
	assert.equal(rows.length, 3);
	assert.deepEqual(
		rows.map((r) => r.querySelector("strong").text),
		["North elevation", "South elevation", "notes.pdf"],
	);
	assert.deepEqual(
		rows.map((r) => r.querySelector("a").getAttribute("href")),
		["/s/shr2/f/f1/download", "/s/shr2/f/f2/download", "/s/shr2/f/f3/download"],
	);
});

Deno.test("Download all appears only when a prebuilt zip exists", async () => {
	const withZip = await dom("collection", { share: collection.toViewModel(), now: NOW });
	assert.equal(
		withZip.querySelector('a[href$="/download-all"]').getAttribute("href"),
		"/s/shr2/download-all",
	);

	const withoutZip = await dom("collection", {
		share: collection.merge({ zipKey: null }).toViewModel(),
		now: NOW,
	});
	assert.equal(withoutZip.querySelector('a[href$="/download-all"]'), null);
	assert.equal(withoutZip.querySelectorAll(".manifest__row").length, 3);
});

Deno.test("share views never leak the PIN hash or the uploader's address", async () => {
	const secret = Share({
		...collection.toJSON(),
		pinHash: "PINHASH_SHOULD_NOT_APPEAR",
		pinSalt: "PINSALT_SHOULD_NOT_APPEAR",
		ownerEmail: "owner@test.local",
	});
	const html = await render("collection", { share: secret.toViewModel(), now: NOW });

	assert.ok(!html.includes("PINHASH_SHOULD_NOT_APPEAR"));
	assert.ok(!html.includes("PINSALT_SHOULD_NOT_APPEAR"));
	assert.ok(!html.includes("owner@test.local"));
});

Deno.test("share pages ask crawlers not to index them", async () => {
	const root = await dom("file", { share: singleFile.toViewModel(), now: NOW });
	assert.match(root.querySelector('meta[name="robots"]').getAttribute("content"), /noindex/);
});

// --- PIN gate -------------------------------------------------------------

Deno.test("the PIN gate renders a form and no file information", async () => {
	const html = await render("pin", { shareId: "shr1", locked: false, lockoutMinutes: 15 });
	const root = parse(html);

	assert.equal(root.querySelector("form").getAttribute("action"), "/s/shr1/unlock");
	assert.equal(root.querySelector("#pin").getAttribute("maxlength"), "6");
	// A crawler that reaches this page must learn nothing about the contents.
	assert.ok(!html.includes("Q3 numbers"));
	assert.equal(root.querySelector('a[href*="/download"]'), null);
});

Deno.test("a locked-out visitor gets no PIN form", async () => {
	const root = await dom("pin", { shareId: "shr1", locked: true, lockoutMinutes: 15 });
	assert.equal(root.querySelector("form"), null);
	assert.match(root.text, /Too many wrong tries/);
});

Deno.test("a wrong PIN is reported with the attempts remaining", async () => {
	const root = await dom("pin", {
		shareId: "shr1",
		locked: false,
		lockoutMinutes: 15,
		flash: { kind: "error", message: "That PIN is not right. 7 tries left." },
	});
	assert.match(root.querySelector(".notice--error").text, /7 tries left/);
});

// --- deletion -------------------------------------------------------------

Deno.test("deletion asks for confirmation and posts to the delete route", async () => {
	const root = await dom("delete_confirm", {
		share: collection.toViewModel(),
		needsPin: false,
	});
	const form = root.querySelector("form");
	assert.equal(form.getAttribute("method"), "post");
	assert.equal(form.getAttribute("action"), "/s/shr2/delete");
	assert.match(form.querySelector("button").text, /Delete permanently/);
	assert.equal(root.querySelector("#pin"), null);
});

Deno.test("a PIN-protected share requires the PIN to delete", async () => {
	const root = await dom("delete_confirm", {
		share: collection.toViewModel(),
		needsPin: true,
	});
	assert.ok(root.querySelector("#pin"));
});

// --- escaping -------------------------------------------------------------

Deno.test("titles from the uploader are escaped, not interpreted", async () => {
	const hostile = Share({
		id: "shr3",
		tenantId: "t1",
		kind: "file",
		title: '<img src=x onerror="alert(1)">',
		files: [{ id: "f1", filename: "x.txt", title: "<script>alert(1)</script>", size: 10 }],
		expiresAt: IN_A_WEEK,
	});
	const html = await render("file", { share: hostile.toViewModel(), now: NOW });

	assert.ok(!html.includes("<img src=x"));
	assert.ok(!html.includes("<script>alert(1)</script>"));
	assert.ok(html.includes("&lt;img src=x"));
	assert.equal(parse(html).querySelectorAll("script").length, 0);
});
