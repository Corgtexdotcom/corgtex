import { describe, expect, it } from "vitest";
import { AppError, invariant } from "./errors";

describe("AppError", () => {
  it("carries status, code, and message", () => {
    const err = new AppError(404, "NOT_FOUND", "Thing not found.");
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Thing not found.");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("invariant", () => {
  it("does not throw when condition is truthy", () => {
    expect(() => invariant(true, 400, "FAIL", "msg")).not.toThrow();
    expect(() => invariant(1, 400, "FAIL", "msg")).not.toThrow();
    expect(() => invariant("str", 400, "FAIL", "msg")).not.toThrow();
    expect(() => invariant({}, 400, "FAIL", "msg")).not.toThrow();
  });

  it("throws AppError when condition is falsy", () => {
    expect(() => invariant(false, 400, "BAD", "bad thing")).toThrowError(AppError);
    expect(() => invariant(null, 404, "MISSING", "missing")).toThrowError("missing");
    expect(() => invariant(undefined, 400, "EMPTY", "empty")).toThrowError(AppError);
    expect(() => invariant(0, 400, "ZERO", "zero")).toThrowError(AppError);
    expect(() => invariant("", 400, "BLANK", "blank")).toThrowError(AppError);
  });

  it("throws AppError with correct fields", () => {
    try {
      invariant(false, 422, "VALIDATION", "Field is invalid.");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(422);
      expect((err as AppError).code).toBe("VALIDATION");
      expect((err as AppError).message).toBe("Field is invalid.");
    }
  });
});
