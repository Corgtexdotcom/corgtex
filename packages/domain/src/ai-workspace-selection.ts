import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import {
  AI_WORKSPACE_PROVIDER_REGISTRY,
  aiWorkspaceProviderFromDb,
  aiWorkspaceProviderToDb,
  aiWorkspaceToolProviderKey,
  isVisibleAiWorkspaceToolProvider,
  listAiWorkspaceToolProviders,
  type AiWorkspaceProviderKey,
} from "./ai-workspaces";
import { getClaudeMcpConnectionStatus } from "./mcp-connector";

export type AiWorkspaceConnectionState = {
  providerKey: AiWorkspaceProviderKey;
  healthStatus: string;
  isDefault: boolean;
  connectedAt: Date | null;
  lastCheckedAt: Date | null;
  verificationSource: string | null;
};

export type AiWorkspaceSelectionState = {
  activeProviderKey: AiWorkspaceProviderKey | null;
  providers: ReturnType<typeof listAiWorkspaceToolProviders>;
  connections: AiWorkspaceConnectionState[];
};

export type AiWorkspaceVerificationResult = {
  providerKey: AiWorkspaceProviderKey;
  verified: boolean;
  connectedAt: Date | null;
  message: string;
  state: AiWorkspaceSelectionState;
};

function requireUserActor(actor: AppActor) {
  if (actor.kind !== "user") {
    throw new AppError(403, "FORBIDDEN", "AI workspace selection requires a user account.");
  }
  return actor.user.id;
}

function activeProviderKeyFromDb(value: string | null | undefined): AiWorkspaceProviderKey | null {
  if (!value) return null;
  const key = aiWorkspaceProviderFromDb(value);
  if (!key) return null;
  return aiWorkspaceToolProviderKey(key);
}

function assertVisibleProvider(providerKey: string): AiWorkspaceProviderKey {
  if (!isVisibleAiWorkspaceToolProvider(providerKey)) {
    throw new AppError(400, "INVALID_INPUT", "Unsupported AI workspace provider.");
  }
  return providerKey;
}

function verificationSourceFromSetupState(setupState: unknown): string | null {
  if (!setupState || typeof setupState !== "object" || Array.isArray(setupState)) return null;
  const value = (setupState as { verificationSource?: unknown }).verificationSource;
  return typeof value === "string" && value.trim() ? value : null;
}

function mergeVerificationSetupState(setupState: unknown, source: string, verifiedAt: Date) {
  const base = setupState && typeof setupState === "object" && !Array.isArray(setupState)
    ? setupState as Record<string, unknown>
    : {};

  return {
    ...base,
    verificationSource: source,
    verifiedAt: verifiedAt.toISOString(),
  };
}

type AiWorkspaceConnectionRow = {
  provider: string;
  healthStatus: string;
  isDefault: boolean;
  lastHealthCheckAt: Date | null;
  lastSuccessfulHealthCheckAt: Date | null;
  setupState: unknown;
  updatedAt: Date;
};

function connectionPriority(row: AiWorkspaceConnectionRow) {
  return (row.isDefault ? 100 : 0)
    + (row.healthStatus === "CONNECTED" ? 20 : 0)
    + (row.healthStatus === "NEEDS_SETUP" ? 10 : 0);
}

function mapConnectionRows(rows: AiWorkspaceConnectionRow[]): AiWorkspaceConnectionState[] {
  const byProvider = new Map<AiWorkspaceProviderKey, AiWorkspaceConnectionRow>();

  for (const row of rows) {
    const providerKey = activeProviderKeyFromDb(row.provider);
    if (!providerKey || !isVisibleAiWorkspaceToolProvider(providerKey)) continue;

    const existing = byProvider.get(providerKey);
    if (!existing || connectionPriority(row) > connectionPriority(existing)) {
      byProvider.set(providerKey, row);
    }
  }

  return [...byProvider.entries()]
    .map(([providerKey, row]) => ({
      providerKey,
      healthStatus: row.healthStatus,
      isDefault: row.isDefault,
      connectedAt: row.lastSuccessfulHealthCheckAt,
      lastCheckedAt: row.lastHealthCheckAt,
      verificationSource: verificationSourceFromSetupState(row.setupState),
    }))
    .sort((a, b) =>
      Number(b.isDefault) - Number(a.isDefault)
      || Number(b.healthStatus === "CONNECTED") - Number(a.healthStatus === "CONNECTED")
      || a.providerKey.localeCompare(b.providerKey)
    );
}

function activeProviderKeyFromConnections(connections: AiWorkspaceConnectionState[]) {
  return connections.find((connection) => connection.isDefault)?.providerKey
    ?? connections.find((connection) => connection.healthStatus === "CONNECTED")?.providerKey
    ?? connections.find((connection) => connection.healthStatus === "NEEDS_SETUP")?.providerKey
    ?? null;
}

export async function getAiWorkspaceSelectionState(
  actor: AppActor,
  workspaceId: string,
): Promise<AiWorkspaceSelectionState> {
  await requireWorkspaceMembership({ actor, workspaceId });
  const providers = listAiWorkspaceToolProviders();
  if (actor.kind !== "user") {
    return { activeProviderKey: null, providers, connections: [] };
  }

  const rows = await prisma.aiWorkspaceConnection.findMany({
    where: {
      workspaceId,
      ownerUserId: actor.user.id,
    },
    select: {
      provider: true,
      healthStatus: true,
      isDefault: true,
      lastHealthCheckAt: true,
      lastSuccessfulHealthCheckAt: true,
      setupState: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  const connections = mapConnectionRows(rows);

  return {
    activeProviderKey: activeProviderKeyFromConnections(connections),
    providers,
    connections,
  };
}

export async function setActiveAiWorkspaceProvider(
  actor: AppActor,
  params: {
    workspaceId: string;
    providerKey: string;
  },
): Promise<AiWorkspaceSelectionState> {
  return makeDefaultAiWorkspaceProvider(actor, params);
}

export async function startAiWorkspaceProviderSetup(
  actor: AppActor,
  params: {
    workspaceId: string;
    providerKey: string;
  },
): Promise<AiWorkspaceSelectionState> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const userId = requireUserActor(actor);
  const providerKey = assertVisibleProvider(params.providerKey);
  const definition = AI_WORKSPACE_PROVIDER_REGISTRY[providerKey];
  const dbProvider = aiWorkspaceProviderToDb(providerKey);

  const existing = await prisma.aiWorkspaceConnection.findFirst({
    where: {
      workspaceId: params.workspaceId,
      ownerUserId: userId,
      provider: dbProvider,
    },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) {
    await prisma.aiWorkspaceConnection.update({
      where: { id: existing.id },
      data: {
        displayName: definition.label,
        healthStatus: existing.healthStatus === "CONNECTED" ? "CONNECTED" : "NEEDS_SETUP",
      },
    });
  } else {
    await prisma.aiWorkspaceConnection.create({
      data: {
        workspaceId: params.workspaceId,
        createdByUserId: userId,
        ownerUserId: userId,
        provider: dbProvider,
        ownershipMode: "USER_MANAGED",
        displayName: definition.label,
        healthStatus: "NEEDS_SETUP",
        isDefault: false,
      },
    });
  }

  return getAiWorkspaceSelectionState(actor, params.workspaceId);
}

export async function makeDefaultAiWorkspaceProvider(
  actor: AppActor,
  params: {
    workspaceId: string;
    providerKey: string;
  },
): Promise<AiWorkspaceSelectionState> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const userId = requireUserActor(actor);
  const providerKey = assertVisibleProvider(params.providerKey);
  const definition = AI_WORKSPACE_PROVIDER_REGISTRY[providerKey];
  const dbProvider = aiWorkspaceProviderToDb(providerKey);

  await prisma.$transaction(async (tx) => {
    await tx.aiWorkspaceConnection.updateMany({
      where: {
        workspaceId: params.workspaceId,
        ownerUserId: userId,
      },
      data: { isDefault: false },
    });

    const existing = await tx.aiWorkspaceConnection.findFirst({
      where: {
        workspaceId: params.workspaceId,
        ownerUserId: userId,
        provider: dbProvider,
      },
      orderBy: { updatedAt: "desc" },
    });

    if (existing) {
      await tx.aiWorkspaceConnection.update({
        where: { id: existing.id },
        data: {
          displayName: definition.label,
          isDefault: true,
        },
      });
      return;
    }

    await tx.aiWorkspaceConnection.create({
      data: {
        workspaceId: params.workspaceId,
        createdByUserId: userId,
        ownerUserId: userId,
        provider: dbProvider,
        ownershipMode: "USER_MANAGED",
        displayName: definition.label,
        healthStatus: "NEEDS_SETUP",
        isDefault: true,
      },
    });
  });

  return getAiWorkspaceSelectionState(actor, params.workspaceId);
}

export async function markAiWorkspaceProviderConnected(
  actor: AppActor,
  params: {
    workspaceId: string;
    providerKey: string;
    source: string;
    connectedAt?: Date | null;
  },
): Promise<AiWorkspaceSelectionState> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const userId = requireUserActor(actor);
  const providerKey = assertVisibleProvider(params.providerKey);
  const definition = AI_WORKSPACE_PROVIDER_REGISTRY[providerKey];
  const dbProvider = aiWorkspaceProviderToDb(providerKey);
  const now = new Date();
  const connectedAt = params.connectedAt ?? now;

  await prisma.$transaction(async (tx) => {
    await tx.aiWorkspaceConnection.updateMany({
      where: {
        workspaceId: params.workspaceId,
        ownerUserId: userId,
      },
      data: { isDefault: false },
    });

    const existing = await tx.aiWorkspaceConnection.findFirst({
      where: {
        workspaceId: params.workspaceId,
        ownerUserId: userId,
        provider: dbProvider,
      },
      orderBy: { updatedAt: "desc" },
    });

    if (existing) {
      await tx.aiWorkspaceConnection.update({
        where: { id: existing.id },
        data: {
          displayName: definition.label,
          healthStatus: "CONNECTED",
          isDefault: true,
          lastHealthCheckAt: now,
          lastSuccessfulHealthCheckAt: connectedAt,
          lastError: null,
          setupState: mergeVerificationSetupState(existing.setupState, params.source, connectedAt),
        },
      });
      return;
    }

    await tx.aiWorkspaceConnection.create({
      data: {
        workspaceId: params.workspaceId,
        createdByUserId: userId,
        ownerUserId: userId,
        provider: dbProvider,
        ownershipMode: "USER_MANAGED",
        displayName: definition.label,
        healthStatus: "CONNECTED",
        lastHealthCheckAt: now,
        lastSuccessfulHealthCheckAt: connectedAt,
        lastError: null,
        isDefault: true,
        setupState: mergeVerificationSetupState(null, params.source, connectedAt),
      },
    });
  });

  return getAiWorkspaceSelectionState(actor, params.workspaceId);
}

export async function verifyAiWorkspaceProviderConnection(
  actor: AppActor,
  params: {
    workspaceId: string;
    providerKey: string;
  },
): Promise<AiWorkspaceVerificationResult> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const userId = requireUserActor(actor);
  const providerKey = assertVisibleProvider(params.providerKey);

  if (providerKey === "claude") {
    const claude = await getClaudeMcpConnectionStatus({
      userId,
      workspaceId: params.workspaceId,
    });

    if (claude.connected) {
      const state = await markAiWorkspaceProviderConnected(actor, {
        workspaceId: params.workspaceId,
        providerKey,
        source: "claude_oauth",
        connectedAt: claude.connectedAt,
      });

      return {
        providerKey,
        verified: true,
        connectedAt: claude.connectedAt,
        message: "Claude is connected.",
        state,
      };
    }
  }

  await startAiWorkspaceProviderSetup(actor, {
    workspaceId: params.workspaceId,
    providerKey,
  });
  const dbProvider = aiWorkspaceProviderToDb(providerKey);
  const existing = await prisma.aiWorkspaceConnection.findFirst({
    where: {
      workspaceId: params.workspaceId,
      ownerUserId: userId,
      provider: dbProvider,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) {
    await prisma.aiWorkspaceConnection.update({
      where: { id: existing.id },
      data: {
        lastHealthCheckAt: new Date(),
        lastError: providerKey === "claude"
          ? "No completed Claude MCP sign-in was visible to Corgtex yet."
          : "Automatic verification is not available for this provider yet.",
      },
    });
  }

  const state = await getAiWorkspaceSelectionState(actor, params.workspaceId);
  return {
    providerKey,
    verified: false,
    connectedAt: null,
    message: providerKey === "claude"
      ? "Corgtex has not seen Claude finish sign-in yet. Try one prompt in Claude, then verify again or mark it connected."
      : "Corgtex cannot automatically verify this app yet. Mark it connected after sign-in is complete.",
    state,
  };
}
