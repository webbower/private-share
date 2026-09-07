/** Captures outgoing mail so tests can read the magic link out of the body. */
export const FakeMailClient = () => {
	const sent = [];
	return Object.freeze({
		sent,
		send(message) {
			const record = { ...message, id: `fake-mail-${sent.length + 1}` };
			sent.push(record);
			return Promise.resolve({ id: record.id });
		},
		lastTo: (address) => sent.filter((m) => m.to === address).at(-1) ?? null,
		last: () => sent.at(-1) ?? null,
		/** Pull the first http(s) URL out of the most recent message. */
		lastLink() {
			const body = `${sent.at(-1)?.text ?? ""} ${sent.at(-1)?.html ?? ""}`;
			return body.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null;
		},
		reset: () => sent.splice(0, sent.length),
	});
};
