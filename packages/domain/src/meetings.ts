import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export async function listMeetings(workspaceId: string) {
  return prisma.meeting.findMany({
    where: { workspaceId },
    orderBy: { recordedAt: "desc" },
  });
}

export async function getMeeting(workspaceId: string, meetingId: string) {
  return prisma.meeting.findFirst({
    where: {
      id: meetingId,
      workspaceId,
    },
    include: {
      proposals: {
        include: {
          author: {
            select: {
              displayName: true,
              email: true,
            },
          },
          reactions: true,
          tensions: {
            select: {
              id: true,
              title: true,
              status: true,
            },
          },
          actions: {
            select: {
              id: true,
              title: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
      tensions: {
        include: {
          author: {
            select: {
              displayName: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

export async function getMeetingParticipants(workspaceId: string, participantIds: string[]) {
  return prisma.member.findMany({
    where: {
      workspaceId,
      userId: { in: participantIds },
    },
    include: {
      user: { select: { displayName: true, email: true } },
      roleAssignments: {
        include: {
          role: { select: { name: true } },
        },
      },
    },
  });
}

export async function createMeeting(actor: AppActor, params: {
  workspaceId: string;
  title?: string | null;
  source: string;
  recordedAt: Date;
  transcript?: string | null;
  summaryMd?: string | null;
  participantIds?: string[];
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const source = params.source.trim();
  invariant(source.length > 0, 400, "INVALID_INPUT", "Meeting source is required.");
  invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");

  return prisma.$transaction(async (tx) => {
    const meeting = await tx.meeting.create({
      data: {
        workspaceId: params.workspaceId,
        title: params.title?.trim() || null,
        source,
        recordedAt: params.recordedAt,
        transcript: params.transcript?.trim() || null,
        summaryMd: params.summaryMd?.trim() || null,
        participantIds: (params.participantIds ?? []).map((value) => value.trim()).filter(Boolean),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting.created",
        entityType: "Meeting",
        entityId: meeting.id,
        meta: {
          source: meeting.source,
          recordedAt: meeting.recordedAt.toISOString(),
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "meeting.created",
        aggregateType: "Meeting",
        aggregateId: meeting.id,
        payload: {
          meetingId: meeting.id,
          title: meeting.title,
          source: meeting.source,
        },
      },
    ]);

    return meeting;
  });
}

export async function deleteMeeting(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    const meeting = await tx.meeting.findUnique({
      where: {
        id: params.meetingId,
        workspaceId: params.workspaceId,
      },
    });

    invariant(meeting, 404, "NOT_FOUND", "Meeting not found.");

    await tx.meeting.delete({ where: { id: meeting.id } });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting.deleted",
        entityType: "Meeting",
        entityId: meeting.id,
        meta: { title: meeting.title, source: meeting.source },
      },
    });

    return { id: meeting.id };
  });
}
