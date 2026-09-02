import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_RBAC_CONDITION,
  canonicalizeCondition,
  validateMigrationPrincipal,
} from "./validate-azure-migration-principal.mjs";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const resourceGroup = "rg-corgtex-migration-rehearsal";
const scope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
const clientId = "33333333-3333-4333-8333-333333333333";
const principalId = "44444444-4444-4444-8444-444444444444";
const expectedClientSha256 = createHash("sha256").update(clientId).digest("hex");

const assignment = (name, roleId, condition = null) => ({
  id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
  scope,
  principalId,
  principalType: "ServicePrincipal",
  roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`,
  condition,
  conditionVersion: condition ? "2.0" : null,
});

const safeDocument = () => ({
  clientId,
  principalId,
  subscriptionId,
  resourceGroup,
  assignments: [
    assignment("55555555-5555-4555-8555-555555555555", "b24988ac-6180-42a0-ab88-20f7382dd24c"),
    assignment(
      "66666666-6666-4666-8666-666666666666",
      "f58310d9-a9f6-439a-9e8d-f62e7b41a168",
      EXPECTED_RBAC_CONDITION,
    ),
  ],
});

const validate = (document) => validateMigrationPrincipal(document, { expectedClientSha256 });

describe("Azure migration principal runtime boundary", () => {
  it("accepts only the pinned client and exact two-role boundary", () => {
    const receipt = validate(safeDocument());
    expect(receipt).toMatchObject({
      status: "EXACT_MIGRATION_PRINCIPAL",
      effectiveRoleAssignmentCount: 2,
    });
    expect(receipt.clientRef).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(receipt.principalRef).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(receipt.scopeRef).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(receipt)).not.toContain(clientId);
    expect(JSON.stringify(receipt)).not.toContain(principalId);
  });

  it("requires both write and delete restrictions in the RBAC condition", () => {
    expect(EXPECTED_RBAC_CONDITION).toContain("roleAssignments/write");
    expect(EXPECTED_RBAC_CONDITION).toContain("roleAssignments/delete");

    const missingDelete = safeDocument();
    missingDelete.assignments[1].condition = EXPECTED_RBAC_CONDITION.split(" AND ((!(ActionMatches")[0];
    expect(() => validate(missingDelete)).toThrow("RBAC_CONDITION_MISMATCH");
  });

  it("normalizes Azure casing and insignificant condition whitespace only", () => {
    const document = safeDocument();
    document.clientId = clientId.toUpperCase();
    document.principalId = principalId.toUpperCase();
    document.assignments = document.assignments.map((value) => ({
      ...value,
      id: value.id.toUpperCase(),
      scope: value.scope.toUpperCase(),
      principalId: value.principalId.toUpperCase(),
      roleDefinitionId: value.roleDefinitionId.toUpperCase(),
      condition: value.condition?.replaceAll("(", " ( ").toUpperCase() ?? null,
    }));
    expect(() => validate(document)).not.toThrow();
    expect(canonicalizeCondition("'Service Principal'")).not.toBe(canonicalizeCondition("'ServicePrincipal'"));
  });

  it("rejects another client, principal, role, or inherited assignment", () => {
    expect(() => validate({ ...safeDocument(), clientId: "77777777-7777-4777-8777-777777777777" }))
      .toThrow("UNEXPECTED_AZURE_CLIENT");

    const wrongPrincipal = safeDocument();
    wrongPrincipal.assignments[0].principalId = "77777777-7777-4777-8777-777777777777";
    expect(() => validate(wrongPrincipal)).toThrow("ROLE_PRINCIPAL_MISMATCH");

    const wrongRole = safeDocument();
    wrongRole.assignments[0].roleDefinitionId = `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/77777777-7777-4777-8777-777777777777`;
    expect(() => validate(wrongRole)).toThrow("UNEXPECTED_ROLE_DEFINITION");

    const inherited = safeDocument();
    inherited.assignments[0].scope = `/subscriptions/${subscriptionId}`;
    expect(() => validate(inherited)).toThrow("INHERITED_OR_FOREIGN_ROLE_ASSIGNMENT");
  });

  it("rejects missing, duplicate, or additional effective assignments", () => {
    const missing = safeDocument();
    missing.assignments.pop();
    expect(() => validate(missing)).toThrow("UNEXPECTED_EFFECTIVE_ROLE_ASSIGNMENT_COUNT");

    const additional = safeDocument();
    additional.assignments.push({ ...additional.assignments[0], id: additional.assignments[1].id });
    expect(() => validate(additional)).toThrow("UNEXPECTED_EFFECTIVE_ROLE_ASSIGNMENT_COUNT");

    const duplicate = safeDocument();
    duplicate.assignments[1] = { ...duplicate.assignments[0], id: duplicate.assignments[1].id };
    expect(() => validate(duplicate)).toThrow("UNEXPECTED_ROLE_DEFINITION");
  });
});
