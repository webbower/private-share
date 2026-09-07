import { HttpError } from "../HttpClient.js";

/**
 * Records every outbound call and answers from a canned-response table.
 *
 * Matching order: an exact `METHOD url` string always wins over a pattern.
 * Among patterns, the first one registered wins, so stubs read specific-first
 * and a later catch-all cannot swallow an earlier narrow rule. An unmatched
 * call throws, so a test that forgets to stub something fails loudly rather
 * than quietly hitting the network.
 *
 *   const http = FakeHttpClient();
 *   http.on("DELETE", /orphan$/, { status: 500 });        // specific first
 *   http.on("DELETE", /storage\.test/, { status: 204 });  // then the general case
 *   http.on("POST", "https://api.resend.com/emails", { status: 200, json: { id: "e1" } });
 *   ...
 *   assert.equal(http.calls.length, 2);
 *   assert.equal(http.callsTo("PUT").length, 1);
 */
export const FakeHttpClient = ({ strict = true } = {}) => {
	const calls = [];
	const routes = [];
	let fallback = null;

	const toResponse = (spec, url) => {
		const status = spec.status ?? 200;
		const headers = new Headers(spec.headers ?? {});
		let body = spec.body ?? null;
		if (spec.json !== undefined) {
			body = JSON.stringify(spec.json);
			if (!headers.has("content-type")) headers.set("content-type", "application/json");
		}
		if (status === 204 || status === 304 || spec.noBody) body = null;
		const response = new Response(body, { status, headers });
		Object.defineProperty(response, "url", { value: url });
		return response;
	};

	const applies = (route, method) => route.method === method || route.method === "*";

	const match = (method, url) => {
		// Exact URL stubs take precedence over any pattern.
		const exact = routes.find((r) =>
			applies(r, method) && typeof r.pattern === "string" && r.pattern === url
		);
		if (exact) return exact;

		return routes.find((r) => {
			if (!applies(r, method)) return false;
			if (r.pattern instanceof RegExp) return r.pattern.test(url);
			if (typeof r.pattern === "function") return r.pattern(url);
			return false;
		}) ?? null;
	};

	const send = async (method, url, options = {}) => {
		const call = {
			method,
			url,
			headers: { ...(options.headers ?? {}) },
			body: options.body ?? null,
			at: calls.length,
		};
		calls.push(call);

		const route = match(method, url);
		const spec = route ? route.spec : fallback;

		if (!spec) {
			if (strict) {
				throw new HttpError(`FakeHttpClient: no stub for ${method} ${url}`, { url, status: 0 });
			}
			return toResponse({ status: 200 }, url);
		}

		if (route) route.hits += 1;
		const resolved = typeof spec === "function" ? await spec(call) : spec;
		if (resolved instanceof Response) return resolved;
		if (resolved?.throws) throw resolved.throws;
		return toResponse(resolved, url);
	};

	const expectOk = async (response, method, url) => {
		if (response.ok) return response;
		const body = await response.text().catch(() => "");
		throw new HttpError(`${method} ${url} returned ${response.status}`, {
			status: response.status,
			url,
			body,
		});
	};

	return Object.freeze({
		calls,
		request: send,

		/** Register a canned response. `spec` may be an object, a Response, or a function. */
		on(method, pattern, spec) {
			routes.push({ method, pattern, spec, hits: 0 });
			return this;
		},
		/** Response used when nothing else matches. */
		onAny(spec) {
			fallback = spec;
			return this;
		},

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

		// --- assertion helpers ---
		callsTo: (method) => calls.filter((c) => c.method === method),
		callsMatching: (pattern) =>
			calls.filter((c) => (pattern instanceof RegExp ? pattern.test(c.url) : c.url === pattern)),
		lastCall: () => calls.at(-1) ?? null,
		jsonBodyOf: (call) => (call?.body ? JSON.parse(call.body) : null),
		reset: () => {
			calls.splice(0, calls.length);
			routes.splice(0, routes.length);
			fallback = null;
		},
	});
};
