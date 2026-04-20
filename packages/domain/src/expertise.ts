import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

// Helper function to create a slug
function slugify(text: string) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-") // Replace spaces with -
    .replace(/[^\w-]+/g, "") // Remove all non-word chars
    .replace(/--+/g, "-"); // Replace multiple - with single -
}

export async function listExpertiseTags(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  return prisma.expertiseTag.findMany({
    where: { workspaceId },
    orderBy: { label: "asc" },
  });
}

export async function createExpertiseTag(
  actor: AppActor,
  params: { workspaceId: string; label: string; description?: string }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const label = params.label.trim();
  invariant(label.length > 0, 400, "INVALID_INPUT", "Expertise tag label cannot be empty");

  const baseSlug = slugify(label);
  let slug = baseSlug;
  let counter = 1;

  // Handle slug collisions
  while (await prisma.expertiseTag.findUnique({ where: { workspaceId_slug: { workspaceId: params.workspaceId, slug } } })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return prisma.$transaction(async (tx) => {
    const tag = await tx.expertiseTag.create({
      data: {
        workspaceId: params.workspaceId,
        label,
        slug,
        description: params.description?.trim(),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "expertiseTag.created",
        entityType: "ExpertiseTag",
        entityId: tag.id,
        meta: { label: tag.label, slug: tag.slug },
      },
    });

    return tag;
  });
}

export async function getMemberExpertiseProfile(actor: AppActor, workspaceId: string, memberId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const member = await prisma.member.findFirst({
    where: { id: memberId, workspaceId },
    include: {
      expertise: {
        include: { expertiseTag: true },
        orderBy: { endorsedCount: "desc" },
      },
    },
  });

  invariant(member, 404, "NOT_FOUND", "Member not found");
  return member.expertise;
}

export async function addMemberExpertise(
  actor: AppActor,
  params: { 
    workspaceId: string; 
    memberId: string; 
    tagId: string; 
    level?: "LEARNING" | "PRACTITIONER" | "EXPERT" | "AUTHORITY";
    source?: "SELF" | "AI_INFERRED" | "PEER_ENDORSED";
  }
) {
  // Ensure the actor can only self-declare for themselves unless they are AI (system actor could be added later)
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  
  // Verify member exists in workspace
  const member = await prisma.member.findUnique({
    where: { id: params.memberId },
    select: { workspaceId: true, userId: true },
  });
  invariant(member?.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Member not found");

  if (actor.kind === "user") {
    // A regular user can only self-declare for their own member profile 
    invariant(member.userId === actor.user.id, 403, "FORBIDDEN", "You can only manage your own expertise");
  }

  const source = params.source || "SELF";
  const level = params.level || "PRACTITIONER";

  return prisma.$transaction(async (tx) => {
    const result = await tx.memberExpertise.upsert({
      where: {
        memberId_expertiseTagId: {
          memberId: params.memberId,
          expertiseTagId: params.tagId,
        },
      },
      update: { level },
      create: {
        memberId: params.memberId,
        expertiseTagId: params.tagId,
        level,
        source,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "memberExpertise.added",
        entityType: "MemberExpertise",
        entityId: result.id,
        meta: { tagId: params.tagId, level, source },
      },
    });

    return result;
  });
}

export async function endorseMemberExpertise(
  actor: AppActor,
  params: { workspaceId: string; memberId: string; tagId: string }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  
  // You cannot endorse yourself
  if (actor.kind === "user") {
    const targetMember = await prisma.member.findUnique({ where: { id: params.memberId } });
    invariant(targetMember?.userId !== actor.user.id, 400, "INVALID_ACTION", "You cannot endorse your own expertise");
  }

  return prisma.$transaction(async (tx) => {
    // Ensure the expertise exists first; if not, create it with PEER_ENDORSED source
    let expertise = await tx.memberExpertise.findUnique({
      where: {
        memberId_expertiseTagId: {
          memberId: params.memberId,
          expertiseTagId: params.tagId,
        },
      },
    });

    if (!expertise) {
      expertise = await tx.memberExpertise.create({
        data: {
          memberId: params.memberId,
          expertiseTagId: params.tagId,
          level: "PRACTITIONER",
          source: "PEER_ENDORSED",
          endorsedCount: 1,
        },
      });
    } else {
      expertise = await tx.memberExpertise.update({
        where: { id: expertise.id },
        data: {
          endorsedCount: { increment: 1 },
        },
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "memberExpertise.endorsed",
        entityType: "MemberExpertise",
        entityId: expertise.id,
        meta: { tagId: params.tagId },
      },
    });

    return expertise;
  });
}

export async function findExpertsByTag(actor: AppActor, workspaceId: string, tagSlug: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.memberExpertise.findMany({
    where: {
      expertiseTag: { workspaceId, slug: tagSlug },
    },
    include: {
      member: {
        include: { user: { select: { id: true, displayName: true } } },
      },
      expertiseTag: true,
    },
    orderBy: [
      { endorsedCount: "desc" },
    ],
  });
}
