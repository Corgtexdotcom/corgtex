import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CUSTOMER_ISSUE_AUDIENCE_ALL_CUSTOMERS,
  CUSTOMER_ISSUE_PUBLIC_STATUSES,
  serializeCustomerIssuePublication,
  type CustomerIssuePublicProjection,
} from "./customer-issue-publication";

const VALID_SOURCE = {
  publicationState: "PUBLISHED",
  publicSlug: "login-redirect-loop",
  publicTitle: "Login redirect loop",
  publicSummary: "Some customers are redirected in a loop after sign-in.",
  publicStatus: "INVESTIGATING",
  audience: "ALL_CUSTOMERS",
  revision: 1,
  publishedAt: "2026-01-02T03:04:05.006Z",
};

function validSource(overrides: Record<string, unknown> = {}) {
  return { ...VALID_SOURCE, ...overrides };
}

afterEach(() => vi.restoreAllMocks());

describe("serializeCustomerIssuePublication", () => {
  it("serializes a valid PUBLISHED ALL_CUSTOMERS source to exactly seven keys", () => {
    const result = serializeCustomerIssuePublication(validSource());
    expect(result).toEqual({
      slug: "login-redirect-loop",
      title: "Login redirect loop",
      summary: "Some customers are redirected in a loop after sign-in.",
      status: "INVESTIGATING",
      audience: CUSTOMER_ISSUE_AUDIENCE_ALL_CUSTOMERS,
      revision: 1,
      publishedAt: "2026-01-02T03:04:05.006Z",
    });
    expect(Object.keys(result as object).sort()).toEqual([
      "audience", "publishedAt", "revision", "slug",
      "status", "summary", "title",
    ]);
  });

  it("returns a newly constructed object that does not alias the source", () => {
    const source = validSource();
    expect(serializeCustomerIssuePublication(source)).not.toBe(source);
  });

  it("reads each approved source field exactly once", () => {
    const reads = new Map<PropertyKey, number>();
    const source = new Proxy(VALID_SOURCE, {
      getOwnPropertyDescriptor(target, property) {
        reads.set(property, (reads.get(property) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(serializeCustomerIssuePublication(source)).not.toBeNull();
    for (const property of Object.keys(VALID_SOURCE)) {
      expect(reads.get(property)).toBe(1);
    }
  });
  it("does not read public fields for an unpublished source", () => {
    const source = new Proxy(validSource({ publicationState: "DRAFT" }), {
      get(target, property, receiver) {
        if (property === "publicSlug") {
          throw new Error("publicSlug must not be read");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(serializeCustomerIssuePublication(source)).toBeNull();
  });
  it("does not read public fields for an unauthorized audience", () => {
    const source = new Proxy(validSource({ audience: "INTERNAL_ONLY" }), {
      get(target, property, receiver) {
        if (property === "publicSlug") throw new Error("must not be read");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(serializeCustomerIssuePublication(source)).toBeNull();
  });
  it("rejects inherited publication fields", () => {
    expect(serializeCustomerIssuePublication(Object.create(VALID_SOURCE))).toBeNull();
  });
  it("binds each field read to its own-property check", () => {
    const source = Object.assign(Object.create({ publicTitle: "Inherited" }), VALID_SOURCE);
    Object.defineProperty(source, "publicSlug", { get() {
      delete source.publicTitle;
      return VALID_SOURCE.publicSlug;
    } });
    expect(serializeCustomerIssuePublication(source)).toBeNull();
  });
  it("never falls through to an inherited value after an own snapshot", () => {
    const target = Object.assign(Object.create({ publicTitle: "Inherited" }), VALID_SOURCE);
    const source = new Proxy(target, { getOwnPropertyDescriptor(current, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
      if (property === "publicTitle") delete current.publicTitle;
      return descriptor;
    } });
    expect(serializeCustomerIssuePublication(source)?.title).toBe(VALID_SOURCE.publicTitle);
  });
  it("keeps the public status allowlist immutable", () => {
    expect(Object.isFrozen(CUSTOMER_ISSUE_PUBLIC_STATUSES)).toBe(true);
    expect(() => Array.prototype.push.call(
      CUSTOMER_ISSUE_PUBLIC_STATUSES, "PRIVATE",
    )).toThrow();
  });

  it("accepts every allowed public status", () => {
    for (const status of CUSTOMER_ISSUE_PUBLIC_STATUSES) {
      const result = serializeCustomerIssuePublication(
        validSource({ publicStatus: status }),
      );
      expect(result).not.toBeNull();
      expect((result as CustomerIssuePublicProjection).status).toBe(status);
    }
  });

  it("accepts slug, title, and summary at exact length boundaries", () => {
    const result = serializeCustomerIssuePublication(
      validSource({
        publicSlug: "a".repeat(120),
        publicTitle: "𐐷".repeat(160),
        publicSummary: "𐐷".repeat(2000),
      }),
    );
    expect(result).not.toBeNull();
  });

  it("stops reading oversized text after each code-point limit", () => {
    const original = String.prototype[Symbol.iterator];
    const oversized = "𐐷".repeat(5000);
    let reads = 0;
    vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function* (this: string): Generator<string, undefined, unknown> {
      for (const character of original.call(this)) {
        if (String(this) === oversized) reads += 1;
        yield character;
      }
      return undefined;
    });
    expect(serializeCustomerIssuePublication(validSource({ publicTitle: oversized }))).toBeNull();
    expect(reads).toBe(161);
    reads = 0;
    expect(serializeCustomerIssuePublication(validSource({ publicSummary: oversized }))).toBeNull();
    expect(reads).toBe(2001);
  });

  it("accepts large positive safe-integer revisions", () => {
    expect(
      serializeCustomerIssuePublication(
        validSource({ revision: Number.MAX_SAFE_INTEGER }),
      ),
    ).not.toBeNull();
  });

  it.each([null, undefined, 42, "PUBLISHED", true, [], [VALID_SOURCE]])(
    "returns null for non-record input %j",
    (input) => {
      expect(serializeCustomerIssuePublication(input)).toBeNull();
    },
  );

  it("returns null for a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(serializeCustomerIssuePublication(proxy)).toBeNull();
  });

  it.each(["DRAFT", "WITHDRAWN", "published", "", undefined])(
    "returns null for publicationState %j",
    (publicationState) => {
      expect(
        serializeCustomerIssuePublication(validSource({ publicationState })),
      ).toBeNull();
    },
  );

  it.each(["INTERNAL_ONLY", "SELECTED_CUSTOMERS", "all_customers", "", undefined])(
    "returns null for audience %j",
    (audience) => {
      expect(serializeCustomerIssuePublication(validSource({ audience }))).toBeNull();
    },
  );

  it.each([
    "Upper-Case", "-leading", "trailing-", "double--hyphen", "white space",
    "path/segment", "query?x=1", "fragment#x", "", "a".repeat(121), 42,
    undefined,
  ])("returns null for publicSlug %j", (publicSlug) => {
    expect(
      serializeCustomerIssuePublication(validSource({ publicSlug })),
    ).toBeNull();
  });

  it.each([" leading", "trailing ", "   ", "", "t".repeat(161), 42, undefined])(
    "returns null for publicTitle %j", (publicTitle) => {
    expect(
      serializeCustomerIssuePublication(validSource({ publicTitle })),
    ).toBeNull();
    },
  );

  it.each([" leading", "trailing ", "   ", "", "s".repeat(2001), 42, undefined])(
    "returns null for publicSummary %j", (publicSummary) => {
    expect(
      serializeCustomerIssuePublication(validSource({ publicSummary })),
    ).toBeNull();
    },
  );

  it.each(["OPEN", "investigating", "", undefined])(
    "returns null for publicStatus %j",
    (publicStatus) => {
      expect(
        serializeCustomerIssuePublication(validSource({ publicStatus })),
      ).toBeNull();
    },
  );

  it.each([
    0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN,
    Number.MAX_SAFE_INTEGER + 1, "2", undefined,
  ])("returns null for revision %j", (revision) => {
    expect(
      serializeCustomerIssuePublication(validSource({ revision })),
    ).toBeNull();
  });

  it.each([
    "2026-01-02T03:04:05.006+01:00", "2026-01-02T03:04:05Z",
    "2026-01-02 03:04:05", "not-a-date", "9999-99-99T99:99:99.999Z",
    1772684645006, undefined,
  ])("returns null for publishedAt %j", (publishedAt) => {
    expect(
      serializeCustomerIssuePublication(validSource({ publishedAt })),
    ).toBeNull();
  });

  it("ignores sentinel private fields and never emits them", () => {
    const source = validSource({
      actionBody: "private action body",
      reporterId: "user_123",
      reporterEmail: "reporter@example.com",
      workspaceId: "ws_123",
      customerName: "Acme Corp",
      url: "https://internal.example.com/x",
      evidence: ["screenshot.png"],
      comments: [{ body: "internal note" }],
      assigneeId: "user_456",
      internalId: "int_123",
      sourceActionVersion: 9,
      actorId: "actor_1",
      auditTrail: [{ at: "2026-01-01T00:00:00.000Z" }],
      operationalMetadata: { region: "us" },
    });
    const result = serializeCustomerIssuePublication(source);
    expect(result).not.toBeNull();
    const projection = result as CustomerIssuePublicProjection;
    expect(Object.keys(projection).sort()).toEqual([
      "audience", "publishedAt", "revision", "slug",
      "status", "summary", "title",
    ]);
    const serialized = JSON.stringify(projection);
    for (const sentinel of [
      "actionBody", "reporterId", "reporterEmail", "workspaceId",
      "customerName", "evidence", "comments", "assigneeId", "internalId",
      "sourceActionVersion", "actorId", "auditTrail", "operationalMetadata",
      "publicationState", "Acme Corp", "reporter@example.com",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});
