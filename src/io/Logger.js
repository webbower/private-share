/**
 * Thin wrapper over `console`. Everything that writes to stdout goes through
 * this so tests can assert on log output and stay silent by default.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export const Logger = ({ level = "info", sink = console, now = () => new Date() } = {}) => {
	const threshold = LEVELS[level] ?? LEVELS.info;

	const write = (levelName, method, message, fields) => {
		if ((LEVELS[levelName] ?? 99) > threshold) return;
		const line = { t: now().toISOString(), level: levelName, msg: message };
		if (fields !== undefined) line.fields = fields;
		sink[method](JSON.stringify(line));
	};

	/** Build a logger whose messages are prefixed with `scope` (empty for root). */
	const at = (scope) => {
		const label = (message) => (scope ? `${scope}: ${message}` : message);
		return Object.freeze({
			level,
			error: (message, fields) => write("error", "error", label(message), fields),
			warn: (message, fields) => write("warn", "warn", label(message), fields),
			info: (message, fields) => write("info", "log", label(message), fields),
			debug: (message, fields) => write("debug", "log", label(message), fields),
			/** Child logger that prefixes every message with a further scope. */
			scoped: (inner) => at(scope ? `${scope}.${inner}` : inner),
		});
	};

	return at("");
};
