/** Transactional email over the Resend HTTP API. */
export const MailClient = ({ http, config, logger }) => {
	const log = logger?.scoped("mail");

	return Object.freeze({
		async send({ to, subject, html, text }) {
			const result = await http.postJson(
				config.endpoint,
				{ from: config.from, to: [to], subject, html, text },
				{ headers: { authorization: `Bearer ${config.apiKey}` } },
			);
			log?.info("sent email", { to, subject, id: result?.id });
			return { id: result?.id ?? null };
		},
	});
};
