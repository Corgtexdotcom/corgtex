import { describe, expect, it } from "vitest";
import { isDatabaseSchemaMissingError, isDatabaseUnavailableError } from "./db-errors";

describe("isDatabaseUnavailableError", () => {
  it("detects Prisma initialization failures", () => {
    const error = Object.assign(new Error("Can't reach database server"), {
      name: "PrismaClientInitializationError",
    });

    expect(isDatabaseUnavailableError(error)).toBe(true);
  });

  it("detects Prisma request errors with connection-related codes", () => {
    const error = Object.assign(new Error("Timed out fetching a new connection from the connection pool."), {
      name: "PrismaClientKnownRequestError",
      code: "P2024",
    });

    expect(isDatabaseUnavailableError(error)).toBe(true);
  });

  it("ignores normal auth failures", () => {
    const error = Object.assign(new Error("Invalid email or password."), {
      name: "AppError",
      code: "UNAUTHENTICATED",
    });

    expect(isDatabaseUnavailableError(error)).toBe(false);
  });
});

describe("isDatabaseSchemaMissingError", () => {
  it("detects Prisma request errors for missing tables", () => {
    const error = Object.assign(new Error("The table `public.UnknownTable` does not exist in the current database."), {
      name: "PrismaClientKnownRequestError",
      code: "P2021",
    });

    expect(isDatabaseSchemaMissingError(error)).toBe(true);
  });

  it("detects missing relations from raw database messages", () => {
    const error = Object.assign(new Error("relation \"UnknownRelation\" does not exist"), {
      name: "PrismaClientUnknownRequestError",
    });

    expect(isDatabaseSchemaMissingError(error)).toBe(true);
  });

  it("ignores connectivity failures", () => {
    const error = Object.assign(new Error("Can't reach database server"), {
      name: "PrismaClientInitializationError",
    });

    expect(isDatabaseSchemaMissingError(error)).toBe(false);
  });
});
