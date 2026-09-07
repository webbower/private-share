/**
 * Upload page behaviour. Plain DOM, no framework.
 *
 * Nothing secret reaches this file. It knows the size limits (which are in the
 * HTML as data attributes anyway) and nothing about who is allowed to upload —
 * that check lives entirely on the server in `tenants.server.js`, and
 * `tests/build/no_email_leak.test.js` proves it never lands in this bundle.
 *
 * The upload itself goes browser -> R2 directly using presigned URLs the server
 * mints. File bytes never pass through the app.
 */

import { zipSync } from "fflate";
import { ZIP_FILENAME, ZIP_MAX_TOTAL_BYTES } from "../src/config/limits.js";

const el = (id) => document.getElementById(id);

const formatBytes = (bytes) => {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

/* -------------------------------------------------------------------------
   Copy buttons. Used on both the upload page and the completion slip.
   ------------------------------------------------------------------------- */

const wireCopyButtons = () => {
	document.querySelectorAll("[data-copy-for]").forEach((button) => {
		button.addEventListener("click", async () => {
			const input = el(button.getAttribute("data-copy-for"));
			if (!input) return;
			try {
				await navigator.clipboard.writeText(input.value);
			} catch {
				// Clipboard API needs a secure context; selecting the text at least
				// leaves the visitor one keystroke from copying it.
				input.select();
				input.setSelectionRange(0, input.value.length);
			}
			const original = button.textContent;
			button.textContent = "Copied";
			button.dataset.copied = "true";
			setTimeout(() => {
				button.textContent = original;
				delete button.dataset.copied;
			}, 1800);
		});
	});
};

/* -------------------------------------------------------------------------
   Staging
   ------------------------------------------------------------------------- */

const createStage = (form) => {
	const limits = {
		maxFileBytes: Number(form.dataset.maxFileBytes),
		maxTotalBytes: Number(form.dataset.maxTotalBytes),
		maxFiles: Number(form.dataset.maxFiles),
	};

	const list = el("staged-list");
	const toggle = el("collection-toggle");
	const titleField = el("collection-title-field");
	const submit = el("submit-button");
	const status = el("upload-status");

	/** @type {{key: string, file: File, title: string}[]} */
	let staged = [];
	let nextKey = 0;

	const totalBytes = () => staged.reduce((sum, item) => sum + item.file.size, 0);

	const say = (message, kind = "") => {
		if (!message) {
			status.hidden = true;
			status.textContent = "";
			return;
		}
		status.hidden = false;
		status.className = kind ? `notice notice--${kind}` : "notice";
		status.textContent = message;
	};

	const rejectionFor = (file) => {
		if (file.size === 0) return `"${file.name}" is empty.`;
		if (file.size > limits.maxFileBytes) {
			return `"${file.name}" is ${formatBytes(file.size)}, over the ${
				formatBytes(limits.maxFileBytes)
			} limit.`;
		}
		return null;
	};

	const add = (files) => {
		const problems = [];
		for (const file of files) {
			if (staged.length >= limits.maxFiles) {
				problems.push(`Only ${limits.maxFiles} files at a time.`);
				break;
			}
			const problem = rejectionFor(file);
			if (problem) {
				problems.push(problem);
				continue;
			}
			if (totalBytes() + file.size > limits.maxTotalBytes) {
				problems.push(`That would go over the ${formatBytes(limits.maxTotalBytes)} total.`);
				break;
			}
			staged.push({ key: `s${nextKey++}`, file, title: file.name });
		}
		say(problems.join(" "), problems.length ? "warn" : "");
		draw();
	};

	const remove = (key) => {
		staged = staged.filter((item) => item.key !== key);
		draw();
	};

	const draw = () => {
		list.replaceChildren();

		staged.forEach((item) => {
			const row = document.createElement("li");
			row.className = "staged__item";
			row.dataset.key = item.key;
			row.dataset.state = "waiting";

			const title = document.createElement("input");
			title.type = "text";
			title.className = "staged__title";
			title.value = item.title;
			title.maxLength = 180;
			title.setAttribute("aria-label", `Title for ${item.file.name}`);
			// The title is display-only; the file still saves under its own name.
			title.addEventListener("input", () => {
				item.title = title.value;
			});

			const drop = document.createElement("button");
			drop.type = "button";
			drop.className = "staged__remove";
			drop.textContent = "Remove";
			drop.setAttribute("aria-label", `Remove ${item.file.name}`);
			drop.addEventListener("click", () => remove(item.key));

			const meta = document.createElement("span");
			meta.className = "staged__meta";
			meta.textContent = `${item.file.name} · ${formatBytes(item.file.size)}`;

			const bar = document.createElement("span");
			bar.className = "staged__bar";
			bar.append(document.createElement("span"));

			row.append(title, drop, meta, bar);
			list.append(row);
		});

		// The collection option is only meaningful for more than one file.
		const many = staged.length > 1;
		toggle.hidden = !many;
		if (!many) {
			el("as-collection").checked = false;
			titleField.hidden = true;
		} else {
			titleField.hidden = !el("as-collection").checked;
		}

		submit.disabled = staged.length === 0;
	};

	const progressFor = (key) => {
		const row = list.querySelector(`[data-key="${key}"]`);
		return {
			set(fraction) {
				if (row) row.querySelector(".staged__bar span").style.width = `${fraction * 100}%`;
			},
			state(value) {
				if (row) row.dataset.state = value;
			},
		};
	};

	return {
		limits,
		add,
		draw,
		say,
		progressFor,
		items: () => staged,
		totalBytes,
		isCollection: () => staged.length > 1 && el("as-collection").checked,
		collectionTitle: () => el("collection-title").value.trim(),
	};
};

/* -------------------------------------------------------------------------
   Transfer
   ------------------------------------------------------------------------- */

/** PUT a blob to a presigned URL, reporting progress. */
const putToStorage = ({ url, headers, body, onProgress }) =>
	new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("PUT", url, true);

		// `content-length` is set by the browser from the body and cannot be set
		// here — which is the point: the server signed the exact length it agreed
		// to, so a mismatched body fails the signature at R2.
		Object.entries(headers ?? {}).forEach(([name, value]) => {
			if (name.toLowerCase() === "content-length") return;
			request.setRequestHeader(name, value);
		});

		request.upload.addEventListener("progress", (event) => {
			if (event.lengthComputable) onProgress?.(event.loaded / event.total);
		});
		request.addEventListener("load", () =>
			request.status >= 200 && request.status < 300
				? resolve(request)
				: reject(new Error(`Storage rejected the upload (${request.status})`)));
		request.addEventListener("error", () =>
			reject(new Error("The connection dropped.")));
		request.addEventListener("abort", () =>
			reject(new Error("Upload cancelled.")));

		request.send(body);
	});

/**
 * Build the "Download all" zip here rather than on the server. Zipping
 * server-side would mean pulling every file back down into the app, paying
 * egress twice and holding it all in a 512MB isolate. Doing it in the tab costs
 * nothing on either leg, since storage ingress is free.
 *
 * Stored, not deflated: these are usually already-compressed files, and
 * spending the visitor's CPU to save a percent or two is a bad trade.
 */
const buildZip = async (items) => {
	const entries = {};
	const used = new Set();

	for (const item of items) {
		let name = item.title.trim() || item.file.name;
		if (!/\.[^.]+$/.test(name)) {
			const ext = item.file.name.match(/\.[^.]+$/)?.[0] ?? "";
			name += ext;
		}
		// Two files can carry the same title; the zip needs unique entries.
		let candidate = name;
		let n = 2;
		while (used.has(candidate)) {
			candidate = name.replace(/(\.[^.]+)?$/, (ext) => ` (${n})${ext ?? ""}`);
			n += 1;
		}
		used.add(candidate);
		entries[candidate] = [new Uint8Array(await item.file.arrayBuffer()), { level: 0 }];
	}

	return new Blob([zipSync(entries, { level: 0 })], { type: "application/zip" });
};

/** Submit a real form so the confirmation page, and its one-time PIN, is server-rendered. */
const handOffToServer = ({ shareId, withPin, zipSize }) => {
	const form = document.createElement("form");
	form.method = "post";
	form.action = "/upload/complete";
	form.style.display = "none";

	const field = (name, value) => {
		const input = document.createElement("input");
		input.type = "hidden";
		input.name = name;
		input.value = String(value);
		form.append(input);
	};

	field("shareId", shareId);
	field("withPin", withPin ? "1" : "0");
	field("zipSize", zipSize);

	document.body.append(form);
	form.submit();
};

/* -------------------------------------------------------------------------
   Wiring
   ------------------------------------------------------------------------- */

const wireUploadForm = () => {
	const form = el("upload-form");
	if (!form) return;

	const stage = createStage(form);
	const dropzone = el("dropzone");
	const input = el("file-input");
	const submit = el("submit-button");

	input.addEventListener("change", () => {
		stage.add([...input.files]);
		input.value = "";
	});

	["dragenter", "dragover"].forEach((type) =>
		dropzone.addEventListener(type, (event) => {
			event.preventDefault();
			dropzone.dataset.active = "true";
		})
	);
	["dragleave", "drop"].forEach((type) =>
		dropzone.addEventListener(type, (event) => {
			event.preventDefault();
			if (type === "dragleave" && dropzone.contains(event.relatedTarget)) return;
			dropzone.dataset.active = "false";
		})
	);
	dropzone.addEventListener("drop", (event) => {
		const files = [...(event.dataTransfer?.files ?? [])];
		if (files.length) stage.add(files);
	});

	// Dropping anywhere else in the window should not navigate away from a
	// half-filled form.
	["dragover", "drop"].forEach((type) =>
		globalThis.addEventListener(type, (event) => {
			if (!dropzone.contains(event.target)) event.preventDefault();
		})
	);

	el("as-collection").addEventListener("change", () => stage.draw());

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const items = stage.items();
		if (!items.length) return;

		submit.disabled = true;
		form.querySelectorAll("input, select, button").forEach((node) => (node.disabled = true));

		const asCollection = stage.isCollection();
		const withPin = el("with-pin").checked;

		try {
			stage.say("Preparing…");

			const response = await fetch("/api/uploads", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					files: items.map((item) => ({
						name: item.file.name,
						title: item.title,
						size: item.file.size,
						type: item.file.type || "application/octet-stream",
					})),
					asCollection,
					collectionTitle: stage.collectionTitle(),
					expiryDays: Number(el("expiry").value),
				}),
			});

			const plan = await response.json();
			if (!response.ok) throw new Error(plan.message ?? "That upload was refused.");

			stage.say(`Uploading ${items.length} ${items.length === 1 ? "file" : "files"}…`);

			// Sequential rather than parallel: it keeps the progress bars honest
			// and avoids saturating a slow connection with concurrent PUTs.
			for (const [index, upload] of plan.uploads.entries()) {
				const item = items[index];
				const progress = stage.progressFor(item.key);
				progress.state("uploading");
				try {
					await putToStorage({
						url: upload.url,
						headers: upload.headers,
						body: item.file,
						onProgress: (fraction) => progress.set(fraction),
					});
					progress.set(1);
					progress.state("done");
				} catch (error) {
					progress.state("failed");
					throw error;
				}
			}

			let zipSize = 0;
			if (plan.zipUpload) {
				if (stage.totalBytes() <= ZIP_MAX_TOTAL_BYTES) {
					stage.say("Packing a zip for “Download all”…");
					try {
						const blob = await buildZip(items);
						await putToStorage({
							url: plan.zipUpload.url,
							headers: plan.zipUpload.headers,
							body: blob,
						});
						zipSize = blob.size;
					} catch {
						// The collection is still perfectly usable without one.
						stage.say("Could not build the zip; the files are still uploading fine.", "warn");
					}
				}
			}

			stage.say("Finishing…");
			handOffToServer({ shareId: plan.shareId, withPin, zipSize });
		} catch (error) {
			stage.say(error.message ?? "That did not work. Try again.", "error");
			form.querySelectorAll("input, select, button").forEach((node) => (node.disabled = false));
			submit.disabled = false;
		}
	});

	stage.draw();
};

wireCopyButtons();
wireUploadForm();

export { buildZip, formatBytes, ZIP_FILENAME };
