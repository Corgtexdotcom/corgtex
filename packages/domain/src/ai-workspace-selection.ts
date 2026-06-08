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

export type AiWorkspaceSelectionState = {
  activeProviderKey: AiWorkspaceProviderKey | null;
  providers: ReturnType<typeof listAiWorkspaceToolProviders>;
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

export async function getAiWorkspaceSelectionState(
  actor: AppActor,
  workspaceId: string,
): Promise<AiWorkspaceSelectionState> {
  await requireWorkspaceMembership({ actor, workspaceId });
  const providers = listAiWorkspaceToolProviders();
  if (actor.kind !== "user") {
    return { activeProviderKey: null, providers };
  }

  const row = await prisma.aiWorkspaceConnection.findFirst({
    where: {
      workspaceId,
      ownerUserId: actor.user.id,
      isDefault: true,
    },
    select: { provider: true },
    orderBy: { updatedAt: "desc" },
  });

  return {
    activeProviderKey: activeProviderKeyFromDb(row?.provider),
    providers,
  };
}

export async function setActiveAiWorkspaceProvider(
  actor: AppActor,
  params: {
    workspaceId: string;
    providerKey: string;
  },
): Promise<AiWorkspaceSelectionState> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const userId = requireUserActor(actor);
  if (!isVisibleAiWorkspaceToolProvider(params.providerKey)) {
    throw new AppError(400, "INVALID_INPUT", "Unsupported AI workspace provider.");
  }

  const providerKey = params.providerKey;
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
          healthStatus: "NEEDS_SETUP",
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
