import { expect, test } from "vitest";
import { ERROR_STATUS, PairingCreated, PairingPurpose, PairingRequest, SessionRequest } from "./index.ts";

const secret = `emp_${"a".repeat(43)}`;

test("pairing purpose defaults to device and internal errors have a status", () => {
  expect(PairingPurpose.options).toEqual(["device", "machine"]);
  expect(PairingRequest.parse({})).toEqual({ purpose: "device" });
  expect(PairingRequest.parse({ purpose: "machine" })).toEqual({ purpose: "machine" });
  expect(PairingRequest.safeParse({ purpose: "other" }).success).toBe(false);
  expect(ERROR_STATUS.internal).toBe(500);
});

test("session accepts exactly one bounded secret or normalized Crockford code", () => {
  expect(SessionRequest.parse({ secret })).toEqual({ secret });
  expect(SessionRequest.parse({ code: "oIl0-abcd" })).toEqual({ code: "0110ABCD" });
  expect(SessionRequest.parse({ code: "abcd2345" })).toEqual({ code: "ABCD2345" });
  for (const body of [
    {},
    { secret, code: "ABCD2345" },
    { secret: `${secret}a` },
    { secret: "em_a" },
    { code: "ABCDU234" },
    { code: " ABCD2345" },
    { code: "ABC-D2345" },
    { code: "a".repeat(100) },
  ]) {
    expect(SessionRequest.safeParse(body).success).toBe(false);
  }
});

test("pairing response uses only a fragment secret, canonical code and UTC timestamp", () => {
  const value = {
    url: `https://example.test/pair#${secret}`,
    code: "ABCD-2345",
    expiresAt: "2026-01-01T00:10:00.000Z",
  };
  expect(PairingCreated.parse(value)).toEqual(value);
  for (const patch of [
    { url: `ftp://example.test/pair#${secret}` },
    { url: `https://example.test/pair?secret=${secret}` },
    { url: `https://example.test/pair?x=1#${secret}` },
    { url: `https://example.test/pair?#${secret}` },
    { code: "abcd-2345" },
    { expiresAt: 123 },
    { expiresAt: "2026-01-01T00:10:00+01:00" },
  ]) {
    expect(PairingCreated.safeParse({ ...value, ...patch }).success).toBe(false);
  }
});
