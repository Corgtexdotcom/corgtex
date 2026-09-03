import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeSchemaDump,
  buildCreateDatabaseSql,
  buildConstraintSemanticDiagnostic,
  buildLocaleDiagnostic,
  buildPgServiceContents,
  buildRestoreDiagnostic,
  buildSchemaDifferenceDiagnostic,
  buildTargetConnectionProbeDiagnostic,
  buildUniqueCheckTokenEdit,
  buildSequenceUseList,
  classifyCollationVersionRelation,
  collectCheckConstraintDetail,
  collectConstraintCatalogManifest,
  collectReboundSourceCheckDetail,
  collectLargeObjects,
  inspectLargeObjectAccess,
  isCurrentCollationVersion,
  localeDefinitionMismatchFields,
  loadTargetTlsRootCertificate,
  nodeClientConfig,
  parseSourceDatabaseUrl,
  POSTGRES_CLIENT_IMAGE,
  SCHEMA_RESTRICT_KEY,
  SCHEMA_TOKEN_ALGORITHM,
  schemaTokenDigest,
  serializePgServiceValue,
  tokenizeSchemaDump,
  validateSourceTlsRootCertificate,
  validateTargetTlsRootCertificate,
  waitForTargetConnection,
} from "./run-postgres-restore-rehearsal.mjs";

const TEST_SOURCE_CA = `-----BEGIN CERTIFICATE-----
MIIBrjCCAVOgAwIBAgIUGqAOm5MYGReJildG1O4p80Jd3z4wCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZQ29yZ3RleCBNaWdyYXRpb24gVGVzdCBDQTAeFw0yNjA5MDIy
MTMxMjVaFw0zNjA4MzAyMTMxMjVaMCQxIjAgBgNVBAMMGUNvcmd0ZXggTWlncmF0
aW9uIFRlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATcet6Z6ZVe9rFC
ZqP7N1geOzmJ7NPjr8DmzN+sNjPmwPhH2qzTiAz/t6RaYpnT/RKmJk3eBBROaKaj
VWjo4Bwso2MwYTAdBgNVHQ4EFgQUUKBRyEWB0rKMNcP1z1kPHeicI8MwHwYDVR0j
BBgwFoAUUKBRyEWB0rKMNcP1z1kPHeicI8MwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSQAwRgIhAIOwLRqK4OUmTLOugyuVxdnk
0kZGfb+4eTTgyctrrnv3AiEA1EY3BiiezqB3f2Cc/qWzW+BKADJdAq6S4Hs/wSk6
duI=
-----END CERTIFICATE-----
`;

const TEST_SOURCE_LEAF = `-----BEGIN CERTIFICATE-----
MIIBxDCCAWugAwIBAgIUIVYtJqjZ9sO2s/AhWBbQURQo+uQwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZQ29yZ3RleCBNaWdyYXRpb24gVGVzdCBDQTAeFw0yNjA5MDIy
MTMxMjVaFw0zNjA4MzAyMTMxMjVaMB4xHDAaBgNVBAMME3NvdXJjZS5leGFtcGxl
LnRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQaPnSXnM5p32Kqf6wr1q0s
ix4592wRuB1xp/gMZAA7L11YlyQtJtbvn+UmXdDBgsItV0RsiDB+djv38Wuwx1Vf
o4GAMH4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwHgYDVR0RBBcwFYIT
c291cmNlLmV4YW1wbGUudGVzdDAdBgNVHQ4EFgQUN0/RiCeGuPpUvXgLvStQaQ7h
lB0wHwYDVR0jBBgwFoAUUKBRyEWB0rKMNcP1z1kPHeicI8MwCgYIKoZIzj0EAwID
RwAwRAIgQ35C/sj6LKFpq+Ft0UkSrJDQsAkBqEEgMoiPW7+IRv4CIDy6Gh89WxvB
xh2/uXu6vPtzLdW9VbcKqn7DPmGo9gWr
-----END CERTIFICATE-----
`;

const lengthFramedLargeObjectManifest = (objects) => {
  const manifest = createHash("sha256");
  for (const { oid, content } of objects) {
    const digest = createHash("sha256").update(content).digest("hex");
    for (const value of [oid, String(content.length), digest]) {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.length));
      manifest.update(length);
      manifest.update(bytes);
    }
  }
  return manifest.digest("hex");
};

const largeObjectClient = (objects) => ({
  query: async (sql, values = []) => {
    if (sql.includes("FROM pg_largeobject_metadata")) {
      return {
        rows: objects.map(({ oid, readable = true }) => ({ oid, readable })),
      };
    }
    if (sql.includes("SELECT lo_get")) {
      const [oid, offset, length] = values;
      const object = objects.find((candidate) => candidate.oid === oid);
      if (!object) throw Object.assign(new Error("missing"), { code: "42704" });
      const start = Number(offset);
      return { rows: [{ chunk: object.content.subarray(start, start + length) }] };
    }
    throw new Error("UNEXPECTED_QUERY");
  },
});

const constraintCatalogRow = (overrides = {}) => ({
  constraint_oid: "123",
  namespace_name: "private_namespace",
  constraint_name: "private_constraint",
  object_kind: "TABLE",
  relation_namespace_name: "private_namespace",
  relation_name: "private_relation",
  domain_namespace_name: null,
  domain_name: null,
  type: "c",
  deferrable: false,
  initially_deferred: false,
  validated: true,
  enforced: true,
  locally_defined: true,
  inheritance_count: "0",
  no_inherit: false,
  period: false,
  foreign_key_update_action: " ",
  foreign_key_delete_action: " ",
  foreign_key_match_type: " ",
  has_parent: false,
  parent_constraint_name: null,
  parent_relation_namespace_name: null,
  parent_relation_name: null,
  parent_domain_namespace_name: null,
  parent_domain_name: null,
  has_referenced_relation: false,
  referenced_namespace_name: null,
  referenced_relation_name: null,
  has_supporting_index: false,
  supporting_index_namespace_name: null,
  supporting_index_name: null,
  extension_name: null,
  key_column_count: "1",
  referenced_key_column_count: "0",
  delete_set_column_count: "0",
  primary_foreign_operator_count: "0",
  primary_primary_operator_count: "0",
  foreign_foreign_operator_count: "0",
  exclusion_operator_count: "0",
  key_columns: ["private_column"],
  referenced_key_columns: [],
  delete_set_columns: [],
  primary_foreign_operators: [],
  primary_primary_operators: [],
  foreign_foreign_operators: [],
  exclusion_operators: [],
  definition: "CHECK ((private_column <> 'private-literal'::text))",
  definition_within_limit: true,
  check_expression: "(private_column <> 'private-literal'::text)",
  check_expression_within_limit: true,
  ...overrides,
});

const checkDetail = (expression, overrides = {}) => ({
  ok: true,
  tokens: tokenizeSchemaDump(expression),
  nodeTagCounts: Object.fromEntries([
    "ARRAYCOERCEEXPR", "ARRAYEXPR", "BOOLEXPR", "BOOLEANTEST", "CASEEXPR", "CASETESTEXPR",
    "CASEWHEN", "COALESCEEXPR", "COERCETODOMAIN", "COERCETODOMAINVALUE", "COERCEVIAIO",
    "COLLATEEXPR", "CONST", "CONVERTROWTYPEEXPR", "DISTINCTEXPR", "FIELDSELECT", "FUNCEXPR",
    "MINMAXEXPR", "NAMEDARGEXPR", "NEXTVALUEEXPR", "NULLIFEXPR", "NULLTEST", "OPEXPR",
    "PARAM", "RELABELTYPE", "ROWCOMPAREEXPR", "ROWEXPR", "SCALARARRAYOPEXPR", "SETTODEFAULT",
    "SQLVALUEFUNCTION", "VAR", "XMLEXPR", "OTHER",
  ].map((tag) => [tag, 0])),
  dependencies: [
    ["a", "table column", "private_namespace", "private_relation", "private_namespace.private_relation.private_column"],
    ["n", "operator", "pg_catalog", "<>", "pg_catalog.<>(text,text)"],
    ["n", "type", "pg_catalog", "text", "pg_catalog.text"],
  ],
  ...overrides,
});

const constraintManifest = async (rows) => collectConstraintCatalogManifest({
  query: async () => ({ rows }),
}, "CONSTRAINT_CATALOG_FAILED");

describe("PostgreSQL restore rehearsal runner", () => {
  it("pins the immutable PostgreSQL 18.6 client", () => {
    expect(POSTGRES_CLIENT_IMAGE).toBe(
      "postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280",
    );
  });

  describe("schema-token parity", () => {
    const dump = (body) => [
      `\\restrict ${SCHEMA_RESTRICT_KEY}`,
      body,
      `\\unrestrict ${SCHEMA_RESTRICT_KEY}`,
      "",
    ].join("\n");

    it("ignores only comments and whitespace outside executable tokens", () => {
      const compact = dump('CREATE TABLE "Account" ("id" text DEFAULT \'active\');');
      const formatted = dump([
        "-- generated at a different instant",
        "CREATE /* outer /* nested */ comment */ TABLE",
        '  "Account" ( "id" text DEFAULT \'active\' ) ; -- trailing comment',
      ].join("\n"));
      const compactAnalysis = analyzeSchemaDump(compact);
      const formattedAnalysis = analyzeSchemaDump(formatted);
      expect(compactAnalysis.algorithm).toBe(SCHEMA_TOKEN_ALGORITHM);
      expect(formattedAnalysis.digest).toBe(compactAnalysis.digest);
      expect(formattedAnalysis.legacyDigest).not.toBe(compactAnalysis.legacyDigest);
    });

    it.each([
      ["quoted identifier", 'CREATE TABLE "PrivateAccount" ("id" text);'],
      ["default literal", 'CREATE TABLE "Account" ("id" text DEFAULT \'disabled\');'],
      ["constraint", 'ALTER TABLE ONLY "Account" ADD CONSTRAINT "Account_pkey" PRIMARY KEY ("id", "tenantId");'],
      ["index", 'CREATE UNIQUE INDEX "Account_email_key" ON "Account" USING btree ("email", "tenantId");'],
      ["trigger", 'CREATE TRIGGER account_guard BEFORE UPDATE ON "Account" FOR EACH ROW EXECUTE FUNCTION guard_account_v2();'],
      ["policy", 'CREATE POLICY account_policy ON "Account" USING (("tenantId" = current_setting(\'app.other_tenant\')));'],
      ["view", 'CREATE OR REPLACE VIEW "ActiveAccount" AS SELECT "id" FROM "Account" WHERE "enabled" = false;'],
      ["extension version", "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public VERSION '0.8.2';"],
      ["comment", 'COMMENT ON TABLE "Account" IS \'private customer ledger\';'],
    ])("detects an executable %s change", (_label, changedStatement) => {
      const baseline = dump([
        'CREATE TABLE "Account" ("id" text, "tenantId" text, "email" text, "enabled" boolean DEFAULT true);',
        'ALTER TABLE ONLY "Account" ADD CONSTRAINT "Account_pkey" PRIMARY KEY ("id");',
        'CREATE UNIQUE INDEX "Account_email_key" ON "Account" USING btree ("email");',
        'CREATE TRIGGER account_guard BEFORE UPDATE ON "Account" FOR EACH ROW EXECUTE FUNCTION guard_account();',
        'CREATE POLICY account_policy ON "Account" USING (("tenantId" = current_setting(\'app.tenant\')));',
        'CREATE OR REPLACE VIEW "ActiveAccount" AS SELECT "id" FROM "Account" WHERE "enabled" = true;',
        "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public VERSION '0.8.1';",
        'COMMENT ON TABLE "Account" IS \'customer ledger\';',
      ].join("\n"));
      expect(analyzeSchemaDump(dump(changedStatement)).digest).not.toBe(analyzeSchemaDump(baseline).digest);
    });

    it("preserves every byte inside a dollar-quoted function body", () => {
      const source = dump("CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$BEGIN PERFORM 1; -- executable-body-byte\nEND$body$;");
      const destination = source.replace("PERFORM 1", "PERFORM 2");
      expect(analyzeSchemaDump(destination).digest).not.toBe(analyzeSchemaDump(source).digest);
    });

    it.each([
      ["unterminated string", dump("SELECT 'private;"), "UNTERMINATED_SCHEMA_STRING"],
      ["unterminated identifier", dump('CREATE TABLE "private;'), "UNTERMINATED_SCHEMA_IDENTIFIER"],
      ["unterminated dollar body", dump("CREATE FUNCTION f() RETURNS void AS $body$private;"), "UNTERMINATED_SCHEMA_DOLLAR_BODY"],
      ["unterminated comment", dump("CREATE TABLE t (id text); /* private"), "UNTERMINATED_SCHEMA_COMMENT"],
      ["unexpected meta command", `\\connect private\n${dump("SELECT 1;")}`, "UNEXPECTED_SCHEMA_META_COMMAND"],
      ["inline meta command", `SELECT 1; \\restrict ${SCHEMA_RESTRICT_KEY}`, "UNEXPECTED_SCHEMA_META_COMMAND"],
    ])("fails closed for %s", (_label, content, code) => {
      expect(() => tokenizeSchemaDump(content)).toThrow(code);
    });

    it("length-frames token domains and values", () => {
      expect(schemaTokenDigest([
        { domain: "DDL_TOKEN", value: "ab" },
        { domain: "DDL_TOKEN", value: "c" },
      ])).not.toBe(schemaTokenDigest([
        { domain: "DDL_TOKEN", value: "a" },
        { domain: "DDL_TOKEN", value: "bc" },
      ]));
      expect(() => schemaTokenDigest([{ domain: "PRIVATE", value: "secret" }])).toThrow("INVALID_SCHEMA_TOKEN");
    });

    it("emits an enum-and-count-only diagnostic", () => {
      const sourceName = "source_private_customer_table";
      const destinationName = "destination_private_customer_table";
      const sourceTokens = tokenizeSchemaDump(dump([
        `CREATE TABLE "${sourceName}" ("private_column" text DEFAULT 'private-value');`,
        `COMMENT ON TABLE "${sourceName}" IS 'private-comment';`,
      ].join("\n")));
      const destinationTokens = tokenizeSchemaDump(dump([
        `CREATE TABLE "${destinationName}" ("private_column" text DEFAULT 'other-private-value');`,
        `COMMENT ON TABLE "${destinationName}" IS 'other-private-comment';`,
      ].join("\n")));
      const diagnostic = buildSchemaDifferenceDiagnostic(sourceTokens, destinationTokens);
      expect(diagnostic).toEqual({
        schemaVersion: "1.0.0",
        classification: "EXECUTABLE_SCHEMA_DIFFERENCE",
        sourceOnly: {
          statementClasses: {
            EXTENSION: 0, TYPE: 0, FUNCTION: 0, TABLE: 1, CONSTRAINT: 0, INDEX: 0,
            TRIGGER: 0, POLICY: 0, VIEW: 0, COMMENT: 1, OTHER: 0,
          },
          tokenDomains: { DDL_TOKEN: 15, STRING_LITERAL: 2, DOLLAR_BODY: 0, META_COMMAND: 0 },
        },
        destinationOnly: {
          statementClasses: {
            EXTENSION: 0, TYPE: 0, FUNCTION: 0, TABLE: 1, CONSTRAINT: 0, INDEX: 0,
            TRIGGER: 0, POLICY: 0, VIEW: 0, COMMENT: 1, OTHER: 0,
          },
          tokenDomains: { DDL_TOKEN: 15, STRING_LITERAL: 2, DOLLAR_BODY: 0, META_COMMAND: 0 },
        },
        truncated: false,
      });
      const serialized = JSON.stringify(diagnostic);
      for (const forbidden of [sourceName, destinationName, "private_column", "private-value", "private-comment"]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(serialized).not.toMatch(/[a-f0-9]{64}/u);
    });

    it("compares constraint semantics without serializing private catalog values", async () => {
      const source = await constraintManifest([
        constraintCatalogRow(),
        constraintCatalogRow({
          constraint_name: "private_second_constraint",
          relation_name: "private_second_relation",
          definition: "CHECK ((private_second_column > 7))",
          check_expression: "(private_second_column > 7)",
          key_columns: ["private_second_column"],
        }),
      ]);
      const destination = await constraintManifest([
        constraintCatalogRow({
          constraint_name: "private_second_constraint",
          relation_name: "private_second_relation",
          definition: "CHECK ((private_second_column > 7))",
          check_expression: "(private_second_column > 7)",
          key_columns: ["private_second_column"],
        }),
        constraintCatalogRow(),
      ]);

      const diagnostic = buildConstraintSemanticDiagnostic(source, destination, "MATCH");
      expect(diagnostic).toEqual({
        schemaVersion: "1.0.0",
        serverVersionRelation: "MATCH",
        identitySetEqual: true,
        counts: {
          source: {
            CHECK: 2, FOREIGN_KEY: 0, NOT_NULL: 0, PRIMARY_KEY: 0,
            CONSTRAINT_TRIGGER: 0, UNIQUE: 0, EXCLUSION: 0,
          },
          destination: {
            CHECK: 2, FOREIGN_KEY: 0, NOT_NULL: 0, PRIMARY_KEY: 0,
            CONSTRAINT_TRIGGER: 0, UNIQUE: 0, EXCLUSION: 0,
          },
        },
        semanticEqual: true,
        mismatchCount: 0,
        mismatchFields: [],
        checkExpressionDifference: null,
        truncated: false,
      });
      const serialized = JSON.stringify(diagnostic);
      for (const forbidden of [
        "private_namespace",
        "private_constraint",
        "private_relation",
        "private_column",
        "private-literal",
        "CHECK",
      ]) {
        if (forbidden !== "CHECK") expect(serialized).not.toContain(forbidden);
      }
      expect(serialized).not.toMatch(/[a-f0-9]{64}/u);
    });

    it.each([
      ["VALIDATION", { validated: false }],
      ["ENFORCEMENT", { enforced: false }],
      ["INHERITANCE", { no_inherit: true }],
      ["DEFERRABILITY", { deferrable: true }],
      ["PERIOD", { period: true }],
      ["BINDING", { key_columns: ["other_private_column"] }],
      ["DEFINITION", { definition: "CHECK ((private_column >= 'private-literal'::text))" }],
      ["CHECK_EXPRESSION", { check_expression: "(private_column >= 'private-literal'::text)" }],
      ["EXTENSION_OWNERSHIP", { extension_name: "private_extension" }],
    ])("classifies a %s constraint semantic mismatch", async (field, overrides) => {
      const source = await constraintManifest([constraintCatalogRow()]);
      const destination = await constraintManifest([constraintCatalogRow(overrides)]);
      const diagnostic = buildConstraintSemanticDiagnostic(source, destination);
      expect(diagnostic.semanticEqual).toBe(false);
      expect(diagnostic.mismatchCount).toBe(1);
      expect(diagnostic.mismatchFields).toContain(field);
    });

    it("emits only fixed token, node, and dependency categories for one CHECK expression mismatch", async () => {
      const source = await constraintManifest([constraintCatalogRow({
        check_expression: "((private_column <> 'private-literal'::text))",
        definition: "CHECK (((private_column <> 'private-literal'::text)))",
        expression_tree: "{RELABELTYPE :arg {OPEXPR :args ({VAR} {CONST})}}",
      })]);
      const destination = await constraintManifest([constraintCatalogRow({
        check_expression: "(private_column <> 'private-literal'::text)",
        definition: "CHECK ((private_column <> 'private-literal'::text))",
        expression_tree: "{OPEXPR :args ({VAR} {CONST})}",
      })]);
      const sourceDetail = checkDetail("((private_column <> 'private-literal'::text))");
      sourceDetail.nodeTagCounts.RELABELTYPE = 1;
      const diagnostic = buildConstraintSemanticDiagnostic(source, destination, "MATCH", {
        source: sourceDetail,
        destination: checkDetail("(private_column <> 'private-literal'::text)"),
      });
      expect(diagnostic.checkExpressionDifference).toEqual({
        status: "UNIQUE",
        limitKind: null,
        side: null,
        stage: null,
        tokenEdit: {
          status: "UNIQUE",
          sourceOnly: {
            CAST_OPERATOR: 0,
            BUILTIN_TYPE: 0,
            PARENTHESIS: 2,
            COLLATION: 0,
            OPERATOR: 0,
            FUNCTION: 0,
            COLUMN_REFERENCE: 0,
            STRING_LITERAL: 0,
            OTHER: 0,
          },
          destinationOnly: {
            CAST_OPERATOR: 0,
            BUILTIN_TYPE: 0,
            PARENTHESIS: 0,
            COLLATION: 0,
            OPERATOR: 0,
            FUNCTION: 0,
            COLUMN_REFERENCE: 0,
            STRING_LITERAL: 0,
            OTHER: 0,
          },
        },
        nodeTagDeltas: {
          sourceOnly: expect.objectContaining({ RELABELTYPE: 1, OTHER: 0 }),
          destinationOnly: expect.objectContaining({ RELABELTYPE: 0, OTHER: 0 }),
        },
        dependencies: { identitySetEqual: true, changedClasses: [] },
      });
      const serialized = JSON.stringify(diagnostic);
      for (const forbidden of [
        "private_namespace",
        "private_constraint",
        "private_relation",
        "private_column",
        "private-literal",
        "pg_catalog.<>",
      ]) expect(serialized).not.toContain(forbidden);
      expect(serialized).not.toMatch(/[a-f0-9]{64}/u);
    });

    it("fails closed to ambiguous token edits and reports fixed dependency classes only", async () => {
      const source = await constraintManifest([constraintCatalogRow({
        check_expression: "private_column OR private_column",
        definition: "CHECK (private_column OR private_column)",
      })]);
      const destination = await constraintManifest([constraintCatalogRow({
        check_expression: "private_column",
        definition: "CHECK (private_column)",
        dependencies: [
          ["a", "table column", "private_namespace", "other_private_relation", "private_namespace.other_private_relation.private_column"],
        ],
      })]);
      const diagnostic = buildConstraintSemanticDiagnostic(source, destination, "UNAVAILABLE", {
        source: checkDetail("private_column OR private_column"),
        destination: checkDetail("private_column", {
          dependencies: [
            ["a", "table column", "private_namespace", "other_private_relation", "private_namespace.other_private_relation.private_column"],
          ],
        }),
      });
      expect(diagnostic.checkExpressionDifference).toEqual({
        status: "AMBIGUOUS",
        limitKind: null,
        side: null,
        stage: null,
        tokenEdit: null,
        nodeTagDeltas: null,
        dependencies: null,
      });
      expect(JSON.stringify(diagnostic)).not.toContain("other_private_relation");
    });

    it.each([
      ["CAST_OPERATOR", "private_column::text", "private_column text"],
      ["BUILTIN_TYPE", "private_column::text", "private_column::integer"],
      ["COLLATION", "private_column COLLATE private_collation", "private_column"],
      ["OPERATOR", "private_column > 1", "private_column < 1"],
      ["FUNCTION", "private_function(private_column)", "other_function(private_column)"],
      ["COLUMN_REFERENCE", "private_column > 1", "other_column > 1"],
      ["STRING_LITERAL", "private_column = 'private-literal'", "private_column = 'other-literal'"],
      ["OTHER", "private_column > 1", "private_column > 2"],
    ])("classifies a unique %s CHECK token edit without values", (category, source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly[category] + edit.destinationOnly[category]).toBeGreaterThan(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ['"order-total"', '"order_total"', "COLUMN_REFERENCE"],
      ['"a+b"', '"a_b"', "COLUMN_REFERENCE"],
      ['"<>"', '"comparison"', "COLUMN_REFERENCE"],
      ['"a""b"', '"a_b"', "COLUMN_REFERENCE"],
      ['"collate" > 0', '"renamed" > 0', "COLUMN_REFERENCE"],
      ['"private-function"(private_column)', '"other_function"(private_column)', "FUNCTION"],
    ])("classifies quoted identifier edits without treating embedded operators as syntax", (source, destination, category) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly[category]).toBe(1);
      expect(edit.destinationOnly[category]).toBe(1);
      expect(edit.sourceOnly.OPERATOR).toBe(0);
      expect(edit.destinationOnly.OPERATOR).toBe(0);
    });

    it.each([
      ["private_column COLLATE private_schema.private_a", "private_column COLLATE private_schema.private_b", 1, 1],
      ["private_column COLLATE private_schema.private_a", "private_column COLLATE other_schema.private_a", 1, 1],
      ['private_column COLLATE "private schema"."private-a"', 'private_column COLLATE "private schema"."private-b"', 1, 1],
      ['private_column COLLATE private_schema."private-a"', 'private_column COLLATE private_schema."private-b"', 1, 1],
      ['private_column COLLATE "private""schema"."private-a"', 'private_column COLLATE "private""schema"."private-b"', 1, 1],
      ['private_column COLLATE "C"', 'private_column COLLATE "POSIX"', 1, 1],
      ["private_column COLLATE private_a IS NULL", "private_column COLLATE private_b IS NULL", 1, 1],
      ["private_column COLLATE private_schema.private_a", "private_column COLLATE private_a", 2, 0],
      ["private_column COLLATE private_a", "private_column COLLATE private_schema.private_a", 0, 2],
      [
        "private_a COLLATE private_schema.collation_a = private_b COLLATE other_schema.collation_b",
        "private_a COLLATE private_schema.collation_c = private_b COLLATE other_schema.collation_b",
        1,
        1,
      ],
    ])("classifies bounded qualified COLLATE token edits without values", (source, destination, sourceCount, destinationCount) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.COLLATION).toBe(sourceCount);
      expect(edit.destinationOnly.COLLATION).toBe(destinationCount);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ['private_column = "COLLATE"', 'private_column = "renamed"', "COLUMN_REFERENCE"],
      ["private_column = 'COLLATE private_schema.private_a'", "private_column = 'other'", "STRING_LITERAL"],
      ["private_column COLLATE catalog.private_schema.private_a", "private_column COLLATE catalog.private_schema.private_b", "OTHER"],
      ["private_column COLLATE", "private_column renamed", "OTHER"],
      ["private_column COLLATE private_schema.", "private_column renamed private_schema.", "OTHER"],
      ["private_function(private_column)", "other_function(private_column)", "FUNCTION"],
      ["private_column > 1", "private_column < 1", "OPERATOR"],
    ])("does not infer COLLATE spans from malformed or unrelated tokens", (source, destination, category) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly[category] + edit.destinationOnly[category]).toBeGreaterThan(0);
      expect(edit.sourceOnly.COLLATION + edit.destinationOnly.COLLATION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_schema.validate(private_column)", "other_schema.validate(private_column)", 1, 1],
      ["private_schema.validate(private_column)", "private_schema.other(private_column)", 1, 1],
      ["private_schema.validate(private_column)", "validate(private_column)", 2, 0],
      ["validate(private_column)", "private_schema.validate(private_column)", 0, 2],
      ['"private schema"."private-function"(private_column)', '"other schema"."private-function"(private_column)', 1, 1],
      ['private_schema."private-function"(private_column)', 'other_schema."private-function"(private_column)', 1, 1],
      ['"private""schema"."private-function"(private_column)', '"other""schema"."private-function"(private_column)', 1, 1],
      ["outer_function(private_schema.validate(private_column))", "outer_function(other_schema.validate(private_column))", 1, 1],
      ["NOT private_schema.validate(private_column)", "NOT other_schema.validate(private_column)", 1, 1],
      [
        "private_schema.validate(private_column) AND other_schema.check_value(private_column)",
        "changed_schema.validate(private_column) AND other_schema.check_value(private_column)",
        1,
        1,
      ],
      ['"COLLATE"(private_column)', '"renamed"(private_column)', 1, 1],
    ])("classifies bounded qualified function token edits without values", (source, destination, sourceCount, destinationCount) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.FUNCTION).toBe(sourceCount);
      expect(edit.destinationOnly.FUNCTION).toBe(destinationCount);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["COALESCE(private_column, 0)", "NULLIF(private_column, 0)"],
      ["GREATEST(private_column, 0)", "LEAST(private_column, 0)"],
      ["coalesce(private_column, 0)", "nullif(private_column, 0)"],
    ])("classifies closed SQL constructs as syntax rather than functions", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.OTHER).toBe(1);
      expect(edit.destinationOnly.OTHER).toBe(1);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      "CURRENT_CATALOG",
      "CURRENT_DATE",
      "CURRENT_ROLE",
      "CURRENT_SCHEMA",
      "CURRENT_TIME",
      "CURRENT_TIMESTAMP",
      "CURRENT_USER",
      "LOCALTIME",
      "LOCALTIMESTAMP",
      "SESSION_USER",
      "SYSTEM_USER",
      "USER",
    ])("classifies the closed SQL value construct %s as syntax", (source) => {
      const destination = source === "CURRENT_DATE" ? "CURRENT_TIME" : "CURRENT_DATE";
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.OTHER).toBe(1);
      expect(edit.destinationOnly.OTHER).toBe(1);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
    });

    it.each([
      ["CURRENT_TIME(3)", "CURRENT_TIMESTAMP(3)"],
      ["LOCALTIME(3)", "LOCALTIMESTAMP(3)"],
    ])("keeps parenthesized SQL value constructs out of FUNCTION", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.OTHER).toBeGreaterThan(0);
      expect(edit.destinationOnly.OTHER).toBeGreaterThan(0);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
    });

    it("keeps the optional CURRENT_SCHEMA parentheses as syntax", () => {
      const edit = buildUniqueCheckTokenEdit(
        tokenizeSchemaDump("CURRENT_SCHEMA()"),
        tokenizeSchemaDump("CURRENT_SCHEMA"),
      );
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.PARENTHESIS).toBe(2);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
    });

    it.each([
      ['"current_date"', '"other_date"', "COLUMN_REFERENCE"],
      ['"current_time"(3)', '"other_time"(3)', "FUNCTION"],
      ["app.current_date(private_column)", "other.current_date(private_column)", "FUNCTION"],
      ["current_setting", "other_setting", "COLUMN_REFERENCE"],
      ["current_query()", "other_query()", "FUNCTION"],
      ["current_path", "other_path", "COLUMN_REFERENCE"],
      ["local_value", "other_value", "COLUMN_REFERENCE"],
    ])("does not widen SQL value classification for %s", (source, destination, category) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly[category]).toBeGreaterThan(0);
      expect(edit.destinationOnly[category]).toBeGreaterThan(0);
      expect(edit.sourceOnly.OTHER + edit.destinationOnly.OTHER).toBe(0);
    });

    it.each([
      ["private_schema.coalesce(private_column, 0)", "other_schema.coalesce(private_column, 0)"],
      ["private_schema.operator(private_column)", "other_schema.operator(private_column)"],
      ['"COALESCE"(private_column, 0)', '"NULLIF"(private_column, 0)'],
      ['"OPERATOR"(private_column)', '"renamed"(private_column)'],
    ])("keeps quoted or qualified construct names in FUNCTION", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.FUNCTION).toBeGreaterThan(0);
      expect(edit.destinationOnly.FUNCTION).toBeGreaterThan(0);
      expect(edit.sourceOnly.OTHER + edit.destinationOnly.OTHER).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_catalog.private_schema.validate(private_column)", "other_catalog.private_schema.validate(private_column)"],
      [".validate(private_column)", ".other(private_column)"],
      ["private_schema..validate(private_column)", "other_schema..validate(private_column)"],
      ["private_schema.(private_column)", "other_schema.(private_column)"],
    ])("fails closed for malformed or unsupported callable chains", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.OTHER + edit.destinationOnly.OTHER).toBeGreaterThan(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_column OPERATOR(private_schema.>) 0", "private_column OPERATOR(other_schema.>) 0", 1, 1],
      ["private_column OPERATOR(private_schema.>) 0", "private_column OPERATOR(private_schema.<) 0", 1, 1],
      ["private_column OPERATOR(operator.>) 0", "private_column OPERATOR(other.>) 0", 1, 1],
      ['private_column OPERATOR("private schema".>) 0', 'private_column OPERATOR("other schema".>) 0', 1, 1],
      ['private_column OPERATOR("operator".>) 0', 'private_column OPERATOR("other".>) 0', 1, 1],
      ['private_column OPERATOR("private""schema".>) 0', 'private_column OPERATOR("other""schema".>) 0', 1, 1],
      ["private_column OPERATOR(private_schema.+) 0", "private_column OPERATOR(other_schema.+) 0", 1, 1],
    ])("classifies bounded qualified operator token edits without values", (
      source,
      destination,
      sourceCount,
      destinationCount,
    ) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.OPERATOR).toBe(sourceCount);
      expect(edit.destinationOnly.OPERATOR).toBe(destinationCount);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_column OPERATOR(private_catalog.private_schema.>) 0", "private_column OPERATOR(other_catalog.private_schema.>) 0"],
      ["private_column OPERATOR(private_schema..>) 0", "private_column OPERATOR(other_schema..>) 0"],
      ["private_column OPERATOR(private_schema.) 0", "private_column OPERATOR(other_schema.) 0"],
      ["private_column OPERATOR(private_schema.++) 0", "private_column OPERATOR(other_schema.++) 0"],
      ['private_column OPERATOR(private_schema."+") 0', 'private_column OPERATOR(other_schema."+") 0'],
    ])("fails closed for malformed or unsupported qualified operator contexts", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.OTHER + edit.destinationOnly.OTHER).toBeGreaterThan(0);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_column::private_schema.private_type", "private_column::other_schema.private_type", 1, 1],
      ["private_column::private_schema.private_type", "private_column::private_schema.other_type", 1, 1],
      ["private_column::private_type", "private_column::other_type", 1, 1],
      ["private_column::operator", "private_column::other_type", 1, 1],
      ["private_column::operator.bounded_text", "private_column::other_schema.bounded_text", 1, 1],
      ["private_column::operator(10)", "private_column::other_type(10)", 1, 1],
      ['private_column::"private schema"."private-type"', 'private_column::"other schema"."private-type"', 1, 1],
      ['private_column::"operator"."private-type"', 'private_column::"other"."private-type"', 1, 1],
      ['private_column::private_schema."private-type"', 'private_column::other_schema."private-type"', 1, 1],
      ["private_column::private_schema.private_type(10)", "private_column::other_schema.private_type(10)", 1, 1],
      ["private_column::private_schema.private_type[]", "private_column::other_schema.private_type[]", 1, 1],
    ])("classifies bounded qualified cast type edits without values", (
      source,
      destination,
      sourceCount,
      destinationCount,
    ) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.BUILTIN_TYPE).toBe(sourceCount);
      expect(edit.destinationOnly.BUILTIN_TYPE).toBe(destinationCount);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_column::private_schema.local_timestamp AT TIME ZONE 'UTC'", "private_column::other_schema.local_timestamp AT TIME ZONE 'UTC'"],
      ["private_column::private_schema.private_type COLLATE private_collation", "private_column::other_schema.private_type COLLATE private_collation"],
      ["private_column::private_schema.private_type IS NULL", "private_column::other_schema.private_type IS NULL"],
      ["private_column::private_schema.private_type IS DISTINCT FROM NULL", "private_column::other_schema.private_type IS DISTINCT FROM NULL"],
      ["private_column::private_schema.private_type = private_column", "private_column::other_schema.private_type = private_column"],
      ["private_column::private_schema.private_type(10)", "private_column::other_schema.private_type(10)"],
      ["private_column::private_schema.private_type[]", "private_column::other_schema.private_type[]"],
      ["private_column::private_schema.private_type[1]", "private_column::other_schema.private_type[1]"],
    ])("keeps qualified cast identities bounded before valid expression suffixes", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.BUILTIN_TYPE).toBe(1);
      expect(edit.destinationOnly.BUILTIN_TYPE).toBe(1);
      expect(edit.sourceOnly.OTHER + edit.destinationOnly.OTHER).toBe(0);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_column::private_catalog.private_schema.private_type", "private_column::other_catalog.private_schema.private_type"],
      ["private_column::private_schema..private_type", "private_column::other_schema..private_type"],
      ["private_column::private_schema.", "private_column::other_schema."],
      ['private_column::U&"private_type"', 'private_column::U&"other_type"'],
    ])("fails closed for malformed or unsupported cast identity spans", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.OTHER + edit.destinationOnly.OTHER).toBeGreaterThan(0);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_schema.private_column > 0", "other_schema.private_column > 0", "COLUMN_REFERENCE"],
      ["private_column IN (1, 2)", "other_column IN (1, 2)", "COLUMN_REFERENCE"],
      ["private_column = ANY (private_array)", "other_column = ANY (private_array)", "COLUMN_REFERENCE"],
      ["private_column = ALL (private_array)", "other_column = ALL (private_array)", "COLUMN_REFERENCE"],
      ["private_column OPERATOR(pg_catalog.>) 0", "private_column OPERATOR(pg_catalog.<) 0", "OPERATOR"],
      ["private_column::numeric(10, 2)", "other_column::numeric(10, 2)", "COLUMN_REFERENCE"],
    ])("does not infer function spans from ordinary or operator contexts", (source, destination, category) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly[category] + edit.destinationOnly[category]).toBeGreaterThan(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_column::character varying(10)", "private_column::character(10)"],
      ["private_column::bit varying(8)", "private_column::bit(8)"],
      ["private_column::double precision", "private_column::double"],
      ["private_column::CHARACTER VARYING(10)", "private_column::CHARACTER(10)"],
      ["private_column::character varying", "private_column::character"],
      ["private_column::character varying IS NOT NULL", "private_column::character IS NOT NULL"],
      ["private_column::character varying(10)[]", "private_column::character(10)[]"],
    ])("classifies PG18 multiword built-in type edits without values", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.BUILTIN_TYPE).toBe(1);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["private_column::time with time zone", "private_column::time without time zone"],
      ["private_column::timestamp with time zone", "private_column::timestamp without time zone"],
      ["private_column::timestamp(3) with time zone", "private_column::timestamp(3) without time zone"],
    ])("classifies PG18 time-zone type identity edits without values", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.BUILTIN_TYPE).toBe(1);
      expect(edit.destinationOnly.BUILTIN_TYPE).toBe(1);
      expect(edit.sourceOnly.COLUMN_REFERENCE + edit.destinationOnly.COLUMN_REFERENCE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["text <> ''::text", "description <> ''::text"],
      ["date IS NOT NULL", "created_at IS NOT NULL"],
      ["name = 'value'", "label = 'value'"],
      ['"text" <> \'\'', '"description" <> \'\''],
    ])("keeps built-in-shaped bare identifiers in COLUMN_REFERENCE", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.COLUMN_REFERENCE).toBe(1);
      expect(edit.destinationOnly.COLUMN_REFERENCE).toBe(1);
      expect(edit.sourceOnly.BUILTIN_TYPE + edit.destinationOnly.BUILTIN_TYPE).toBe(0);
    });

    it.each([
      ["text(private_column)", "description(private_column)"],
      ["date(private_column)", "created_at(private_column)"],
      ["name(private_column)", "label(private_column)"],
    ])("keeps function-shaped built-in names in FUNCTION", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.FUNCTION).toBe(1);
      expect(edit.destinationOnly.FUNCTION).toBe(1);
      expect(edit.sourceOnly.BUILTIN_TYPE + edit.destinationOnly.BUILTIN_TYPE).toBe(0);
    });

    it("keeps a multiword built-in typmod edit semantic", () => {
      const edit = buildUniqueCheckTokenEdit(
        tokenizeSchemaDump("private_column::character varying(10)"),
        tokenizeSchemaDump("private_column::character varying(11)"),
      );
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.OTHER).toBe(1);
      expect(edit.destinationOnly.OTHER).toBe(1);
      expect(edit.sourceOnly.BUILTIN_TYPE + edit.destinationOnly.BUILTIN_TYPE).toBe(0);
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
    });

    it.each([
      ['private_column::"character" varying(10)', 'other_column::"character" varying(10)'],
      ["private_column::character varying(10", "other_column::character varying(10"],
      ["private_column::custom varying(10)", "other_column::custom varying(10)"],
    ])("fails closed for unsupported cast type contexts", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.FUNCTION + edit.destinationOnly.FUNCTION).toBe(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it.each([
      ["varying(private_column)", "other(private_column)"],
      ["private_schema.varying(private_column)", "other_schema.varying(private_column)"],
      ['"varying"(private_column)', '"other"(private_column)'],
    ])("keeps ordinary functions named varying in FUNCTION", (source, destination) => {
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(source), tokenizeSchemaDump(destination));
      expect(edit.status).toBe("UNIQUE");
      expect(edit.sourceOnly.FUNCTION).toBeGreaterThan(0);
      expect(edit.destinationOnly.FUNCTION).toBeGreaterThan(0);
      expect(JSON.stringify(edit)).not.toContain("private");
    });

    it("bounds CHECK edit analysis before allocating its comparison matrix", () => {
      const oversized = Array.from({ length: 1025 }, () => ({ domain: "DDL_TOKEN", value: "private" }));
      expect(buildUniqueCheckTokenEdit(oversized, [{ domain: "DDL_TOKEN", value: "other" }])).toEqual({
        status: "LIMIT_EXCEEDED",
        sourceOnly: null,
        destinationOnly: null,
      });
      expect(() => buildUniqueCheckTokenEdit([], [])).toThrow("EMPTY_SCHEMA_TOKEN_STREAM");
    });

    it("keeps the broad constraint collection free of CHECK trees and dependency identities", async () => {
      let queryText = "";
      await collectConstraintCatalogManifest({
        query: async (sql) => {
          queryText = sql;
          return { rows: [constraintCatalogRow()] };
        },
      }, "CONSTRAINT_CATALOG_FAILED");
      expect(queryText).not.toContain("AS expression_tree");
      expect(queryText).not.toContain("pg_catalog.pg_identify_object");
      expect(queryText).toContain("definition_within_limit");
      expect(queryText).toContain("check_expression_within_limit");
      expect(queryText).toContain("pg_catalog.convert_to");
      expect(queryText).not.toMatch(/convert_to\(constraint_row\.conbin::text/iu);
    });

    it("collects one rebound CHECK detail only after every bounded preflight", async () => {
      const entry = (await constraintManifest([constraintCatalogRow()])).values().next().value;
      const expression = "(private_column <> 'private-literal'::text)";
      const dependency = {
        dependency_type: "a",
        type: "table column",
        schema: "private_namespace",
        name: "private_relation",
        identity: "private_namespace.private_relation.private_column",
      };
      const dependencyFieldBytes = Object.values(dependency).map((value) => Buffer.byteLength(value, "utf8"));
      const calls = [];
      const responses = [
        { rows: [{
          namespace_name: "private_namespace",
          constraint_name: "private_constraint",
          object_kind: "TABLE",
          relation_namespace_name: "private_namespace",
          relation_name: "private_relation",
          domain_namespace_name: null,
          domain_name: null,
          type: "c",
          client_encoding: "UTF8",
          expression_bytes: String(Buffer.byteLength(expression, "utf8")),
          tree_bytes: "128",
          dependency_count: "1",
          node_count: "2",
        }], rowCount: 1 },
        { rows: [{
          max_field_bytes: String(Math.max(...dependencyFieldBytes)),
          total_bytes: String(dependencyFieldBytes.reduce((total, value) => total + value, 0)),
        }], rowCount: 1 },
        { rows: [{ check_expression: expression }], rowCount: 1 },
        { rows: [dependency], rowCount: 1 },
        { rows: [{ node_tag: "OPEXPR", node_count: "1" }, { node_tag: "PRIVATE_NODE", node_count: "1" }], rowCount: 2 },
      ];
      const detail = await collectCheckConstraintDetail({
        query: async (sql, values) => {
          calls.push({ sql, values });
          return responses.shift();
        },
      }, entry);
      expect(detail.ok).toBe(true);
      expect(detail.nodeTagCounts).toMatchObject({ OPEXPR: 1, OTHER: 1 });
      expect(calls).toHaveLength(5);
      expect(calls.every(({ values }) => values[0] === "123")).toBe(true);
      expect(calls[0].sql).not.toContain("AS expression_tree");
      expect(calls[0].sql).toContain("current_setting('client_encoding')");
      expect(calls[0].sql).toContain("convert_to(pg_catalog.pg_get_expr");
      expect(calls[1].sql).toContain("max(GREATEST(");
      expect(calls[1].sql).not.toContain("pg_catalog.greatest");
      expect(calls[1].sql).toContain("convert_to(dependency_type, 'UTF8')");
      expect(calls[1].sql).toContain("convert_to(identity, 'UTF8')");
      expect(calls[3].sql).toContain("LIMIT 257");
      expect(JSON.stringify(buildConstraintSemanticDiagnostic(
        await constraintManifest([constraintCatalogRow({ check_expression: `(${expression})` })]),
        await constraintManifest([constraintCatalogRow()]),
        "MATCH",
        { source: detail, destination: detail },
      ))).not.toContain("private_namespace");
    });

    it.each([
      ["EXPRESSION_BYTES", { expression_bytes: "65537" }],
      ["TREE_BYTES", { tree_bytes: "262145" }],
      ["DEPENDENCY_COUNT", { dependency_count: "257" }],
      ["NODE_COUNT", { node_count: "4097" }],
    ])("stops CHECK collection before value fetch on the %s limit", async (limitKind, override) => {
      const entry = (await constraintManifest([constraintCatalogRow()])).values().next().value;
      const query = vi.fn(async () => ({
        rowCount: 1,
        rows: [{
          namespace_name: "private_namespace",
          constraint_name: "private_constraint",
          object_kind: "TABLE",
          relation_namespace_name: "private_namespace",
          relation_name: "private_relation",
          domain_namespace_name: null,
          domain_name: null,
          type: "c",
          client_encoding: "UTF8",
          expression_bytes: "64",
          tree_bytes: "128",
          dependency_count: "1",
          node_count: "2",
          ...override,
        }],
      }));
      await expect(collectCheckConstraintDetail({ query }, entry)).resolves.toEqual({
        ok: false,
        status: "LIMIT_EXCEEDED",
        stage: "PREFLIGHT",
        limitKind,
      });
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("requires UTF8 preflight before fetching protected CHECK values", async () => {
      const entry = (await constraintManifest([constraintCatalogRow()])).values().next().value;
      const query = vi.fn(async () => ({
        rowCount: 1,
        rows: [{
          namespace_name: "private_namespace",
          constraint_name: "private_constraint",
          object_kind: "TABLE",
          relation_namespace_name: "private_namespace",
          relation_name: "private_relation",
          domain_namespace_name: null,
          domain_name: null,
          type: "c",
          client_encoding: "LATIN1",
          expression_bytes: "64",
          tree_bytes: "128",
          dependency_count: "0",
          node_count: "1",
        }],
      }));
      await expect(collectCheckConstraintDetail({ query }, entry)).resolves.toEqual({
        ok: false,
        status: "COLLECTION_UNAVAILABLE",
        stage: "PREFLIGHT",
        limitKind: null,
      });
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("uses identical UTF8 byte counts before and after multibyte CHECK fetches", async () => {
      const entry = (await constraintManifest([constraintCatalogRow()])).values().next().value;
      const expression = "(caf\u00e9 = '\u00e9')";
      const dependency = {
        dependency_type: "a",
        type: "table column",
        schema: "sch\u00e9ma",
        name: "caf\u00e9",
        identity: "sch\u00e9ma.caf\u00e9",
      };
      const fieldBytes = Object.values(dependency).map((value) => Buffer.byteLength(value, "utf8"));
      const responses = [
        { rowCount: 1, rows: [{
          namespace_name: "private_namespace", constraint_name: "private_constraint", object_kind: "TABLE",
          relation_namespace_name: "private_namespace", relation_name: "private_relation",
          domain_namespace_name: null, domain_name: null, type: "c", client_encoding: "UTF8",
          expression_bytes: String(Buffer.byteLength(expression, "utf8")), tree_bytes: "128",
          dependency_count: "1", node_count: "1",
        }] },
        { rowCount: 1, rows: [{
          max_field_bytes: String(Math.max(...fieldBytes)),
          total_bytes: String(fieldBytes.reduce((total, value) => total + value, 0)),
        }] },
        { rowCount: 1, rows: [{ check_expression: expression }] },
        { rowCount: 1, rows: [dependency] },
        { rowCount: 1, rows: [{ node_tag: "OPEXPR", node_count: "1" }] },
      ];
      await expect(collectCheckConstraintDetail({
        query: vi.fn(async () => responses.shift()),
      }, entry)).resolves.toMatchObject({ ok: true });
    });

    it.each([
      ["EXPRESSION_FETCH", true],
      ["DEPENDENCY_FETCH", false],
    ])("fails closed on a %s UTF8 byte-count mismatch", async (expectedStage, expressionMismatch) => {
      const entry = (await constraintManifest([constraintCatalogRow()])).values().next().value;
      const expression = "(caf\u00e9 IS NOT NULL)";
      const dependency = {
        dependency_type: "a",
        type: "table column",
        schema: "sch\u00e9ma",
        name: "caf\u00e9",
        identity: "sch\u00e9ma.caf\u00e9",
      };
      const fieldBytes = Object.values(dependency).map((value) => Buffer.byteLength(value, "utf8"));
      const totalBytes = fieldBytes.reduce((total, value) => total + value, 0);
      const responses = [
        { rowCount: 1, rows: [{
          namespace_name: "private_namespace", constraint_name: "private_constraint", object_kind: "TABLE",
          relation_namespace_name: "private_namespace", relation_name: "private_relation",
          domain_namespace_name: null, domain_name: null, type: "c", client_encoding: "UTF8",
          expression_bytes: String(Buffer.byteLength(expression, "utf8") - Number(expressionMismatch)),
          tree_bytes: "128", dependency_count: "1", node_count: "1",
        }] },
        { rowCount: 1, rows: [{
          max_field_bytes: String(Math.max(...fieldBytes)),
          total_bytes: String(totalBytes - Number(!expressionMismatch)),
        }] },
        { rowCount: 1, rows: [{ check_expression: expression }] },
        { rowCount: 1, rows: [dependency] },
      ];
      await expect(collectCheckConstraintDetail({
        query: vi.fn(async () => responses.shift()),
      }, entry)).resolves.toEqual({
        ok: false,
        status: "COLLECTION_UNAVAILABLE",
        stage: expectedStage,
        limitKind: null,
      });
    });

    it("rebinds the source CHECK by logical identity and validates all phase-one semantics before detail", async () => {
      const entry = (await constraintManifest([constraintCatalogRow()])).values().next().value;
      const expression = "(private_column <> 'private-literal'::text)";
      const commands = [];
      const client = {
        connect: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        query: vi.fn(async (sql, values) => {
          commands.push(sql);
          if (/LIMIT 2\s*$/u.test(sql)) return { rowCount: 1, rows: [constraintCatalogRow()] };
          if (sql.includes("AS expression_bytes")) return { rowCount: 1, rows: [{
            namespace_name: "private_namespace", constraint_name: "private_constraint", object_kind: "TABLE",
            relation_namespace_name: "private_namespace", relation_name: "private_relation",
            domain_namespace_name: null, domain_name: null, type: "c",
            client_encoding: "UTF8",
            expression_bytes: String(Buffer.byteLength(expression)), tree_bytes: "128",
            dependency_count: "0", node_count: "1",
          }] };
          if (sql.includes("max(GREATEST")) return { rowCount: 1, rows: [{ max_field_bytes: "0", total_bytes: "0" }] };
          if (sql.includes("AS check_expression")) return { rowCount: 1, rows: [{ check_expression: expression }] };
          if (sql.includes("AS dependency_type")) return { rowCount: 0, rows: [] };
          if (sql.includes("AS node_tag")) return { rowCount: 1, rows: [{ node_tag: "OPEXPR", node_count: "1" }] };
          return { rowCount: null, rows: [] };
        }),
      };
      const detail = await collectReboundSourceCheckDetail({
        host: "127.0.0.1", port: 5432, user: "reader", password: "private-password",
        database: "private_database", sslmode: "disable",
      }, entry, () => client);
      expect(detail.ok).toBe(true);
      expect(commands.indexOf("COMMIT")).toBeGreaterThan(commands.findIndex((sql) => sql.includes("AS node_tag")));
      expect(commands.indexOf("SET LOCAL timezone = 'UTC'")).toBeGreaterThan(commands.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
      expect(commands.indexOf("SET LOCAL timezone = 'UTC'")).toBeLessThan(commands.findIndex((sql) => /LIMIT 2\s*$/u.test(sql)));
      expect(commands).toContain("SET LOCAL client_encoding = 'UTF8'");
      expect(commands).not.toContain("ROLLBACK");
      expect(client.end).toHaveBeenCalledOnce();
    });

    it("rolls back when UTC cannot be restored for source CHECK rebind", async () => {
      const entry = (await constraintManifest([constraintCatalogRow()])).values().next().value;
      const commands = [];
      const client = {
        connect: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        query: vi.fn(async (sql) => {
          commands.push(sql);
          if (sql === "SET LOCAL timezone = 'UTC'") throw new Error("setting failed");
          return { rowCount: null, rows: [] };
        }),
      };
      await expect(collectReboundSourceCheckDetail({
        host: "127.0.0.1", port: 5432, user: "reader", password: "private-password",
        database: "private_database", sslmode: "disable",
      }, entry, () => client)).resolves.toEqual({
        ok: false,
        status: "COLLECTION_UNAVAILABLE",
        stage: "REBIND",
        limitKind: null,
      });
      expect(commands).toContain("ROLLBACK");
      expect(client.end).toHaveBeenCalledOnce();
    });

    it("fails closed on source CHECK recreation before issuing any detail query", async () => {
      const entry = (await constraintManifest([constraintCatalogRow()])).values().next().value;
      const commands = [];
      const client = {
        connect: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        query: vi.fn(async (sql) => {
          commands.push(sql);
          if (/LIMIT 2\s*$/u.test(sql)) {
            return { rowCount: 1, rows: [constraintCatalogRow({ constraint_oid: "124" })] };
          }
          return { rowCount: null, rows: [] };
        }),
      };
      await expect(collectReboundSourceCheckDetail({
        host: "127.0.0.1", port: 5432, user: "reader", password: "private-password",
        database: "private_database", sslmode: "disable",
      }, entry, () => client)).resolves.toEqual({
        ok: false,
        status: "SOURCE_REBIND_DRIFT",
        stage: "REBIND",
        limitKind: null,
      });
      expect(commands.some((sql) => sql.includes("AS expression_bytes"))).toBe(false);
      expect(commands).toContain("ROLLBACK");
      expect(client.end).toHaveBeenCalledOnce();
    });

    it("classifies identity, type, parentage, and foreign-key action mismatches", async () => {
      const sourceCheck = await constraintManifest([constraintCatalogRow()]);
      const changedIdentity = await constraintManifest([constraintCatalogRow({ relation_name: "other_private_relation" })]);
      expect(buildConstraintSemanticDiagnostic(sourceCheck, changedIdentity)).toMatchObject({
        identitySetEqual: false,
        semanticEqual: false,
        mismatchCount: 2,
        mismatchFields: ["IDENTITY_SET"],
      });

      const changedType = await constraintManifest([constraintCatalogRow({
        type: "n",
        check_expression: null,
        expression_tree: null,
      })]);
      expect(buildConstraintSemanticDiagnostic(sourceCheck, changedType).mismatchFields).toContain("TYPE");

      const changedParentage = await constraintManifest([constraintCatalogRow({
        has_parent: true,
        parent_constraint_name: "private_parent_constraint",
        parent_relation_namespace_name: "private_namespace",
        parent_relation_name: "private_parent_relation",
      })]);
      expect(buildConstraintSemanticDiagnostic(sourceCheck, changedParentage).mismatchFields).toContain("PARENTAGE");

      const foreignKey = constraintCatalogRow({
        type: "f",
        check_expression: null,
        expression_tree: null,
        definition: "FOREIGN KEY (private_column) REFERENCES private_parent(private_column)",
        has_referenced_relation: true,
        referenced_namespace_name: "private_namespace",
        referenced_relation_name: "private_parent",
        referenced_key_columns: ["private_column"],
        referenced_key_column_count: "1",
        foreign_key_update_action: "a",
        foreign_key_delete_action: "a",
        foreign_key_match_type: "s",
      });
      const sourceForeignKey = await constraintManifest([foreignKey]);
      const changedForeignKey = await constraintManifest([{ ...foreignKey, foreign_key_delete_action: "c" }]);
      expect(buildConstraintSemanticDiagnostic(sourceForeignKey, changedForeignKey).mismatchFields).toContain("FK_ACTION");
    });

    it("fails closed on unsupported, duplicate, or unresolved constraint catalog rows", async () => {
      await expect(constraintManifest([constraintCatalogRow({ type: "z" })]))
        .rejects.toThrow("INVALID_CONSTRAINT_CATALOG_ROW");
      await expect(constraintManifest([constraintCatalogRow(), constraintCatalogRow()]))
        .rejects.toThrow("DUPLICATE_CONSTRAINT_CATALOG_IDENTITY");
      await expect(constraintManifest([constraintCatalogRow({
        has_referenced_relation: true,
        referenced_namespace_name: null,
        referenced_relation_name: null,
      })])).rejects.toThrow("INVALID_CONSTRAINT_CATALOG_ROW");
      await expect(constraintManifest([constraintCatalogRow({ constraint_oid: "4294967296" })]))
        .rejects.toThrow("INVALID_CONSTRAINT_CATALOG_ROW");
      await expect(constraintManifest([constraintCatalogRow({ definition_within_limit: false, definition: null })]))
        .rejects.toThrow("CONSTRAINT_TEXT_LIMIT_EXCEEDED");
    });
  });

  it("parses a TLS-required source URL without retaining a raw URL field", () => {
    const config = parseSourceDatabaseUrl("postgresql://reader:p%40ss@db.example.test:5432/core?sslmode=require");
    expect(config).toEqual({
      host: "db.example.test",
      dockerHost: "db.example.test",
      port: 5432,
      user: "reader",
      password: "p@ss",
      database: "core",
      sslmode: "require",
    });
    expect(config).not.toHaveProperty("url");
  });

  it.each([
    "postgresql://reader:secret@db.example.test/core",
    "postgresql://reader:secret@db.example.test/core?sslmode=disable",
    "postgresql://reader:secret@db.example.test/core?sslmode=verify-ca",
    "postgresql://reader:secret@db.example.test/core?sslmode=verify-full",
    "mysql://reader:secret@db.example.test/core?sslmode=require",
  ])("rejects a source URL outside the exact Railway TLS input contract", (value) => {
    expect(() => parseSourceDatabaseUrl(value)).toThrow();
  });

  it("accepts exactly one current CA certificate as the source trust anchor", () => {
    expect(validateSourceTlsRootCertificate(TEST_SOURCE_CA, new Date("2030-01-01T00:00:00Z"))).toBe(TEST_SOURCE_CA);
  });

  it.each([
    ["missing", ""],
    ["malformed", "not a certificate"],
    ["multiple", `${TEST_SOURCE_CA}${TEST_SOURCE_CA}`],
    ["control character", `${TEST_SOURCE_CA}\u0000`],
  ])("rejects a %s source trust anchor", (_label, value) => {
    expect(() => validateSourceTlsRootCertificate(value, new Date("2030-01-01T00:00:00Z")))
      .toThrow("INVALID_SOURCE_TLS_ROOT_CERT");
  });

  it("rejects a non-CA source certificate", () => {
    expect(() => validateSourceTlsRootCertificate(TEST_SOURCE_LEAF, new Date("2030-01-01T00:00:00Z")))
      .toThrow("SOURCE_TLS_ROOT_CERT_NOT_CA");
  });

  it("rejects a source CA outside its validity window", () => {
    expect(() => validateSourceTlsRootCertificate(TEST_SOURCE_CA, new Date("2020-01-01T00:00:00Z")))
      .toThrow("SOURCE_TLS_ROOT_CERT_NOT_YET_VALID");
    expect(() => validateSourceTlsRootCertificate(TEST_SOURCE_CA, new Date("2040-01-01T00:00:00Z")))
      .toThrow("SOURCE_TLS_ROOT_CERT_EXPIRED");
  });

  it("uses exact-CA verification for Node source connections", () => {
    const config = nodeClientConfig({
      host: "source.example.test",
      port: 5432,
      user: "reader",
      password: "secret",
      database: "core",
      sslmode: "require",
      sourceTlsRootCert: TEST_SOURCE_CA,
    }, "source-test");
    expect(config.ssl).toMatchObject({ ca: TEST_SOURCE_CA, rejectUnauthorized: true });
    expect(config.ssl.checkServerIdentity("proxy.example.test", {})).toBeUndefined();
  });

  it("keeps explicit-root hostname verification for Node target connections", () => {
    const targetTlsRootCert = loadTargetTlsRootCertificate();
    const config = nodeClientConfig({
      host: "target.example.test",
      port: 5432,
      user: "admin",
      password: "secret",
      database: "scratch",
      sslmode: "verify-full",
      targetTlsRootCert,
    }, "target-test");
    expect(config.ssl).toEqual({ ca: targetTlsRootCert, rejectUnauthorized: true });
  });

  it("accepts only the exact fingerprint-pinned Azure PostgreSQL root bundle", () => {
    const targetTlsRootCert = loadTargetTlsRootCertificate();
    expect(validateTargetTlsRootCertificate(targetTlsRootCert)).toBe(targetTlsRootCert);
    expect(() => validateTargetTlsRootCertificate(TEST_SOURCE_CA)).toThrow("INVALID_TARGET_TLS_ROOT_CERT");
    expect(() => validateTargetTlsRootCertificate(targetTlsRootCert.replace("MIIDjj", "NIIDjj")))
      .toThrow("INVALID_TARGET_TLS_ROOT_CERT");
    expect(() => validateTargetTlsRootCertificate(
      targetTlsRootCert,
      undefined,
      new Date("2100-01-01T00:00:00Z"),
    )).toThrow("INVALID_TARGET_TLS_ROOT_CERT");
  });

  it("fails closed when a target Node connection lacks its pinned trust anchor", () => {
    expect(() => nodeClientConfig({
      host: "target.example.test",
      port: 5432,
      user: "admin",
      password: "secret",
      database: "scratch",
      sslmode: "verify-full",
    }, "target-test")).toThrow("MISSING_TARGET_TLS_ROOT_CERT");
  });

  it("fails closed when a source Node connection lacks its exact trust anchor", () => {
    expect(() => nodeClientConfig({
      host: "source.example.test",
      port: 5432,
      user: "reader",
      password: "secret",
      database: "core",
      sslmode: "require",
    }, "source-test")).toThrow("MISSING_SOURCE_TLS_ROOT_CERT");
  });

  it("serializes libpq service values without literal quotes", () => {
    expect(serializePgServiceValue("disable")).toBe("disable");
    expect(serializePgServiceValue("source-db.internal")).toBe("source-db.internal");
    expect(serializePgServiceValue(5432)).toBe("5432");
    expect(`sslmode=${serializePgServiceValue("disable")}`).toBe("sslmode=disable");
    expect(`host=${serializePgServiceValue("source-db.internal")}`).not.toContain("'");
  });

  it("uses exact mounted roots with verify-ca and verify-full", () => {
    const service = buildPgServiceContents(
      { dockerHost: "source.example.test", port: 5432, user: "reader", database: "core", sslmode: "require" },
      { dockerHost: "target.example.test", port: 5432, user: "admin", database: "scratch", sslmode: "verify-full" },
    );
    expect(service).toContain("sslmode=verify-ca\nsslrootcert=/work/source-root.crt");
    expect(service.match(/sslmode=verify-full\nsslrootcert=\/work\/target-root\.crt/gu)).toHaveLength(1);
    expect(service).not.toContain("sslrootcert=system");
  });

  it("never downgrades a stronger source URL claim to CA-only verification", () => {
    expect(() => buildPgServiceContents(
      { dockerHost: "source.example.test", port: 5432, user: "reader", database: "core", sslmode: "verify-full" },
      { dockerHost: "target.example.test", port: 5432, user: "admin", database: "scratch", sslmode: "verify-full" },
    )).toThrow("INVALID_SOURCE_TLS_MODE");
  });

  it("omits system trust roots only for the synthetic non-TLS services", () => {
    const service = buildPgServiceContents(
      { dockerHost: "source", port: 5432, user: "reader", database: "core", sslmode: "disable" },
      { dockerHost: "target", port: 5432, user: "admin", database: "scratch", sslmode: "disable" },
    );
    expect(service.match(/sslmode=disable/gu)).toHaveLength(2);
    expect(service).not.toContain("sslrootcert");
  });

  it("waits for Azure firewall propagation before continuing", async () => {
    let clock = 0;
    let attempts = 0;
    let queries = 0;
    const result = await waitForTargetConnection({
      targetAdminConfig: {
        host: "target.example.test",
        port: 5432,
        user: "admin",
        password: "secret",
        database: "postgres",
        sslmode: "verify-full",
        targetTlsRootCert: loadTargetTlsRootCertificate(),
      },
      timeoutMs: 5_000,
      retryDelayMs: 1_000,
      now: () => clock,
      sleepFn: async (milliseconds) => { clock += milliseconds; },
      clientFactory: () => ({
        connect: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("not ready");
        },
        query: async (sql) => {
          expect(sql).toBe("SELECT 1");
          queries += 1;
        },
        end: async () => {},
      }),
    });
    expect(result).toEqual({ attempts: 3 });
    expect(queries).toBe(1);
  });

  it("fails closed at the bounded firewall propagation deadline", async () => {
    let clock = 0;
    const connectionTimeouts = [];
    const queryTimeouts = [];
    const promise = waitForTargetConnection({
      targetAdminConfig: {
        host: "target.example.test",
        port: 5432,
        user: "admin",
        password: "secret",
        database: "postgres",
        sslmode: "verify-full",
        targetTlsRootCert: loadTargetTlsRootCertificate(),
      },
      timeoutMs: 2_500,
      retryDelayMs: 1_000,
      now: () => clock,
      sleepFn: async (milliseconds) => { clock += milliseconds; },
      clientFactory: (config) => {
        connectionTimeouts.push(config.connectionTimeoutMillis);
        queryTimeouts.push(config.query_timeout);
        return {
          connect: async () => { throw new Error("not ready"); },
          query: async () => {},
          end: async () => {},
        };
      },
    });
    await expect(promise).rejects.toThrow("TARGET_FIREWALL_PROPAGATION_TIMEOUT");
    expect(clock).toBe(2_500);
    expect(connectionTimeouts).toEqual([2_500, 1_500, 500]);
    expect(queryTimeouts).toEqual([2_500, 1_500, 500]);
  });

  it("selects only exact sequence-set entries from a PostgreSQL archive TOC", () => {
    const selection = buildSequenceUseList([
      "; Archive created at 2026-09-02 18:00:00 UTC",
      "12; 1259 100 TABLE public Event postgres",
      "13; 0 101 SEQUENCE SET public Event_id_seq postgres",
      "14; 0 102 SEQUENCE SET internal audit_id_seq postgres",
      "15; 0 100 TABLE DATA public Event postgres",
      "",
    ].join("\n"));
    expect(selection).toEqual({
      tocEntryCount: 2,
      contents: [
        "13; 0 101 SEQUENCE SET public Event_id_seq postgres",
        "14; 0 102 SEQUENCE SET internal audit_id_seq postgres",
        "",
      ].join("\n"),
    });
    expect(selection.contents).not.toContain("TABLE DATA");
  });

  it("supports an archive with zero user sequences", () => {
    expect(buildSequenceUseList("12; 1259 100 TABLE public Event postgres\n")).toEqual({
      tocEntryCount: 0,
      contents: "",
    });
  });

  it("proves the empty large-object set without reading the protected page catalog", async () => {
    const client = largeObjectClient([]);
    const identities = await inspectLargeObjectAccess(client, "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED");
    const evidence = await collectLargeObjects(
      client,
      identities,
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    );

    expect(evidence).toEqual({
      count: 0,
      contentSha256: createHash("sha256").digest("hex"),
    });
  });

  it("hashes authorized large objects in bounded chunks with deterministic framing", async () => {
    const objects = [
      { oid: "101", content: Buffer.alloc((1024 * 1024) + 17, 0x61) },
      { oid: "202", content: Buffer.from("second-object", "utf8") },
    ];
    const client = largeObjectClient(objects);
    const identities = await inspectLargeObjectAccess(client, "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED");

    await expect(collectLargeObjects(
      client,
      identities,
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    )).resolves.toEqual({
      count: 2,
      contentSha256: lengthFramedLargeObjectManifest(objects),
    });
  });

  it("binds large-object content and OID into the manifest digest", async () => {
    const evidenceFor = async (oid, content) => collectLargeObjects(
      largeObjectClient([{ oid, content }]),
      [{ oid, readable: true }],
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    );
    const baseline = await evidenceFor("101", Buffer.from("content", "utf8"));
    const changedContent = await evidenceFor("101", Buffer.from("changed", "utf8"));
    const changedOid = await evidenceFor("102", Buffer.from("content", "utf8"));

    expect(changedContent.contentSha256).not.toBe(baseline.contentSha256);
    expect(changedOid.contentSha256).not.toBe(baseline.contentSha256);
  });

  it("fails closed on unreadable or non-deterministically ordered large objects", async () => {
    const client = largeObjectClient([
      { oid: "202", content: Buffer.alloc(0) },
      { oid: "101", content: Buffer.alloc(0) },
    ]);
    await expect(collectLargeObjects(
      client,
      [{ oid: "101", readable: false }],
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    )).rejects.toThrow("SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING");
    await expect(collectLargeObjects(
      client,
      [{ oid: "202", readable: true }, { oid: "101", readable: true }],
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    )).rejects.toThrow("INVALID_LARGE_OBJECT_ORDER");
  });

  it("maps raw PostgreSQL privilege errors to bounded large-object stage codes", async () => {
    const denied = {
      query: async () => { throw Object.assign(new Error("private database error"), { code: "42501" }); },
    };
    await expect(inspectLargeObjectAccess(denied, "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED"))
      .rejects.toThrow("SOURCE_LARGE_OBJECT_EVIDENCE_FAILED");
    await expect(collectLargeObjects(
      denied,
      [{ oid: "101", readable: true }],
      "DESTINATION_LARGE_OBJECT_EVIDENCE_FAILED",
      "DESTINATION_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    )).rejects.toThrow("DESTINATION_LARGE_OBJECT_EVIDENCE_FAILED");
  });

  it.each([
    ["pre-data privilege", "pre-data", "ERROR:  42501\n", "0:3", "INSUFFICIENT_PRIVILEGE", "42501"],
    ["data constraint", "data", "ERROR:  23505\n", "0:3", "DATA_CONSTRAINT", "23505"],
    ["post-data duplicate", "post-data", "ERROR:  42P07\n", "0:3", "DUPLICATE_OBJECT", "42P07"],
  ])("reduces %s to server-authored SQLSTATE evidence", (_label, section, stderr, statuses, category, sqlstate) => {
    const diagnostic = buildRestoreDiagnostic({
      section,
      stderrChunks: [Buffer.from(stderr, "utf8")],
      statusChunks: [Buffer.from(`CORGTEX_RESTORE_STATUS:${statuses}\n`, "utf8")],
    });
    expect(diagnostic).toEqual({
      phase: "DESTINATION_RESTORE",
      section: section.replace("-", "_").toUpperCase(),
      processClass: "SCRIPT_ERROR",
      category,
      sqlstate,
      stderrObserved: true,
      stderrTruncated: false,
    });
    expect(Object.keys(diagnostic)).toEqual([
      "phase",
      "section",
      "processClass",
      "category",
      "sqlstate",
      "stderrObserved",
      "stderrTruncated",
    ]);
  });

  it.each([
    ["connection", 2, "private tls host password secret\n", "CONNECTION_ERROR", "UNKNOWN", null],
    ["server script", 3, "ERROR:  42501\n", "SCRIPT_ERROR", "INSUFFICIENT_PRIVILEGE", "42501"],
    ["unexpected process", 1, "private process output\n", "PROCESS_ERROR", "UNKNOWN", null],
  ])("reduces a target %s probe failure to fixed fields", (_label, status, stderr, processClass, category, sqlstate) => {
    const diagnostic = buildTargetConnectionProbeDiagnostic({
      stderrChunks: [Buffer.from(stderr, "utf8")],
      status,
    });
    expect(diagnostic).toEqual({
      phase: "TARGET_CLIENT_CONNECTION_PROBE",
      processClass,
      category,
      sqlstate,
      stderrObserved: true,
      stderrTruncated: false,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|tls|host|password|secret|process output/u);
  });

  it("classifies arbitrary chunk boundaries and a missing final newline", () => {
    const stderrChunks = Array.from(Buffer.from("ERROR:  42501", "utf8"), (byte) => Buffer.from([byte]));
    const statusChunks = Array.from(Buffer.from("CORGTEX_RESTORE_STATUS:141:3", "utf8"), (byte) => Buffer.from([byte]));
    expect(buildRestoreDiagnostic({ section: "pre-data", stderrChunks, statusChunks })).toMatchObject({
      section: "PRE_DATA",
      processClass: "SCRIPT_ERROR",
      category: "INSUFFICIENT_PRIVILEGE",
      sqlstate: "42501",
    });
  });

  it.each([
    ["archive renderer", "1:0", "ARCHIVE_RENDER_FAILED"],
    ["archive renderer with secondary script error", "1:3", "ARCHIVE_RENDER_FAILED"],
    ["connection", "0:2", "CONNECTION_ERROR"],
    ["psql client", "0:1", "PROCESS_ERROR"],
    ["unexpected consumer", "0:9", "PROCESS_ERROR"],
  ])("classifies a %s exit without retaining process output", (_label, statuses, processClass) => {
    const diagnostic = buildRestoreDiagnostic({
      section: "data",
      stderrChunks: [Buffer.from("private host password secret\n", "utf8")],
      statusChunks: [Buffer.from(`CORGTEX_RESTORE_STATUS:${statuses}\n`, "utf8")],
    });
    expect(diagnostic).toMatchObject({ processClass, category: "UNKNOWN", sqlstate: null, stderrObserved: true });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|host|password|secret/u);
  });

  it("fails closed when the controlled status marker or process result is unavailable", () => {
    expect(buildRestoreDiagnostic({
      section: "post-data",
      stderrChunks: [],
      statusChunks: [],
    })).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
    expect(buildRestoreDiagnostic({
      section: "post-data",
      stderrChunks: [],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
      spawnError: true,
    })).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
    expect(buildRestoreDiagnostic({
      section: "post-data",
      stderrChunks: [],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
      signal: "SIGKILL",
    })).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
    expect(buildRestoreDiagnostic({
      section: "post-data",
      stderrChunks: [],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:0\n", "utf8")],
      status: 125,
    })).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
  });

  it("rejects message-shaped and malformed SQLSTATE claims", () => {
    const diagnostic = buildRestoreDiagnostic({
      section: "pre-data",
      stderrChunks: [Buffer.from("SQLSTATE: 42501\nERROR: private 42501\n", "utf8")],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(diagnostic).toMatchObject({ processClass: "SCRIPT_ERROR", category: "UNKNOWN", sqlstate: null });
  });

  it("fails closed on truncated or malformed diagnostic streams", () => {
    const diagnostic = buildRestoreDiagnostic({
      section: "pre-data",
      stderrChunks: [Buffer.alloc(5 * 1024, 0x61), Buffer.from("\nERROR:  42501\n", "utf8")],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(diagnostic).toMatchObject({
      processClass: "SCRIPT_ERROR",
      category: "UNKNOWN",
      sqlstate: null,
      stderrTruncated: true,
    });
    const malformedStderr = buildRestoreDiagnostic({
      section: "data",
      stderrChunks: [Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from("\nERROR:  42501\n", "utf8")],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(malformedStderr).toMatchObject({
      processClass: "SCRIPT_ERROR",
      category: "UNKNOWN",
      sqlstate: null,
      stderrTruncated: true,
    });
    const malformedStatus = buildRestoreDiagnostic({
      section: "data",
      stderrChunks: [Buffer.from("ERROR:  42501\n", "utf8")],
      statusChunks: [Buffer.from([0xff]), Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(malformedStatus).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
    const oversizedStatus = buildRestoreDiagnostic({
      section: "data",
      stderrChunks: [Buffer.from("ERROR:  42501\n", "utf8")],
      statusChunks: [Buffer.alloc(256, 0x61), Buffer.from("\nCORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(oversizedStatus).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
  });

  it("rejects duplicate selected archive entries", () => {
    expect(() => buildSequenceUseList([
      "13; 0 101 SEQUENCE SET public first_seq postgres",
      "13; 0 102 SEQUENCE SET public second_seq postgres",
    ].join("\n"))).toThrow("DUPLICATE_ARCHIVE_SEQUENCE_ENTRY");
  });

  it.each([
    [
      "libc",
      { provider: "libc", providerLocale: null, icuRules: null },
      "LOCALE_PROVIDER 'libc' LC_COLLATE 'C' LC_CTYPE 'C'",
    ],
    [
      "icu",
      { provider: "icu", providerLocale: "en-US", icuRules: "&a < b" },
      "LOCALE_PROVIDER 'icu' LC_COLLATE 'C' LC_CTYPE 'C' ICU_LOCALE 'en-US' ICU_RULES '&a < b'",
    ],
    [
      "builtin",
      { provider: "builtin", providerLocale: "C.UTF-8", icuRules: null },
      "LOCALE_PROVIDER 'builtin' LC_COLLATE 'C' LC_CTYPE 'C' BUILTIN_LOCALE 'C.UTF-8'",
    ],
  ])("builds an exact PostgreSQL 18 %s locale clause", (_label, locale, clause) => {
    const sql = buildCreateDatabaseSql("corgtex_rehearsal_123_core", {
      encoding: "UTF8",
      collation: "C",
      ctype: "C",
      collationVersion: "1",
      ...locale,
    });
    expect(sql).toContain("TEMPLATE template0 ENCODING 'UTF8'");
    expect(sql).toContain(clause);
    expect(sql).not.toContain("COLLATION_VERSION");
  });

  it("omits ICU rules when the source catalog has none", () => {
    const sql = buildCreateDatabaseSql("corgtex_rehearsal_123_core", {
      encoding: "UTF8",
      collation: "C",
      ctype: "C",
      provider: "icu",
      providerLocale: "en-US",
      icuRules: null,
      collationVersion: "153.128",
    });
    expect(sql).toContain("ICU_LOCALE 'en-US'");
    expect(sql).not.toContain("ICU_RULES");
  });

  it("treats provider-version drift separately from the exact locale definition", () => {
    const source = {
      encoding: "UTF8",
      collation: "C",
      ctype: "C",
      provider: "icu",
      providerLocale: "en-US",
      icuRules: null,
      collationVersion: "153.128",
      actualCollationVersion: "153.128",
    };
    const target = { ...source, collationVersion: "154.1", actualCollationVersion: "154.1" };

    expect(localeDefinitionMismatchFields(source, target)).toEqual([]);
    expect(isCurrentCollationVersion(source)).toBe(true);
    expect(isCurrentCollationVersion(target)).toBe(true);
    expect(classifyCollationVersionRelation(source, target)).toBe("DIFFERENT");
    expect(buildLocaleDiagnostic(source, target)).toEqual({
      schemaVersion: "1.0.0",
      definitionMismatchFields: [],
      sourceVersionCurrent: true,
      targetVersionCurrent: true,
      crossRuntimeVersionRelation: "DIFFERENT",
    });
  });

  it("reports only allowlisted field names and fixed statuses in locale diagnostics", () => {
    const source = {
      encoding: "UTF8",
      collation: "private-source-locale",
      ctype: "C",
      provider: "libc",
      providerLocale: null,
      icuRules: null,
      collationVersion: null,
      actualCollationVersion: null,
    };
    const target = { ...source, collation: "private-target-locale" };
    const diagnostic = buildLocaleDiagnostic(source, target);

    expect(diagnostic).toEqual({
      schemaVersion: "1.0.0",
      definitionMismatchFields: ["collation"],
      sourceVersionCurrent: true,
      targetVersionCurrent: true,
      crossRuntimeVersionRelation: "UNVERSIONED",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-source-locale");
    expect(JSON.stringify(diagnostic)).not.toContain("private-target-locale");
  });

  it("detects stale recorded collation versions with null-safe equality", () => {
    expect(isCurrentCollationVersion({ collationVersion: null, actualCollationVersion: null })).toBe(true);
    expect(isCurrentCollationVersion({ collationVersion: "1", actualCollationVersion: "2" })).toBe(false);
    expect(classifyCollationVersionRelation(
      { collationVersion: null },
      { collationVersion: "2" },
    )).toBe("UNVERSIONED");
  });

  it.each([
    { provider: "unknown", providerLocale: null, icuRules: null },
    { provider: "libc", providerLocale: "en-US", icuRules: null },
    { provider: "icu", providerLocale: null, icuRules: null },
    { provider: "builtin", providerLocale: "C.UTF-8", icuRules: "rule" },
  ])("rejects an invalid locale provider contract", (locale) => {
    expect(() => buildCreateDatabaseSql("corgtex_rehearsal_123_core", {
      encoding: "UTF8",
      collation: "C",
      ctype: "C",
      collationVersion: null,
      ...locale,
    })).toThrow();
  });

  it.each(["value with spaces", "value#comment", "value;other", "value='quoted'", "line\nbreak"])(
    "rejects unsafe service-file value %j",
    (value) => {
      expect(() => serializePgServiceValue(value)).toThrow("INVALID_SERVICE_VALUE");
    },
  );
});
