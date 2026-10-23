/**
 * Eta rendering.
 *
 * Templates are read once with `Deno.readTextFile` and handed to Eta's cache as
 * named templates (`@upload`, `@partials/head`). Nothing resolves a filesystem
 * path at render time, which keeps Eta's `node:fs` path out of the picture on
 * Deno Deploy and makes `include` a plain cache lookup.
 *
 * `render` is a function from (template name, data) to an HTML string, with no
 * IO and no request context. That is what makes the view tests in
 * `tests/render/` cheap to write and fast to run.
 */

import { Eta } from "eta";
import { EXPIRY_OPTIONS, PIN_LENGTH } from "~/config/limits.js";

const VIEWS_ROOT = new URL("./views/", import.meta.url);

/**
 * Explicit manifest rather than a directory scan: it is verified at boot, it
 * documents the view surface in one place, and it does not depend on
 * `Deno.readDir` behaving identically locally and on Deploy.
 */
export const TEMPLATES = Object.freeze([
	"partials/head",
	"partials/foot",
	"partials/flash",
	"partials/copyfield",
	"login",
	"login_sent",
	"upload",
	"complete",
	"pin",
	"file",
	"collection",
	"delete_confirm",
	"deleted",
	"gone",
	"error",
]);

/**
 * `useWith` keeps templates writing bare `title` rather than `it.title`.
 * `autoEscape` makes `<%= %>` escape and `<%~ %>` the deliberate opt-out, so
 * anything interpolated from an uploader is safe unless someone goes out of
 * their way to make it otherwise.
 */
const eta = new Eta({
	useWith: true,
	autoEscape: true,
	autoTrim: false,
	cache: true,
});

let loading = null;

const loadAll = async () => {
	await Promise.all(TEMPLATES.map(async (name) => {
		const source = await Deno.readTextFile(new URL(`${name}.eta`, VIEWS_ROOT));
		eta.loadTemplate(`@${name}`, source);
	}));
	return eta;
};

/** Idempotent; concurrent first renders share a single load. */
export const ready = () => (loading ??= loadAll());

/** Human-readable "in 6 days" / "in 4 hours" for an expiry timestamp. */
export const relativeExpiry = (expiresAt, nowMs) => {
	const ms = expiresAt - nowMs;
	if (ms <= 0) return "expired";
	const hours = Math.floor(ms / 3600000);
	if (hours < 1) return `in ${Math.max(1, Math.floor(ms / 60000))} minutes`;
	if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
	const days = Math.round(hours / 24);
	return `in ${days} ${days === 1 ? "day" : "days"}`;
};

export const formatDate = (ms) =>
	new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * The "Sharing this safely" bullets. Rendered on the completion screen and
 * copied verbatim (em dash flattened to a hyphen) into the upload-summary
 * `.txt` download — kept in one place so the two cannot drift.
 */
export const SHARING_TIPS = Object.freeze([
	"Send the link and the PIN separately — the link by email, the PIN by text or in person. Anyone who intercepts one message then has only half of it.",
	"Anyone holding the link can open the share. Treat it like the files themselves rather than like a password-protected account.",
	"The delete link works for anyone who has it, so do not post it anywhere you post the share link.",
	"Pick the shortest expiry you can live with. It is the only cleanup that happens on its own.",
	"Public posts get crawled within seconds. The PIN is what stops those crawlers, so use one whenever the link goes somewhere public.",
]);

/** Values every template can rely on existing. */
const baseLocals = (data) => ({
	title: "Private Share",
	tenantName: "Private Share",
	bodyClass: "",
	clientScript: null,
	flash: null,
	expiryOptions: EXPIRY_OPTIONS,
	pinLength: PIN_LENGTH,
	relativeExpiry,
	formatDate,
	sharingTips: SHARING_TIPS,
	...data,
});

export const render = async (name, data = {}) => {
	await ready();
	return eta.render(`@${name}`, baseLocals(data));
};

/** Drop compiled templates so `deno task dev`'s watcher picks up edits. */
export const clearTemplateCache = () => {
	eta.templatesSync.reset();
	eta.templatesAsync.reset();
	loading = null;
};
