import { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import { prisma, hashPassword, randomOpaqueToken } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { z } from "zod";
import { requireDeploymentWorkspaceScope } from "./auth";
import { invariant } from "./errors";
import { lockWorkspaceMembership, requireSupportOwner, requireUnmanagedMember } from "./workspace-support-access";
import { closeRoleLifecycleForMember } from "./role-onboarding";
import { assertTrialMemberCapacity } from "./trial-entitlements";
import { issueSetupToken, sendMemberSetupEmail } from "./members";

const role = z.enum(["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"]);
export const supportConfigurationCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), name: z.string().trim().min(1).max(160), description: z.string().max(4000).optional() }).strict(),
  z.object({ kind: z.literal("member"), memberId: z.string().min(1), role, isActive: z.boolean() }).strict(),
  z.object({ kind: z.literal("addMember"), email: z.string().email().max(254), role }).strict(),
  z.object({ kind: z.literal("invitePolicy"), policy: z.enum(["ADMINS_ONLY", "MEMBERS_CAN_INVITE", "MEMBERS_CAN_REQUEST"]) }).strict(),
  z.object({ kind: z.literal("budget"), monthlyCostCapUsd: z.number().finite().min(-1).max(1000000), alertThresholdPct: z.number().int().min(1).max(100), periodStartDay: z.number().int().min(1).max(31) }).strict(),
  z.object({ kind: z.literal("oauth"), connectionId: z.string().min(1), status: z.enum(["ACTIVE", "PAUSED"]), calendar: z.boolean(), documents: z.boolean(), email: z.boolean() }).strict(),
  z.object({ kind: z.literal("communication"), installationId: z.string().min(1), rawRetentionDays: z.number().int().min(1).max(365) }).strict(),
  z.object({ kind: z.literal("recorder"), defaultProvider: z.enum(["RECALL_AI", "MEETING_BAAS"]), fallbackProvider: z.enum(["RECALL_AI", "MEETING_BAAS"]).nullable(), monthlyMinuteCap: z.number().int().min(0).max(1000000), botName: z.string().trim().min(1).max(100).optional(), entryMessage: z.string().max(1000).optional() }).strict(),
]);
export type SupportConfigurationCommand = z.infer<typeof supportConfigurationCommand>;
type Db = Prisma.TransactionClient;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

async function authorize(db: Db, actor: AppActor, workspaceId: string, expectedVersion?: number) {
  await requireDeploymentWorkspaceScope(workspaceId, db);
  invariant(actor.kind === "user", 403, "SUPPORT_ACCESS_REQUIRED", "Named support access is required.");
  const grant = await db.workspaceSupportGrant.findUnique({ where: { workspaceId_userId: { workspaceId, userId: actor.user.id } }, select: { id: true, version: true, isActive: true, role: true } });
  invariant(grant?.isActive, 403, "SUPPORT_ACCESS_REQUIRED", "Support access is unavailable.");
  invariant(expectedVersion === undefined || expectedVersion === grant.version, 409, "VERSION_CONFLICT", "Support access changed. Refresh and try again.");
  return { userId: actor.user.id, grant };
}

// Compare concrete authority, not a numeric role hierarchy. Lateral role changes
// can add capabilities under module-specific policy. Deactivation with an unchanged
// role is safe; every role change needs an owner decision.
async function accessChange(db: Db, workspaceId: string, command: SupportConfigurationCommand) {
  if (command.kind === "addMember") {
    const user = await db.user.findUnique({ where: { email: command.email.trim().toLowerCase() }, select: { id: true, isSupportAccount: true } });
    invariant(!user?.isSupportAccount, 400, "MEMBER_UNAVAILABLE", "Named member account is unavailable.");
    if (user) {
      await requireUnmanagedMember(db, workspaceId, user.id);
      invariant(!await db.member.findUnique({ where: { workspaceId_userId: { workspaceId, userId: user.id } }, select: { id: true } }), 409, "EXISTING_MEMBERSHIP", "Use the existing membership controls.");
    }
    return { approval: true, state: { userId: user?.id ?? null } };
  }
  if (command.kind === "member") {
    const member = await db.member.findFirst({ where: { workspaceId, id: command.memberId, kind: "HUMAN" }, select: { id: true, userId: true, role: true, isActive: true } });
    invariant(member, 404, "MEMBER_UNAVAILABLE", "Member not found.");
    await requireUnmanagedMember(db, workspaceId, member.userId);
    return { approval: (!member.isActive && command.isActive) || command.role !== member.role, state: member };
  }
  if (command.kind === "invitePolicy") {
    const flag = await db.workspaceFeatureFlag.findUnique({ where: { workspaceId_flag: { workspaceId, flag: "MEMBER_INVITES" } }, select: { config: true } });
    const policy = object(flag?.config).policy;
    return { approval: command.policy === "MEMBERS_CAN_INVITE" && policy !== "MEMBERS_CAN_INVITE", state: { policy: typeof policy === "string" ? policy : "ADMINS_ONLY" } };
  }
  return { approval: false, state: {} };
}

function syncConfiguration(settings: unknown, scopes: string[], provider: string) {
  const s = object(settings);
  const lower = scopes.map(scope => scope.toLowerCase());
  const has = (...values: string[]) => values.some(v => lower.includes(v));
  const documents = object(s.documents), email = object(s.email);
  return {
    calendar: object(s.calendar).enabled !== false,
    documents: documents.enabled === true,
    email: email.enabled === true,
    canEnableCalendar: provider === "GOOGLE" ? has("https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events") : provider === "MICROSOFT" && has("calendars.read"),
    canEnableDocuments: Array.isArray(documents.selectedDriveIds) && documents.selectedDriveIds.length > 0 && (provider === "GOOGLE" ? has("https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive") : has("files.read", "sites.read.all")),
    canEnableEmail: Array.isArray(email.filters) && email.filters.length > 0 && has("https://www.googleapis.com/auth/gmail.readonly", "mail.read"),
  };
}

export async function getSupportConfiguration(actor: AppActor, workspaceId: string) {
  return prisma.$transaction(async tx => {
    const { userId, grant } = await authorize(tx, actor, workspaceId);
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, name: true, supportOwnerUserId: true } });
    const managed = await tx.workspaceSupportGrant.findMany({ where: { workspaceId }, select: { userId: true } });
    const protectedUsers = new Set([userId, workspace.supportOwnerUserId, ...managed.map(g => g.userId)]);
    const members = await tx.member.findMany({ where: { workspaceId, kind: "HUMAN" }, select: { id: true, userId: true, role: true, isActive: true, user: { select: { email: true } } }, orderBy: { id: "asc" } });
    const budget = await tx.modelUsageBudget.findUnique({ where: { workspaceId }, select: { monthlyCostCapUsd: true, alertThresholdPct: true, periodStartDay: true } });
    const invites = await tx.workspaceFeatureFlag.findUnique({ where: { workspaceId_flag: { workspaceId, flag: "MEMBER_INVITES" } }, select: { config: true } });
    const connections = await tx.oAuthConnection.findMany({ where: { workspaceId }, select: { id: true, provider: true, status: true, scopes: true, syncSettings: true }, orderBy: { id: "asc" } });
    const installations = await tx.communicationInstallation.findMany({ where: { workspaceId }, select: { id: true, provider: true, status: true, settings: true }, orderBy: { id: "asc" } });
    const recorder = await tx.workspaceMeetingRecorderConfig.findUnique({ where: { workspaceId }, select: { enabled: true, autoRecordEnabled: true, defaultProvider: true, fallbackProvider: true, monthlyMinuteCap: true } });
    const policy = object(invites?.config).policy;
    // Never return raw settings, source IDs/names, errors, tokens, scopes, profiles or usage.
    return {
      version: grant.version, workspace: { id: workspace.id, name: workspace.name },
      members: members.map(m => ({ id: m.id, email: m.user.email, role: m.role, isActive: m.isActive, protected: protectedUsers.has(m.userId) })),
      budget: budget ? { ...budget, monthlyCostCapUsd: Number(budget.monthlyCostCapUsd) } : { monthlyCostCapUsd: -1, alertThresholdPct: 80, periodStartDay: 1 },
      invitePolicy: policy === "MEMBERS_CAN_INVITE" || policy === "MEMBERS_CAN_REQUEST" ? policy : "ADMINS_ONLY",
      connections: connections.map(c => ({ id: c.id, provider: c.provider, status: c.status, ...syncConfiguration(c.syncSettings, c.scopes, c.provider) })),
      installations: installations.map(i => ({ id: i.id, provider: i.provider, status: i.status, rawRetentionDays: typeof object(i.settings).rawRetentionDays === "number" && Number.isFinite(object(i.settings).rawRetentionDays) ? Math.max(1, Math.floor(Number(object(i.settings).rawRetentionDays))) : 30 })),
      recorder,
      accessRequests: await tx.workspaceSupportAccessRequest.findMany({ where: { workspaceId, grantId: grant.id }, select: { id: true, command: true, status: true, grantVersion: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    };
  });
}

export async function changeSupportConfiguration(actor: AppActor, workspaceId: string, expectedVersion: number, input: unknown) {
  const command = supportConfigurationCommand.parse(input);
  invariant(Number.isSafeInteger(expectedVersion) && expectedVersion > 0, 400, "INVALID_INPUT", "A grant version is required.");
  const delivery: { email: string; token: string }[] = [];
  const result = await prisma.$transaction(async tx => {
    await lockWorkspaceMembership(tx, workspaceId);
    const { userId, grant } = await authorize(tx, actor, workspaceId, expectedVersion);
    if (grant.role === "SETUP") {
      const change = await accessChange(tx, workspaceId, command);
      if (change.approval) {
        invariant(await tx.workspaceSupportAccessRequest.count({ where: { workspaceId, grantId: grant.id, grantVersion: grant.version, status: "PENDING" } }) < 50, 409, "PENDING_REQUEST_LIMIT", "The owner must review pending access requests first.");
        const request = await tx.workspaceSupportAccessRequest.create({ data: { workspaceId, grantId: grant.id, grantVersion: grant.version, requestedByUserId: userId, command, targetState: change.state } });
        await tx.auditLog.create({ data: { workspaceId, actorUserId: userId, action: "support.access.requested", entityType: "WorkspaceSupportAccessRequest", entityId: request.id, meta: { grantId: grant.id, version: grant.version, kind: command.kind } } });
        return { saved: false, version: grant.version, approvalRequired: true, requestId: request.id };
      }
    }
    return applyConfiguration(tx, actor, workspaceId, userId, grant, command, delivery);
  });
  return { ...result, invitation: await deliverInvitation(delivery, workspaceId) };
}

async function applyConfiguration(tx: Db, actor: AppActor, workspaceId: string, userId: string, grant: { id: string; version: number }, command: SupportConfigurationCommand, delivery: { email: string; token: string }[]) {
    let entityId: string = workspaceId;
    if (command.kind === "workspace") {
      await tx.workspace.update({ where: { id: workspaceId }, data: { name: command.name, ...(command.description === undefined ? {} : { description: command.description || null }) } });
    } else if (command.kind === "budget") {
      const { kind: _kind, ...data } = command;
      await tx.modelUsageBudget.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    } else if (command.kind === "invitePolicy") {
      const data = { enabled: true, config: { policy: command.policy } };
      await tx.workspaceFeatureFlag.upsert({ where: { workspaceId_flag: { workspaceId, flag: "MEMBER_INVITES" } }, create: { workspaceId, flag: "MEMBER_INVITES", ...data }, update: data });
    } else if (command.kind === "member" || command.kind === "addMember") {
      const target = command.kind === "member"
        ? await tx.member.findFirst({ where: { workspaceId, id: command.memberId, kind: "HUMAN" }, select: { id: true, userId: true, role: true, isActive: true } })
        : null;
      const email = command.kind === "addMember" ? command.email.trim().toLowerCase() : null;
      let user = email ? await tx.user.findUnique({ where: { email }, select: { id: true, isSupportAccount: true } }) : null;
      invariant(command.kind === "member" ? target : !user?.isSupportAccount, 400, "MEMBER_UNAVAILABLE", "Named member account is unavailable.");
      if (email && !user) {
        await assertTrialMemberCapacity(workspaceId);
        user = await tx.user.create({ data: { email, passwordHash: hashPassword(randomOpaqueToken()) }, select: { id: true, isSupportAccount: true } });
        delivery.push({ email, token: await issueSetupToken(tx, user.id) });
      }
      const targetUserId = target?.userId ?? user!.id;
      invariant(targetUserId !== userId, 403, "SUPPORT_OWNER_REQUIRED", "Support cannot change its own access.");
      await requireUnmanagedMember(tx, workspaceId, targetUserId);
      if (command.kind === "addMember") {
        invariant(!await tx.member.findUnique({ where: { workspaceId_userId: { workspaceId, userId: targetUserId } }, select: { id: true } }), 409, "EXISTING_MEMBERSHIP", "Use the existing membership controls.");
        await assertTrialMemberCapacity(workspaceId);
        entityId = (await tx.member.create({ data: { workspaceId, userId: targetUserId, role: command.role, kind: "HUMAN" } })).id;
      } else {
        if (!target!.isActive && command.isActive) await assertTrialMemberCapacity(workspaceId);
        if (target!.role === "ADMIN" && target!.isActive && (command.role !== "ADMIN" || !command.isActive)) {
          invariant(await tx.member.count({ where: { workspaceId, role: "ADMIN", isActive: true, id: { not: target!.id } } }) > 0, 400, "LAST_ADMIN", "Workspace must keep an active admin.");
        }
        await tx.member.update({ where: { id: target!.id }, data: { role: command.role, isActive: command.isActive } });
        if (target!.isActive && !command.isActive) await closeRoleLifecycleForMember(tx, { workspaceId, memberId: target!.id, actor });
        entityId = target!.id;
      }
    } else if (command.kind === "oauth") {
      const connection = await tx.oAuthConnection.findFirst({ where: { id: command.connectionId, workspaceId }, select: { id: true, provider: true, scopes: true, status: true, syncSettings: true, updatedAt: true } });
      invariant(connection && ["ACTIVE", "PAUSED"].includes(connection.status), 409, "OWNER_CONSENT_REQUIRED", "The connection owner must reconnect this integration.");
      const options = syncConfiguration(connection.syncSettings, connection.scopes, connection.provider);
      invariant((!command.calendar || options.calendar || options.canEnableCalendar) && (!command.documents || options.documents || options.canEnableDocuments) && (!command.email || options.email || options.canEnableEmail), 403, "OWNER_SELECTION_REQUIRED", "The connection owner must authorize and select these sources first.");
      const settings = object(connection.syncSettings);
      const saved = await tx.oAuthConnection.updateMany({ where: { id: connection.id, workspaceId, status: connection.status, updatedAt: connection.updatedAt }, data: { status: command.status, syncSettings: { ...settings, calendar: { ...object(settings.calendar), enabled: command.calendar }, documents: { ...object(settings.documents), enabled: command.documents }, email: { ...object(settings.email), enabled: command.email } } as Prisma.InputJsonValue } });
      invariant(saved.count === 1, 409, "VERSION_CONFLICT", "Connection changed. Refresh and try again.");
      entityId = connection.id;
    } else if (command.kind === "communication") {
      const installation = await tx.communicationInstallation.findFirst({ where: { workspaceId, id: command.installationId }, select: { id: true, settings: true, updatedAt: true } });
      invariant(installation, 404, "NOT_FOUND", "Connection not found.");
      const saved = await tx.communicationInstallation.updateMany({ where: { id: installation.id, workspaceId, updatedAt: installation.updatedAt }, data: { settings: { ...object(installation.settings), rawRetentionDays: command.rawRetentionDays } as Prisma.InputJsonValue } });
      invariant(saved.count === 1, 409, "VERSION_CONFLICT", "Connection changed. Refresh and try again.");
      entityId = installation.id;
    } else if (command.kind === "recorder") {
      invariant(command.fallbackProvider !== command.defaultProvider, 400, "INVALID_INPUT", "Choose a different fallback provider.");
      const { kind: _kind, ...data } = command;
      // Preserve enablement/consent and provider secrets. Existing scheduler reads these preferences.
      const result = await tx.workspaceMeetingRecorderConfig.updateMany({ where: { workspaceId }, data });
      invariant(result.count === 1, 409, "OWNER_CONSENT_REQUIRED", "The owner must configure recording first.");
    }
    await tx.auditLog.create({ data: { workspaceId, actorUserId: userId, action: `support.configuration.${command.kind}`, entityType: "WorkspaceConfiguration", entityId, meta: { grantId: grant.id, version: grant.version, fields: Object.keys(command).filter(k => k !== "kind") } } });
    return { saved: true, version: grant.version, approvalRequired: false, requestId: null };
}

async function deliverInvitation(delivery: { email: string; token: string }[], workspaceId: string) {
  // Credentials never leave this server-side delivery path; existing accounts are not reset.
  let invitation: "sent" | "unavailable" | null = null;
  if (delivery[0]) {
    const sent = await sendMemberSetupEmail({ ...delivery[0], workspaceId });
    invitation = sent.sent ? "sent" : "unavailable";
  }
  return invitation;
}

export async function listSupportAccessRequests(actor: AppActor, workspaceId: string) {
  await requireSupportOwner(prisma, actor, workspaceId);
  const requests = await prisma.workspaceSupportAccessRequest.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100 });
  const ids = requests.flatMap(request => [request.requestedByUserId, object(request.targetState).userId]).filter((id): id is string => typeof id === "string");
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
  const emails = new Map(users.map(user => [user.id, user.email]));
  return requests.map(request => ({ ...request, command: supportConfigurationCommand.parse(request.command), requesterEmail: emails.get(request.requestedByUserId) ?? request.requestedByUserId, targetEmail: emails.get(String(object(request.targetState).userId)) ?? null }));
}

export async function decideSupportAccessRequest(actor: AppActor, workspaceId: string, requestId: string, approve: boolean) {
  const delivery: { email: string; token: string }[] = [];
  const result = await prisma.$transaction(async tx => {
    await lockWorkspaceMembership(tx, workspaceId);
    const ownerId = await requireSupportOwner(tx, actor, workspaceId);
    const request = await tx.workspaceSupportAccessRequest.findFirst({ where: { id: requestId, workspaceId } });
    invariant(request?.status === "PENDING", 409, "REQUEST_UNAVAILABLE", "The access request is no longer pending.");
    if (approve) {
      const grant = await tx.workspaceSupportGrant.findFirst({ where: { id: request.grantId, workspaceId, userId: request.requestedByUserId, version: request.grantVersion, isActive: true, role: "SETUP" } });
      invariant(grant, 409, "VERSION_CONFLICT", "Support access changed. This request cannot be approved.");
      const command = supportConfigurationCommand.parse(request.command);
      invariant(["addMember", "member", "invitePolicy"].includes(command.kind), 409, "REQUEST_UNAVAILABLE", "This request cannot grant access.");
      const current = await accessChange(tx, workspaceId, command);
      invariant(isDeepStrictEqual(current.state, request.targetState), 409, "VERSION_CONFLICT", "The target changed. Request a new owner decision.");
      // Execute the stored command as the actual owner, never as an invented admin.
      await applyConfiguration(tx, actor, workspaceId, ownerId, grant, command, delivery);
    }
    await tx.workspaceSupportAccessRequest.update({ where: { id: request.id }, data: { status: approve ? "APPROVED" : "REJECTED", decidedByUserId: ownerId, decidedAt: new Date() } });
    await tx.auditLog.create({ data: { workspaceId, actorUserId: ownerId, action: approve ? "support.access.approved" : "support.access.rejected", entityType: "WorkspaceSupportAccessRequest", entityId: request.id, meta: { grantId: request.grantId, version: request.grantVersion, requestedByUserId: request.requestedByUserId } } });
    return { approved: approve };
  });
  return { ...result, invitation: await deliverInvitation(delivery, workspaceId) };
}
