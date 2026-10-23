import assert from "node:assert/strict";
import { buildUploadSummary } from "~/lib/uploadSummary.js";
import { formatStamp, formatStampForFilename } from "~/lib/dates.js";
import { Share } from "~/models/Share.js";

const DAY = 86400000;
const DOMAIN = "share.bower.family";
// The examples read as US Eastern: 2026-09-07 21:13 UTC is 5:13pm EDT.
const TZ = "America/New_York";
const CREATED = Date.UTC(2026, 8, 7, 21, 13, 0);
const EXPIRES = CREATED + 7 * DAY;

/** Build one completion-payload item from raw file specs. */
const item = ({ id, kind = "file", title, files, pin = null }) => {
	const share = Share({
		id,
		tenantId: "share",
		kind,
		title,
		files,
		createdAt: CREATED,
		expiresAt: EXPIRES,
		expiryDays: 7,
	});
	return {
		share: share.toViewModel(),
		shareUrl: `https://${DOMAIN}/s/${id}`,
		deleteUrl: `https://${DOMAIN}/s/${id}/delete`,
		pin,
	};
};

const example = (name) =>
	Deno.readTextFileSync(new URL(`../../docs/upload-summary/${name}`, import.meta.url));

Deno.test("date helpers format an instant in the given time zone", () => {
	// 2026-09-07 21:13 UTC is 5:13pm US Eastern / 2:13pm US Pacific.
	assert.equal(formatStamp(CREATED, TZ), "Sep 7, 2026 5:13pm");
	assert.equal(formatStamp(EXPIRES, TZ), "Sep 14, 2026 5:13pm");
	assert.equal(formatStamp(CREATED, "America/Los_Angeles"), "Sep 7, 2026 2:13pm");
	assert.equal(formatStampForFilename(CREATED, TZ), "Sep 7, 2026 0513pm");
	assert.equal(formatStampForFilename(CREATED, "America/Los_Angeles"), "Sep 7, 2026 0213pm");
});

Deno.test("single file — matches docs/upload-summary/example-1-single-file.txt", () => {
	const { filename, body } = buildUploadSummary({
		timeZone: TZ,
		domain: DOMAIN,
		items: [
			item({
				id: "k8s0mqf9d2wnvb4x7j3h5p1a",
				title: "Q3 report",
				pin: "482913",
				files: [{ id: "f1", title: "Q3 report", filename: "q3-report-final.pdf", size: 2516582 }],
			}),
		],
	});

	assert.equal(filename, "share.bower.family Upload at Sep 7, 2026 0513pm.txt");
	assert.equal(body, example("example-1-single-file.txt"));
});

Deno.test("several files, no collection — matches example-2, one block per file, distinct PINs", () => {
	const { filename, body } = buildUploadSummary({
		timeZone: TZ,
		domain: DOMAIN,
		items: [
			item({
				id: "a1b2c3d4e5f6g7h8i9j0k1l2",
				title: "Q3 report",
				pin: "100001",
				files: [{ id: "f1", title: "Q3 report", filename: "q3-report-final.pdf", size: 2516582 }],
			}),
			item({
				id: "m3n4o5p6q7r8s9t0u1v2w3x4",
				title: "budget.xlsx",
				pin: "100002",
				files: [{ id: "f2", title: "budget.xlsx", filename: "budget.xlsx", size: 524288 }],
			}),
			item({
				id: "y5z6a7b8c9d0e1f2g3h4i5j6",
				title: "notes.txt",
				pin: "100003",
				files: [{ id: "f3", title: "notes.txt", filename: "notes.txt", size: 4096 }],
			}),
		],
	});

	assert.equal(filename, "share.bower.family Upload at Sep 7, 2026 0513pm.txt");
	assert.equal(body, example("example-2-multi-file.txt"));
});

Deno.test("collection — matches example-3, one block with a numbered file list", () => {
	const { filename, body } = buildUploadSummary({
		timeZone: TZ,
		domain: DOMAIN,
		items: [
			item({
				id: "p9q8r7s6t5u4v3w2x1y0z9a8",
				kind: "collection",
				title: "North Elevations",
				pin: "482913",
				files: [
					{ id: "f1", title: "North elevation", filename: "north.jpg", size: 1048576 },
					{ id: "f2", title: "South elevation", filename: "south.jpg", size: 2097152 },
					{ id: "f3", title: "notes.pdf", filename: "notes.pdf", size: 51200 },
				],
			}),
		],
	});

	assert.equal(
		filename,
		"North Elevations Uploaded to share.bower.family at Sep 7, 2026 0513pm.txt",
	);
	assert.equal(body, example("example-3-collection.txt"));
});

Deno.test("no PIN — the PIN line is omitted, nothing else changes", () => {
	const withPin = buildUploadSummary({
		timeZone: TZ,
		domain: DOMAIN,
		items: [item({
			id: "abc",
			title: "notes.txt",
			pin: "123456",
			files: [{ id: "f1", title: "notes.txt", filename: "notes.txt", size: 4096 }],
		})],
	}).body;

	const noPin = buildUploadSummary({
		timeZone: TZ,
		domain: DOMAIN,
		items: [item({
			id: "abc",
			title: "notes.txt",
			pin: null,
			files: [{ id: "f1", title: "notes.txt", filename: "notes.txt", size: 4096 }],
		})],
	}).body;

	assert.ok(withPin.includes("- PIN: 123456"));
	assert.ok(!noPin.includes("PIN:"));
	assert.equal(noPin, withPin.replace("- PIN: 123456\n", ""));
});

Deno.test("collection title is sanitised for the file name", () => {
	const { filename } = buildUploadSummary({
		timeZone: TZ,
		domain: DOMAIN,
		items: [item({
			id: "x",
			kind: "collection",
			title: 'Q3: drafts / "final"',
			files: [
				{ id: "f1", title: "a", filename: "a.txt", size: 10 },
				{ id: "f2", title: "b", filename: "b.txt", size: 20 },
			],
		})],
	});
	// sanitizeFilename drops : / \ " and collapses whitespace.
	assert.equal(filename, "Q3 drafts - final Uploaded to share.bower.family at Sep 7, 2026 0513pm.txt");
});
