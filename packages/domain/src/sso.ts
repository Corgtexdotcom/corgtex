import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import { randomBytes } from "node:crypto";

export async function getSsoConfigByWorkspace(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
  return prisma.workspaceSsoConfig.findMany({
    where: { workspaceId }
  });
}

export async function upsertSsoConfig(actor: AppActor, params: {
  workspaceId: string;
  provider: string;
  clientId: string;
  clientSecretEnc: string;
  allowedDomains: string[];
  isEnabled: boolean;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  if (params.provider !== "GOOGLE" && params.provider !== "MICROSOFT") {
    throw new AppError(400, "INVALID_PROVIDER", "Invalid SSO Provider");
  }

  const clientId = params.clientId.trim();
  const clientSecret = params.clientSecretEnc.trim();
  const allowedDomains = params.allowedDomains
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

  invariant(clientId.length > 0, 400, "INVALID_INPUT", "Client ID is required.");
  invariant(allowedDomains.length > 0, 400, "INVALID_INPUT", "At least one allowed domain is required.");

  const existing = await prisma.workspaceSsoConfig.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: params.workspaceId,
        provider: params.provider,
      },
    },
  });
  invariant(existing || clientSecret.length > 0, 400, "INVALID_INPUT", "Client secret is required.");

  return prisma.workspaceSsoConfig.upsert({
    where: {
      workspaceId_provider: {
        workspaceId: params.workspaceId,
        provider: params.provider,
      }
    },
    update: {
      clientId,
      ...(clientSecret ? { clientSecretEnc: clientSecret } : {}),
      allowedDomains,
      isEnabled: params.isEnabled,
    },
    create: {
      workspaceId: params.workspaceId,
      provider: params.provider,
      clientId,
      clientSecretEnc: clientSecret,
      allowedDomains,
      isEnabled: params.isEnabled,
    }
  });
}

export async function lookupSsoConfigForDomain(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;

  const activeConfigs = await prisma.workspaceSsoConfig.findMany({
    where: { isEnabled: true },
    include: { workspace: { select: { id: true, slug: true, name: true } } }
  });

  for (const config of activeConfigs) {
    if (config.allowedDomains.some((allowedDomain) => allowedDomain.toLowerCase() === domain)) {
      return config;
    }
  }

  return null;
}

export async function linkOrProvisionSsoUser(params: {
  workspaceId: string;
  provider: string;
  providerSubjectId: string;
  email: string;
  displayName?: string | null;
}) {
  const email = params.email.trim().toLowerCase();
  const existingIdentity = await prisma.userSsoIdentity.findUnique({
    where: {
      provider_providerSubjectId: {
        provider: params.provider,
        providerSubjectId: params.providerSubjectId
      }
    },
    include: { user: true }
  });

  if (existingIdentity) {
    await prisma.member.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: params.workspaceId,
          userId: existingIdentity.userId,
        }
      },
      update: {},
      create: {
        workspaceId: params.workspaceId,
        userId: existingIdentity.userId,
        role: "CONTRIBUTOR",
        isActive: true,
      }
    });

    return existingIdentity.user;
  }

  let user = await prisma.user.findUnique({
    where: { email }
  });

  if (!user) {
    const randomHash = "sso$" + randomBytes(32).toString("hex");
    user = await prisma.user.create({
      data: {
        email,
        displayName: params.displayName || email.split("@")[0],
        passwordHash: randomHash,
      }
    });
  }

  await prisma.userSsoIdentity.upsert({
    where: {
      provider_providerSubjectId: {
        provider: params.provider,
        providerSubjectId: params.providerSubjectId
      }
    },
    update: {
      userId: user.id,
      email,
    },
    create: {
      userId: user.id,
      provider: params.provider,
      providerSubjectId: params.providerSubjectId,
      email,
    }
  });

  await prisma.member.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: params.workspaceId,
        userId: user.id,
      }
    },
    update: {},
    create: {
      workspaceId: params.workspaceId,
      userId: user.id,
      role: "CONTRIBUTOR",
      isActive: true,
    }
  });

  return user;
}
