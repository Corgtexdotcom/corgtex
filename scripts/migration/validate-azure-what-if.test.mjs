import { describe, expect, it } from "vitest";
import {
  EXPECTED_RESOURCE_TYPE_COUNTS,
  expectedResourceGroupId,
  resourceTypeFromId,
  validateWhatIfBytes,
  validateWhatIfDocument,
} from "./validate-azure-what-if.mjs";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const resourceGroup = "rg-corgtex-migration-rehearsal";
const groupId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
const resource = (type, name, changeType = "Create") => {
  const [provider, ...typeSegments] = type.split("/");
  const nameSegments = name.split("/");
  const nestedIdentity = typeSegments.flatMap((typeSegment, index) => [typeSegment, nameSegments[index]]).join("/");
  return {
    resourceId: `${groupId}/providers/${provider}/${nestedIdentity}`,
    changeType,
    after: { type, apiVersion: "2026-01-01" },
  };
};
const digests = {
  templateDigest: "a".repeat(64),
  parametersDigest: "b".repeat(64),
  targetDigest: "c".repeat(64),
};
const options = { subscriptionId, resourceGroup, ...digests };
const safeDocument = () => ({
  status: "Succeeded",
  diagnostics: null,
  potentialChanges: null,
  error: null,
  changes: [
    resource("Microsoft.Authorization/roleAssignments", "role-1"),
    resource("Microsoft.Authorization/roleAssignments", "role-2"),
    resource("Microsoft.Storage/storageAccounts", "ctmigration123"),
    resource("Microsoft.Storage/storageAccounts/blobServices", "ctmigration123/default"),
    resource("Microsoft.Storage/storageAccounts/blobServices/containers", "ctmigration123/default/objects"),
    resource("Microsoft.Storage/storageAccounts/blobServices/containers", "ctmigration123/default/migration-restore"),
    resource("Microsoft.DBforPostgreSQL/flexibleServers", "restore-pg"),
    resource("Microsoft.DBforPostgreSQL/flexibleServers/configurations", "restore-pg/azure.extensions"),
    resource("Microsoft.DBforPostgreSQL/flexibleServers/databases", "restore-pg/corgtex"),
    resource("Microsoft.Insights/components", "appi"),
    resource("Microsoft.KeyVault/vaults", "vault"),
    resource("Microsoft.ManagedIdentity/userAssignedIdentities", "identity"),
    resource("Microsoft.OperationalInsights/workspaces", "logs"),
  ],
});

describe("Azure migration foundation what-if validation", () => {
  it("accepts only the exact create manifest and emits only counts, hashes, and opaque references", () => {
    const bytes = Buffer.from(JSON.stringify(safeDocument()));
    const result = validateWhatIfBytes(bytes, options);
    expect(result).toMatchObject({
      status: "SAFE_EXACT_CREATE",
      changeCount: 13,
      changeCounts: { Create: 13 },
      templateSha256: digests.templateDigest,
      parametersSha256: digests.parametersDigest,
      targetSha256: digests.targetDigest,
    });
    expect(result.previewSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.subscriptionRef).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.resourceGroupRef).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(result.resourceSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result).not.toHaveProperty("resourceTypeCounts");
    expect(JSON.stringify(result)).not.toContain(subscriptionId);
    expect(JSON.stringify(result)).not.toContain(resourceGroup);
  });

  it.each(["Delete", "Modify", "Deploy", "Ignore", "Unsupported"])("rejects unsafe %s changes", (changeType) => {
    const document = safeDocument();
    document.changes[1].changeType = changeType;
    expect(() => validateWhatIfDocument(document, options)).toThrow("UNSAFE_CHANGE_TYPE");
  });

  it("rejects resources outside the exact group", () => {
    const document = safeDocument();
    document.changes[1] = {
      resourceId: `/subscriptions/${subscriptionId}/resourceGroups/rg-corgtex-production/providers/Microsoft.Storage/storageAccounts/foreign`,
      changeType: "Create",
      after: { type: "Microsoft.Storage/storageAccounts", apiVersion: "2026-01-01" },
    };
    expect(() => validateWhatIfDocument(document, options)).toThrow("FOREIGN_RESOURCE");
  });

  it("rejects unexpected resource types", () => {
    const document = safeDocument();
    document.changes[1] = resource("Microsoft.App/containerApps", "forbidden");
    expect(() => validateWhatIfDocument(document, options)).toThrow("UNEXPECTED_RESOURCE_TYPE");
  });

  it("rejects duplicate resource identities case-insensitively", () => {
    const document = safeDocument();
    document.changes[2] = { ...document.changes[1], resourceId: document.changes[1].resourceId.toUpperCase() };
    expect(() => validateWhatIfDocument(document, options)).toThrow("DUPLICATE_RESOURCE");
  });

  it("rejects provider results outside the bounded change count", () => {
    const document = safeDocument();
    document.changes = Array.from({ length: 129 }, (_, index) => resource(
      "Microsoft.Resources/deployments",
      `deployment-${index}`,
    ));
    expect(() => validateWhatIfDocument(document, options)).toThrow("TOO_MANY_CHANGES");
  });

  it("rejects empty and partial resource sets", () => {
    const empty = safeDocument();
    empty.changes = [];
    expect(() => validateWhatIfDocument(empty, options)).toThrow("INCOMPLETE_RESOURCE_SET");

    const partial = safeDocument();
    partial.changes.pop();
    expect(() => validateWhatIfDocument(partial, options)).toThrow("INCOMPLETE_RESOURCE_SET");
  });

  it("rejects provider diagnostics, potential changes, errors, and missing completeness fields", () => {
    for (const [key, value] of [
      ["diagnostics", [{ level: "Warning" }]],
      ["potentialChanges", [{}]],
      ["error", { code: "ProviderFailure" }],
    ]) {
      const document = safeDocument();
      document[key] = value;
      expect(() => validateWhatIfDocument(document, options)).toThrow("INCOMPLETE_PROVIDER_RESULT");
    }

    const missing = safeDocument();
    delete missing.potentialChanges;
    expect(() => validateWhatIfDocument(missing, options)).toThrow("MISSING_COMPLETENESS_FIELD");
  });

  it("rejects a type mismatch, missing API version, or invalid binding digest", () => {
    const mismatch = safeDocument();
    mismatch.changes[1].after.type = "Microsoft.KeyVault/vaults";
    expect(() => validateWhatIfDocument(mismatch, options)).toThrow("RESOURCE_TYPE_MISMATCH");

    const noVersion = safeDocument();
    delete noVersion.changes[1].after.apiVersion;
    expect(() => validateWhatIfDocument(noVersion, options)).toThrow("MISSING_API_VERSION");

    expect(() => validateWhatIfDocument(safeDocument(), { ...options, targetDigest: "bad" }))
      .toThrow("INVALID_BINDING_DIGEST");
  });

  it.each([
    [null, "INVALID_DOCUMENT"],
    [{}, "WHAT_IF_NOT_SUCCEEDED"],
    [{ status: "Failed", changes: [] }, "WHAT_IF_NOT_SUCCEEDED"],
    [{ status: "Succeeded" }, "MISSING_COMPLETENESS_FIELD"],
    [{ status: "Succeeded", diagnostics: null, potentialChanges: null, error: null }, "MISSING_CHANGES"],
  ])("rejects incomplete provider documents", (document, code) => {
    expect(() => validateWhatIfDocument(document, options)).toThrow(code);
  });

  it("rejects malformed and truncated JSON", () => {
    expect(() => validateWhatIfBytes(Buffer.from("{"), options)).toThrow("INVALID_JSON");
    expect(() => validateWhatIfBytes(Buffer.alloc(0), options)).toThrow("INVALID_INPUT_SIZE");
  });

  it("freezes the reviewed provider resource-type manifest", () => {
    expect(EXPECTED_RESOURCE_TYPE_COUNTS).toEqual({
      "microsoft.authorization/roleassignments": 2,
      "microsoft.dbforpostgresql/flexibleservers": 1,
      "microsoft.dbforpostgresql/flexibleservers/configurations": 1,
      "microsoft.dbforpostgresql/flexibleservers/databases": 1,
      "microsoft.insights/components": 1,
      "microsoft.keyvault/vaults": 1,
      "microsoft.managedidentity/userassignedidentities": 1,
      "microsoft.operationalinsights/workspaces": 1,
      "microsoft.storage/storageaccounts": 1,
      "microsoft.storage/storageaccounts/blobservices": 1,
      "microsoft.storage/storageaccounts/blobservices/containers": 2,
    });
  });

  it("validates the exact subscription and migration resource-group forms", () => {
    expect(expectedResourceGroupId(subscriptionId, resourceGroup)).toBe(groupId);
    expect(() => expectedResourceGroupId("not-a-subscription", resourceGroup)).toThrow("INVALID_SUBSCRIPTION_ID");
    expect(() => expectedResourceGroupId(subscriptionId, "rg-corgtex-production")).toThrow("INVALID_RESOURCE_GROUP");
  });

  it("derives nested Azure resource types from exact resource IDs", () => {
    expect(resourceTypeFromId(
      `${groupId}/providers/Microsoft.Storage/storageAccounts/account/blobServices/default/containers/objects`,
      groupId,
    )).toBe("microsoft.storage/storageaccounts/blobservices/containers");
  });
});
