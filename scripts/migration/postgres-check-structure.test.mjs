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

const typeIdentity = (name, length, byValue, category, collation) => [
  "pg_catalog", name, "b", length, byValue, category, collation,
  "pg_catalog", `${name}in`, `${name}in`, null, "internal",
  "pg_catalog", `${name}out`, `${name}out`, null, "internal",
];
const databaseBinding = (version = "2.41") => ({ kind: "database_collation", oid: "0",
  identity: ["UTF8", "c", "en_US.utf8", "en_US.utf8", null, null, version, version] });
const boolBindings = () => [
  ...[1, 2, 3].map((oid) => ({ kind: "attribute", oid: String(oid),
    identity: ["public", "ConstitutionSourceReference", `attribute-${oid}`, 16, -1, 0] })),
  { kind: "type", oid: "16", identity: typeIdentity("bool", 1, true, "B", 0) },
  databaseBinding(),
];
const clientFor = (tree, identities = null) => ({
  async query(sql) {
    if (sql.startsWith("SELECT current_setting")) return { rows: [{ ro: "on", timeout: "15s" }] };
    if (sql.includes("octet_length(c.conbin")) return { rows: [{ relation_oid: "40000", bytes: Buffer.byteLength(tree), tree }] };
    if (sql.includes("WITH requested")) return { rows: identities ?? boolBindings() };
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
    const altered = boolBindings();
    altered[0].identity[2] = "changed";
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

  it("keeps equal-count regroupings outside the known diagnostic shape", async () => {
    const source = await capture(nested);
    const destination = await capture(bool("and", variable(1), bool("and", variable(2), variable(3))));
    expect(compareKnownCheckStructure(source, destination, candidate(), "MATCH")).toEqual(expect.objectContaining({
      status: "STRUCTURALLY_DIFFERENT", canonicalEqual: true, originalEqual: false,
      sourceFlattened: 1, destinationFlattened: 1,
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

// Entirely synthetic CHECK and catalog rows; no production expressions or bindings.
const typedVariable = (attno, type) => variable(attno).replace(":vartype 16", `:vartype ${type}`)
  .replace(":varcollid 0", `:varcollid ${type === 25 ? 100 : 0}`);
const constant = (type) => `{CONST :consttype ${type} :consttypmod -1 :constcollid ${type === 25 ? 100 : 0} :constlen ${type === 25 ? -1 : 4} :constbyval ${type !== 25} :constisnull false :location -1 :constvalue 4 [ 1 0 0 0 0 0 0 0 ]}`;
const op = (oid, fn, input, output, a, b) => `{OPEXPR :opno ${oid} :opfuncid ${fn} :opresulttype ${output} :opretset false :opcollid ${output === 25 ? 100 : 0} :inputcollid ${input === 25 ? 100 : 0} :args (${a} ${b}) :location -1}`;
const lower = op(525, 150, 23, 16, typedVariable(2, 23), constant(23));
const upper = op(523, 149, 23, 16, typedVariable(2, 23), constant(23));
const sourceOrder = op(525, 150, 23, 16, typedVariable(3, 23), constant(23));
const asText = `{COERCEVIAIO :arg ${typedVariable(2, 23)} :resulttype 25 :resultcollid 100 :coerceformat 1 :location -1}`;
const concat = op(654, 1258, 25, 25, constant(25), asText);
const textEquals = op(98, 67, 25, 16, typedVariable(1, 25), concat);
const supportedNested = bool("and", bool("and", lower, upper), sourceOrder, textEquals);
const supportedFlat = bool("and", lower, upper, sourceOrder, textEquals);
const supportedBindings = (version = "2.41") => [
  ...[[16, "bool", 1, true, "B", 0], [23, "int4", 4, true, "N", 0], [25, "text", -1, false, "S", 100]]
    .map(([oid, ...identity]) => ({ kind: "type", oid: String(oid), identity: typeIdentity(...identity) })),
  ...[[525, ">=", 23, 16, 150, "int4ge"], [523, "<=", 23, 16, 149, "int4le"],
    [98, "=", 25, 16, 67, "texteq"], [654, "||", 25, 25, 1258, "textcat"]]
    .flatMap(([oid, name, input, output, fn, source]) => [
      { kind: "operator", oid: String(oid), identity: ["pg_catalog", name, "b", input, input, output, fn] },
      { kind: "function", oid: String(fn), identity: ["pg_catalog", source, `${input} ${input}`, output,
        source, null, "internal", "f", "i", true, false, false, null] },
    ]),
  { kind: "collation", oid: "100", identity: ["pg_catalog", "default", "d", true, -1, null, null, null, null, null, version] },
  ...[[1, "pointKey", 25, 100], [2, "pointOrder", 23, 0], [3, "sourceOrder", 23, 0]]
    .map(([oid, name, type, collation]) => ({ kind: "attribute", oid: String(oid),
      identity: ["public", "ConstitutionSourceReference", name, type, -1, collation] })),
  databaseBinding(version),
];
const proofFor = async (a = supportedBindings(), b = supportedBindings("2.38"),
  sourceTree = supportedNested, targetTree = supportedFlat) => compareKnownCheckStructure(
  await capture(sourceTree, a), await capture(targetTree, b), candidate(), "MATCH",
);
const expectedFields = {
  type: "NAMESPACE NAME KIND LENGTH BY_VALUE CATEGORY COLLATION INPUT_NAMESPACE INPUT_NAME INPUT_SOURCE INPUT_BINARY INPUT_LANGUAGE OUTPUT_NAMESPACE OUTPUT_NAME OUTPUT_SOURCE OUTPUT_BINARY OUTPUT_LANGUAGE",
  operator: "NAMESPACE NAME KIND LEFT_TYPE RIGHT_TYPE RESULT_TYPE FUNCTION",
  function: "NAMESPACE NAME ARGUMENT_TYPES RESULT_TYPE SOURCE BINARY LANGUAGE KIND VOLATILITY STRICT RETURNS_SET SECURITY_DEFINER CONFIG",
  collation: "NAMESPACE NAME PROVIDER DETERMINISTIC ENCODING COLLATE CTYPE LOCALE ICU_RULES VERSION ACTUAL_VERSION",
  attribute: "NAMESPACE TABLE NAME TYPE TYPMOD COLLATION",
  database_collation: "ENCODING PROVIDER COLLATE CTYPE LOCALE ICU_RULES VERSION ACTUAL_VERSION",
};

describe("CHECK binding field diagnostic and version assessment", () => {
  it("isolates version drift without relaxing strict binding equality", async () => {
    const proof = await proofFor();
    expect(proof).toMatchObject({ status: "STRUCTURALLY_DIFFERENT", bindingsEqual: false,
      canonicalEqual: true, originalEqual: false, referenceSetsEqual: true, nonVersionBindingsEqual: true,
      collationVersionOnly: true, operationsSupported: true, defaultCollationCurrentLibc: true,
      versionDriftAssessment: "VERSION_DRIFT_IRRELEVANT_TO_SUPPORTED_CHECK" });
    for (const [kind, names] of Object.entries(expectedFields)) {
      expect(Object.keys(proof.bindingDifferences[kind.toUpperCase()].fields)).toEqual(names.split(" "));
    }
    expect(proof.bindingDifferences.COLLATION).toMatchObject({ missing: 0, extra: 0, changed: 1, fields: { VERSION: 0, ACTUAL_VERSION: 1 } });
    expect(proof.bindingDifferences.DATABASE_COLLATION).toMatchObject({ changed: 1, fields: { VERSION: 1, ACTUAL_VERSION: 1 } });
  });

  for (const [kind, names] of Object.entries(expectedFields)) {
    for (const [index, name] of names.split(" ").entries()) {
      it(`accounts for ${kind}.${name} without publishing its value`, async () => {
        const rows = supportedBindings();
        const row = rows.find((item) => item.kind === kind);
        const value = row.identity[index];
        row.identity[index] = typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value
          : name === "CONFIG" ? ["private-field-sentinel"] : "private-field-sentinel";
        const proof = await proofFor(supportedBindings(), rows);
        const isVersion = ["collation", "database_collation"].includes(kind) && ["VERSION", "ACTUAL_VERSION"].includes(name);
        expect(proof.bindingsEqual).toBe(false);
        expect(proof.collationVersionOnly).toBe(isVersion);
        expect(proof.bindingDifferences[kind.toUpperCase()]).toMatchObject({ changed: 1, fields: { [name]: 1 } });
        expect(proof.versionDriftAssessment).toBe("UNPROVEN");
        expect(JSON.stringify(proof)).not.toContain("private-field-sentinel");
      });
    }
  }

  it("compares reference sets by key instead of catalog row order", async () => {
    expect(await proofFor(supportedBindings(), supportedBindings().reverse())).toMatchObject({ bindingsEqual: true,
      collationVersionOnly: false, versionDriftAssessment: "UNPROVEN" });
    const rows = supportedBindings("2.38");
    rows.find((row) => row.kind === "attribute" && row.oid === "3").oid = "4";
    const tree = supportedFlat.replaceAll(":varattno 3", ":varattno 4").replaceAll(":varattnosyn 3", ":varattnosyn 4");
    expect(await proofFor(supportedBindings(), rows, supportedNested, tree)).toMatchObject({
      referenceSetsEqual: false, collationVersionOnly: false, nonVersionBindingsEqual: false,
      bindingDifferences: { ATTRIBUTE: { missing: 1, extra: 1, changed: 0 } }, versionDriftAssessment: "UNPROVEN",
    });
  });

  it.each(["missing", "duplicate", "unknown", "extra-field", "wrong-type", "null-identity", "oversized"])(
    "fails closed on %s catalog capture", async (failure) => {
      const rows = supportedBindings();
      if (failure === "missing") rows.pop();
      if (failure === "duplicate") rows[0] = rows[1];
      if (failure === "unknown") rows[0].kind = "private-field-sentinel";
      if (failure === "extra-field") rows[0].identity.push("private-field-sentinel");
      if (failure === "wrong-type") rows[0].identity[4] = "true";
      if (failure === "null-identity") rows[0].identity = null;
      if (failure === "oversized") rows[0].identity[0] = "x".repeat(65_537);
      const captured = await capture(supportedNested, rows);
      expect(captured.status).toBe(failure === "oversized" ? "LIMIT_EXCEEDED" : "NOT_ELIGIBLE");
      const proof = compareKnownCheckStructure(captured, await capture(supportedFlat, supportedBindings()), candidate(), "MATCH");
      expect(proof.collationVersionOnly).not.toBe(true);
      expect(proof.versionDriftAssessment).not.toBe("VERSION_DRIFT_IRRELEVANT_TO_SUPPORTED_CHECK");
      expect(JSON.stringify(proof)).not.toContain("private-field-sentinel");
    },
  );

  it.each([
    ["locale-sensitive operator", (tree) => tree.replaceAll(":opno 98", ":opno 664").replaceAll(":opfuncid 67", ":opfuncid 740"), (rows) => {
      const operator = rows.find((r) => r.kind === "operator" && r.oid === "98");
      operator.oid = "664"; operator.identity[1] = "<"; operator.identity[6] = 740;
      const fn = rows.find((r) => r.kind === "function" && r.oid === "67");
      fn.oid = "740"; fn.identity[1] = "text_lt"; fn.identity[4] = "text_lt";
    }],
    ["wrong operand type", (tree) => tree.replace(typedVariable(2, 23), typedVariable(1, 25)), () => {}],
    ["wrong collation", (tree) => tree.replace(":inputcollid 100", ":inputcollid 0"), () => {}],
    ["wrong coercion", (tree) => tree.replace(`:arg ${typedVariable(2, 23)}`, `:arg ${typedVariable(1, 25)}`), () => {}],
    ["unexpected boolean operator", (tree) => tree.replaceAll(":boolop and", ":boolop or"), () => {}],
  ])("does not assess %s even when both sides agree", async (_name, transform, mutate) => {
    const a = supportedBindings(); const b = supportedBindings("2.38"); mutate(a); mutate(b);
    expect(await proofFor(a, b, transform(supportedNested), transform(supportedFlat))).toMatchObject({
      canonicalEqual: true, collationVersionOnly: true, operationsSupported: false, versionDriftAssessment: "UNPROVEN",
    });
  });

  it.each([
    ["nondeterministic default", "collation", 3, false],
    ["non-default provider", "collation", 2, "i"],
    ["non-libc database", "database_collation", 1, "b"],
    ["non-UTF8 database", "database_collation", 0, "LATIN1"],
    ["provider locale", "database_collation", 4, "en_US"],
    ["ICU rules", "database_collation", 5, "rules"],
    ["stale database recorded version", "database_collation", 6, "2.00"],
    ["stale default actual version", "collation", 10, "2.00"],
    ["unexpected default recorded version", "collation", 9, "2.00"],
  ])("rejects %s even if the non-version binding agrees", async (_name, kind, index, value) => {
    const a = supportedBindings(); const b = supportedBindings("2.38");
    for (const rows of [a, b]) rows.find((r) => r.kind === kind).identity[index] = value;
    expect(await proofFor(a, b)).toMatchObject({ collationVersionOnly: true, defaultCollationCurrentLibc: false,
      versionDriftAssessment: "UNPROVEN" });
  });

  it("requires the existing unequal-flatten grouping shape", async () => {
    expect(await proofFor(supportedBindings(), supportedBindings("2.38"), supportedFlat, supportedFlat))
      .toMatchObject({ collationVersionOnly: true, versionDriftAssessment: "UNPROVEN" });
  });

  it("retains only opaque handles and owns its private rows", async () => {
    const rows = supportedBindings();
    const a = await capture(supportedNested, rows);
    rows[0].identity[1] = "private-field-sentinel";
    const b = await capture(supportedFlat, supportedBindings("2.38"));
    const proof = compareKnownCheckStructure(a, b, candidate(), "MATCH");
    expect(proof.operationsSupported).toBe(true);
    expect(JSON.stringify([a, b])).toBe('[{"status":"CAPTURED"},{"status":"CAPTURED"}]');
    expect(JSON.stringify(proof)).not.toMatch(/private-field-sentinel|pointKey|int4|pg_catalog|2\.41|2\.38|BOOLEXPR|conbin/);
    expect(compareKnownCheckStructure({ ...a }, b, candidate(), "MATCH")).toEqual({ status: "UNAVAILABLE" });
  });
});
