/** Wraps `Date.now` so expiry logic is testable without waiting. */
export const Clock = () =>
	Object.freeze({
		now: () => Date.now(),
		date: () => new Date(),
	});
