/**
 * The only module in the app that calls `fetch`. Everything that talks to the
 * network — object storage, the mail provider — goes through an HttpClient, so
 * a test can swap in `FakeHttpClient` and assert on the exact outbound calls.
 */

export class HttpError extends Error {
	constructor(message, { status = 0, url = "", body = "" } = {}) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.url = url;
		this.body = body;
	}
}

/**
 * @param {object} deps
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {object} [deps.logger]
 * @param {number} [deps.timeoutMs]
 */
export const HttpClient = ({ fetchImpl = globalThis.fetch, logger, timeoutMs = 30_000 } = {}) => {
	const log = logger?.scoped("http");

	const send = async (method, url, { headers = {}, body, signal } = {}) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

		log?.debug("request", { method, url });
		try {
			const response = await fetchImpl(url, {
				method,
				headers,
				body,
				signal: controller.signal,
				redirect: "follow",
			});
			log?.debug("response", { method, url, status: response.status });
			return response;
		} catch (cause) {
			log?.error("request failed", { method, url, error: String(cause) });
			throw new HttpError(`${method} ${url} failed: ${cause}`, { url });
		} finally {
			clearTimeout(timer);
		}
	};

	const expectOk = async (response, method, url) => {
		if (response.ok) return response;
		const body = await response.text().catch(() => "");
		throw new HttpError(`${method} ${url} returned ${response.status}`, {
			status: response.status,
			url,
			body: body.slice(0, 500),
		});
	};

	return Object.freeze({
		request: send,

		async get(url, options) {
			return await expectOk(await send("GET", url, options), "GET", url);
		},
		async head(url, options) {
			return await send("HEAD", url, options);
		},
		async put(url, options) {
			return await expectOk(await send("PUT", url, options), "PUT", url);
		},
		async del(url, options) {
			return await expectOk(await send("DELETE", url, options), "DELETE", url);
		},
		async postJson(url, payload, { headers = {}, ...rest } = {}) {
			const response = await send("POST", url, {
				...rest,
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(payload),
			});
			await expectOk(response, "POST", url);
			const text = await response.text();
			return text ? JSON.parse(text) : null;
		},
	});
};
