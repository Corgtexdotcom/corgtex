/**
 * seed-demo-video.ts - demo-video infrastructure seed.
 *
 * Supplements the JNJ demo workspace with data that the base seed
 * doesn't create: goals, agent identities, agent runs with full
 * observability traces, recognitions, and audit logs.
 *
 * Designed to be idempotent - safe to run repeatedly.
 *
 * Usage:
 *   npm run seed:demo-video
 *   # or after running seed:jnj-demo:
 *   npx tsx scripts/seed-demo-video.ts
 */
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const prisma = new PrismaClient();

function uuid() {
  return crypto.randomUUID();
}

async function main() {
  // --- Resolve workspace ---
  const workspace = await prisma.workspace.findUnique({
    where: { slug: "jnj-demo" },
  });
  if (!workspace) {
    throw new Error(
      "Workspace 'jnj-demo' not found. Run `npm run prisma:seed` and `npm run seed:jnj-demo` first."
    );
  }
  const workspaceId = workspace.id;
  console.log(`\nSeeding demo data for workspace: ${workspace.name} (${workspaceId})\n`);

  // --- Resolve existing members ---
  const members = await prisma.member.findMany({
    where: { workspaceId, isActive: true },
    include: { user: { select: { id: true, email: true, displayName: true } } },
  });
  if (members.length < 2) {
    throw new Error("Need at least 2 active members. Run seed:jnj-demo first.");
  }
  const adminMember = members.find((m) => m.role === "ADMIN") ?? members[0];
  console.log(`  Admin: ${adminMember.user.displayName} (${adminMember.user.email})`);
  console.log(`  Total members: ${members.length}`);

  // --- Resolve existing circles ---
  const circles = await prisma.circle.findMany({
    where: { workspaceId, archivedAt: null },
  });
  const firstCircle = circles[0];
  if (!firstCircle) {
    throw new Error("No circles found. Run seed:jnj-demo first.");
  }

  // =====================================================================
  // GOALS - always missing from base seed
  // =====================================================================
  const goalData = [
    {
      title: "Ship Agent Governance v2",
      descriptionMd: "Complete the agent registry, observability traces, spend controls, and access management features.",
      level: "COMPANY" as const,
      cadence: "QUARTERLY" as const,
      status: "ON_TRACK" as const,
      progressPercent: 72,
      targetDate: new Date("2026-06-30"),
    },
    {
      title: "Onboard 5 Enterprise Pilots",
      descriptionMd: "Convert pipeline prospects into active pilot deployments with full governance setup.",
      level: "COMPANY" as const,
      cadence: "QUARTERLY" as const,
      status: "ON_TRACK" as const,
      progressPercent: 40,
      targetDate: new Date("2026-06-30"),
    },
    {
      title: "Reduce Agent Cost per Workspace by 30%",
      descriptionMd: "Optimize model routing, caching, and token budgets to cut per-workspace AI spend.",
      level: "COMPANY" as const,
      cadence: "QUARTERLY" as const,
      status: "ON_TRACK" as const,
      progressPercent: 91,
      targetDate: new Date("2026-05-15"),
    },
  ];

  let goalsCreated = 0;
  for (const [i, g] of goalData.entries()) {
    const existing = await prisma.goal.findFirst({
      where: { workspaceId, title: g.title },
    });
    if (!existing) {
      await prisma.goal.create({
        data: {
          id: uuid(),
          workspaceId,
          title: g.title,
          descriptionMd: g.descriptionMd,
          level: g.level,
          cadence: g.cadence,
          status: g.status,
          progressPercent: g.progressPercent,
          targetDate: g.targetDate,
          ownerMemberId: adminMember.id,
          sortOrder: i,
        },
      });
      goalsCreated++;
    }
  }
  console.log(`  Goals: ${goalsCreated} created (${goalData.length - goalsCreated} already existed)`);

  // =====================================================================
  // AGENT IDENTITIES
  // =====================================================================
  const agentKeys = [
    {
      agentKey: "slack-agent",
      displayName: "Slack Agent",
      purposeMd: "Interprets natural-language Slack messages and converts them into Corgtex work items (actions, tensions, proposals) or answers knowledge queries.",
    },
    {
      agentKey: "daily-digest",
      displayName: "Daily Digest Agent",
      purposeMd: "Synthesizes organizational activity from conversations, Slack, PRs, and meetings into personalized daily briefings for each team member.",
    },
    {
      agentKey: "meeting-summary",
      displayName: "Meeting Summary Agent",
      purposeMd: "Processes meeting transcripts to extract insights, action items, and decisions, then posts summaries to Slack threads.",
    },
    {
      agentKey: "proposal-drafting",
      displayName: "Proposal Drafting Agent",
      purposeMd: "Drafts governance proposals from operator prompts with workspace context and reviewable source grounding.",
    },
    {
      agentKey: "crm-lead-enrichment",
      displayName: "CRM Lead Enrichment Agent",
      purposeMd: "Enriches inbound leads with public data, company profiles, and scoring to prioritize the pipeline.",
    },
  ];

  let agentsCreated = 0;
  for (const ak of agentKeys) {
    await prisma.agentIdentity.upsert({
      where: { workspaceId_agentKey: { workspaceId, agentKey: ak.agentKey } },
      update: { displayName: ak.displayName, purposeMd: ak.purposeMd, isActive: true },
      create: {
        id: uuid(),
        workspaceId,
        agentKey: ak.agentKey,
        displayName: ak.displayName,
        purposeMd: ak.purposeMd,
        memberType: "INTERNAL",
        isActive: true,
      },
    });
    agentsCreated++;
  }
  console.log(`  Agent identities: ${agentsCreated} upserted`);

  // =====================================================================
  // AGENT RUNS - with full observability (tool calls, steps, model usage)
  // =====================================================================
  // Only create if no runs exist yet
  const existingRuns = await prisma.agentRun.count({ where: { workspaceId } });
  let runsCreated = 0;

  if (existingRuns === 0) {
    const now = new Date();
    const agentRunData = [
      {
        agentKey: "daily-digest",
        goal: "Generate personalized daily digest for all workspace members",
        status: "COMPLETED" as const,
        triggerType: "SCHEDULE" as const,
        durationMs: 12400,
        hoursAgo: 14,
      },
      {
        agentKey: "slack-agent",
        goal: "Interpret Slack request and create action: Follow up with APAC vendor",
        status: "COMPLETED" as const,
        triggerType: "EVENT" as const,
        durationMs: 3200,
        hoursAgo: 10,
      },
      {
        agentKey: "meeting-summary",
        goal: "Extract insights from Weekly Operations Sync transcript",
        status: "COMPLETED" as const,
        triggerType: "EVENT" as const,
        durationMs: 8700,
        hoursAgo: 8,
      },
      {
        agentKey: "proposal-drafting",
        goal: "Draft proposal: Async consent for standard governance",
        status: "COMPLETED" as const,
        triggerType: "EVENT" as const,
        durationMs: 4100,
        hoursAgo: 6,
      },
      {
        agentKey: "crm-lead-enrichment",
        goal: "Enrich lead data for Meridian Group using public sources",
        status: "COMPLETED" as const,
        triggerType: "SCHEDULE" as const,
        durationMs: 6500,
        hoursAgo: 4,
      },
      {
        agentKey: "slack-agent",
        goal: "Answer workspace question: What is our current procurement policy?",
        status: "COMPLETED" as const,
        triggerType: "EVENT" as const,
        durationMs: 2800,
        hoursAgo: 2,
      },
      {
        agentKey: "crm-lead-enrichment",
        goal: "Enrich lead data for Horizon Capital Partners",
        status: "WAITING_APPROVAL" as const,
        triggerType: "SCHEDULE" as const,
        durationMs: null,
        hoursAgo: 1,
      },
    ];

    for (const ar of agentRunData) {
      const startedAt = new Date(now.getTime() - ar.hoursAgo * 3600000);
      const completedAt = ar.durationMs
        ? new Date(startedAt.getTime() + ar.durationMs)
        : null;

      const run = await prisma.agentRun.create({
        data: {
          id: uuid(),
          workspaceId,
          agentKey: ar.agentKey,
          goal: ar.goal,
          status: ar.status,
          triggerType: ar.triggerType,
          triggerRef: `demo-seed-${runsCreated}`,
          approvalRequired: ar.status === "WAITING_APPROVAL",
          startedAt,
          completedAt,
          resultJson:
            ar.status === "COMPLETED"
              ? {
                  status: "success",
                  items_processed: Math.floor(Math.random() * 10) + 1,
                }
              : null,
        },
      });

      // Steps for each run
      if (ar.status === "COMPLETED" && ar.durationMs) {
        const stepNames = [
          "Load context",
          "Extract intent",
          "Execute action",
          "Deliver result",
        ];
        for (const [j, name] of stepNames.entries()) {
          const stepDuration = Math.floor(ar.durationMs / stepNames.length);
          await prisma.agentStep.create({
            data: {
              id: uuid(),
              agentRunId: run.id,
              name,
              status: "COMPLETED",
              startedAt: new Date(startedAt.getTime() + j * stepDuration),
              completedAt: new Date(
                startedAt.getTime() + (j + 1) * stepDuration
              ),
              outputJson: { step: j + 1, result: "ok" },
            },
          });
        }

        // Tool calls
        const toolCallNames = [
          "context.load_workspace",
          "model.extract_intent",
          ar.agentKey === "slack-agent"
            ? "slack.post_reply"
            : "corgtex.create_entity",
        ];
        for (const [j, name] of toolCallNames.entries()) {
          const tcDuration =
            Math.floor(Math.random() * (ar.durationMs / 3)) + 100;
          await prisma.agentToolCall.create({
            data: {
              id: uuid(),
              agentRunId: run.id,
              name,
              status: "COMPLETED",
              inputJson: { source: "demo", step: j },
              outputJson: { result: "ok", items: j + 1 },
              startedAt: new Date(startedAt.getTime() + j * 1200),
              completedAt: new Date(
                startedAt.getTime() + j * 1200 + tcDuration
              ),
            },
          });
        }

        // Model usage
        await prisma.modelUsage.create({
          data: {
            id: uuid(),
            workspaceId,
            agentRunId: run.id,
            provider: "openrouter",
            model: "qwen/qwen3-32b",
            taskType: "AGENT",
            inputTokens: Math.floor(Math.random() * 3000) + 500,
            outputTokens: Math.floor(Math.random() * 1500) + 200,
            latencyMs: ar.durationMs,
            estimatedCostUsd: Number(
              (Math.random() * 0.02 + 0.001).toFixed(6)
            ),
          },
        });
      }

      runsCreated++;
    }
    console.log(`  Agent runs: ${runsCreated} created with steps, tool calls, and model usage`);
  } else {
    console.log(`  Agent runs: skipped (${existingRuns} already exist)`);
  }

  // =====================================================================
  // RECOGNITIONS
  // =====================================================================
  const existingRecognitions = await prisma.recognition.count({
    where: { workspaceId },
  });
  if (existingRecognitions === 0 && members.length >= 2) {
    const recipient = adminMember;
    const author = members.find((m) => m.id !== adminMember.id)!;
    await prisma.recognition.create({
      data: {
        id: uuid(),
        workspaceId,
        authorMemberId: author.id,
        recipientMemberId: recipient.id,
        title: "Exceptional Systems Thinking",
        storyMd:
          "For building the agent governance system end-to-end in record time. The observability traces and spend controls give us real confidence in our AI workforce.",
        valueTags: ["INNOVATION", "SPEED", "LEADERSHIP"],
        visibility: "WORKSPACE",
      },
    });
    console.log("  Recognitions: 1 created");
  } else {
    console.log(`  Recognitions: skipped (${existingRecognitions} already exist)`);
  }

  // =====================================================================
  // AUDIT LOGS - recent activity for the Live Activity feed
  // =====================================================================
  const existingAudit = await prisma.auditLog.count({ where: { workspaceId } });
  if (existingAudit < 5) {
    const now = new Date();
    const auditData = [
      { action: "proposal.published", entityType: "Proposal" },
      { action: "action.created", entityType: "Action" },
      { action: "tension.published", entityType: "Tension" },
      { action: "meeting.agenda.posted", entityType: "Meeting" },
      { action: "agent.run.completed", entityType: "AgentRun" },
      { action: "brain.article.updated", entityType: "BrainArticle" },
      { action: "action.status.changed", entityType: "Action" },
      { action: "recognition.created", entityType: "Recognition" },
      { action: "agent.run.waiting_approval", entityType: "AgentRun" },
      { action: "goal.progress.updated", entityType: "Goal" },
    ];
    for (const [i, al] of auditData.entries()) {
      await prisma.auditLog.create({
        data: {
          id: uuid(),
          workspaceId,
          action: al.action,
          entityType: al.entityType,
          entityId: uuid(),
          actorUserId:
            i % 3 === 0 ? adminMember.userId : members[i % members.length].userId,
          createdAt: new Date(now.getTime() - i * 1800000),
        },
      });
    }
    console.log(`  Audit logs: ${auditData.length} created`);
  } else {
    console.log(`  Audit logs: skipped (${existingAudit} already exist)`);
  }

  // =====================================================================
  // Summary
  // =====================================================================
  const counts = {
    articles: await prisma.brainArticle.count({ where: { workspaceId } }),
    actions: await prisma.action.count({ where: { workspaceId } }),
    tensions: await prisma.tension.count({ where: { workspaceId } }),
    proposals: await prisma.proposal.count({ where: { workspaceId } }),
    goals: await prisma.goal.count({ where: { workspaceId } }),
    meetings: await prisma.meeting.count({ where: { workspaceId } }),
    circles: await prisma.circle.count({ where: { workspaceId } }),
    agentRuns: await prisma.agentRun.count({ where: { workspaceId } }),
    agentIdentities: await prisma.agentIdentity.count({ where: { workspaceId } }),
    recognitions: await prisma.recognition.count({ where: { workspaceId } }),
    auditLogs: await prisma.auditLog.count({ where: { workspaceId } }),
  };

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Demo workspace ready: ${workspace.name} (${workspace.slug})`);
  console.log(`${"=".repeat(50)}`);
  Object.entries(counts).forEach(([key, val]) =>
    console.log(`  ${key.padEnd(20)} ${val}`)
  );
  console.log("");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
