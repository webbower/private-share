/**
 * Minimal local stand-in for the `@webbower/stdlib/lang` predicates that
 * `Model.js` depends on. Mapped via the `deno.json` import map so `Model.js`
 * stays byte-identical to the canonical version.
 *
 * Replace the import-map entry with the real package when it is published.
 */

export const isFn = (x) => typeof x === "function";
export const isString = (x) => typeof x === "string";
export const isNumber = (x) => typeof x === "number" && !Number.isNaN(x);
export const isObject = (x) => x !== null && typeof x === "object";
export const isArray = Array.isArray;
export const isNil = (x) => x === null || x === undefined;
