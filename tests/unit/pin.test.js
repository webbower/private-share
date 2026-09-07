import assert from "node:assert/strict";
import { createTestContainer } from "~/deps-test.js";
import { createPin, hashPin, PinResult, PinService } from "~/services/pin.js";
import { PIN_MAX_ATTEMPTS } from "~/config/limits.js";

const share = (overrides) => ({ id: "shr1", tenantId: "t1", ...overrides });

Deno.test("a generated PIN is six digits and hashes with its salt", async () => {
	const c = createTestContainer({ ids: undefined });
	const { pin, salt, hash } = await createPin(c);

	assert.match(pin, /^\d{6}$/);
	assert.equal(hash, await hashPin(pin, salt));
	assert.notEqual(hash, await hashPin(pin, "different-salt"));
	assert.notEqual(hash, pin);
});

Deno.test("the correct PIN verifies and clears the attempt counter", async () => {
	const c = createTestContainer();
	const pins = PinService(c);
	const { pin, salt, hash } = await createPin(c);
	const s = share({ pinHash: hash, pinSalt: salt });

	await pins.verify(s, "000000");
	assert.equal(await pins.attemptsUsed("t1", "shr1"), 1);

	const result = await pins.verify(s, pin);
	assert.equal(result.result, PinResult.OK);
	assert.equal(await pins.attemptsUsed("t1", "shr1"), 0);
});

Deno.test("guesses are exhausted and then locked out", async () => {
	const c = createTestContainer();
	const pins = PinService(c);
	const { pin, salt, hash } = await createPin(c);
	const s = share({ pinHash: hash, pinSalt: salt });

	for (let i = 1; i < PIN_MAX_ATTEMPTS; i += 1) {
		const { result, remaining } = await pins.verify(s, "000000");
		assert.equal(result, PinResult.WRONG);
		assert.equal(remaining, PIN_MAX_ATTEMPTS - i);
	}

	assert.equal((await pins.verify(s, "000000")).result, PinResult.LOCKED);
	// Even the right PIN is refused while locked out.
	assert.equal((await pins.verify(s, pin)).result, PinResult.LOCKED);
});

Deno.test("the lockout lifts once its window passes", async () => {
	const c = createTestContainer();
	const pins = PinService(c);
	const { pin, salt, hash } = await createPin(c);
	const s = share({ pinHash: hash, pinSalt: salt });

	for (let i = 0; i < PIN_MAX_ATTEMPTS; i += 1) await pins.verify(s, "000000");
	assert.equal(await pins.isLocked("t1", "shr1"), true);

	c.clock.advance(16 * 60 * 1000);
	assert.equal(await pins.isLocked("t1", "shr1"), false);
	assert.equal((await pins.verify(s, pin)).result, PinResult.OK);
});

Deno.test("non-digits and empty input are treated as wrong, not as errors", async () => {
	const c = createTestContainer();
	const pins = PinService(c);
	const { salt, hash } = await createPin(c);
	const s = share({ pinHash: hash, pinSalt: salt });

	for (const bad of ["", null, undefined, "abcdef", "  "]) {
		assert.equal((await pins.verify(s, bad)).result, PinResult.WRONG);
	}
});
