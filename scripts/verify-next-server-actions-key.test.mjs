import { describe, expect, it } from "vitest";

import {
  parseArgs,
  validateServerActionsKey,
  verifyNextServerActionsKey,
} from "./verify-next-server-actions-key.mjs";

const VALID_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64");

describe("Next Server Action key verification", () => {
  it("accepts a 32-byte base64 key", () => {
    expect(validateServerActionsKey(VALID_KEY)).toEqual({ ok: true });
  });

  it("rejects missing keys in required mode", () => {
    expect(verifyNextServerActionsKey({}, { required: true })).toMatchObject({
      ok: false,
      level: "error",
      message: expect.stringContaining("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is missing"),
    });
  });

  it("warns but does not fail local builds without a key", () => {
    expect(verifyNextServerActionsKey({}, { required: false })).toMatchObject({
      ok: true,
      level: "warn",
    });
  });

  it("rejects malformed or short key material", () => {
    expect(validateServerActionsKey("not base64")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("standard base64"),
    });
    expect(validateServerActionsKey("c2hvcnQ=")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("32 bytes"),
    });
  });

  it("parses required mode", () => {
    expect(parseArgs(["--required"])).toEqual({ required: true });
    expect(parseArgs([])).toEqual({ required: false });
  });
});
