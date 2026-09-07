/** A clock the tests drive by hand. */
export const FixedClock = (startMs = Date.parse("2026-03-01T12:00:00.000Z")) => {
	let current = startMs;
	return Object.freeze({
		now: () => current,
		date: () => new Date(current),
		advance: (ms) => (current += ms),
		advanceDays: (days) => (current += days * 86400000),
		set: (ms) => (current = ms),
	});
};
