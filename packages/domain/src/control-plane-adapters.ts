export type ControlPlaneAdapterKind =
  | "managed_workspace"
  | "remote_mcp"
  | "federated_control_plane"
  | "azure_read_model"
  | "unconfigured";

export type ControlPlaneAdapterInput = {
  id: string;
  cloudProvider?: string | null;
  deploymentKind?: string | null;
  managedWorkspaceId?: string | null;
  supportMcpUrl?: string | null;
  supportConnectorStatus?: string | null;
  supportCredentialEnc?: string | null;
  hasSupportCredential?: boolean | null;
};

export type ControlPlaneAdapter = {
  kind: ControlPlaneAdapterKind;
  deploymentId: string;
  canReadCentralWorkspace: boolean;
  canUseSupportConnector: boolean;
  canFederateControlPlane: boolean;
  canReadProviderStatus: boolean;
  requiresConnectorSetup: boolean;
};

export class ManagedWorkspaceAdapter implements ControlPlaneAdapter {
  readonly kind = "managed_workspace";
  readonly canReadCentralWorkspace = true;
  readonly canUseSupportConnector = false;
  readonly canFederateControlPlane = false;
  readonly canReadProviderStatus = false;
  readonly requiresConnectorSetup = false;

  constructor(readonly deploymentId: string) {}
}

export class RemoteMcpAdapter implements ControlPlaneAdapter {
  readonly kind = "remote_mcp";
  readonly canReadCentralWorkspace = false;
  readonly canUseSupportConnector = true;
  readonly canFederateControlPlane = false;
  readonly canReadProviderStatus = false;

  constructor(
    readonly deploymentId: string,
    readonly requiresConnectorSetup: boolean,
  ) {}
}

export class FederatedControlPlaneAdapter implements ControlPlaneAdapter {
  readonly kind = "federated_control_plane";
  readonly canReadCentralWorkspace = false;
  readonly canUseSupportConnector = true;
  readonly canFederateControlPlane = true;
  readonly canReadProviderStatus = false;

  constructor(
    readonly deploymentId: string,
    readonly requiresConnectorSetup: boolean,
  ) {}
}

export class AzureReadModelAdapter implements ControlPlaneAdapter {
  readonly kind = "azure_read_model";
  readonly canUseSupportConnector: boolean;
  readonly canFederateControlPlane = false;
  readonly canReadProviderStatus = true;

  constructor(
    readonly deploymentId: string,
    readonly requiresConnectorSetup: boolean,
    readonly canReadCentralWorkspace: boolean,
  ) {
    this.canUseSupportConnector = !requiresConnectorSetup;
  }
}

export class UnconfiguredControlPlaneAdapter implements ControlPlaneAdapter {
  readonly kind = "unconfigured";
  readonly canReadCentralWorkspace = false;
  readonly canUseSupportConnector = false;
  readonly canFederateControlPlane = false;
  readonly canReadProviderStatus = false;
  readonly requiresConnectorSetup = true;

  constructor(readonly deploymentId: string) {}
}

function hasConnectorSignal(input: ControlPlaneAdapterInput) {
  return Boolean(
    input.supportCredentialEnc
      || input.hasSupportCredential
      || input.supportMcpUrl?.trim()
      || (input.supportConnectorStatus && input.supportConnectorStatus !== "not_configured"),
  );
}

export function createControlPlaneAdapter(input: ControlPlaneAdapterInput): ControlPlaneAdapter {
  const requiresConnectorSetup = !hasConnectorSignal(input);
  if (input.cloudProvider === "AZURE") {
    return new AzureReadModelAdapter(input.id, requiresConnectorSetup, Boolean(input.managedWorkspaceId));
  }

  if (input.managedWorkspaceId) {
    return new ManagedWorkspaceAdapter(input.id);
  }

  if (input.deploymentKind === "CUSTOMER_CONTROL_PLANE") {
    return new FederatedControlPlaneAdapter(input.id, requiresConnectorSetup);
  }

  if (hasConnectorSignal(input)) {
    return new RemoteMcpAdapter(input.id, requiresConnectorSetup);
  }

  return new UnconfiguredControlPlaneAdapter(input.id);
}
