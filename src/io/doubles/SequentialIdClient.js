import { isCuid } from "@paralleldrive/cuid2";

/**
 * Predictable ids so assertions can name them. Still produces cuid-shaped
 * strings so anything that validates the format keeps working.
 */
export const SequentialIdClient = ({ prefix = "tst" } = {}) => {
	const counters = new Map();
	const next = (kind, length) => {
		const n = (counters.get(kind) ?? 0) + 1;
		counters.set(kind, n);
		return `${prefix}${kind}${String(n).padStart(3, "0")}`.padEnd(length, "x").slice(0, length);
	};

	let pinSeed = 100000;

	return Object.freeze({
		shareId: () => next("share", 24),
		fileId: () => next("file", 16),
		sessionId: () => next("sess", 24),
		token: () => next("token", 48),
		isValidId: (value) => typeof value === "string" && (isCuid(value) || value.startsWith(prefix)),
		pin: () => String(pinSeed++).slice(-6).padStart(6, "0"),
		salt: () => `salt${next("salt", 8)}`,
		reset: () => {
			counters.clear();
			pinSeed = 100000;
		},
	});
};
