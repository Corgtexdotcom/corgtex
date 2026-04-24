// Run with: npx tsx scripts/migrate-to-deliberation.ts
// Idempotent: checks for existing entries before inserting

import { prisma } from "@corgtex/shared";

async function main() {
  // 1. Migrate ProposalReaction → DeliberationEntry (parentType: "PROPOSAL")
  const reactions = await prisma.proposalReaction.findMany({
    include: { proposal: { select: { workspaceId: true } } },
  });
  
  for (const r of reactions) {
    const existing = await prisma.deliberationEntry.findFirst({
      where: { parentType: "PROPOSAL", parentId: r.proposalId, authorUserId: r.userId, createdAt: r.createdAt },
    });
    if (!existing) {
      await prisma.deliberationEntry.create({
        data: {
          workspaceId: r.proposal.workspaceId,
          parentType: "PROPOSAL",
          parentId: r.proposalId,
          authorUserId: r.userId,
          entryType: r.reaction as any,  // Already matches: SUPPORT, OBJECTION, QUESTION, CONCERN, REACTION
          bodyMd: r.bodyMd,
          resolvedAt: r.resolvedAt,
          resolvedNote: r.resolvedNote,
          createdAt: r.createdAt,
        },
      });
    }
  }
  
  // 2. Migrate SpendComment → DeliberationEntry (parentType: "SPEND")
  const comments = await prisma.spendComment.findMany({
    include: { spend: { select: { workspaceId: true } } },
  });
  
  for (const c of comments) {
    const existing = await prisma.deliberationEntry.findFirst({
      where: { parentType: "SPEND", parentId: c.spendId, authorUserId: c.authorUserId, createdAt: c.createdAt },
    });
    if (!existing) {
      await prisma.deliberationEntry.create({
        data: {
          workspaceId: c.spend.workspaceId,
          parentType: "SPEND",
          parentId: c.spendId,
          authorUserId: c.authorUserId,
          entryType: c.isObjection ? "OBJECTION" : "REACTION",
          bodyMd: c.bodyMd,
          resolvedAt: c.resolvedAt,
          createdAt: c.createdAt,
        },
      });
    }
  }
  
  console.log(`Migrated ${reactions.length} proposal reactions and ${comments.length} spend comments.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
