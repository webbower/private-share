/**
 * Date formatting for the upload-summary download.
 *
 * Pure functions, no IO. All three take an IANA `timeZone` (e.g.
 * `"America/New_York"`) so timestamps read in the uploader's own local time —
 * the browser sends its zone with the completion POST. When `timeZone` is
 * omitted the runtime's local zone is used (UTC on Deno Deploy).
 *
 * `src/render.js` keeps its own `formatDate` / `relativeExpiry` for the HTML
 * views — those are unaffected.
 */

/** Some ICU builds put a narrow/no-break space before AM/PM; flatten to ASCII. */
const tidy = (s) => s.replace(/[\u00a0\u202f\u2009]/g, " ");

/** "Sep 7, 2026" — US month/day/year. */
export const formatDateStamp = (ms, timeZone) =>
	new Date(ms).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone,
	});

/** "Sep 7, 2026 5:13pm" — US date + time, no zero-pad, lowercase meridiem. */
export const formatStamp = (ms, timeZone) =>
	tidy(
		new Date(ms).toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
			timeZone,
		}),
	).replace(/, (\d{1,2}:\d{2}) (AM|PM)$/, (_m, t, ap) => ` ${t}${ap.toLowerCase()}`);

/** "Sep 7, 2026 0513pm" — same instant, safe for a download file name. */
export const formatStampForFilename = (ms, timeZone) =>
	tidy(
		new Date(ms).toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: true,
			timeZone,
		}),
	).replace(/, (\d{2}):(\d{2}) (AM|PM)$/, (_m, h, min, ap) => ` ${h}${min}${ap.toLowerCase()}`);
