import { prisma, hashPassword, verifyPassword } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import { isNotificationPreferenceChannel } from "./notifications";
import type { NewspaperCadence } from "@prisma/client";

// ------------------------------------------------------------------
// Profile Management
// ------------------------------------------------------------------

export async function getUserProfile(actor: AppActor, workspaceId: string) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only user accounts have profiles.");

  const [user, member] = await Promise.all([
    prisma.user.findUnique({
      where: { id: actor.user.id },
      select: {
        id: true,
        email: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        linkedinUrl: true,
        websiteUrl: true,
        createdAt: true,
        ssoIdentities: { select: { provider: true } },
      },
    }),
    prisma.member.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: actor.user.id,
        },
      },
      include: {
        roleAssignments: {
          include: {
            role: {
              include: {
                circle: { select: { id: true, name: true } },
              },
            },
          },
        },
        expertise: {
          include: { expertiseTag: true },
          orderBy: { endorsedCount: "desc" },
        },
        recognitionsReceived: {
          take: 5,
          orderBy: { createdAt: "desc" },
          include: {
            author: { include: { user: { select: { displayName: true } } } },
          },
        },
      },
    }),
  ]);

  invariant(user, 404, "NOT_FOUND", "User not found.");

  return {
    user,
    member: member || null,
  };
}

export async function updateUserProfile(actor: AppActor, params: {
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  linkedinUrl?: string | null;
  websiteUrl?: string | null;
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only user accounts have profiles.");

  const data: Record<string, any> = {};
  if (params.displayName !== undefined) data.displayName = params.displayName?.trim() || null;
  if (params.bio !== undefined) data.bio = params.bio?.trim() || null;
  if (params.avatarUrl !== undefined) data.avatarUrl = params.avatarUrl;
  if (params.linkedinUrl !== undefined) data.linkedinUrl = normalizeProfileUrl(params.linkedinUrl, "LinkedIn URL");
  if (params.websiteUrl !== undefined) data.websiteUrl = normalizeProfileUrl(params.websiteUrl, "Website URL");

  if (Object.keys(data).length === 0) return actor.user;

  const updated = await prisma.user.update({
    where: { id: actor.user.id },
    data,
    select: {
      id: true,
      email: true,
      displayName: true,
      bio: true,
      avatarUrl: true,
      linkedinUrl: true,
      websiteUrl: true,
    },
  });

  return updated;
}

function normalizeProfileUrl(value: string | null | undefined, label: string) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError(400, "INVALID_PROFILE_URL", `${label} must be a valid https:// URL.`);
  }

  if (parsed.protocol !== "https:") {
    throw new AppError(400, "INVALID_PROFILE_URL", `${label} must start with https://.`);
  }

  return trimmed;
}

// ------------------------------------------------------------------
// Security: Password & Sessions
// ------------------------------------------------------------------

export async function changeUserPassword(actor: AppActor, params: { currentPassword: string; newPassword: string }) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only user accounts can change passwords.");
  invariant(params.newPassword.length >= 8, 400, "INVALID_INPUT", "New password must be at least 8 characters.");

  const user = await prisma.user.findUnique({
    where: { id: actor.user.id },
    select: { passwordHash: true },
  });

  invariant(user, 404, "NOT_FOUND", "User not found.");

  if (!verifyPassword(params.currentPassword, user.passwordHash)) {
    throw new AppError(400, "INVALID_CREDENTIALS", "Current password is incorrect.");
  }

  // Update password and invalidate all sessions in a single transaction
  await prisma.$transaction([
    prisma.user.update({
      where: { id: actor.user.id },
      data: { passwordHash: hashPassword(params.newPassword) },
    }),
    prisma.session.deleteMany({
      where: { userId: actor.user.id },
    }),
  ]);

  return { success: true };
}

export async function listUserSessions(actor: AppActor, currentTokenHash?: string) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only user accounts have sessions.");

  const sessions = await prisma.session.findMany({
    where: { userId: actor.user.id },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
      tokenHash: true,
    },
  });

  return sessions.map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    isCurrent: currentTokenHash ? s.tokenHash === currentTokenHash : false,
  }));
}

export async function revokeUserSession(actor: AppActor, sessionId: string) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only user accounts have sessions.");

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  invariant(session && session.userId === actor.user.id, 404, "NOT_FOUND", "Session not found.");

  await prisma.session.delete({ where: { id: sessionId } });
}

export async function revokeAllOtherSessions(actor: AppActor, currentTokenHash: string) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only user accounts have sessions.");
  invariant(currentTokenHash, 400, "INVALID_INPUT", "Current session token required.");

  await prisma.session.deleteMany({
    where: {
      userId: actor.user.id,
      tokenHash: { not: currentTokenHash },
    },
  });
}

// ------------------------------------------------------------------
// Notification Preferences
// ------------------------------------------------------------------

export async function getUserNotificationPreferences(actor: AppActor) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only user accounts have notification preferences.");

  const prefs = await prisma.notificationPreference.findMany({
    where: { userId: actor.user.id },
  });

  return prefs.map((pref) => (
    pref.channel === "BOTH" ? { ...pref, channel: "IN_APP_EMAIL" } : pref
  ));
}

export async function updateNotificationPreference(actor: AppActor, params: { notifType: string; channel: string }) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only user accounts have notification preferences.");

  invariant(isNotificationPreferenceChannel(params.channel), 400, "INVALID_INPUT", "Invalid notification channel.");

  if (params.channel === "USE_DEFAULT") {
    await prisma.notificationPreference.deleteMany({
      where: {
        userId: actor.user.id,
        notifType: params.notifType,
      },
    });
    return null;
  }

  const pref = await prisma.notificationPreference.upsert({
    where: {
      userId_notifType: {
        userId: actor.user.id,
        notifType: params.notifType,
      },
    },
    update: {
      channel: params.channel,
    },
    create: {
      userId: actor.user.id,
      notifType: params.notifType,
      channel: params.channel,
    },
  });

  return pref;
}

export async function updateMemberNewspaperCadencePreference(
  actor: AppActor,
  params: {
    workspaceId: string;
    cadence: NewspaperCadence | null;
  },
) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only user accounts have newspaper preferences.");

  if (params.cadence !== null) {
    const validCadences = ["DAILY", "WEEKLY", "OFF"];
    invariant(validCadences.includes(params.cadence), 400, "INVALID_INPUT", "Invalid newspaper cadence.");
  }

  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(membership, 403, "NOT_A_MEMBER", "You are not an active member of this workspace.");

  return prisma.member.update({
    where: { id: membership.id },
    data: { newspaperCadence: params.cadence },
    select: {
      id: true,
      newspaperCadence: true,
    },
  });
}
