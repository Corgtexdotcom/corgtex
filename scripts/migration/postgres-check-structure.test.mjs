import { describe, expect, it } from "vitest";
import {
  KNOWN_CHECK_KEY,
  captureKnownCheckStructure,
  compareKnownCheckStructure,
} from "./postgres-check-structure.mjs";

const variable = (attno) => `{VAR :varno 1 :varattno ${attno} :vartype 16 :vartypmod -1 :varcollid 0 :varnullingrels (b) :varlevelsup 0 :varreturningtype 0 :varnosyn 1 :varattnosyn ${attno} :location -1}`;
const bool = (op, ...args) => `{BOOLEXPR :boolop ${op} :args (${args.join(" ")}) :location -1}`;
const nested = bool("and", bool("and", variable(1), variable(2)), variable(3));
const flat = bool("and", variable(1), variable(2), variable(3));
const entry = (digest) => ({
  key: KNOWN_CHECK_KEY,
  type: "CHECK",
  semantics: {
    TYPE: "c", VALIDATION: true, ENFORCEMENT: true, INHERITANCE: [true, 0, false],
    DEFERRABILITY: [false, false], PERIOD: false, FK_ACTION: [" ", " ", " "],
    PARENTAGE: null, BINDING: [null], DEFINITION: `definition-${digest}`,
    CHECK_EXPRESSION: `expression-${digest}`, EXTENSION_OWNERSHIP: null,
  },
  diagnostic: { constraintOid: "50000" },
});

const clientFor = (tree, identities = null) => ({
  async query(sql) {
    if (sql.startsWith("SELECT current_setting")) return { rows: [{ ro: "on", timeout: "15s" }] };
    if (sql.includes("octet_length(c.conbin")) return { rows: [{ relation_oid: "40000", bytes: Buffer.byteLength(tree), tree }] };
    if (sql.includes("WITH requested")) return { rows: identities ?? [
      { kind: "attribute", oid: "1", identity: ["public", "ConstitutionSourceReference", "a", 16, -1, 0] },
      { kind: "attribute", oid: "2", identity: ["public", "ConstitutionSourceReference", "b", 16, -1, 0] },
      { kind: "attribute", oid: "3", identity: ["public", "ConstitutionSourceReference", "c", 16, -1, 0] },
      { kind: "type", oid: "16", identity: ["pg_catalog", "bool", "b", 1, true] },
    ] };
    return { rows: [] };
  },
});

const capture = (tree, identities) => captureKnownCheckStructure(clientFor(tree, identities), entry("source"));
const candidate = () => ({ source: entry("source"), destination: entry("destination") });

describe("known PostgreSQL CHECK structural proof", () => {
  it("recognizes only ordered associative grouping", async () => {
    const source = await capture(nested);
    const destination = await capture(flat);
    expect(compareKnownCheckStructure(source, destination, candidate(), "MATCH")).toEqual(expect.objectContaining({
      status: "ASSOCIATIVE_GROUPING_ONLY", canonicalEqual: true, originalEqual: false, bindingsEqual: true,
    }));
  });

  it.each([
    ["order", bool("and", variable(2), variable(1), variable(3))],
    ["duplicate", bool("and", variable(1), variable(2), variable(2))],
    ["attribute", bool("and", variable(1), variable(2), variable(4))],
    ["operator", bool("or", variable(1), variable(2), variable(3))],
    ["not", bool("and", bool("not", variable(1)), variable(2), variable(3))],
  ])("rejects changed %s semantics", async (_name, changed) => {
    const source = await capture(nested);
    const destination = await capture(changed);
    expect(compareKnownCheckStructure(source, destination, candidate(), "MATCH").status).not.toBe("ASSOCIATIVE_GROUPING_ONLY");
  });

  it("rejects changed catalog bindings", async () => {
    const source = await capture(nested);
    const altered = [
      { kind: "attribute", oid: "1", identity: ["public", "ConstitutionSourceReference", "changed", 16, -1, 0] },
      { kind: "attribute", oid: "2", identity: ["public", "ConstitutionSourceReference", "b", 16, -1, 0] },
      { kind: "attribute", oid: "3", identity: ["public", "ConstitutionSourceReference", "c", 16, -1, 0] },
      { kind: "type", oid: "16", identity: ["pg_catalog", "bool", "b", 1, true] },
    ];
    const destination = await capture(flat, altered);
    expect(compareKnownCheckStructure(source, destination, candidate(), "MATCH")).toEqual(expect.objectContaining({
      status: "STRUCTURALLY_DIFFERENT", bindingsEqual: false,
    }));
  });

  it("does not treat identical trees as evidence of grouping-only drift", async () => {
    const source = await capture(flat);
    const destination = await capture(flat);
    expect(compareKnownCheckStructure(source, destination, candidate(), "MATCH")).toEqual(expect.objectContaining({
      status: "STRUCTURALLY_DIFFERENT", originalEqual: true, canonicalEqual: true,
    }));
  });

  it.each([
    ["unknown nodes", nested.replace("{VAR", "{FUNCEXPR")],
    ["duplicate fields", nested.replace(":location -1}", ":location -1 :location -1}")],
    ["trailing content", `${nested} private-literal`],
    ["malformed containers", nested.slice(0, -1)],
    ["unexpected boolean fields", nested.replace(":args", ":unexpected")],
    ["bad NOT arity", bool("not", variable(1), variable(2))],
  ])("fails closed for %s", async (_name, tree) => {
    expect(await capture(tree)).toEqual({ status: "NOT_ELIGIBLE" });
  });

  it("fails closed for limits without exposing the tree", async () => {
    const result = await capture(`{${"x".repeat(262_145)}}`);
    expect(result).toEqual({ status: "LIMIT_EXCEEDED" });
    expect(JSON.stringify(result)).not.toContain("xxx");
  });

  it("sanitizes catalog errors without exposing their message", async () => {
    const client = clientFor(flat);
    const query = client.query;
    client.query = async (sql) => {
      if (sql.includes("octet_length(c.conbin")) throw new Error("private-database-literal");
      return query(sql);
    };
    const result = await captureKnownCheckStructure(client, entry("source"));
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("private-database-literal");
  });

  it("requires exact candidate, server, and mismatch shape", async () => {
    const source = await capture(nested);
    const destination = await capture(flat);
    expect(compareKnownCheckStructure(source, destination, candidate(), "DIFFERENT")).toEqual({ status: "NOT_ELIGIBLE" });
    const wrong = candidate();
    wrong.source.semantics.VALIDATION = false;
    expect(compareKnownCheckStructure(source, destination, wrong, "MATCH")).toEqual({ status: "NOT_ELIGIBLE" });
  });
});
