/**
 * Web Crypto helpers. Pure functions — no IO — so they are exercised directly
 * rather than through a test double.
 */

const encoder = new TextEncoder();

export const toBytes = (input) => (typeof input === "string" ? encoder.encode(input) : input);

export const toHex = (buffer) =>
	Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

export const base64UrlEncode = (buffer) => {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const base64UrlDecode = (value) => {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
		Math.ceil(value.length / 4) * 4,
		"=",
	);
	const binary = atob(padded);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

export const sha256Hex = async (input) => toHex(await crypto.subtle.digest("SHA-256", toBytes(input)));

export const hmacSha256 = async (key, message) => {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		toBytes(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, toBytes(message)));
};

export const hmacSha256Hex = async (key, message) => toHex(await hmacSha256(key, message));

/** Comparison whose duration does not depend on where the first difference is. */
export const timingSafeEqual = (a, b) => {
	const left = toBytes(a);
	const right = toBytes(b);
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
	return diff === 0;
};

export const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

export const randomToken = (byteLength = 32) => base64UrlEncode(randomBytes(byteLength));

/**
 * PBKDF2-SHA256. Used for the share PIN. The PIN is six digits, so this is not
 * meaningfully resistant to an offline attack — the rate limiter in
 * `services/pin.js` is what actually protects a share. The KDF is here so a
 * leaked KV dump does not immediately reveal live PINs.
 */
export const pbkdf2 = async (password, salt, { iterations = 120_000, bits = 256 } = {}) => {
	const keyMaterial = await crypto.subtle.importKey("raw", toBytes(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const derived = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: toBytes(salt), iterations, hash: "SHA-256" },
		keyMaterial,
		bits,
	);
	return toHex(derived);
};

/** HMAC-signed value of the form `<payload>.<signature>`, for cookies. */
export const sign = async (secret, payload) => {
	const signature = base64UrlEncode(await hmacSha256(secret, payload));
	return `${payload}.${signature}`;
};

export const unsign = async (secret, signed) => {
	const index = String(signed ?? "").lastIndexOf(".");
	if (index <= 0) return null;
	const payload = signed.slice(0, index);
	const signature = signed.slice(index + 1);
	const expected = base64UrlEncode(await hmacSha256(secret, payload));
	return timingSafeEqual(signature, expected) ? payload : null;
};
