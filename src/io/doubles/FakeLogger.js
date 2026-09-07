/** Records log lines in memory instead of writing them. */
export const FakeLogger = () => {
	const lines = [];
	const make = (scope) => {
		const push = (level) => (msg, fields) => lines.push({ level, scope, msg, fields });
		return Object.freeze({
			level: "debug",
			lines,
			error: push("error"),
			warn: push("warn"),
			info: push("info"),
			debug: push("debug"),
			scoped: (inner) => make(scope ? `${scope}.${inner}` : inner),
			/** Test helper: every message recorded at a level. */
			messagesAt: (level) => lines.filter((l) => l.level === level).map((l) => l.msg),
			reset: () => lines.splice(0, lines.length),
		});
	};
	return make("");
};
