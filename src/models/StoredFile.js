import { Model } from "./Model.js";

const SAFE_NAME = /[^\w.\- ()[\]]+/g;

/** Strip anything that could confuse a Content-Disposition header or a filesystem. */
export const sanitizeFilename = (name) =>
	String(name ?? "")
		.replace(/[\\/]/g, "-")
		.replace(SAFE_NAME, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 180) || "file";

export const formatBytes = (bytes) => {
	const n = Number(bytes) || 0;
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB"];
	let value = n / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

/**
 * One uploaded file. `title` is the display name the uploader chose; `filename`
 * is what the browser will actually save it as.
 */
export const StoredFile = Model.extend({
	name: "StoredFile",
	ctor: ({
		id = "",
		filename = "",
		title = "",
		size = 0,
		contentType = "application/octet-stream",
		objectKey = "",
	}) => {
		const safe = sanitizeFilename(filename);
		return {
			id,
			filename: safe,
			title: String(title ?? "").trim() || safe,
			size: Number(size) || 0,
			contentType: String(contentType || "application/octet-stream"),
			objectKey,
		};
	},
	proto: {
		get displaySize() {
			return formatBytes(this.size);
		},
		/** True when the uploader renamed the file for display purposes. */
		get isRenamed() {
			return this.title !== this.filename;
		},
		toJSON() {
			return {
				id: this.id,
				filename: this.filename,
				title: this.title,
				size: this.size,
				contentType: this.contentType,
				objectKey: this.objectKey,
			};
		},
	},
	stat: {
		fromJSON: (json) => StoredFile(json ?? {}),
		sanitizeFilename,
		formatBytes,
	},
});
