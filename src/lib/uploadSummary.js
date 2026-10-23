/**
 * Builds the plain-text "save a copy of these details" file offered on the
 * upload-completion screen.
 *
 * Pure: takes the same `items` the completion template gets (each
 * `{ share: <view model>, shareUrl, deleteUrl, pin }`), the tenant domain, and
 * the uploader's IANA `timeZone` (the browser sends it with the completion
 * POST), and returns `{ filename, body }`. No IO.
 *
 * Worked examples of every case, and the field-by-field spec, live in
 * `docs/upload-summary/`. The unit test asserts this output against those
 * files, so keep them in step.
 */

import { sanitizeFilename } from "~/models/StoredFile.js";
import { SHARING_TIPS } from "~/render.js";
import { formatDateStamp, formatStamp, formatStampForFilename } from "./dates.js";

/** The completion screen's em dash becomes a plain hyphen in a text file. */
const flatten = (line) => line.replace(/—/g, "-");

const expiresValue = (share, tz) => {
	const days = share.expiryDays;
	return `${formatStamp(share.expiresAt, tz)} (${days} day${days === 1 ? "" : "s"} after upload)`;
};

/** One `## <file>` block — used for a single-file share and each ungrouped file. */
const fileBlock = ({ share, shareUrl, deleteUrl, pin }, tz) => {
	const file = share.files[0];
	const lines = [`## ${file.title}`, ""];
	if (file.title !== file.filename) lines.push(`Saved as ${file.filename}`, "");
	lines.push(`- Share link: ${shareUrl}`, `- Delete link: ${deleteUrl}`);
	if (pin) lines.push(`- PIN: ${pin}`);
	lines.push(
		`- Uploaded: ${formatStamp(share.createdAt, tz)}`,
		`- Expires: ${expiresValue(share, tz)}`,
		`- Size: ${file.displaySize}`,
	);
	return lines.join("\n");
};

/** The single `## <collection>` block plus its numbered file list. */
const collectionBlock = ({ share, shareUrl, deleteUrl, pin }, tz) => {
	const lines = [`## ${share.title}`, "", `- Share link: ${shareUrl}`, `- Delete link: ${deleteUrl}`];
	if (pin) lines.push(`- PIN: ${pin}`);
	lines.push(
		`- Uploaded: ${formatStamp(share.createdAt, tz)}`,
		`- Expires: ${expiresValue(share, tz)}`,
		`- Total size: ${share.displayTotalSize}`,
		"",
		"### Files in this collection",
		"",
	);
	share.files.forEach((file, i) => {
		const name = file.title !== file.filename ? `${file.title} (${file.filename})` : file.filename;
		lines.push(`${i + 1}. ${name} - ${file.displaySize}`);
	});
	return lines.join("\n");
};

export const buildUploadSummary = ({ items, domain, timeZone }) => {
	const first = items[0].share;
	const isCollection = items.length === 1 && first.isCollection;
	const stamp = formatStamp(first.createdAt, timeZone);
	const stampFile = formatStampForFilename(first.createdAt, timeZone);
	const expiryDate = formatDateStamp(first.expiresAt, timeZone);

	let heading;
	let filename;
	let summary;

	if (isCollection) {
		heading = `${first.title} - uploaded to ${domain} at ${stamp}`;
		filename = `${sanitizeFilename(first.title)} Uploaded to ${domain} at ${stampFile}.txt`;
		summary =
			`Collection of ${first.fileCount} files (${first.displayTotalSize}) behind one link. Expires ${expiryDate}.`;
	} else {
		heading = `${domain} Upload at ${stamp}`;
		filename = `${domain} Upload at ${stampFile}.txt`;
		summary = items.length === 1
			? `One file. Expires ${expiryDate}.`
			: `${items.length} files, shared as separate links. Each expires ${expiryDate}.`;
	}

	const out = [
		`# ${heading}`,
		"",
		summary,
		"",
		"## Sharing this safely",
		"",
		...SHARING_TIPS.map((tip) => `- ${flatten(tip)}`),
		"",
		"---",
		"",
	];

	if (isCollection) {
		out.push(collectionBlock(items[0], timeZone));
	} else {
		items.forEach((item, i) => {
			if (i > 0) out.push("");
			out.push(fileBlock(item, timeZone));
		});
	}

	return { filename, body: `${out.join("\n")}\n` };
};
