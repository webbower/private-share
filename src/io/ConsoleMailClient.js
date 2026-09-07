/**
 * DEVELOPMENT ONLY. Stands in for `MailClient` when `APP_ENV=development`.
 *
 * Instead of calling Resend, it prints the message — magic-link URL and all —
 * to the terminal running `deno task dev`, so local sign-in works with no email
 * provider and no verified domain. The container swaps this in; nothing else in
 * the app can tell the difference.
 */
export const ConsoleMailClient = ({ logger } = {}) => {
	const log = logger?.scoped("mail");

	return Object.freeze({
		send({ to, subject, text, html }) {
			const link = `${text ?? ""} ${html ?? ""}`.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null;
			const id = `dev-mail-${Date.now()}`;

			// console, not the JSON logger: this banner is meant for a human
			// watching the dev server, not for log scraping.
			console.log(
				[
					"",
					"  ┌────────────────────────────────────────────────────────────────",
					"  │  DEV MAIL — not actually sent",
					`  │  To:      ${to}`,
					`  │  Subject: ${subject}`,
					link ? `  │  Link:    ${link}` : "  │  (no link found in the message body)",
					"  └────────────────────────────────────────────────────────────────",
					"",
				].join("\n"),
			);
			log?.info("dev mail delivered to console", { to, subject, id });

			return Promise.resolve({ id });
		},
	});
};
