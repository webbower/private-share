/**
 * HTTP layer.
 *
 * `createApp(container)` returns a Hono app with no global state, so a test can
 * build one over a container of doubles and drive it with `app.request(...)`.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { ENVS } from "~/config/env.js";
import {
	DEFAULT_EXPIRY_DAYS,
	PIN_COOKIE_TTL_SECONDS,
	PIN_LOCKOUT_SECONDS,
	SESSION_TTL_SECONDS,
} from "~/config/limits.js";
import { tenantForHost } from "~/config/tenants.server.js";
import { formatBytes } from "~/models/StoredFile.js";
import { AuthService } from "~/services/auth.js";
import { PinResult, PinService } from "~/services/pin.js";
import { ShareService, UploadError } from "~/services/shares.js";
import { render } from "~/render.js";
import { serveAsset } from "~/static.js";
import { sign, unsign } from "~/lib/crypto.js";
import { buildUploadSummary } from "~/lib/uploadSummary.js";
import { LOCAL_STORAGE_PREFIX } from "~/io/LocalFileClient.js";

const SESSION_COOKIE = "hoff_session";
const pinCookieName = (shareId) => `hoff_pin_${shareId}`;

/**
 * The browser posts its IANA time zone with `/upload/complete` so the
 * downloadable summary can show timestamps in the uploader's own local time.
 * Returns `undefined` for anything missing or not a real zone, which leaves the
 * formatters on the runtime's local zone (UTC on Deno Deploy).
 */
const resolveTimeZone = (value) => {
	const tz = String(value ?? "").trim();
	if (!tz) return undefined;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return tz;
	} catch {
		return undefined;
	}
};

/**
 * Nothing on this site should be crawled, indexed, or used as model training
 * data: every URL is either a sign-in wall or a private, expiring share link.
 *
 * `User-agent: *` already covers every rule-respecting crawler, but the
 * AI/scraper bots are named explicitly as well — it makes the intent
 * unambiguous, and some operators only honour a block that targets their token
 * by name. This is still advisory; robots.txt is not an access control. The
 * real protections are the auth wall, the unguessable share ids, and the
 * `noindex` meta tag in the page head.
 */
const BLOCKED_USER_AGENTS = [
	"*",
	// OpenAI
	"GPTBot",
	"ChatGPT-User",
	"OAI-SearchBot",
	// Anthropic
	"ClaudeBot",
	"Claude-Web",
	"Claude-User",
	"Claude-SearchBot",
	"anthropic-ai",
	// Google (AI/extended, separate from Googlebot search)
	"Google-Extended",
	"GoogleOther",
	// Common Crawl — feeds many training sets
	"CCBot",
	// Perplexity
	"PerplexityBot",
	"Perplexity-User",
	// Apple
	"Applebot-Extended",
	// Meta
	"Meta-ExternalAgent",
	"meta-externalagent",
	"FacebookBot",
	// ByteDance
	"Bytespider",
	// Amazon
	"Amazonbot",
	// Others seen scraping for LLM corpora
	"cohere-ai",
	"cohere-training-data-crawler",
	"Diffbot",
	"Omgilibot",
	"Omgili",
	"YouBot",
	"Timpibot",
	"ImagesiftBot",
	"PetalBot",
	"DataForSeoBot",
	"AI2Bot",
	"Scrapy",
];

// One full block per agent rather than a stack of User-agent lines: every
// parser, including the lax ones, then reads an explicit "Disallow: /" for the
// token it is looking for.
const ROBOTS_TXT = BLOCKED_USER_AGENTS
	.map((ua) => `User-agent: ${ua}\nDisallow: /`)
	.join("\n\n") + "\n";

export const createApp = (container) => {
	const { config, clock, logger, kv, files, ids, mail } = container;
	const secure = container.appEnv === ENVS.PRODUCTION;

	const auth = AuthService({ kv, mail, ids, clock, logger });
	const pins = PinService({ kv, clock, logger });
	const shares = ShareService({ kv, files, ids, clock, logger });

	const app = new Hono();

	const cookieOptions = (maxAge) => ({
		httpOnly: true,
		secure,
		sameSite: "Lax",
		path: "/",
		maxAge,
	});

	const html = async (c, view, data, status = 200) =>
		c.html(await render(view, { tenantName: c.get("tenant")?.name ?? "Private Share", ...data }), status);

	const errorPage = (c, status, heading, message) =>
		html(c, "error", { title: heading, heading, message }, status);

	// --- static assets ----------------------------------------------------

	app.get("/assets/*", (c) => serveAsset(c.req.path.replace("/assets/", "")));

	app.get("/robots.txt", (c) => c.text(ROBOTS_TXT));

	// --- local object storage (development only) -------------------------

	/**
	 * In development the container hands us a `LocalFileClient` whose presigned
	 * URLs point back here instead of at R2. These two routes are the storage:
	 * the browser PUTs each file straight to `PUT /__local-storage/<key>`, and
	 * download redirects land on `GET /__local-storage/<key>`. Registered before
	 * tenant resolution and the CSRF check, exactly like the other static
	 * routes, and only when the file client can actually move bytes.
	 */
	if (container.appEnv === ENVS.DEVELOPMENT && typeof files.putObject === "function") {
		const keyFromPath = (c) => decodeURIComponent(c.req.path.slice(LOCAL_STORAGE_PREFIX.length));

		app.put(`${LOCAL_STORAGE_PREFIX}*`, async (c) => {
			const key = keyFromPath(c);
			const bytes = new Uint8Array(await c.req.arrayBuffer());
			const declared = c.req.header("content-length");
			if (declared !== undefined && Number(declared) !== bytes.byteLength) {
				return c.text("content-length does not match body", 400);
			}
			try {
				await files.putObject(key, bytes);
			} catch (error) {
				logger?.warn("local storage PUT rejected", { key, error: String(error) });
				return c.text("bad object key", 400);
			}
			return c.body(null, 200);
		});

		app.get(`${LOCAL_STORAGE_PREFIX}*`, async (c) => {
			let bytes;
			try {
				bytes = await files.getObject(keyFromPath(c));
			} catch (error) {
				logger?.warn("local storage GET rejected", { error: String(error) });
				return c.text("bad object key", 400);
			}
			if (!bytes) return c.text("Not found", 404);

			const headers = {
				"content-type": c.req.query("contentType") || "application/octet-stream",
				"content-length": String(bytes.byteLength),
			};
			const filename = c.req.query("filename");
			if (filename) headers["content-disposition"] = files.attachmentHeader(filename);
			return c.body(bytes, 200, headers);
		});
	}

	// --- tenant resolution ------------------------------------------------

	/**
	 * Every request is resolved to a tenant by Host header. An unrecognised
	 * domain gets a flat 404: the app does not confirm it is listening there.
	 */
	app.use("*", async (c, next) => {
		const host = c.req.header("host") ?? "";
		const tenant = tenantForHost(container.appEnv, host);
		if (!tenant) {
			logger?.warn("request for unknown host", { host });
			return c.text("Not found", 404);
		}
		c.set("tenant", tenant);
		c.set("origin", new URL(c.req.url).origin);
		await next();
	});

	/**
	 * Reject cross-site form posts. Same-origin forms send `Sec-Fetch-Site:
	 * same-origin`; older browsers send a matching `Origin`.
	 */
	app.use("*", async (c, next) => {
		if (["POST", "PUT", "DELETE"].includes(c.req.method)) {
			const site = c.req.header("sec-fetch-site");
			const origin = c.req.header("origin");
			const expected = c.get("origin");
			const ok = site === "same-origin" || site === "none" ||
				(!site && (!origin || origin === expected)) ||
				(site === undefined && origin === expected);
			if (!ok && origin !== expected) {
				logger?.warn("cross-site request rejected", { origin, site });
				return c.text("Forbidden", 403);
			}
		}
		await next();
	});

	// --- session ----------------------------------------------------------

	const currentSession = async (c) => {
		if (c.get("sessionChecked")) return c.get("session");
		const signed = getCookie(c, SESSION_COOKIE);
		const sessionId = signed ? await unsign(config.appSecret, signed) : null;
		const session = await auth.sessionFor({ tenant: c.get("tenant"), sessionId });
		c.set("session", session);
		c.set("sessionChecked", true);
		return session;
	};

	const requireSession = async (c, next) => {
		const session = await currentSession(c);
		if (!session) return c.redirect("/auth/sign-in", 302);
		await next();
	};

	// --- auth -------------------------------------------------------------

	app.get("/auth/sign-in", async (c) => {
		if (await currentSession(c)) return c.redirect("/", 302);
		return await html(c, "login", { title: "Sign in" });
	});

	app.post("/auth/request", async (c) => {
		const form = await c.req.parseBody();
		const email = String(form.email ?? "").trim();
		if (!email.includes("@")) {
			return await html(c, "login", {
				title: "Sign in",
				email,
				flash: { kind: "error", message: "That does not look like an email address." },
			}, 400);
		}

		await auth.requestLink({ tenant: c.get("tenant"), email, origin: c.get("origin") });
		// Identical response whether or not the address is allowed.
		return await html(c, "login_sent", { title: "Check your email", email });
	});

	app.get("/auth/callback", async (c) => {
		const token = c.req.query("token");
		const result = await auth.redeemToken({ tenant: c.get("tenant"), token });
		if (!result.ok) {
			return await html(c, "login", {
				title: "Sign in",
				flash: {
					kind: "error",
					message: "That sign-in link has already been used or has expired. Request another.",
				},
			}, 400);
		}
		setCookie(
			c,
			SESSION_COOKIE,
			await sign(config.appSecret, result.session.id),
			cookieOptions(SESSION_TTL_SECONDS),
		);
		return c.redirect("/", 302);
	});

	app.get("/auth/sign-out", async (c) => {
		const session = await currentSession(c);
		if (session) await auth.signOut({ tenant: c.get("tenant"), sessionId: session.id });
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		return c.redirect("/auth/sign-in", 302);
	});

	// --- upload -----------------------------------------------------------

	app.get("/", requireSession, async (c) => {
		const tenant = c.get("tenant");
		const session = c.get("session");
		return await html(c, "upload", {
			title: `Send files — ${tenant.name}`,
			currentEmail: session.email,
			maxFileBytes: tenant.maxFileBytes,
			maxTotalBytes: tenant.maxCollectionBytes,
			maxFiles: tenant.maxFilesPerUpload,
			maxFileLabel: formatBytes(tenant.maxFileBytes),
			defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
			clientScript: "/assets/upload.js",
		});
	});

	/** Phase 1. Returns presigned PUT URLs; stores nothing shareable yet. */
	app.post("/api/uploads", requireSession, async (c) => {
		const body = await c.req.json().catch(() => null);
		if (!body) return c.json({ error: "bad_request", message: "Malformed request." }, 400);

		try {
			const plan = await shares.beginUpload({
				tenant: c.get("tenant"),
				session: c.get("session"),
				files: body.files,
				asCollection: body.asCollection,
				collectionTitle: body.collectionTitle,
				expiryDays: body.expiryDays,
			});
			return c.json(plan);
		} catch (error) {
			if (error instanceof UploadError) {
				return c.json({ error: error.code, message: error.message, ...error.details }, 400);
			}
			throw error;
		}
	});

	/**
	 * Phase 2. A real form POST rather than fetch, so the confirmation page is
	 * server-rendered and the PIN is shown exactly once, in a response the
	 * browser cannot replay.
	 */
	app.post("/upload/complete", requireSession, async (c) => {
		const form = await c.req.parseBody();
		const tenant = c.get("tenant");

		try {
			const { shares: made, pins } = await shares.completeUpload({
				tenant,
				session: c.get("session"),
				shareId: String(form.shareId ?? ""),
				withPin: form.withPin === "1",
				zipSize: Number(form.zipSize ?? 0),
			});

			const origin = c.get("origin");
			const items = made.map((share, i) => {
				const shareUrl = `${origin}/s/${share.id}`;
				return {
					share: share.toViewModel(),
					shareUrl,
					deleteUrl: `${shareUrl}/delete`,
					pin: pins[i] ?? null,
				};
			});

			const summary = buildUploadSummary({
				items,
				domain: tenant.domain,
				timeZone: resolveTimeZone(form.tz),
			});

			return await html(c, "complete", {
				title: "Ready to share",
				currentEmail: c.get("session").email,
				items,
				summaryDownload: {
					filename: summary.filename,
					href: `data:text/plain;charset=utf-8,${encodeURIComponent(summary.body)}`,
				},
				now: clock.now(),
				clientScript: "/assets/upload.js",
			});
		} catch (error) {
			if (error instanceof UploadError) {
				return await errorPage(c, 400, "That upload did not finish", error.message);
			}
			throw error;
		}
	});

	// --- share ------------------------------------------------------------

	const loadShare = async (c) => {
		const share = await shares.find({ tenant: c.get("tenant"), shareId: c.req.param("shareId") });
		if (share) c.set("share", share);
		return share;
	};

	/** Has this visitor already cleared the PIN gate for this share? */
	const pinCleared = async (c, share) => {
		if (!share.hasPin) return true;
		const cookie = getCookie(c, pinCookieName(share.id));
		if (!cookie) return false;
		return (await unsign(config.appSecret, cookie)) === share.id;
	};

	app.get("/s/:shareId", async (c) => {
		const share = await loadShare(c);
		if (!share) return await html(c, "gone", { title: "Link expired" }, 404);

		if (!(await pinCleared(c, share))) {
			const locked = await pins.isLocked(share.tenantId, share.id);
			return await html(c, "pin", {
				title: "Enter the PIN",
				shareId: share.id,
				locked,
				lockoutMinutes: Math.round(PIN_LOCKOUT_SECONDS / 60),
			}, locked ? 429 : 401);
		}

		return await html(c, share.isCollection ? "collection" : "file", {
			title: share.title,
			share: share.toViewModel(),
			now: clock.now(),
		});
	});

	app.post("/s/:shareId/unlock", async (c) => {
		const share = await loadShare(c);
		if (!share) return await html(c, "gone", { title: "Link expired" }, 404);

		const form = await c.req.parseBody();
		const { result, remaining } = await pins.verify(share, form.pin);

		if (result === PinResult.OK) {
			setCookie(
				c,
				pinCookieName(share.id),
				await sign(config.appSecret, share.id),
				cookieOptions(PIN_COOKIE_TTL_SECONDS),
			);
			return c.redirect(`/s/${share.id}`, 302);
		}

		const locked = result === PinResult.LOCKED;
		return await html(c, "pin", {
			title: "Enter the PIN",
			shareId: share.id,
			locked,
			lockoutMinutes: Math.round(PIN_LOCKOUT_SECONDS / 60),
			flash: locked ? null : {
				kind: "error",
				message: `That PIN is not right. ${remaining} ${remaining === 1 ? "try" : "tries"} left.`,
			},
		}, locked ? 429 : 401);
	});

	/**
	 * Downloads are a redirect to a short-lived presigned R2 URL. The file
	 * bytes never pass through this app, so egress and memory stay flat
	 * regardless of file size.
	 */
	app.get("/s/:shareId/f/:fileId/download", async (c) => {
		const share = await loadShare(c);
		if (!share) return await html(c, "gone", { title: "Link expired" }, 404);
		if (!(await pinCleared(c, share))) return c.redirect(`/s/${share.id}`, 302);

		const url = await shares.downloadUrlForFile({ share, fileId: c.req.param("fileId") });
		if (!url) return await errorPage(c, 404, "File not found", "That file is not part of this share.");
		return c.redirect(url, 302);
	});

	app.get("/s/:shareId/download-all", async (c) => {
		const share = await loadShare(c);
		if (!share) return await html(c, "gone", { title: "Link expired" }, 404);
		if (!(await pinCleared(c, share))) return c.redirect(`/s/${share.id}`, 302);

		const url = await shares.downloadUrlForZip({ share });
		if (!url) {
			return await errorPage(
				c,
				404,
				"No zip for this share",
				"Download the files individually instead.",
			);
		}
		return c.redirect(url, 302);
	});

	// --- deletion ---------------------------------------------------------

	app.get("/s/:shareId/delete", async (c) => {
		const share = await loadShare(c);
		if (!share) return await html(c, "gone", { title: "Link expired" }, 404);

		return await html(c, "delete_confirm", {
			title: "Delete this share",
			share: share.toViewModel(),
			needsPin: share.hasPin && !(await pinCleared(c, share)),
		});
	});

	app.post("/s/:shareId/delete", async (c) => {
		const share = await loadShare(c);
		if (!share) return await html(c, "gone", { title: "Link expired" }, 404);

		const needsPin = share.hasPin && !(await pinCleared(c, share));
		if (needsPin) {
			const form = await c.req.parseBody();
			const { result } = await pins.verify(share, form.pin);
			if (result !== PinResult.OK) {
				return await html(c, "delete_confirm", {
					title: "Delete this share",
					share: share.toViewModel(),
					needsPin: true,
					flash: { kind: "error", message: "That PIN is not right." },
				}, 401);
			}
		}

		await shares.destroy({ tenant: c.get("tenant"), share });
		deleteCookie(c, pinCookieName(share.id), { path: "/" });
		return await html(c, "deleted", { title: "Deleted" });
	});

	// --- fallbacks --------------------------------------------------------

	app.notFound((c) =>
		errorPage(c, 404, "Nothing here", "That link does not point at anything on this site.")
	);

	app.onError(async (error, c) => {
		logger?.error("unhandled error", { path: c.req.path, error: String(error?.stack ?? error) });
		return await errorPage(
			c,
			500,
			"Something went wrong",
			"That did not work. Try again in a moment.",
		);
	});

	return app;
};
