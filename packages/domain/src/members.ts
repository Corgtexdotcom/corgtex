import { readableArtifactIds, captureArtifactInputProof, mergeLineageInputRoot, withArtifactCountReleaseSnapshot, captureArtifactPermissionEpochs, lineageContentFingerprint, type LineageKind, type LineageRoot } from "./source-lineage";
import { DigestReadRelease } from "./digest-lineage";
import { requireUnreservedPublicDemoEmail } from "./public-demo-identity";
import { Prisma, type AuditLog, type MemberInviteRequestStatus, type MemberKind, type MemberRole } from "@prisma/client";
import { artifactPermissionEpochIdentities, capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, mergePermissionEpochProofs, parsePermissionEpochProof } from "./source-permission-epochs";
import type { AppActor } from "@corgtex/shared";
import { env, prisma, hashPassword, randomOpaqueToken, sendEmail, sha256, getMcpOrigin, mcpScopesHash } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";
import { isGlobalOperator, requireWorkspaceMembership } from "./auth";
import { lockWorkspaceMembership, requireUnmanagedMember } from "./workspace-support-access";
import { assertTrialMemberCapacity } from "./trial-entitlements";
import { privacyFilter } from "./privacy";
import { closeRoleLifecycleForMember } from "./role-onboarding";
import { maybeCaptureSelfServeSetupEmail } from "./self-serve-ops";
import { renderAccountSetupEmail } from "./email-templates";
import { humanMemberIdentityWhere, inferMemberKindFromUserIdentity, systemMemberIdentityWhere } from "./member-identity";

export type MemberInvitePolicy = "ADMINS_ONLY" | "MEMBERS_CAN_INVITE" | "MEMBERS_CAN_REQUEST";

const MEMBER_INVITE_SETTINGS_FLAG = "MEMBER_INVITES";
const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type MemberSetupEmailStatus = {
  email: string;
  sent: boolean;
  error?: string;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeDisplayName(displayName?: string | null) {
  return displayName?.trim() || null;
}

export async function sendMemberSetupEmail(params: {
  email: string;
  displayName?: string | null;
  token: string;
  workspaceName?: string | null;
  workspaceId?: string | null;
  procurementTrialId?: string | null;
  runId?: string | null;
}): Promise<MemberSetupEmailStatus> {
  const email = normalizeEmail(params.email);
  const appUrl = env.APP_URL.replace(/\/$/, "");
  const setupUrl = `${appUrl}/setup-account/${encodeURIComponent(params.token)}`;
  const subject = "You've been invited to Corgtex";
  if (!env.RESEND_API_KEY) {
    const error = "RESEND_API_KEY is not configured on the server.";
    await maybeCaptureSelfServeSetupEmail({
      email,
      subject,
      setupUrl,
      providerStatus: { status: "SKIPPED", reason: error },
      workspaceId: params.workspaceId,
      procurementTrialId: params.procurementTrialId,
      runId: params.runId,
      source: "member_setup",
    }).catch((captureError) => {
      console.warn("[self-serve-smoke] setup-email capture failed:", captureError);
    });
    return { email, sent: false, error };
  }

  try {
    const providerStatus = await sendEmail({
      to: email,
      subject,
      html: renderAccountSetupEmail({
        setupUrl,
        displayName: params.displayName,
        workspaceName: params.workspaceName,
        kind: params.procurementTrialId ? "trial-claim" : "member-invite",
      }),
    });
    await maybeCaptureSelfServeSetupEmail({
      email,
      subject,
      setupUrl,
      providerStatus,
      workspaceId: params.workspaceId,
      procurementTrialId: params.procurementTrialId,
      runId: params.runId,
      source: "member_setup",
    }).catch((error) => {
      console.warn("[self-serve-smoke] setup-email capture failed:", error);
    });
    return { email, sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await maybeCaptureSelfServeSetupEmail({
      email,
      subject,
      setupUrl,
      providerStatus: { status: "FAILED", error: message },
      workspaceId: params.workspaceId,
      procurementTrialId: params.procurementTrialId,
      runId: params.runId,
      source: "member_setup",
    }).catch((captureError) => {
      console.warn("[self-serve-smoke] setup-email capture failed:", captureError);
    });
    return {
      email,
      sent: false,
      error: message,
    };
  }
}

function parseInvitePolicy(config: unknown): MemberInvitePolicy {
  if (
    config &&
    typeof config === "object" &&
    "policy" in config &&
    (config as { policy?: unknown }).policy === "MEMBERS_CAN_INVITE"
  ) {
    return "MEMBERS_CAN_INVITE";
  }
  if (
    config &&
    typeof config === "object" &&
    "policy" in config &&
    (config as { policy?: unknown }).policy === "MEMBERS_CAN_REQUEST"
  ) {
    return "MEMBERS_CAN_REQUEST";
  }
  return "ADMINS_ONLY";
}

export async function issueSetupToken(tx: any, userId: string) {
  await tx.passwordResetToken.updateMany({
    where: {
      userId,
      usedAt: null,
    },
    data: {
      usedAt: new Date(),
    },
  });

  const token = randomOpaqueToken();
  await tx.passwordResetToken.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + SETUP_TOKEN_TTL_MS),
    },
  });
  return token;
}

export async function listMembers(workspaceId: string) {
  return prisma.member.findMany({
    where: { workspaceId, isActive: true },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          bio: true,
          linkedinUrl: true,
          websiteUrl: true,
        },
      },
    },
    orderBy: {
      joinedAt: "asc",
    },
  });
}

export async function listHumanMembers(workspaceId: string, opts?: { includeInactive?: boolean }) {
  return prisma.member.findMany({
    where: {
      workspaceId,
      ...(opts?.includeInactive ? {} : { isActive: true }),
      ...humanMemberIdentityWhere(),
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          bio: true,
          linkedinUrl: true,
          websiteUrl: true,
        },
      },
    },
    orderBy: {
      joinedAt: "asc",
    },
  });
}

export async function listSystemMembers(workspaceId: string, opts?: { includeInactive?: boolean }) {
  return prisma.member.findMany({
    where: {
      workspaceId,
      ...(opts?.includeInactive ? {} : { isActive: true }),
      ...systemMemberIdentityWhere(),
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          bio: true,
          linkedinUrl: true,
          websiteUrl: true,
        },
      },
    },
    orderBy: {
      joinedAt: "asc",
    },
  });
}

async function redactMemberRoleAssignments<T extends { roleAssignments: Array<{ id: string; role: { id: string; circleId: string; circle: { id: string } } }> }>(actor: AppActor, workspaceId: string, members: T[], release?: DigestReadRelease, managementAssignments: ReadonlySet<string> = new Set()) {
  const assignments = members.flatMap((member) => member.roleAssignments);
  const readable = async (kind: LineageKind, records: { id: string }[]) => release
    ? new Set((await release.capture(kind, records)).records.map(row => row.id))
    : readableArtifactIds(actor, workspaceId, kind, records);
  const allowedAssignments = await readable("RoleAssignment", assignments.filter(assignment => !managementAssignments.has(assignment.id)));
  for (const id of managementAssignments) allowedAssignments.add(id);
  const allowedRoles = await readable("Role", assignments.map((assignment) => assignment.role));
  const allowedCircles = await readable("Circle", assignments.map((assignment) => assignment.role.circle));
  return members.map((member) => ({ ...member, roleAssignments: member.roleAssignments.filter((assignment) =>
    allowedAssignments.has(assignment.id) && allowedRoles.has(assignment.role.id) && allowedCircles.has(assignment.role.circleId)),
  }));
}

export async function listMembersEnriched(actor: AppActor, workspaceId: string, opts?: { includeInactive?: boolean }) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const members = await prisma.member.findMany({
    where: {
      workspaceId,
      ...(opts?.includeInactive ? {} : { isActive: true }),
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          bio: true,
          linkedinUrl: true,
          websiteUrl: true,
        },
      },
      roleAssignments: {
        where: {
          role: {
            archivedAt: null,
            circle: {
              archivedAt: null,
            },
          },
        },
        include: {
          role: {
            include: {
              circle: true,
            },
          },
        },
      },
    },
    orderBy: {
      joinedAt: "asc",
    },
  });
  const release = new DigestReadRelease(actor, workspaceId);
  // Inactive identities remain unavailable to generic content/model readers.
  // This private ledger only serves the human-admin reactivation directory.
  type MetadataKind = "Member" | "User" | "RoleAssignment";
  type MetadataEntry = { kind: MetadataKind; id: string; value: string; head: string };
  const metadataValue = (row: Record<string, unknown>) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
  const loadMetadata = (tx: Prisma.TransactionClient, kind: MetadataKind, id: string) => kind === "Member"
    ? tx.member.findFirst({ where: { id, workspaceId, isActive: false } })
    : kind === "User" ? tx.user.findFirst({ where: { id, memberships: { some: { workspaceId, isActive: false } } }, select: {
      id: true, email: true, displayName: true, avatarUrl: true, bio: true, linkedinUrl: true, websiteUrl: true,
    } }) : tx.roleAssignment.findFirst({ where: { id, member: { workspaceId, isActive: false }, role: { circle: { workspaceId } } } });
  const loadHead = (tx: Prisma.TransactionClient, kind: MetadataKind, id: string) => tx.artifactInputLineage.findFirst({
    where: { workspaceId, artifactType: kind, artifactId: id }, orderBy: { revision: "desc" },
  });
  const requireManagementAuthority = async (tx: Prisma.TransactionClient) => {
    invariant(actor.kind === "user", 403, "FORBIDDEN", "Member management requires a human administrator.");
    const admin = await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"], tx });
    const origin = getMcpOrigin();
    if (origin) {
      const token = origin.kind === "oauth" ? await tx.mcpOAuthAccessToken.findUnique({ where: { id: origin.id } }) : null;
      invariant(token && token.userId === actor.user.id && token.workspaceId === workspaceId
        && mcpScopesHash(token.scopes) === origin.scopeHash && token.scopes.includes("members:read"),
        403, "FORBIDDEN", "The current grant does not authorize member management metadata.");
    }
    return admin!;
  };
  const inactive = opts?.includeInactive && actor.kind === "user" && membership?.role === "ADMIN"
    ? await prisma.$transaction(async tx => {
      const admin = await requireManagementAuthority(tx);
      const entries: MetadataEntry[] = [];
      const records: typeof members = [];
      const assignmentIds = new Set<string>();
      const identities = [{ kind: "MemberRolePolicy", id: admin.id }];
      const capture = async (kind: MetadataKind, original: { id: string } & Record<string, unknown>) => {
        const current = await loadMetadata(tx, kind, original.id);
        if (!current || metadataValue(current) !== metadataValue(original)) return false;
        const head = await loadHead(tx, kind, original.id);
        // Native identity metadata has no required manifest. An existing head
        // may only authenticate these exact human-original bytes, never inputs.
        if (head && (head.origin !== "HUMAN_ORIGINAL" || head.contentHash !== lineageContentFingerprint(kind, kind === "Member"
          ? { ...current, user: members.find(member => member.id === original.id)!.user } : current)
          || head.epochProofVersion !== 1 || !parsePermissionEpochProof(head.permissionEpochsJson)
          || !Array.isArray(head.inputsJson) || head.inputsJson.length !== 0
          || !Array.isArray(head.rootsJson) || head.rootsJson.length !== 0)) return false;
        entries.push({ kind, id: original.id, value: metadataValue(original), head: JSON.stringify(head) });
        identities.push(...artifactPermissionEpochIdentities(kind, { ...original, workspaceId }));
        return true;
      };
      for (const member of members.filter(member => !member.isActive)) {
        const { user, roleAssignments, ...record } = member;
        const start = entries.length;
        if (!await capture("Member", record) || !await capture("User", user)) { entries.splice(start); continue; }
        const admittedAssignments: typeof roleAssignments = [];
        for (const assignment of roleAssignments) {
          const { role, ...record } = assignment;
          if (await capture("RoleAssignment", record)) {
            admittedAssignments.push({ ...record, role });
            assignmentIds.add(assignment.id);
          }
        }
        records.push({ ...member, roleAssignments: admittedAssignments });
      }
      const epochs = mergePermissionEpochProofs(await captureArtifactPermissionEpochs(actor, workspaceId, [], tx),
        await capturePermissionEpochs(tx, workspaceId, identities))!;
      return { entries, records, assignmentIds, epochs };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 }) : null;
  // Member fingerprints use the canonical identity projection. Profile fields
  // are retained separately against the original User row that supplies the DTO.
  const visibleMembers = new Set((await release.capture("Member", members.filter(member => member.isActive).map(member => ({
    ...member, user: { id: member.user.id, email: member.user.email, displayName: member.user.displayName },
  })))).records.map(member => member.id));
  const admitted = members.filter(member => visibleMembers.has(member.id));
  const visibleUsers = new Set((await release.capture("User", admitted.map(member => member.user))).records.map(user => user.id));
  const available = new Map([...admitted.filter(member => visibleUsers.has(member.user.id)), ...(inactive?.records ?? [])]
    .map(member => [member.id, member]));
  const result = await redactMemberRoleAssignments(actor, workspaceId,
    members.flatMap(member => available.has(member.id) ? [available.get(member.id)!] : []), release, inactive?.assignmentIds);
  return release.finish(result, async tx => {
    if (!inactive?.records.length) return;
    await requireManagementAuthority(tx);
    invariant(await isArtifactPermissionEpochProofCurrent(workspaceId, inactive.epochs, tx),
      409, "SOURCE_CHANGED", "Member management authority changed.");
    for (const entry of inactive.entries) {
      const current = await loadMetadata(tx, entry.kind, entry.id);
      const head = await loadHead(tx, entry.kind, entry.id);
      invariant(current && metadataValue(current) === entry.value && JSON.stringify(head) === entry.head,
        409, "SOURCE_CHANGED", "Member management metadata changed.");
    }
  });
}

export async function getMemberInvitePolicy(workspaceId: string): Promise<MemberInvitePolicy> {
  const settings = await prisma.workspaceFeatureFlag.findUnique({
    where: {
      workspaceId_flag: {
        workspaceId,
        flag: MEMBER_INVITE_SETTINGS_FLAG,
      },
    },
    select: {
      config: true,
    },
  });

  return parseInvitePolicy(settings?.config);
}

export async function updateMemberInvitePolicy(actor: AppActor, params: {
  workspaceId: string;
  policy: MemberInvitePolicy;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.workspaceFeatureFlag.upsert({
    where: {
      workspaceId_flag: {
        workspaceId: params.workspaceId,
        flag: MEMBER_INVITE_SETTINGS_FLAG,
      },
    },
    update: {
      enabled: true,
      config: { policy: params.policy },
    },
    create: {
      workspaceId: params.workspaceId,
      flag: MEMBER_INVITE_SETTINGS_FLAG,
      enabled: true,
      config: { policy: params.policy },
    },
  });
}

export async function bulkInviteMembers(actor: AppActor, params: {
  workspaceId: string;
  members: { email: string; displayName?: string | null; role?: MemberRole; kind?: MemberKind }[];
}): Promise<{ invited: number; details: { email: string; displayName: string | null; token: string }[]; errors: string[] }> {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  let invited = 0;
  const errors: string[] = [];
  const details: { email: string; displayName: string | null; token: string }[] = [];

  for (const info of params.members) {
    try {
      const result = await createMember(actor, {
        workspaceId: params.workspaceId,
        email: info.email,
        displayName: info.displayName,
        role: info.role || "CONTRIBUTOR",
        kind: info.kind,
      });
      invited++;
      details.push({
        email: result.user.email,
        displayName: result.user.displayName,
        token: result.token,
      });
    } catch (e: any) {
      errors.push(`Failed for ${info.email}: ${e.message}`);
    }
  }

  return { invited, details, errors };
}

export async function createMember(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName?: string | null;
  role: MemberRole;
  kind?: MemberKind;
  skipAdminCheck?: boolean;
}) {
  if (!params.skipAdminCheck) {
    await requireWorkspaceMembership({
      actor,
      workspaceId: params.workspaceId,
      allowedRoles: ["ADMIN"],
    });
  }

  const email = normalizeEmail(params.email);
  requireUnreservedPublicDemoEmail(email);
  const displayName = normalizeDisplayName(params.displayName);
  const kind = params.kind ?? inferMemberKindFromUserIdentity({ email, displayName });
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");
  await assertTrialMemberCapacity(params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const randomPassword = randomOpaqueToken();
    await lockWorkspaceMembership(tx, params.workspaceId);
    if (!params.skipAdminCheck) {
      await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"], tx });
    }
    const user = await tx.user.upsert({
      where: { email },
      update: {
        displayName: displayName || undefined,
      },
      create: {
        email,
        displayName,
        passwordHash: hashPassword(randomPassword),
      },
      select: {
        id: true,
        email: true,
        displayName: true,
      },
    });

    await requireUnmanagedMember(tx, params.workspaceId, user.id);
    const member = await tx.member.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: params.workspaceId,
          userId: user.id,
        },
      },
      update: {
        role: params.role,
        kind,
        isActive: true,
      },
      create: {
        workspaceId: params.workspaceId,
        userId: user.id,
        role: params.role,
        kind,
        isActive: true,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "member.created",
        entityType: "Member",
        entityId: member.id,
        meta: {
          email,
          role: params.role,
          kind,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "member.created",
        aggregateType: "Member",
        aggregateId: member.id,
        payload: {
          memberId: member.id,
          userId: user.id,
          role: member.role,
          kind: member.kind,
        },
      },
    ]);

    const token = await issueSetupToken(tx, user.id);

    return { user, member, token };
  });
}

export async function inviteMember(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName?: string | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(membership, 403, "FORBIDDEN", "Only workspace members can invite members.");

  if (membership?.role !== "ADMIN") {
    const policy = await getMemberInvitePolicy(params.workspaceId);
    if (policy !== "MEMBERS_CAN_INVITE") {
      throw new AppError(403, "FORBIDDEN", "Only admins can invite members in this workspace.");
    }
  }

  return createMember(actor, {
    ...params,
    role: "CONTRIBUTOR",
    skipAdminCheck: true,
  });
}

export async function updateMember(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  role?: MemberRole;
  kind?: MemberKind;
  isActive?: boolean;
  displayName?: string | null;
  email?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"], tx });
    const member = await tx.member.findUnique({
      where: { id: params.memberId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            ssoIdentities: { select: { id: true } },
            _count: { select: { memberships: true } },
          },
        },
      },
    });

    invariant(member && member.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found.");
    requireUnreservedPublicDemoEmail(member.user.email);
    if (params.email !== undefined && params.email !== null) requireUnreservedPublicDemoEmail(params.email);
    await requireUnmanagedMember(tx, params.workspaceId, member.userId);

    const memberData: Record<string, unknown> = {};
    if (params.role !== undefined) memberData.role = params.role;
    if (params.kind !== undefined) memberData.kind = params.kind;
    if (params.isActive !== undefined) memberData.isActive = params.isActive;
    if (params.isActive === false && !member.isActive) {
      throw new AppError(400, "INVALID_STATE", "Member is already deactivated.");
    }

    const nextRole = params.role ?? member.role;
    const nextActive = params.isActive ?? member.isActive;
    if (member.role === "ADMIN" && member.isActive && (nextRole !== "ADMIN" || !nextActive)) {
      const otherAdminCount = await tx.member.count({
        where: {
          workspaceId: params.workspaceId,
          role: "ADMIN",
          isActive: true,
          id: { not: member.id },
        },
      });
      invariant(otherAdminCount > 0, 400, "LAST_ADMIN", "Workspace must keep at least one active admin.");
    }

    const normalizedEmail = params.email !== undefined && params.email !== null
      ? normalizeEmail(params.email)
      : undefined;
    if (normalizedEmail !== undefined) {
      invariant(normalizedEmail.length > 0, 400, "INVALID_INPUT", "Email is required.");
    }

    const emailChanged = normalizedEmail !== undefined && normalizedEmail !== member.user.email;
    if (emailChanged) {
      const existingUser = await tx.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });
      invariant(!existingUser || existingUser.id === member.userId, 409, "ALREADY_EXISTS", "A user with that email already exists.");

      if (!isGlobalOperator(actor)) {
        invariant(
          member.user._count.memberships === 1,
          400,
          "SHARED_ACCOUNT",
          "This user belongs to multiple workspaces. A platform operator must change their email.",
        );
        invariant(
          member.user.ssoIdentities.length === 0,
          400,
          "SSO_ACCOUNT",
          "This user signs in with SSO. A platform operator must change their email.",
        );
      }
    }

    const userData: Record<string, unknown> = {};
    const nextDisplayName = params.displayName !== undefined ? normalizeDisplayName(params.displayName) : undefined;
    if (params.displayName !== undefined) {
      userData.displayName = nextDisplayName;
    }
    if (emailChanged) {
      userData.email = normalizedEmail;
    }
    if (params.kind === undefined && (normalizedEmail !== undefined || nextDisplayName !== undefined)) {
      const inferredKind = inferMemberKindFromUserIdentity({
        email: normalizedEmail ?? member.user.email,
        displayName: nextDisplayName !== undefined ? nextDisplayName : member.user.displayName,
      });
      const currentKind = member.kind ?? inferMemberKindFromUserIdentity(member.user);
      if (inferredKind !== currentKind) {
        memberData.kind = inferredKind;
      }
    }

    if (Object.keys(userData).length > 0) {
      await tx.user.update({
        where: { id: member.userId },
        data: userData,
      });
    }

    if (emailChanged) {
      await tx.session.deleteMany({ where: { userId: member.userId } });
    }

    const updated = Object.keys(memberData).length > 0
      ? await tx.member.update({
        where: { id: params.memberId },
        data: memberData,
        include: { user: { select: { id: true, email: true, displayName: true } } },
      })
      : await tx.member.findUnique({
        where: { id: params.memberId },
        include: { user: { select: { id: true, email: true, displayName: true } } },
      });
    invariant(updated, 404, "NOT_FOUND", "Member not found.");

    if (params.isActive === false && member.isActive) {
      await closeRoleLifecycleForMember(tx, {
        workspaceId: params.workspaceId,
        memberId: params.memberId,
        actor,
      });
    }

    const setupToken = emailChanged ? await issueSetupToken(tx, member.userId) : undefined;
    const fields = [
      ...Object.keys(memberData),
      ...(params.displayName !== undefined ? ["displayName"] : []),
      ...(emailChanged ? ["email"] : []),
    ];
    const action = params.isActive === false
      ? "member.deactivated"
      : params.isActive === true && !member.isActive
        ? "member.reactivated"
        : "member.updated";

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action,
        entityType: "Member",
        entityId: updated.id,
        meta: {
          fields,
          ...(emailChanged ? { oldEmail: member.user.email, newEmail: normalizedEmail } : {}),
          ...(params.displayName !== undefined ? { oldDisplayName: member.user.displayName, newDisplayName: nextDisplayName } : {}),
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: action,
        aggregateType: "Member",
        aggregateId: updated.id,
        payload: {
          memberId: updated.id,
          fields,
        },
      },
    ]);

    return { ...updated, setupToken };
  });
}

export async function deactivateMember(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
}) {
  return updateMember(actor, { ...params, isActive: false });
}

export async function resendMemberAccessLink(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"], tx });
    const member = await tx.member.findUnique({
      where: { id: params.memberId },
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });
    invariant(member && member.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found.");

    await requireUnmanagedMember(tx, params.workspaceId, member.userId);
    const token = await issueSetupToken(tx, member.userId);
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "member.access_link.created",
        entityType: "Member",
        entityId: member.id,
        meta: { email: member.user.email },
      },
    });

    return { user: member.user, member, token };
  });
}

export async function requestMemberInvite(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  displayName?: string | null;
}) {
  const requesterMembership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(requesterMembership, 403, "FORBIDDEN", "Only workspace members can request invites.");

  if (requesterMembership.role === "ADMIN") {
    throw new AppError(400, "INVALID_STATE", "Admins can invite members directly.");
  }

  const policy = await getMemberInvitePolicy(params.workspaceId);
  if (policy !== "MEMBERS_CAN_REQUEST") {
    throw new AppError(403, "FORBIDDEN", "Invite requests are not enabled for this workspace.");
  }

  const email = normalizeEmail(params.email);
  requireUnreservedPublicDemoEmail(email);
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");

  const [existingActiveMember, existingPendingRequest] = await Promise.all([
    prisma.member.findFirst({
      where: {
        workspaceId: params.workspaceId,
        isActive: true,
        user: { email },
      },
      select: { id: true },
    }),
    prisma.memberInviteRequest.findFirst({
      where: {
        workspaceId: params.workspaceId,
        email,
        status: "PENDING",
      },
      select: { id: true },
    }),
  ]);
  invariant(!existingActiveMember, 409, "ALREADY_EXISTS", "That email is already an active member.");
  invariant(!existingPendingRequest, 409, "ALREADY_EXISTS", "There is already a pending invite request for that email.");

  return prisma.memberInviteRequest.create({
    data: {
      workspaceId: params.workspaceId,
      requesterMemberId: requesterMembership.id,
      email,
      displayName: normalizeDisplayName(params.displayName),
    },
  });
}

export async function listMemberInviteRequests(actor: AppActor, params: {
  workspaceId: string;
  status?: MemberInviteRequestStatus;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.memberInviteRequest.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(params.status ? { status: params.status } : {}),
    },
    include: {
      requesterMember: { include: { user: { select: { email: true, displayName: true } } } },
      deciderMember: { include: { user: { select: { email: true, displayName: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function approveMemberInviteRequest(actor: AppActor, params: {
  workspaceId: string;
  requestId: string;
}) {
  const deciderMembership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const request = await prisma.memberInviteRequest.findUnique({
    where: { id: params.requestId },
  });
  invariant(request && request.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Invite request not found.");
  invariant(request.status === "PENDING", 400, "INVALID_STATE", "Invite request is already decided.");

  const result = await createMember(actor, {
    workspaceId: params.workspaceId,
    email: request.email,
    displayName: request.displayName,
    role: "CONTRIBUTOR",
  });

  await prisma.memberInviteRequest.update({
    where: { id: params.requestId },
    data: {
      status: "APPROVED",
      deciderMemberId: deciderMembership?.id === "global-operator" ? null : deciderMembership?.id ?? null,
      decidedAt: new Date(),
    },
  });

  return result;
}

export async function rejectMemberInviteRequest(actor: AppActor, params: {
  workspaceId: string;
  requestId: string;
}) {
  const deciderMembership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const request = await prisma.memberInviteRequest.findUnique({
    where: { id: params.requestId },
  });
  invariant(request && request.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Invite request not found.");
  invariant(request.status === "PENDING", 400, "INVALID_STATE", "Invite request is already decided.");

  return prisma.memberInviteRequest.update({
    where: { id: params.requestId },
    data: {
      status: "REJECTED",
      deciderMemberId: deciderMembership?.id === "global-operator" ? null : deciderMembership?.id ?? null,
      decidedAt: new Date(),
    },
  });
}

export async function getMemberProfile(actor: AppActor, workspaceId: string, memberId: string) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const visibleWorkspaceRecordWhere = {
    ...privacyFilter(actor, membership),
    archivedAt: null,
  };

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          bio: true,
          linkedinUrl: true,
          websiteUrl: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      roleAssignments: {
        where: {
          role: {
            archivedAt: null,
            circle: {
              archivedAt: null,
            },
          },
        },
        include: {
          role: {
            include: {
              circle: true,
            },
          },
        },
      },
    },
  });

  invariant(member && member.workspaceId === workspaceId, 404, "NOT_FOUND", "Member not found.");

  const roots = new Map<string, LineageRoot>();
  const retain = (proof: LineageRoot[]) => {
    for (const root of proof) {
      const key = `${root.kind}:${root.id}`;
      roots.set(key, mergeLineageInputRoot(roots.get(key), root));
    }
  };
  retain(await captureArtifactInputProof(actor, workspaceId, [
    {kind: "Member", id: member.id, snapshot: {...member, user: {
      id: member.user.id, email: member.user.email, displayName: member.user.displayName,
    }}},
    {kind: "User", id: member.user.id, snapshot: member.user},
  ]));
  type RecentCursor = {id: string; at: Date};
  const createdBefore = (after?: RecentCursor) => after ? { OR: [
    {createdAt: {lt: after.at}}, {createdAt: after.at, id: {lt: after.id}},
  ] } : {};
  const recordedBefore = (after?: RecentCursor) => after ? { OR: [
    {recordedAt: {lt: after.at}}, {recordedAt: after.at, id: {lt: after.id}},
  ] } : {};
  const createdOrder = [{createdAt: "desc" as const}, {id: "desc" as const}];
  const recent = async <T extends {id: string; createdAt: Date; recordedAt?: Date}>(kind: LineageKind,
    dateField: "createdAt" | "recordedAt", load: (after: RecentCursor | undefined, take: number) => Promise<T[]>) => {
    const selected: T[] = [];
    let after: RecentCursor | undefined;
    for (;;) {
      const batch = await load(after, 100);
      const readable = await readableArtifactIds(actor, workspaceId, kind, batch);
      const admitted = batch.filter(row => readable.has(row.id)).slice(0, 5 - selected.length);
      if (admitted.length) retain(await captureArtifactInputProof(actor, workspaceId,
        admitted.map(row => ({kind, id: row.id, snapshot: row}))));
      selected.push(...admitted);
      if (selected.length === 5 || batch.length < 100) return selected;
      const last = batch[batch.length - 1], at = last[dateField];
      invariant(at instanceof Date, 409, "SOURCE_CHANGED", "Recent source ordering is unavailable.");
      after = {id: last.id, at};
    }
  };
  const [assignedActions, assignedTensions, meetings, proposals, authoredTensions] = await Promise.all([
    recent("Action", "createdAt", (after, take) => prisma.action.findMany({ where: { AND: [{workspaceId, assigneeMemberId: member.id, status: "OPEN", ...visibleWorkspaceRecordWhere}, createdBefore(after)] }, orderBy: createdOrder, take })),
    recent("Tension", "createdAt", (after, take) => prisma.tension.findMany({ where: { AND: [{workspaceId, assigneeMemberId: member.id, status: "OPEN", ...visibleWorkspaceRecordWhere}, createdBefore(after)] }, orderBy: createdOrder, take })),
    recent("Meeting", "recordedAt", (after, take) => prisma.meeting.findMany({ where: {workspaceId, participantIds: {has: member.user.id}, archivedAt: null, ...recordedBefore(after)}, orderBy: [{recordedAt: "desc"}, {id: "desc"}], take })),
    recent("Proposal", "createdAt", (after, take) => prisma.proposal.findMany({ where: {AND: [{workspaceId, authorUserId: member.user.id, ...visibleWorkspaceRecordWhere}, createdBefore(after)]}, orderBy: createdOrder, take })),
    recent("Tension", "createdAt", (after, take) => prisma.tension.findMany({ where: {AND: [{workspaceId, authorUserId: member.user.id, status: "OPEN", ...visibleWorkspaceRecordWhere}, createdBefore(after)]}, orderBy: createdOrder, take })),
  ]);
  const safeMembers = await redactMemberRoleAssignments(actor, workspaceId, [member]);
  for (const assignment of safeMembers[0].roleAssignments) retain(await captureArtifactInputProof(actor, workspaceId, [
    {kind: "RoleAssignment", id: assignment.id, snapshot: assignment},
    {kind: "Role", id: assignment.role.id, snapshot: assignment.role},
    {kind: "Circle", id: assignment.role.circle.id, snapshot: assignment.role.circle},
  ]));
  const safeMember = { ...safeMembers[0], user: {
    id: member.user.id, email: member.user.email, displayName: member.user.displayName,
    avatarUrl: member.user.avatarUrl, bio: member.user.bio, linkedinUrl: member.user.linkedinUrl, websiteUrl: member.user.websiteUrl,
  }, assignedActions, assignedTensions };
  const kinds: Record<string, LineageKind> = { Action: "Action", Tension: "Tension", Proposal: "Proposal", Goal: "Goal", BrainArticle: "BrainArticle", BrainSource: "BrainSource", Circle: "Circle", Role: "Role", Member: "Member", Meeting: "Meeting" };
  const recentActivity: Array<Omit<AuditLog, "meta"> & {meta: null}> = [];
  let afterActivity: RecentCursor | undefined;
  while (recentActivity.length < 10) {
    const logs = await prisma.auditLog.findMany({where: {workspaceId, actorUserId: member.user.id, ...createdBefore(afterActivity)}, orderBy: createdOrder, take: 100});
    for (const log of logs) {
      const kind = log.entityType ? kinds[log.entityType] : null;
      if (!kind || !log.entityId) continue;
      try { retain(await captureArtifactInputProof(actor, workspaceId, [{ kind, id: log.entityId }])); }
      catch (error) { if (error instanceof AppError && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) continue; throw error; }
      // Historical audit payloads are not proof-bearing copies of today's artifact.
      recentActivity.push({ ...log, meta: null });
      if (recentActivity.length === 10) break;
    }

    if (recentActivity.length === 10 || logs.length < 100) break;
    const last = logs[logs.length - 1];
    afterActivity = {id: last.id, at: last.createdAt};
  }

  return withArtifactCountReleaseSnapshot(actor, workspaceId, [...roots.values()], async () => undefined, async tx => {
    await requireWorkspaceMembership({actor, workspaceId, tx});
    return {
      member: safeMember,
      meetings,
      recentActivity,
      proposals,
      authoredTensions,
    };
  });
}
