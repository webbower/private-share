/**
 * AWS Signature Version 4, query-string ("presigned URL") flavour, implemented
 * against Web Crypto. Pure functions: given the same clock reading and keys it
 * always produces the same URL, which is what makes it testable.
 *
 * R2 speaks the S3 API, so this is all that is needed to hand the browser a URL
 * it can PUT to or GET from directly. Bytes never pass through the app.
 */

import { hmacSha256, sha256Hex, toHex } from "./crypto.js";

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** RFC 3986 escaping. `encodeURIComponent` leaves !'()* alone; S3 does not. */
const uriEncode = (value) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/** Object keys keep their slashes; every other character is escaped. */
export const encodeKeyPath = (key) => key.split("/").map(uriEncode).join("/");

export const amzDate = (date) => `${date.toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
export const dateStamp = (date) => amzDate(date).slice(0, 8);

const canonicalQueryString = (params) =>
	Object.entries(params)
		.filter(([, v]) => v !== undefined && v !== null)
		.map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join("&");

const canonicalHeaders = (headers) => {
	const entries = Object.entries(headers)
		.map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return {
		canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(""),
		signed: entries.map(([k]) => k).join(";"),
	};
};

const signingKey = async (secretAccessKey, stamp, region, service) => {
	const kDate = await hmacSha256(`AWS4${secretAccessKey}`, stamp);
	const kRegion = await hmacSha256(kDate, region);
	const kService = await hmacSha256(kRegion, service);
	return await hmacSha256(kService, "aws4_request");
};

/**
 * Build a presigned URL.
 *
 * Any header passed in `headers` becomes a *signed* header, which means the
 * client must send it with exactly that value or the signature will not verify.
 * That is how the upload size cap is enforced: the server signs
 * `content-length: <declared size>`, so the browser cannot send a larger body.
 *
 * @param {object} args
 * @param {string} args.method                 HTTP verb
 * @param {string} args.endpoint               e.g. https://acct.r2.cloudflarestorage.com
 * @param {string} args.bucket
 * @param {string} args.key                    object key
 * @param {string} args.accessKeyId
 * @param {string} args.secretAccessKey
 * @param {string} [args.region="auto"]
 * @param {string} [args.service="s3"]
 * @param {number} [args.expiresIn=900]        seconds
 * @param {Date}   [args.date=new Date()]
 * @param {Record<string,string>} [args.headers]  additional signed headers
 * @param {Record<string,string>} [args.query]    additional query params
 * @returns {Promise<string>} the signed URL
 */
export const presign = async ({
	method,
	endpoint,
	bucket,
	key,
	accessKeyId,
	secretAccessKey,
	region = "auto",
	service = "s3",
	expiresIn = 900,
	date = new Date(),
	headers = {},
	query = {},
}) => {
	const url = new URL(endpoint);
	const host = url.host;
	// Path-style when a bucket is given (R2's default); virtual-hosted style when
	// the bucket is already part of the endpoint hostname and `bucket` is blank.
	const path = bucket ? `/${bucket}/${encodeKeyPath(key)}` : `/${encodeKeyPath(key)}`;

	const stamp = dateStamp(date);
	const timestamp = amzDate(date);
	const credentialScope = `${stamp}/${region}/${service}/aws4_request`;

	const { canonical, signed } = canonicalHeaders({ host, ...headers });

	const params = {
		...query,
		"X-Amz-Algorithm": ALGORITHM,
		"X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
		"X-Amz-Date": timestamp,
		"X-Amz-Expires": String(expiresIn),
		"X-Amz-SignedHeaders": signed,
	};

	const canonicalRequest = [
		method.toUpperCase(),
		path,
		canonicalQueryString(params),
		canonical,
		signed,
		UNSIGNED_PAYLOAD,
	].join("\n");

	const stringToSign = [
		ALGORITHM,
		timestamp,
		credentialScope,
		await sha256Hex(canonicalRequest),
	].join("\n");

	const key4 = await signingKey(secretAccessKey, stamp, region, service);
	const signature = toHex(await hmacSha256(key4, stringToSign));

	const finalQuery = canonicalQueryString({ ...params, "X-Amz-Signature": signature });
	return `${url.protocol}//${host}${path}?${finalQuery}`;
};

/**
 * Sign a request the *server* will make itself (HEAD, DELETE), using the
 * Authorization header rather than query params.
 */
export const signRequest = async ({
	method,
	endpoint,
	bucket,
	key,
	accessKeyId,
	secretAccessKey,
	region = "auto",
	service = "s3",
	date = new Date(),
	headers = {},
	query = {},
}) => {
	const url = new URL(endpoint);
	const host = url.host;
	const path = bucket ? `/${bucket}/${encodeKeyPath(key)}` : `/${encodeKeyPath(key)}`;
	const stamp = dateStamp(date);
	const timestamp = amzDate(date);
	const credentialScope = `${stamp}/${region}/${service}/aws4_request`;

	const allHeaders = {
		host,
		"x-amz-content-sha256": UNSIGNED_PAYLOAD,
		"x-amz-date": timestamp,
		...headers,
	};
	const { canonical, signed } = canonicalHeaders(allHeaders);

	const canonicalRequest = [
		method.toUpperCase(),
		path,
		canonicalQueryString(query),
		canonical,
		signed,
		UNSIGNED_PAYLOAD,
	].join("\n");

	const stringToSign = [
		ALGORITHM,
		timestamp,
		credentialScope,
		await sha256Hex(canonicalRequest),
	].join("\n");

	const key4 = await signingKey(secretAccessKey, stamp, region, service);
	const signature = toHex(await hmacSha256(key4, stringToSign));

	const authorization =
		`${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signed}, Signature=${signature}`;

	const qs = canonicalQueryString(query);
	return {
		url: `${url.protocol}//${host}${path}${qs ? `?${qs}` : ""}`,
		headers: { ...allHeaders, authorization },
	};
};
