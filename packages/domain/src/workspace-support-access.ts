import { Prisma } from "@prisma/client";
import { env, getSupportAuthorizationContext, prisma, runWithSupportOrigin } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { requireDeploymentWorkspaceScope } from "./auth";
import { z } from "zod";
import { closeRoleLifecycleForMember } from "./role-onboarding";

type Db = Prisma.TransactionClient;
export async function lockWorkspaceMembership(db: Db, workspaceId: string) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`);
}

export async function canManageWorkspaceSupport(actor: AppActor, workspaceId: string) {
  await requireDeploymentWorkspaceScope(workspaceId);
  if (actor.kind !== "user") return false;
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { supportOwnerUserId: true } });
  if (workspace?.supportOwnerUserId !== actor.user.id) return false;
  const member = await prisma.member.findUnique({ where: { workspaceId_userId: { workspaceId, userId: actor.user.id } }, select: { isActive: true, role: true, kind: true } });
  return Boolean(member?.isActive && member.role === "ADMIN" && member.kind === "HUMAN");
}
export type SupportRole = "SETUP" | "FULL";
export async function hasActiveWorkspaceSupport(actor: AppActor) {
  if (actor.kind !== "user") return false;
  return Boolean(await prisma.workspaceSupportGrant.findFirst({
    where: { userId: actor.user.id, isActive: true,
      ...(env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG ? { workspace: { slug: env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG } } : {}) },
    select: { id: true },
  }));
}
export const SUPPORT_CHECKLIST_KEYS = ["configurationPrepared", "consentRequested", "handoffReady"] as const;
export const supportConnectorPreparationSchema = z.array(z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("google"), intent: z.enum(["calendar", "documents"]), calendarImport: z.boolean() }).strict(),
  z.object({ provider: z.literal("microsoft"), intent: z.literal("calendar"), calendarImport: z.boolean() }).strict(),
  z.object({ provider: z.literal("slack"), intent: z.literal("selected_channels"), calendarImport: z.literal(false) }).strict(),
])).max(3).refine((items) => new Set(items.map((item) => item.provider)).size === items.length, "Duplicate provider.")
  .refine((items) => items.every((item) => item.intent === "calendar" || !item.calendarImport), "Calendar import requires calendar consent.");
export type SupportConnectorPreparation = z.infer<typeof supportConnectorPreparationSchema>[number];

function safePreparations(value: unknown) {
  const parsed = supportConnectorPreparationSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

export async function supportCapabilityVersion(userId: string | null | undefined, workspaceId: string, expectedVersion?: number | null) {
  if (expectedVersion === undefined) {
    const origin = getSupportAuthorizationContext()?.origin;
    invariant(!origin || (origin.userId === userId && origin.workspaceId === workspaceId),
      403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
    // Issuance uses the grant already authorized by this request, never a newer grant.
    // Explicit versions remain the contract for agents and persisted session redemption.
    expectedVersion = origin?.version ?? null;
  }
  if (!userId) {
    invariant(expectedVersion == null, 403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
    return null;
  }
  const grant = await prisma.workspaceSupportGrant.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { isActive: true, role: true, version: true },
  });
  if (!grant) {
    invariant(expectedVersion == null, 403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
    return null;
  }
  invariant(grant.isActive && grant.role === "FULL" && expectedVersion === grant.version,
    403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
  return grant.version;
}

export async function requireSupportOwner(db: Db, actor: AppActor, workspaceId: string) {
  await requireDeploymentWorkspaceScope(workspaceId, db);
  invariant(actor.kind === "user", 403, "FORBIDDEN", "A workspace owner is required.");
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { supportOwnerUserId: true },
  });
  invariant(workspace?.supportOwnerUserId === actor.user.id, 403, "SUPPORT_OWNER_REQUIRED", "A verified workspace owner is required.");
  const member = await db.member.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.user.id } },
    select: { role: true, isActive: true, kind: true },
  });
  invariant(member?.isActive && member.role === "ADMIN" && member.kind === "HUMAN", 403, "SUPPORT_OWNER_REQUIRED", "An active workspace owner is required.");
  return actor.user.id;
}

export async function getWorkspaceSupportGrant(actor: AppActor, workspaceId: string) {
  await requireDeploymentWorkspaceScope(workspaceId);
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Named account access is required.");
  return prisma.workspaceSupportGrant.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.user.id } },
  });
}

export async function withWorkspaceSupportExecution<T>(record: {
  workspaceId: string | null;
  supportOriginUserId?: string | null;
  supportGrantVersion?: number | null;
}, run: () => Promise<T>): Promise<T> {
  if (!record.supportOriginUserId) return runWithSupportOrigin(undefined, run);
  invariant(record.workspaceId && record.supportGrantVersion, 403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
  const grant = await prisma.workspaceSupportGrant.findUnique({
    where: { workspaceId_userId: { workspaceId: record.workspaceId, userId: record.supportOriginUserId } },
    select: { isActive: true, role: true, version: true },
  });
  invariant(grant?.isActive && grant.role === "FULL" && grant.version === record.supportGrantVersion, 403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
  return runWithSupportOrigin({ userId: record.supportOriginUserId, workspaceId: record.workspaceId, version: record.supportGrantVersion }, run);
}

export async function listWorkspaceSupportGrants(actor: AppActor, workspaceId: string) {
  await requireSupportOwner(prisma, actor, workspaceId);
  return prisma.workspaceSupportGrant.findMany({
    where: { workspaceId },
    select: {
      id: true, userId: true, role: true, isActive: true, version: true, updatedAt: true,
      setupConnectors: true, setupRevision: true,
      user: { select: { email: true, displayName: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function changeWorkspaceSupportGrant(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  role: SupportRole;
  isActive: boolean;
  expectedVersion: number;
}) {
  invariant(params.role === "SETUP" || params.role === "FULL", 400, "INVALID_INPUT", "Invalid support role.");
  invariant(Number.isSafeInteger(params.expectedVersion) && params.expectedVersion >= 0, 400, "INVALID_INPUT", "A grant version is required.");
  const email = params.email.trim().toLowerCase();
  invariant(email.length > 0, 400, "INVALID_INPUT", "A named account is required.");
  return prisma.$transaction(async (tx) => {
    // Serialize grant changes with ownership and membership changes.
    await lockWorkspaceMembership(tx, params.workspaceId);
    const ownerId = await requireSupportOwner(tx, actor, params.workspaceId);
    const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
    invariant(user && user.id !== ownerId, 400, "INVALID_SUPPORT_ACCOUNT", "Choose another existing named account.");
    const where = { workspaceId_userId: { workspaceId: params.workspaceId, userId: user.id } };
    const current = await tx.workspaceSupportGrant.findUnique({ where });
    invariant((current?.version ?? 0) === params.expectedVersion, 409, "VERSION_CONFLICT", "Support access changed. Refresh and try again.");
    const member = await tx.member.findUnique({ where });
    invariant(current || !member?.isActive, 409, "EXISTING_MEMBERSHIP", "Remove existing workspace membership before granting support access.");
    invariant(current || params.isActive, 400, "INVALID_INPUT", "There is no support grant to revoke.");

    const grant = await tx.workspaceSupportGrant.upsert({
      where,
      create: {
        workspaceId: params.workspaceId, userId: user.id, role: params.role,
        isActive: params.isActive, grantedByUserId: ownerId,
      },
      update: {
        role: params.role, isActive: params.isActive, version: { increment: 1 },
        grantedByUserId: ownerId, revokedAt: params.isActive ? null : new Date(),
      },
    });
    if (params.isActive && params.role === "FULL") {
      await tx.member.upsert({
        where,
        create: { workspaceId: params.workspaceId, userId: user.id, role: "ADMIN", kind: "HUMAN", isActive: true },
        update: { role: "ADMIN", kind: "HUMAN", isActive: true },
      });
    } else if (member) {
      await tx.member.update({ where: { id: member.id }, data: { isActive: false } });
      await closeRoleLifecycleForMember(tx, { workspaceId: params.workspaceId, memberId: member.id, actor });
    }
    // Previously issued capabilities must never revive on a later regrant.
    await tx.agentCredential.updateMany({
      where: { workspaceId: params.workspaceId, createdByUserId: user.id },
      data: { isActive: false },
    });
    await tx.appSession.updateMany({
      where: { workspaceId: params.workspaceId, actorUserId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.mcpOAuthAccessToken.updateMany({
      where: { workspaceId: params.workspaceId, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.mcpOAuthAuthorizationCode.deleteMany({ where: { workspaceId: params.workspaceId, userId: user.id } });
    await tx.oAuthAuthorizationCode.deleteMany({ where: { workspaceId: params.workspaceId, userId: user.id } });
    await tx.oAuthAccessToken.updateMany({
      where: { workspaceId: params.workspaceId, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId, actorUserId: ownerId,
        action: params.isActive ? "support.access.granted" : "support.access.revoked",
        entityType: "WorkspaceSupportGrant", entityId: grant.id,
        meta: { recipientUserId: user.id, role: grant.role, version: grant.version, previousRole: current?.role ?? null },
      },
    });
    return { id: grant.id, userId: grant.userId, role: grant.role, isActive: grant.isActive, version: grant.version };
  });
}

export async function requireUnmanagedMember(db: Db, workspaceId: string, userId: string) {
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { supportOwnerUserId: true } });
  invariant(!workspace?.supportOwnerUserId || workspace.supportOwnerUserId !== userId, 403, "SUPPORT_OWNER_PROTECTED", "Use the owner's account settings to manage this identity.");
  const support = await db.workspaceSupportGrant.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { id: true } });
  if (support) throw new AppError(403, "SUPPORT_OWNER_REQUIRED", "Support access is managed by the workspace owner.");
}

export async function getSupportSetup(actor: AppActor, workspaceId: string) {
  const grant = await getWorkspaceSupportGrant(actor, workspaceId);
  invariant(grant?.isActive, 403, "SUPPORT_ACCESS_REQUIRED", "Support access is unavailable.");
  const [workspace, connections, oauthConnections] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } }),
    prisma.communicationInstallation.findMany({
      where: { workspaceId },
      select: { provider: true, status: true },
      orderBy: { provider: "asc" },
    }),
    prisma.oAuthConnection.findMany({ where: { workspaceId }, select: { provider: true, status: true }, distinct: ["provider", "status"] }),
  ]);
  const checklist = Object.fromEntries(SUPPORT_CHECKLIST_KEYS.map((key) => [
    key, Boolean(grant.setupChecklist && typeof grant.setupChecklist === "object" && !Array.isArray(grant.setupChecklist) && grant.setupChecklist[key] === true),
  ]));
  // This DTO is an allowlist. Never include provider labels, IDs, errors, counts or payloads.
  return { workspace, role: grant.role, version: grant.version, checklist,
    connectors: safePreparations(grant.setupConnectors), setupRevision: grant.setupRevision,
    connections: [...new Map([...connections, ...oauthConnections].map((connection) => [`${connection.provider}:${connection.status}`, { provider: connection.provider, status: connection.status }])).values()] };
}

export async function updateSupportSetup(actor: AppActor, params: {
  workspaceId: string;
  expectedVersion: number;
  checklist: Record<string, boolean>;
  connectors?: SupportConnectorPreparation[];
  expectedSetupRevision?: number;
}) {
  await requireDeploymentWorkspaceScope(params.workspaceId);
  const connectors = params.connectors === undefined ? undefined : supportConnectorPreparationSchema.parse(params.connectors);
  invariant(connectors === undefined || Number.isInteger(params.expectedSetupRevision), 400, "INVALID_INPUT", "Preparation revision is required.");
  invariant(Object.keys(params.checklist).every((key) => (SUPPORT_CHECKLIST_KEYS as readonly string[]).includes(key)), 400, "INVALID_INPUT", "Unknown setup setting.");
  invariant(Object.values(params.checklist).every((value) => typeof value === "boolean"), 400, "INVALID_INPUT", "Invalid setup setting.");
  return prisma.$transaction(async (tx) => {
    invariant(actor.kind === "user", 403, "FORBIDDEN", "Named account access is required.");
    const current = await tx.workspaceSupportGrant.findUnique({
      where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: actor.user.id } },
    });
    invariant(current?.isActive, 403, "SUPPORT_ACCESS_REQUIRED", "Support access is unavailable.");
    const changed = await tx.workspaceSupportGrant.updateMany({
      where: { id: current.id, isActive: true, version: params.expectedVersion, ...(connectors === undefined ? {} : { setupRevision: params.expectedSetupRevision }) },
      data: { setupChecklist: params.checklist, ...(connectors === undefined ? {} : { setupConnectors: connectors, setupRevision: { increment: 1 } }) },
    });
    invariant(changed.count === 1, 409, "VERSION_CONFLICT", "Support access changed. Refresh and try again.");
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId, actorUserId: actor.user.id, action: "support.setup.updated",
        entityType: "WorkspaceSupportGrant", entityId: current.id, meta: { fields: [...Object.keys(params.checklist), ...(connectors === undefined ? [] : ["connectorPreparation"])] },
      },
    });
    return { version: params.expectedVersion, setupRevision: current.setupRevision + (connectors === undefined ? 0 : 1) };
  });
}
