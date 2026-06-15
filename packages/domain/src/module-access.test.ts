import { describe, expect, it } from "vitest";

import {
  createModuleAccessRequest,
  decideModuleAccessRequest,
  expandCircleAncestors,
  listModuleAccessRequests,
  toAccessLevel,
  toPrismaAccessLevel,
} from "./module-access";

describe("expandCircleAncestors", () => {
  it("includes the base circles and all ancestors up the tree", () => {
    // root <- mid <- leaf
    const parentById = new Map<string, string | null>([
      ["root", null],
      ["mid", "root"],
      ["leaf", "mid"],
    ]);
    expect(new Set(expandCircleAncestors(["leaf"], parentById))).toEqual(new Set(["leaf", "mid", "root"]));
  });

  it("merges ancestors from multiple base circles without duplicates", () => {
    const parentById = new Map<string, string | null>([
      ["root", null],
      ["a", "root"],
      ["b", "root"],
    ]);
    expect(new Set(expandCircleAncestors(["a", "b"], parentById))).toEqual(new Set(["a", "b", "root"]));
  });

  it("terminates on cycles", () => {
    const parentById = new Map<string, string | null>([
      ["x", "y"],
      ["y", "x"],
    ]);
    expect(new Set(expandCircleAncestors(["x"], parentById))).toEqual(new Set(["x", "y"]));
  });

  it("returns an empty list for no base circles", () => {
    expect(expandCircleAncestors([], new Map())).toEqual([]);
  });
});

describe("access level enum mapping", () => {
  it("maps Prisma levels to domain levels", () => {
    expect(toAccessLevel("NONE")).toBe("none");
    expect(toAccessLevel("READ")).toBe("read");
    expect(toAccessLevel("WRITE")).toBe("write");
  });

  it("round-trips domain levels back to Prisma levels", () => {
    expect(toPrismaAccessLevel("none")).toBe("NONE");
    expect(toPrismaAccessLevel("read")).toBe("READ");
    expect(toPrismaAccessLevel("write")).toBe("WRITE");
  });

  it("maps the requestable access levels (read/write) to Prisma enums", () => {
    // The request flow only permits read/write (not none); confirm the mapping
    // used when persisting a request's requestedAccess.
    expect(toPrismaAccessLevel("read")).toBe("READ");
    expect(toPrismaAccessLevel("write")).toBe("WRITE");
  });
});

describe("module access request API surface", () => {
  it("exposes the request, list, and decide functions", () => {
    expect(typeof createModuleAccessRequest).toBe("function");
    expect(typeof listModuleAccessRequests).toBe("function");
    expect(typeof decideModuleAccessRequest).toBe("function");
  });
});
