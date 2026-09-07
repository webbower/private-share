/**
 * Share PIN.
 *
 * The PIN's job is to stop link-preview crawlers and bulk scrapers from
 * fetching a share the moment its URL is posted to a social site or passes
 * through a mail scanner. It is not a password, and the UI says so. A crawler
 * sees an HTML form and no file; it does not fill in forms.
 *
 * Because six digits is a small space, the rate limiter below is doing the real
 * work — the KDF only ensures a leaked metadata dump is not a list of live PINs.
 */

import { PIN_LOCKOUT_SECONDS, PIN_MAX_ATTEMPTS } from "~/config/limits.js";
import { keys } from "~/lib/keys.js";
import { pbkdf2, timingSafeEqual } from "~/lib/crypto.js";

export const hashPin = async (pin, salt) => await pbkdf2(pin, salt);

export const createPin = async ({ ids }) => {
	const pin = ids.pin();
	const salt = ids.salt();
	return { pin, salt, hash: await hashPin(pin, salt) };
};

export const PinResult = Object.freeze({
	OK: "ok",
	WRONG: "wrong",
	LOCKED: "locked",
});

export const PinService = ({ kv, clock, logger }) => {
	const log = logger?.scoped("pin");

	return Object.freeze({
		async attemptsUsed(tenantId, shareId) {
			return (await kv.get(keys.pinAttempts(tenantId, shareId))) ?? 0;
		},

		async isLocked(tenantId, shareId) {
			return (await this.attemptsUsed(tenantId, shareId)) >= PIN_MAX_ATTEMPTS;
		},

		/**
		 * Verify a submitted PIN. Wrong guesses burn an attempt; a correct guess
		 * clears the counter.
		 */
		async verify(share, submitted) {
			const { tenantId, id } = share;
			if (await this.isLocked(tenantId, id)) return { result: PinResult.LOCKED, remaining: 0 };

			const candidate = String(submitted ?? "").replace(/\D/g, "");
			const hash = candidate ? await hashPin(candidate, share.pinSalt) : "";

			if (candidate && timingSafeEqual(hash, share.pinHash)) {
				await kv.delete(keys.pinAttempts(tenantId, id));
				return { result: PinResult.OK, remaining: PIN_MAX_ATTEMPTS };
			}

			const used = await kv.increment(keys.pinAttempts(tenantId, id), {
				expireIn: PIN_LOCKOUT_SECONDS * 1000,
			});
			log?.warn("bad pin", { shareId: id, used });

			return used >= PIN_MAX_ATTEMPTS
				? { result: PinResult.LOCKED, remaining: 0 }
				: { result: PinResult.WRONG, remaining: PIN_MAX_ATTEMPTS - used };
		},

		/** Seconds until a locked-out visitor may try again. */
		lockoutSeconds: () => PIN_LOCKOUT_SECONDS,
		clock,
	});
};
