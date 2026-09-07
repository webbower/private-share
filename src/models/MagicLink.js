import { Model } from "./Model.js";

/**
 * A single-use login token. Only the hash is ever persisted, so a KV dump does
 * not hand anyone a working link.
 */
export const MagicLink = Model.extend({
	name: "MagicLink",
	ctor: ({ tokenHash = "", tenantId = "", email = "", createdAt = 0, expiresAt = 0, usedAt = 0 }) => ({
		tokenHash,
		tenantId,
		email: String(email).trim().toLowerCase(),
		createdAt: Number(createdAt) || 0,
		expiresAt: Number(expiresAt) || 0,
		usedAt: Number(usedAt) || 0,
	}),
	proto: {
		get isUsed() {
			return this.usedAt > 0;
		},
		isValidAt(nowMs) {
			return !this.isUsed && this.expiresAt > nowMs;
		},
		toJSON() {
			return { ...this };
		},
	},
	stat: { fromJSON: (json) => MagicLink(json ?? {}) },
});
