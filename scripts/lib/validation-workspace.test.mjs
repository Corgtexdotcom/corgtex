import { describe, expect, it } from "vitest";

import {
  DEMO_WORKSPACE_SLUG,
  INTERNAL_VALIDATION_WORKSPACE_SLUG,
  classifyWorkspaceSlug,
  requireInternalValidationWorkspace,
  selectWorkspaceForValidation,
  validationWorkspaceSelectorFromEnv,
  workspaceTenant,
} from "./validation-workspace.mjs";

const workspaces = [
  { id: "ws-demo", slug: DEMO_WORKSPACE_SLUG, name: "Demo" },
  { id: "ws-validation", slug: INTERNAL_VALIDATION_WORKSPACE_SLUG, name: "Validation" },
  { id: "ws-customer", slug: "customer-a", name: "Customer A" },
];

describe("validation workspace contract", () => {
  it("defaults production validation selectors to the internal validation slug", () => {
    expect(validationWorkspaceSelectorFromEnv({})).toEqual({
      workspaceId: null,
      workspaceSlug: INTERNAL_VALIDATION_WORKSPACE_SLUG,
      explicit: false,
    });
  });

  it("uses script-specific selectors before global validation selectors", () => {
    expect(validationWorkspaceSelectorFromEnv({
      CRM_SMOKE_WORKSPACE_SLUG: "crm-target",
      PRODUCTION_VALIDATION_WORKSPACE_SLUG: "global-target",
    }, "CRM_SMOKE")).toMatchObject({
      workspaceSlug: "crm-target",
      explicit: true,
    });
  });

  it("classifies demo, internal validation, and customer workspaces", () => {
    expect(classifyWorkspaceSlug(DEMO_WORKSPACE_SLUG)).toBe("demo");
    expect(classifyWorkspaceSlug(INTERNAL_VALIDATION_WORKSPACE_SLUG)).toBe("internal-validation");
    expect(classifyWorkspaceSlug("corgtex")).toBe("internal");
    expect(classifyWorkspaceSlug("external-client")).toBe("customer");
  });

  it("selects a workspace by id or slug", () => {
    expect(selectWorkspaceForValidation(workspaces, { workspaceId: "ws-validation" })).toEqual(workspaces[1]);
    expect(selectWorkspaceForValidation(workspaces, { workspaceSlug: "customer-a" })).toEqual(workspaces[2]);
  });

  it("does not silently select the first workspace unless explicitly allowed", () => {
    expect(() => selectWorkspaceForValidation(workspaces, { workspaceSlug: "" })).toThrow(/Set production validation workspace/);
    expect(selectWorkspaceForValidation(workspaces, { workspaceSlug: "", allowFirstWorkspace: true })).toEqual(workspaces[0]);
    expect(selectWorkspaceForValidation(workspaces, {
      workspaceSlug: "missing-validation-slug",
      fallbackToFirstWorkspace: true,
    })).toEqual(workspaces[0]);
  });

  it("rejects demo and customer tenants for mutation-heavy validation by default", () => {
    expect(() => requireInternalValidationWorkspace(workspaces[0], { env: {} })).toThrow(/demo workspace/);
    expect(() => requireInternalValidationWorkspace(workspaces[2], { env: {} })).toThrow(/corgtex-validation/);
    expect(requireInternalValidationWorkspace(workspaces[1], { env: {} })).toEqual(workspaces[1]);
  });

  it("requires an explicit override before allowing customer validation writes", () => {
    expect(requireInternalValidationWorkspace(workspaces[2], {
      env: { PRODUCTION_VALIDATION_ALLOW_CUSTOMER_WRITES: "true" },
    })).toEqual(workspaces[2]);
  });

  it("normalizes tenant evidence", () => {
    expect(workspaceTenant(workspaces[1])).toEqual({
      id: "ws-validation",
      slug: INTERNAL_VALIDATION_WORKSPACE_SLUG,
      label: "Validation",
    });
  });
});
