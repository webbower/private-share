/**
 * Values in this module are shared between the server and the browser bundle.
 * Nothing secret may ever live here — see `src/config/tenants.server.js`.
 */

/** Retention choices offered in the upload form. */
export const EXPIRY_OPTIONS = Object.freeze([
	Object.freeze({ days: 1, label: "1 day", prefix: "d1" }),
	Object.freeze({ days: 3, label: "3 days", prefix: "d3" }),
	Object.freeze({ days: 7, label: "1 week", prefix: "d7" }),
	Object.freeze({ days: 14, label: "2 weeks", prefix: "d14" }),
	Object.freeze({ days: 30, label: "1 month", prefix: "d30" }),
]);

export const DEFAULT_EXPIRY_DAYS = 7;

export const ALLOWED_EXPIRY_DAYS = Object.freeze(EXPIRY_OPTIONS.map((o) => o.days));

/**
 * Object-key prefix for a retention window. R2 lifecycle rules are configured
 * per prefix, so the prefix is what actually deletes the blob.
 */
export const prefixForDays = (days) => {
	const option = EXPIRY_OPTIONS.find((o) => o.days === Number(days));
	if (!option) throw new RangeError(`Unsupported retention: ${days}`);
	return option.prefix;
};

export const isAllowedExpiry = (days) => ALLOWED_EXPIRY_DAYS.includes(Number(days));

/** Length of the share/file/collection identifiers produced by cuid2. */
export const ID_LENGTH = 24;

/** PIN is a fixed 6 digits. It gates scrapers, not determined humans. */
export const PIN_LENGTH = 6;

/** How long an unlocked-PIN cookie stays valid, in seconds. */
export const PIN_COOKIE_TTL_SECONDS = 60 * 60 * 12;

/** Magic-link token lifetime, in seconds. */
export const MAGIC_LINK_TTL_SECONDS = 60 * 15;

/** Session lifetime, in seconds. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Presigned upload/download URL lifetime, in seconds. */
export const PRESIGN_UPLOAD_TTL_SECONDS = 60 * 30;

/**
 * How long a pending-upload record survives. Deliberately far longer than the
 * presigned URLs it describes: once those expire, this record is the only thing
 * that knows which objects were written for an upload that never completed, so
 * the sweeper needs it to still be there.
 */
export const PENDING_TTL_SECONDS = 60 * 60 * 24;

/** Age at which an incomplete upload is considered abandoned. */
export const ORPHAN_AGE_SECONDS = 60 * 60 * 2;
export const PRESIGN_DOWNLOAD_TTL_SECONDS = 60 * 5;

/** Failed PIN attempts allowed per share before a lockout. */
export const PIN_MAX_ATTEMPTS = 8;
export const PIN_LOCKOUT_SECONDS = 60 * 15;

export const ZIP_FILENAME = "collection.zip";

/**
 * Above this combined size the browser stops building a "Download all" zip.
 * Zipping happens in the visitor's tab and holds every file in memory at once,
 * so past a certain point the collection is better off without one — the
 * listing still offers every file individually.
 */
export const ZIP_MAX_TOTAL_BYTES = 150 * 1024 * 1024;
