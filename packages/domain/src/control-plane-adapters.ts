export type ControlPlaneAdapterKind =
  | "managed_workspace"
  | "remote_mcp"
  | "federated_control_plane"
  | "unconfigured";

export type ControlPlaneAdapterInput = {
  id: string;
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
  requiresConnectorSetup: boolean;
};

export class ManagedWorkspaceAdapter implements ControlPlaneAdapter {
  readonly kind = "managed_workspace";
  readonly canReadCentralWorkspace = true;
  readonly canUseSupportConnector = false;
  readonly canFederateControlPlane = false;
  readonly requiresConnectorSetup = false;

  constructor(readonly deploymentId: string) {}
}

export class RemoteMcpAdapter implements ControlPlaneAdapter {
  readonly kind = "remote_mcp";
  readonly canReadCentralWorkspace = false;
  readonly canUseSupportConnector = true;
  readonly canFederateControlPlane = false;

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

  constructor(
    readonly deploymentId: string,
    readonly requiresConnectorSetup: boolean,
  ) {}
}

export class UnconfiguredControlPlaneAdapter implements ControlPlaneAdapter {
  readonly kind = "unconfigured";
  readonly canReadCentralWorkspace = false;
  readonly canUseSupportConnector = false;
  readonly canFederateControlPlane = false;
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
  if (input.managedWorkspaceId) {
    return new ManagedWorkspaceAdapter(input.id);
  }

  const requiresConnectorSetup = !hasConnectorSignal(input);
  if (input.deploymentKind === "CUSTOMER_CONTROL_PLANE") {
    return new FederatedControlPlaneAdapter(input.id, requiresConnectorSetup);
  }

  if (hasConnectorSignal(input)) {
    return new RemoteMcpAdapter(input.id, requiresConnectorSetup);
  }

  return new UnconfiguredControlPlaneAdapter(input.id);
}
