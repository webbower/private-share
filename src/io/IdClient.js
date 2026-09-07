import { init, isCuid } from "@paralleldrive/cuid2";
import { PIN_LENGTH } from "~/config/limits.js";
import { ID_LENGTH } from "~/config/limits.js";

/**
 * Identifier generation. cuid2 for share, file and session ids: collision
 * resistant, no coordination, and URL-safe without escaping.
 */
export const IdClient = () => {
	const createShareId = init({ length: ID_LENGTH });
	const createFileId = init({ length: 16 });

	return Object.freeze({
		shareId: () => createShareId(),
		fileId: () => createFileId(),
		sessionId: () => createShareId(),
		token: () => createShareId() + createShareId(),
		isValidId: (value) => typeof value === "string" && isCuid(value),

		/** Uniform 6-digit PIN. Rejection sampling keeps the distribution even. */
		pin() {
			const max = 10 ** PIN_LENGTH;
			const limit = Math.floor(4294967296 / max) * max;
			const buffer = new Uint32Array(1);
			let value;
			do {
				crypto.getRandomValues(buffer);
				value = buffer[0];
			} while (value >= limit);
			return String(value % max).padStart(PIN_LENGTH, "0");
		},

		salt: () =>
			Array.from(crypto.getRandomValues(new Uint8Array(16)))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(""),
	});
};
