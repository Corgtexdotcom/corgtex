import { describe, expect, it } from "vitest";
import { createControlPlaneAdapter } from "./control-plane-adapters";

describe("control plane adapters", () => {
  it("uses the Azure read model adapter for Azure deployments without requiring Azure mutation support", () => {
    const adapter = createControlPlaneAdapter({
      id: "dep-azure",
      cloudProvider: "AZURE",
    });

    expect(adapter).toMatchObject({
      kind: "azure_read_model",
      deploymentId: "dep-azure",
      canReadProviderStatus: true,
      canReadCentralWorkspace: false,
      canFederateControlPlane: false,
      canUseSupportConnector: false,
      requiresConnectorSetup: true,
    });
  });

  it("preserves support connector access when Azure deployments have connector signals", () => {
    const adapter = createControlPlaneAdapter({
      id: "dep-azure",
      cloudProvider: "AZURE",
      supportMcpUrl: "https://selfserve.example/api/mcp",
      supportCredentialEnc: "encrypted-token",
    });

    expect(adapter).toMatchObject({
      kind: "azure_read_model",
      canReadProviderStatus: true,
      canUseSupportConnector: true,
      requiresConnectorSetup: false,
    });
  });
});
