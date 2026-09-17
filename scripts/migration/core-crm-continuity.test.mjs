import { describe, expect, it } from "vitest";
import { hashCanonical, hashFrames } from "./shared-tenant-export.ts";
import { prepareCoreCrmContinuity, verifyCoreCrmContinuity, restoreCoreQualificationTokens } from "./core-crm-continuity.ts";
import { transferScalarFieldKinds } from "./shared-tenant-transfer-contract.ts";

function table(name, columns, rows, foreignKeys = []) {
  return { name, columns: columns.map((name) => ({ name, type: name === "payload" ? "jsonb" : "text", nullable: !["id", "workspaceId"].includes(name) })),
    primaryKey: ["id"], foreignKeys, rows, sha256: hashFrames(rows) };
}
function rehash(snapshot) {
  for (const t of snapshot.tables) t.sha256 = hashFrames(t.rows);
  snapshot.manifestSha256 = hashCanonical(snapshot.manifest);
  const { sha256, ...body } = snapshot; snapshot.sha256 = hashCanonical(body); return snapshot;
}
function fixture() {
  const precision = '{"integer":9007199254740993,"decimal":0.1234567890123456789}';
  const tables = [
    table("Workspace", ["id", "slug"], [["core", "corgtex"]]),
    table("DemoLead", ["id", "workspaceId", "qualifyToken"], [["lead", "core", "original-purpose-token"], ["lead-null", "core", null]]),
    table("Event", ["id", "workspaceId", "status", "lockedAt", "lockedBy", "payload"], [["event", "core", "DISPATCHED", null, null, precision]]),
    table("WorkflowJob", ["id", "workspaceId", "status", "lockedAt", "lockedBy", "eventId", "dependsOnJobId", "dedupeKey", "payload"], [
      ["parent", "core", "FAILED", null, null, "event", null, "parent-key", precision],
      ["blocked", "core", "PENDING", null, null, null, "parent", "blocked-key", precision],
      ["leased", "core", "RUNNING", "2026-09-01 00:00:00", "old-worker", "event", null, "leased-key", precision],
      ["history", "core", "COMPLETED", null, null, null, null, "history-key", precision],
    ], [{ columns: ["eventId"], referencedTable: "Event", referencedColumns: ["id"] }, { columns: ["dependsOnJobId"], referencedTable: "WorkflowJob", referencedColumns: ["id"] }]),
    table("NewspaperDelivery", ["id", "workspaceId", "workflowJobId"], [["delivery", "core", "parent"]], [{ columns: ["workflowJobId"], referencedTable: "WorkflowJob", referencedColumns: ["id"] }]),
  ];
  const manifest = { formatVersion: 1, transferId: "core-transfer", workspaceId: "core", workspaceSlug: "corgtex", schemaSha256: "a".repeat(64),
    tables: Object.fromEntries(tables.map(t => [t.name, { disposition: "copy", reason: "Synthetic", fields: Object.fromEntries(t.columns.flatMap(c => {
      const kind = transferScalarFieldKinds[t.name]?.[c.name] ?? (c.name === "payload" ? "content" : null);
      return kind ? [[c.name, { kind, reason: "Synthetic explicit classification" }]] : [];
    })) }])) };
  return rehash({ formatVersion: 1, manifest, manifestSha256: "", sourceDatabase: "synthetic", sourceSnapshot: "10:20:", schemaSha256: manifest.schemaSha256, tables,
    dispositions: tables.map(t => ({ table: t.name, sourceRows: String(t.rows.length), selectedRows: String(t.rows.length), disposition: "copy", reason: "Synthetic" })), sha256: "" });
}

describe("Core-specific continuity preparation", () => {
  it("quarantines connected pending/leased/dependency-blocked work without modifying any original frame", () => {
    const source = fixture(), before = structuredClone(source), bundle = prepareCoreCrmContinuity(source);
    expect(source).toEqual(before); expect(bundle.sourceSnapshot).toEqual(before);
    const staged = bundle.publication.staging;
    expect(staged.rows.find(r => r.table === "WorkflowJob").primaryKeys).toEqual([["blocked"], ["leased"], ["parent"]]);
    expect(staged.rows.find(r => r.table === "Event").primaryKeys).toEqual([["event"]]);
    for (const t of staged.rows) for (const [i, [id]] of t.primaryKeys.entries()) {
      expect(t.rows[i]).toEqual(source.tables.find(s => s.name === t.table).rows.find(r => r[0] === id));
      expect(t.rows[i].at(-1)).toContain("9007199254740993");
    }
    expect(staged.detachedReferences[0].originalValues).toEqual(["parent"]);
    expect(bundle.publication.publicationSnapshot.tables.find(t => t.name === "NewspaperDelivery").rows[0][2]).toBeNull();
    expect(bundle.publication.publicationSnapshot.tables.find(t => t.name === "WorkflowJob").rows.map(r => r[0])).toEqual(["history"]);
    expect(verifyCoreCrmContinuity(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
  });
  it.each([
    ["other slug", s => { s.manifest.workspaceSlug = "other"; }],
    ["foreign lead", s => { s.tables[1].rows[0][1] = "other"; }],
    ["foreign queue", s => { s.tables[3].rows[0][1] = "other"; }],
    ["global queue", s => { s.tables[3].rows[0][1] = null; }],
    ["missing parent", s => { s.tables[3].rows[1][6] = "missing"; }],
    ["missing event", s => { s.tables[3].rows[0][5] = "missing"; }],
    ["unknown status", s => { s.tables[3].rows[0][2] = "BLOCKED"; }],
    ["duplicate token", s => { s.tables[1].rows[1][2] = s.tables[1].rows[0][2]; }],
    ["required history reference", s => { s.tables[4].columns[2].nullable = false; }],
    ["already prepared snapshot", s => { s.manifest.preparedFromSha256 = "a".repeat(64); }],
  ])("rejects %s", (_name, change) => {
    const source = fixture(); change(source);
    expect(() => prepareCoreCrmContinuity(rehash(source))).toThrow(/CORE_CONTINUITY_/);
  });
  it("rejects altered quarantine even when its outer digest was recomputed", () => {
    const bundle = prepareCoreCrmContinuity(fixture());
    bundle.publication.staging.rows[0].rows[0][2] = "COMPLETED";
    const { sha256, ...body } = bundle; bundle.sha256 = hashCanonical(body);
    expect(() => verifyCoreCrmContinuity(bundle)).toThrow("BUNDLE_MISMATCH");
  });
  it.each(["operator-control", "discard", "rebuild", "transform"])("requires queue copy rather than %s disposition", (disposition) => {
    const source = fixture(); source.manifest.tables.WorkflowJob.disposition = disposition;
    expect(() => prepareCoreCrmContinuity(rehash(source))).toThrow("QUEUE_COPY_REQUIRED");
  });
  function emptyQueues() {
    const source = fixture();
    source.tables = source.tables.filter(table => ["Workspace", "DemoLead"].includes(table.name));
    source.dispositions = source.dispositions.filter(row => ["Workspace", "DemoLead"].includes(row.table));
    return source;
  }
  it("accepts explicitly selected globally empty queues and zero selected rows owned elsewhere", () => {
    const source = emptyQueues();
    expect(prepareCoreCrmContinuity(rehash(source)).publication.staging.rows).toEqual([]);
    for (const table of ["Event", "WorkflowJob"]) source.dispositions.push({ table, sourceRows: "723", selectedRows: "0", disposition: "copy", reason: source.manifest.tables[table].reason });
    expect(prepareCoreCrmContinuity(rehash(source)).publication.staging.rows).toEqual([]);
  });
  it.each([
    ["missing copy policy", s => { delete s.manifest.tables.Event; }],
    ["excluded populated queue", s => { s.dispositions.push({ table: "Event", sourceRows: "2", selectedRows: "0", disposition: "operator-control", reason: "Synthetic" }); }],
    ["missing selected frames", s => { s.dispositions.push({ table: "Event", sourceRows: "2", selectedRows: "1", disposition: "copy", reason: "Synthetic" }); }],
    ["malformed count", s => { s.dispositions.push({ table: "Event", sourceRows: "NaN", selectedRows: "0", disposition: "copy", reason: "Synthetic" }); }],
    ["ambiguous count", s => { const row = { table: "Event", sourceRows: "2", selectedRows: "0", disposition: "copy", reason: "Synthetic" }; s.dispositions.push(row, row); }],
  ])("rejects incomplete admission evidence: %s", (_name, change) => {
    const source = emptyQueues(); change(source);
    expect(() => prepareCoreCrmContinuity(rehash(source))).toThrow(/QUEUE_/);
  });
  it.each(["pending", "leased terminal"])("quarantines an isolated %s event without requiring a job", (kind) => {
    const source = fixture();
    for (const row of source.tables[3].rows) { row[2] = "COMPLETED"; row[3] = null; row[4] = null; row[5] = null; row[6] = null; }
    source.tables[2].rows[0][2] = kind === "pending" ? "PENDING" : "FAILED";
    source.tables[2].rows[0][3] = kind === "pending" ? null : "2026-09-01 00:00:00";
    const staged = prepareCoreCrmContinuity(rehash(source)).publication.staging;
    expect(staged.rows.map(row => row.table)).toEqual(["Event"]);
    expect(staged.rows[0].rows).toEqual(source.tables[2].rows);
  });
  it("rejects tampered source and missing execute/receipt binding before touching SQL", async () => {
    let calls = 0; const client = { query: async () => { calls++; return { rows: [] }; } };
    const bundle = prepareCoreCrmContinuity(fixture());
    await expect(restoreCoreQualificationTokens(client, bundle, {})).rejects.toThrow("EXPLICIT_BINDING_REQUIRED");
    bundle.sourceSnapshot.tables[1].rows[0][2] = "tampered";
    await expect(restoreCoreQualificationTokens(client, bundle, {})).rejects.toThrow("BUNDLE_INVALID");
    expect(calls).toBe(0);
  });
  it.each([undefined, {}, { host: "localhost" }, { host: "/tmp", port: 5432 },
    { host: " localhost", port: 5432 }, { host: "", port: 5432 }, { host: "bad..host", port: 5432 },
    { host: "localhost", port: "5432" }, { host: "localhost", port: 0 },
    { host: "localhost", port: 65536 }, { host: "localhost", port: 1.5 }])(
    "requires an independent unambiguous network endpoint: %j", async endpoint => {
      let calls = 0;
      const client = { query: async () => { calls++; return { rows: [] }; } };
      await expect(restoreCoreQualificationTokens(client, prepareCoreCrmContinuity(fixture()), {
        execute: true, target: { database: "synthetic", user: "postgres", endpoint },
        expectedImportReceiptSha256: "a".repeat(64),
      })).rejects.toThrow("ENDPOINT_REQUIRED");
      expect(calls).toBe(0);
    },
  );
  it("does not accept a query-only adapter with an otherwise valid binding", async () => {
    const client = { query: () => { throw new Error("SQL must not run"); } };
    await expect(restoreCoreQualificationTokens(client, prepareCoreCrmContinuity(fixture()), {
      execute: true, target: { database: "synthetic", user: "postgres", endpoint: { host: "localhost", port: 5432 } },
      expectedImportReceiptSha256: "a".repeat(64),
    })).rejects.toThrow("CLIENT_REQUIRED");
  });
});
