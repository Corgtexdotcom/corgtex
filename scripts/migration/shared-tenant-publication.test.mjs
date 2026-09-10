import { describe, expect, it } from "vitest";
import { prepareTenantPublication } from "./shared-tenant-publication.ts";
import { hashCanonical, hashFrames } from "./shared-tenant-export.ts";

function table(name, fields, rows, foreignKeys = []) {
  return { name, columns: fields.map(([name, type = "text", nullable = true]) => ({ name, type, nullable })),
    primaryKey: ["id"], foreignKeys, rows, sha256: hashFrames(rows) };
}
const fk = (column, referencedTable, declared = false) => ({ columns: [column], referencedTable,
  referencedColumns: ["id"], ...(declared ? { declared: true } : {}) });
function fixture() {
  const tables = [
    table("Workspace", [["id", "text", false]], [["ws"]]),
    table("User", [["id", "text", false]], [["historical-user"]]),
    table("Member", [["id", "text", false], ["workspaceId", "text", false], ["userId", "text", false]],
      [["member", "ws", "historical-user"]], [fk("workspaceId", "Workspace"), fk("userId", "User")]),
    table("WorkflowJob", [["id", "text", false], ["workspaceId", "text", false], ["status", "text", false], ["payload", "jsonb", false], ["attempts", "integer", false]],
      [["pending", "ws", "PENDING", '{"amount":9007199254740993,"fraction":0.1234567890123456789}', "2"],
        ["completed", "ws", "COMPLETED", '{"result":"original history"}', "1"]], [fk("workspaceId", "Workspace")]),
    table("WorkspaceBriefing", [["id", "text", false], ["workspaceId", "text", false], ["workflowJobId"], ["title"]],
      [["briefing", "ws", "pending", "Historical title"]], [fk("workspaceId", "Workspace"), fk("workflowJobId", "WorkflowJob")]),
    table("EmailDelivery", [["id", "text", false], ["workspaceId", "text", false], ["userId"]],
      [["delivery", "ws", "historical-user"]], [fk("workspaceId", "Workspace"), fk("userId", "User", true)]),
  ];
  const manifest = { formatVersion: 1, transferId: "synthetic-publication", workspaceId: "ws", workspaceSlug: "ws", schemaSha256: "a".repeat(64),
    tables: Object.fromEntries(tables.map((table) => [table.name, { disposition: "copy", reason: "Synthetic explicit policy" }])) };
  manifest.tables.WorkflowJob.fields = { payload: { kind: "content", reason: "Original pending and terminal payload" } };
  manifest.tables.EmailDelivery.fields = { workspaceId: { kind: "reference", reason: "Scalar tenant ownership" }, userId: { kind: "reference", reason: "Historical scalar actor", references: { table: "User", column: "id" } } };
  const body = { formatVersion: 1, manifest, manifestSha256: hashCanonical(manifest), sourceSnapshot: "synthetic", sourceDatabase: "synthetic",
    schemaSha256: manifest.schemaSha256, tables,
    dispositions: tables.map((table) => ({ table: table.name, sourceRows: String(table.rows.length), selectedRows: String(table.rows.length), disposition: "copy", reason: "Synthetic explicit policy" })) };
  return { ...body, sha256: hashCanonical(body) };
}
const stage = (table, id) => ({ table, primaryKeys: [[id]], reason: "Keep original source work privately staged" });
const detach = (table, column, id) => ({ ...stage(table, id), column, reason: "Detach explicit historical source reference" });
const policy = () => ({ stagedRows: [stage("WorkflowJob", "pending")], detachReferences: [detach("WorkspaceBriefing", "workflowJobId", "briefing")] });
function rehash(value) {
  for (const table of value.tables) table.sha256 = hashFrames(table.rows);
  value.manifestSha256 = hashCanonical(value.manifest);
  const { sha256: _sha256, ...body } = value; value.sha256 = hashCanonical(body);
  return value;
}

describe("exact operator publication preparation", () => {
  it("preserves pending state, complete payload precision and detached history without mutating input", () => {
    const input = fixture(); const before = structuredClone(input); const requests = policy(); const originalPolicy = structuredClone(requests);
    const result = prepareTenantPublication(input, requests);
    expect(input).toEqual(before); expect(requests).toEqual(originalPolicy);
    expect(result.staging.rows[0].rows).toEqual([input.tables.find((table) => table.name === "WorkflowJob").rows[0]]);
    expect(result.staging.rows[0].columns).toEqual(input.tables.find((table) => table.name === "WorkflowJob").columns);
    expect(result.staging.detachedReferences[0]).toMatchObject({ table: "WorkspaceBriefing", column: "workflowJobId", primaryKey: ["id"], primaryKeys: [["briefing"]], originalValues: ["pending"] });
    expect(result.publicationSnapshot.tables.find((table) => table.name === "WorkspaceBriefing").rows).toEqual([["briefing", "ws", null, "Historical title"]]);
    expect(result.publicationSnapshot.tables.find((table) => table.name === "WorkflowJob").rows).toEqual([input.tables.find((table) => table.name === "WorkflowJob").rows[1]]);
    expect(result.publicationSnapshot.tables.find((table) => table.name === "User").rows).toEqual([["historical-user"]]);
    expect(result.publicationSnapshot.dispositions.find((entry) => entry.table === "WorkflowJob")).toMatchObject({ sourceRows: "2", selectedRows: "1" });
  });

  it("binds original snapshot, staging payload and final publication with reproducible hashes", () => {
    const input = fixture(); const result = prepareTenantPublication(input, policy());
    const { sha256: stagingHash, ...stagingBody } = result.staging;
    expect(stagingHash).toBe(hashCanonical(stagingBody));
    expect(result.publicationSnapshot.manifest).toMatchObject({ preparedFromSha256: input.sha256, stagingSha256: stagingHash });
    const { sha256: publicationHash, ...publicationBody } = result.publicationSnapshot;
    expect(publicationHash).toBe(hashCanonical(publicationBody));
    expect(result.sha256).toBe(hashCanonical({ publicationSnapshot: result.publicationSnapshot, staging: result.staging }));
    expect(prepareTenantPublication(input, policy())).toEqual(result);
  });

  it("rejects dangling references instead of cascading deletion or deleting referenced users", () => {
    expect(() => prepareTenantPublication(fixture(), { stagedRows: [stage("WorkflowJob", "pending")], detachReferences: [] })).toThrow("PUBLICATION_STAGED_REFERENCE_REMAINS:WorkspaceBriefing");
    expect(() => prepareTenantPublication(fixture(), { stagedRows: [stage("User", "historical-user")], detachReferences: [] })).toThrow("PUBLICATION_STAGED_REFERENCE_REMAINS:Member");
  });

  it("permits only declared scalar references with matching policy", () => {
    const requests = { stagedRows: [], detachReferences: [detach("EmailDelivery", "userId", "delivery")] };
    const result = prepareTenantPublication(fixture(), requests);
    expect(result.staging.detachedReferences[0].originalValues).toEqual(["historical-user"]);
    const invalid = fixture(); delete invalid.manifest.tables.EmailDelivery.fields;
    expect(() => prepareTenantPublication(rehash(invalid), requests)).toThrow("TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:EmailDelivery.workspaceId");
  });

  it.each(["id", "workspaceId", "title"])("refuses detaching key, ownership or business column %s", (column) => {
    expect(() => prepareTenantPublication(fixture(), { stagedRows: [], detachReferences: [detach("WorkspaceBriefing", column, "briefing")] })).toThrow("PUBLICATION_REFERENCE_DETACH_FORBIDDEN");
  });

  it("retains catalog metadata for tables whose rows are all staged", () => {
    const result = prepareTenantPublication(fixture(), { stagedRows: [stage("EmailDelivery", "delivery")], detachReferences: [] });
    expect(result.publicationSnapshot.tables.find((table) => table.name === "EmailDelivery")).toMatchObject({ rows: [], primaryKey: ["id"], sha256: hashFrames([]) });
    expect(result.publicationSnapshot.dispositions.find((entry) => entry.table === "EmailDelivery").selectedRows).toBe("0");
  });

  it("selects composite keys exactly and honors nullable MATCH SIMPLE references", () => {
    const input = fixture();
    const jobs = input.tables.find((table) => table.name === "WorkflowJob");
    jobs.primaryKey = ["id", "workspaceId"];
    const briefing = input.tables.find((table) => table.name === "WorkspaceBriefing");
    briefing.foreignKeys[1] = { columns: ["workflowJobId", "workspaceId"], referencedTable: "WorkflowJob", referencedColumns: ["id", "workspaceId"] };
    const result = prepareTenantPublication(rehash(input), {
      stagedRows: [{ table: "WorkflowJob", primaryKeys: [["pending", "ws"]], reason: "Exact composite source key" }],
      detachReferences: policy().detachReferences,
    });
    expect(result.staging.rows[0].primaryKeys).toEqual([["pending", "ws"]]);
    expect(result.staging.detachedReferences[0].references[0].columns).toEqual(["workflowJobId", "workspaceId"]);
    expect(result.publicationSnapshot.tables.find((table) => table.name === "WorkspaceBriefing").rows[0]).toEqual(["briefing", "ws", null, "Historical title"]);
    expect(() => prepareTenantPublication(input, { stagedRows: [{ table: "WorkflowJob", primaryKeys: [["ws", "pending"]], reason: "Wrong order" }], detachReferences: [] })).toThrow("PUBLICATION_UNKNOWN_KEY");
  });

  it("refuses a nonnullable foreign key and duplicate selections across request groups", () => {
    expect(() => prepareTenantPublication(fixture(), { stagedRows: [], detachReferences: [detach("Member", "userId", "member")] })).toThrow("PUBLICATION_REFERENCE_DETACH_FORBIDDEN");
    expect(() => prepareTenantPublication(fixture(), { stagedRows: [stage("EmailDelivery", "delivery"), stage("EmailDelivery", "delivery")], detachReferences: [] })).toThrow("PUBLICATION_DUPLICATE_REQUEST_KEY");
  });

  it.each([
    [{ ...stage("Missing", "pending") }, "UNKNOWN_TABLE"],
    [{ ...stage("WorkflowJob", "missing") }, "UNKNOWN_KEY"],
    [{ ...stage("WorkflowJob", "pending"), primaryKeys: [["pending"], ["pending"]] }, "DUPLICATE_REQUEST_KEY"],
    [{ ...stage("WorkflowJob", "pending"), reason: " " }, "REASON_REQUIRED"],
    [{ ...stage("WorkflowJob", "pending"), primaryKeys: [["pending", "extra"]] }, "KEY_SHAPE_INVALID"],
  ])("rejects unknown, duplicate, unreasoned and malformed requests", (request, code) => {
    const input = fixture(); const before = structuredClone(input);
    expect(() => prepareTenantPublication(input, { stagedRows: [request], detachReferences: [] })).toThrow(`PUBLICATION_${code}`);
    expect(input).toEqual(before);
  });

  it("rejects overlapping staging/detach selections and duplicate detach requests", () => {
    expect(() => prepareTenantPublication(fixture(), { stagedRows: [stage("WorkspaceBriefing", "briefing")], detachReferences: policy().detachReferences })).toThrow("PUBLICATION_STAGED_ROW_DETACH_CONFLICT");
    expect(() => prepareTenantPublication(fixture(), { stagedRows: [], detachReferences: [...policy().detachReferences, ...policy().detachReferences] })).toThrow("PUBLICATION_DUPLICATE_REQUEST_KEY");
  });

  it("checks snapshot, manifest and individual table hashes before editing", () => {
    const changed = fixture(); changed.tables[0].rows[0][0] = "tampered";
    expect(() => prepareTenantPublication(changed, policy())).toThrow("PUBLICATION_SNAPSHOT_DIGEST_MISMATCH");
    const tableTampered = fixture(); tableTampered.tables[0].sha256 = "0".repeat(64);
    const { sha256: _sha256, ...body } = tableTampered; tableTampered.sha256 = hashCanonical(body);
    expect(() => prepareTenantPublication(tableTampered, policy())).toThrow("PUBLICATION_TABLE_DIGEST_MISMATCH");
  });
});

function appendFixtureTable(input, added, fields = {}) {
  input.tables.push(added);
  input.manifest.tables[added.name] = { disposition: "copy", reason: "Explicit synthetic classification", fields };
  input.dispositions.push({ table: added.name, sourceRows: String(added.rows.length), selectedRows: String(added.rows.length), disposition: "copy", reason: "Synthetic source" });
  return rehash(input);
}

describe("publication scalar policy and source marker validation", () => {
  it.each([
    ["CommunicationInstallation", "botTokenEnc"],
    ["ExternalDataSource", "connectionStringEnc"],
    ["AiWorkspaceConnection", "apiKeyEnc"],
    ["DemoLead", "qualifyToken"],
  ])("requires secret classification for populated %s.%s even when a snapshot was rehashed", (name, field) => {
    const input = appendFixtureTable(fixture(), table(name, [["id"], [field]], [["credential-row", "synthetic-source-secret"]]));
    expect(() => prepareTenantPublication(input, { stagedRows: [], detachReferences: [] })).toThrow(`TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:${name}.${field}:secret`);
    input.manifest.tables[name].fields[field] = { kind: "content", reason: "Calling a credential content cannot authorize it" };
    expect(() => prepareTenantPublication(rehash(input), { stagedRows: [], detachReferences: [] })).toThrow(`TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:${name}.${field}:secret`);
    input.manifest.tables[name].fields[field] = { kind: "secret", reason: "Keep source credential private for separate disposition" };
    const result = prepareTenantPublication(rehash(input), { stagedRows: [stage(name, "credential-row")], detachReferences: [] });
    expect(result.staging.rows[0].rows).toEqual([["credential-row", "synthetic-source-secret"]]);
  });

  it("requires explicit opaque scalar reference policy without inventing a target relation", () => {
    const input = appendFixtureTable(fixture(), table("KnowledgeChunk", [["id"], ["sourceId"]], [["chunk", "historical-polymorphic-id"]]));
    expect(() => prepareTenantPublication(input, { stagedRows: [], detachReferences: [] })).toThrow("TRANSFER_SCALAR_FIELD_POLICY_REQUIRED:KnowledgeChunk.sourceId:reference");
    input.manifest.tables.KnowledgeChunk.fields.sourceId = { kind: "reference", reason: "Reviewed historical polymorphic identifier" };
    expect(prepareTenantPublication(rehash(input), { stagedRows: [], detachReferences: [] }).publicationSnapshot.tables.at(-1).foreignKeys).toEqual([]);
  });

  it("rejects a surviving source import marker and preserves it only through exact staging", () => {
    const input = appendFixtureTable(fixture(), table("WorkspaceFeatureFlag", [["id"], ["flag"], ["enabled"]], [["marker", "operator_import_inactive", "false"], ["ordinary", "synthetic-feature", "true"]]));
    expect(() => prepareTenantPublication(input, { stagedRows: [], detachReferences: [] })).toThrow("TRANSFER_SOURCE_IMPORT_MARKER_MUST_BE_STAGED");
    const result = prepareTenantPublication(input, { stagedRows: [stage("WorkspaceFeatureFlag", "marker")], detachReferences: [] });
    expect(result.staging.rows[0].rows).toEqual([["marker", "operator_import_inactive", "false"]]);
    expect(result.publicationSnapshot.tables.at(-1).rows).toEqual([["ordinary", "synthetic-feature", "true"]]);
    expect(input.tables.at(-1).rows).toHaveLength(2);
  });
});
