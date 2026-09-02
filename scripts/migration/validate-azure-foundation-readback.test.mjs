import { describe, expect, it } from "vitest";
import { validateFoundationReadback } from "./validate-azure-foundation-readback.mjs";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const resourceGroup = "rg-corgtex-migration-rehearsal";
const groupId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
const tags = {
  purpose: "railway-to-azure-migration-foundation",
  authority: "non-authoritative-restore-target",
  managedBy: "github-oidc",
};
const options = {
  subscriptionId,
  resourceGroup,
  templateDigest: "a".repeat(64),
  parametersDigest: "b".repeat(64),
  targetDigest: "c".repeat(64),
};

const resource = (type, name, tagged = false) => {
  const [provider, ...typeSegments] = type.split("/");
  const names = name.split("/");
  const nestedIdentity = typeSegments.flatMap((segment, index) => [segment, names[index]]).join("/");
  return {
    resourceId: `${groupId}/providers/${provider}/${nestedIdentity}`,
    changeType: "Create",
    after: { type, apiVersion: "2026-01-01", ...(tagged ? { tags } : {}) },
  };
};

const previewDocument = () => ({
  status: "Succeeded",
  diagnostics: null,
  potentialChanges: null,
  error: null,
  changes: [
    resource("Microsoft.Authorization/roleAssignments", "role-1"),
    resource("Microsoft.Authorization/roleAssignments", "role-2"),
    resource("Microsoft.Storage/storageAccounts", "ctmigration123", true),
    resource("Microsoft.Storage/storageAccounts/blobServices", "ctmigration123/default"),
    resource("Microsoft.Storage/storageAccounts/blobServices/containers", "ctmigration123/default/objects"),
    resource("Microsoft.Storage/storageAccounts/blobServices/containers", "ctmigration123/default/migration-restore"),
    resource("Microsoft.DBforPostgreSQL/flexibleServers", "restore-pg", true),
    resource("Microsoft.DBforPostgreSQL/flexibleServers/configurations", "restore-pg/azure.extensions"),
    resource("Microsoft.DBforPostgreSQL/flexibleServers/databases", "restore-pg/corgtex"),
    resource("Microsoft.Insights/components", "appi", true),
    resource("Microsoft.KeyVault/vaults", "vault", true),
    resource("Microsoft.ManagedIdentity/userAssignedIdentities", "identity", true),
    resource("Microsoft.OperationalInsights/workspaces", "logs", true),
  ],
});

const readbackDocument = (preview) => preview.changes.map((change) => ({
  id: change.resourceId,
  type: change.after.type,
  ...(change.after.tags ? { tags: { ...change.after.tags } } : {}),
  ...(change.after.type === "Microsoft.DBforPostgreSQL/flexibleServers"
    ? { properties: { version: "18", backup: { backupRetentionDays: 7 } } }
    : {}),
}));

const bytes = (value) => Buffer.from(JSON.stringify(value));

describe("Azure migration foundation provider readback", () => {
  it("accepts the exact preview identity set with required tags and PostgreSQL backup metadata", () => {
    const preview = previewDocument();
    const receipt = validateFoundationReadback(bytes(preview), bytes(readbackDocument(preview)), options);
    expect(receipt).toMatchObject({
      status: "EXACT_CREATE_READ_BACK",
      resourceCount: 13,
      taggedResourceCount: 6,
      postgresVersion: "18",
      postgresBackupRetentionDays: 7,
      templateSha256: options.templateDigest,
      parametersSha256: options.parametersDigest,
      targetSha256: options.targetDigest,
    });
    expect(receipt.resourceSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.readbackSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(subscriptionId);
    expect(JSON.stringify(receipt)).not.toContain(resourceGroup);
  });

  it("rejects missing, duplicate, unexpected, and type-mismatched resources", () => {
    const preview = previewDocument();
    const missing = readbackDocument(preview).slice(0, -1);
    expect(() => validateFoundationReadback(bytes(preview), bytes(missing), options)).toThrow("INCOMPLETE_READBACK");

    const duplicate = readbackDocument(preview);
    duplicate[1] = { ...duplicate[0] };
    expect(() => validateFoundationReadback(bytes(preview), bytes(duplicate), options))
      .toThrow("DUPLICATE_READBACK_RESOURCE");

    const unexpected = readbackDocument(preview);
    unexpected[1].id = `${groupId}/providers/Microsoft.App/containerApps/forbidden`;
    expect(() => validateFoundationReadback(bytes(preview), bytes(unexpected), options))
      .toThrow("UNEXPECTED_READBACK_RESOURCE");

    const mismatch = readbackDocument(preview);
    mismatch[1].type = "Microsoft.KeyVault/vaults";
    expect(() => validateFoundationReadback(bytes(preview), bytes(mismatch), options))
      .toThrow("READBACK_TYPE_MISMATCH");
  });

  it("rejects missing authority tags and PostgreSQL drift", () => {
    const preview = previewDocument();
    const tagsMissing = readbackDocument(preview);
    delete tagsMissing[2].tags.authority;
    expect(() => validateFoundationReadback(bytes(preview), bytes(tagsMissing), options))
      .toThrow("READBACK_TAG_MISMATCH");

    const versionDrift = readbackDocument(preview);
    versionDrift[6].properties.version = "17";
    expect(() => validateFoundationReadback(bytes(preview), bytes(versionDrift), options))
      .toThrow("POSTGRES_VERSION_MISMATCH");

    const backupDrift = readbackDocument(preview);
    backupDrift[6].properties.backup.backupRetentionDays = 8;
    expect(() => validateFoundationReadback(bytes(preview), bytes(backupDrift), options))
      .toThrow("POSTGRES_BACKUP_MISMATCH");
  });

  it("rejects malformed readback documents", () => {
    const preview = previewDocument();
    expect(() => validateFoundationReadback(bytes(preview), Buffer.from("{"), options)).toThrow("INVALID_JSON");
    expect(() => validateFoundationReadback(bytes(preview), bytes({}), options)).toThrow("INVALID_READBACK");
  });
});
