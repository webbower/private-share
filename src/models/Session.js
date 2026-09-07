import { Model } from "./Model.js";

/** An authenticated uploader session, scoped to one tenant. */
export const Session = Model.extend({
	name: "Session",
	ctor: ({ id = "", tenantId = "", email = "", createdAt = 0, expiresAt = 0 }) => ({
		id,
		tenantId,
		email: String(email).trim().toLowerCase(),
		createdAt: Number(createdAt) || 0,
		expiresAt: Number(expiresAt) || 0,
	}),
	proto: {
		isValidAt(nowMs) {
			return this.expiresAt > nowMs;
		},
		belongsTo(tenantId) {
			return this.tenantId === tenantId;
		},
		toJSON() {
			return { ...this };
		},
	},
	stat: { fromJSON: (json) => Session(json ?? {}) },
});
