import { env, logger, prisma, sendEmail } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { defaultModelGateway, resolveModel } from "@corgtex/models";
import {
  AGENT_REGISTRY,
  getAgentModelOverride,
  getWorkspaceNewspaperCadence,
  instrumentNewspaperHtmlLinks,
  normalizeNewspaperCadence,
  recordNewspaperDelivery,
} from "@corgtex/domain";
import { 
  batchIngestDailyConversations, 
  createArticle, 
  listSlackMessagesForDigest,
  updateArticle, 
  rebuildBacklinks 
} from "@corgtex/domain";
import type { BrainArticleType, NewspaperCadence } from "@prisma/client";
import {
  normalizeNewspaperDigestPayload,
  normalizeNewspaperPersonalizationPayload,
  renderNewspaperDigestMarkdown,
  renderNewspaperEmailHtml,
} from "./newspaper-email";

type DeliveryCadence = Exclude<NewspaperCadence, "OFF">;

const LOOKBACK_DAYS_BY_CADENCE: Record<DeliveryCadence, number> = {
  DAILY: 1,
  WEEKLY: 7,
};

function cadenceLabel(cadence: NewspaperCadence) {
  return cadence === "WEEKLY" ? "Weekly" : "Daily";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function workspaceUrl(workspaceId: string) {
  return `${env.APP_URL.replace(/\/$/, "")}/workspaces/${workspaceId}`;
}

function isDeliveryCadence(cadence: NewspaperCadence): cadence is DeliveryCadence {
  return cadence === "DAILY" || cadence === "WEEKLY";
}

export function buildDemoWelcomeNewspaperHtml(params?: { workspaceName?: string | null }) {
  const workspaceName = escapeHtml(params?.workspaceName?.trim() || "Corgtex");

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f4f1ea;color:#1f1d1a;font-family:Georgia,'Times New Roman',serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ea;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fffaf0;border:1px solid #2d2a24;">
            <tr>
              <td style="padding:24px 28px 12px;border-bottom:3px double #2d2a24;text-align:center;">
                <div style="font-size:12px;letter-spacing:1.6px;text-transform:uppercase;">The ${workspaceName} Edition</div>
                <h1 style="font-size:34px;line-height:1.05;margin:8px 0 6px;font-weight:700;">Welcome to Corgtex</h1>
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;">A first look at your operating picture</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px;">
                <h2 style="font-size:22px;line-height:1.2;margin:0 0 12px;">What Corgtex helps your team do</h2>
                <p style="font-size:16px;line-height:1.6;margin:0 0 18px;">Welcome. This first newspaper is meant to make Corgtex concrete: one calm place to see what is happening, what has been decided, what needs attention, and where work is moving. The goal is not to add another inbox. It is to help your team adopt AI while keeping ownership of context, decisions, handoffs, and human review.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #2d2a24;border-bottom:1px solid #2d2a24;margin:20px 0;">
                  <tr>
                    <td style="padding:16px 0;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Shared company memory</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Important context from conversations, documents, decisions, and operating history becomes easier to find and easier to trust.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 0;border-top:1px solid #c9c0aa;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Decision visibility</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Proposals, approvals, objections, and advice records stay visible so teams know why a choice was made and what changed afterward.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 0;border-top:1px solid #c9c0aa;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Follow-through on work</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Actions, tensions, meetings, goals, and shipped work can be summarized into a practical newspaper that tells each member what matters next.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 0;border-top:1px solid #c9c0aa;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Business visibility</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Practice Ledger finance, budget, and operating activity can live beside the work itself, helping leaders see cost, value, and progress in one operating picture.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 0;border-top:1px solid #c9c0aa;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Ownership and control</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Especially for employee-owned, self-managed, or mission-driven teams, AI should strengthen trust and accountability rather than hide how work gets done.</p>
                    </td>
                  </tr>
                </table>
                <h2 style="font-size:22px;line-height:1.2;margin:0 0 12px;">What to try first</h2>
                <p style="font-size:16px;line-height:1.6;margin:0;">Open the workspace, read the newspaper, then look at the source items behind it. You can add company context to the Organization Brain, invite the people who should share the picture, capture meetings, track actions, and use governance workflows when decisions need a visible path.</p>
                <p style="font-size:15px;line-height:1.6;margin:20px 0 0;"><a href="${env.APP_URL.replace(/\/$/, "")}" style="color:#2d2a24;text-decoration:underline;">Open Corgtex</a> when you are ready to see the operating picture behind the newspaper.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

type BuildArtifactDigestItem = {
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  branchName: string | null;
  title: string;
  summaryMd: string | null;
  status: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
  assets: {
    kind: string;
    label: string;
    captionMd: string | null;
  }[];
};

function formatBuildArtifactDate(value: Date | null) {
  return value ? value.toISOString().split("T")[0] : "unknown date";
}

function formatBuildArtifactDigestItem(item: BuildArtifactDigestItem) {
  const repo = `${item.repositoryOwner}/${item.repositoryName}`;
  const pr = item.pullRequestNumber ? `#${item.pullRequestNumber}` : "unlinked PR";
  const proof = item.assets.length > 0
    ? item.assets.map((asset) => `${asset.label} (${asset.kind})${asset.captionMd ? `: ${asset.captionMd}` : ""}`).join("; ")
    : "No visual proof attached yet.";

  return [
    `- ${item.title} (${repo} ${pr})`,
    item.pullRequestUrl ? `  PR: ${item.pullRequestUrl}` : null,
    item.branchName ? `  Branch: ${item.branchName}` : null,
    `  Last activity: ${formatBuildArtifactDate(item.updatedAt)}`,
    item.mergedAt ? `  Merged: ${formatBuildArtifactDate(item.mergedAt)}` : null,
    item.closedAt && item.status === "CLOSED" ? `  Closed: ${formatBuildArtifactDate(item.closedAt)}` : null,
    item.summaryMd ? `  Plan / description: ${item.summaryMd.slice(0, 800)}` : null,
    `  Visual proof: ${proof}`,
  ].filter(Boolean).join("\n");
}

function formatBuildArtifactDigestInput(items: BuildArtifactDigestItem[]) {
  const active = items.filter((item) => item.status === "OPEN");
  const merged = items.filter((item) => item.status === "MERGED");
  const closed = items.filter((item) => item.status === "CLOSED");
  const sections = [
    active.length > 0 ? `Active PR work:\n${active.map(formatBuildArtifactDigestItem).join("\n\n")}` : null,
    merged.length > 0 ? `Merged PRs / shipped outcomes:\n${merged.map(formatBuildArtifactDigestItem).join("\n\n")}` : null,
    closed.length > 0 ? `Closed without merge:\n${closed.map(formatBuildArtifactDigestItem).join("\n\n")}` : null,
  ];
  return sections.filter(Boolean).join("\n\n");
}

export async function runDailyDigest(params: {
  workspaceId: string;
  workflowJobId?: string;
  agentRunId?: string;
  dateISO: string;
  cadence?: NewspaperCadence;
  model?: string;
}) {
  const agentActor: AppActor = {
    kind: "agent",
    authProvider: "bootstrap",
    label: "daily-digest-agent",
  };

  const cadence = normalizeNewspaperCadence(params.cadence);
  if (!isDeliveryCadence(cadence)) {
    logger.info("newspaper_delivery_skipped", {
      workspaceId: params.workspaceId,
      cadence,
      reason: "cadence_off",
    });
    return {
      success: true,
      message: "Newspaper cadence is off.",
      cadence,
      processedSessions: 0,
      processedSlackMessages: 0,
      updatedProfiles: 0,
      sentEmails: 0,
      failedEmails: 0,
      skippedEmails: 0,
    };
  }

  const workspaceCadence = await getWorkspaceNewspaperCadence(params.workspaceId);
  const activeMembers = await prisma.member.findMany({
    where: { workspaceId: params.workspaceId, isActive: true },
    include: { user: { select: { email: true, displayName: true, id: true } } },
  });
  const recipientMembers = activeMembers.filter((member) => (
    (member.newspaperCadence ?? workspaceCadence) === cadence
  ));

  if (recipientMembers.length === 0) {
    logger.info("newspaper_delivery_skipped", {
      workspaceId: params.workspaceId,
      cadence,
      reason: "no_matching_recipients",
    });
    return {
      success: true,
      message: `No active members configured for the ${cadence.toLowerCase()} newspaper.`,
      cadence,
      processedSessions: 0,
      processedSlackMessages: 0,
      updatedProfiles: 0,
      sentEmails: 0,
      failedEmails: 0,
      skippedEmails: 0,
    };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { name: true },
  });
  const workspaceName = workspace?.name?.trim() || "Corgtex";

  const lookbackDays = LOOKBACK_DAYS_BY_CADENCE[cadence];
  const since = new Date(new Date(params.dateISO).getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const model = params.model ?? resolveModel(
    AGENT_REGISTRY["daily-digest"].defaultModelTier,
    await getAgentModelOverride(params.workspaceId, "daily-digest"),
  );

  // 1. Batch ingest all raw conversations as tier-3 sources
  await batchIngestDailyConversations({
    workspaceId: params.workspaceId,
    since,
  });

  // 2. Load all conversations from past 24h to extract insights and build the digest
  const sessions = await prisma.conversationSession.findMany({
    where: {
      workspaceId: params.workspaceId,
      turns: { some: { createdAt: { gte: since } } }
    },
    include: {
      turns: {
        where: { createdAt: { gte: since } },
        orderBy: { sequenceNumber: "asc" }
      },
      user: {
        select: { id: true, email: true, displayName: true }
      }
    }
  });
  const slackMessages = await listSlackMessagesForDigest(params.workspaceId, since);
  const buildArtifacts = await prisma.buildArtifact.findMany({
    where: {
      workspaceId: params.workspaceId,
      OR: [
        { updatedAt: { gte: since } },
        { mergedAt: { gte: since } },
        { closedAt: { gte: since } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 40,
    select: {
      repositoryOwner: true,
      repositoryName: true,
      pullRequestNumber: true,
      pullRequestUrl: true,
      branchName: true,
      title: true,
      summaryMd: true,
      status: true,
      mergedAt: true,
      closedAt: true,
      updatedAt: true,
      assets: {
        select: {
          kind: true,
          label: true,
          captionMd: true,
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        take: 5,
      },
    },
  });

  if (sessions.length === 0 && slackMessages.length === 0 && buildArtifacts.length === 0) {
    logger.info("newspaper_delivery_skipped", {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      cadence,
      reason: "no_digest_inputs",
    });
    return {
      success: true,
      message: "No conversations, Slack messages, or PR activity to digest.",
      cadence,
      processedSessions: 0,
      processedSlackMessages: 0,
      updatedProfiles: 0,
      sentEmails: 0,
      failedEmails: 0,
      skippedEmails: 0,
    };
  }

  // 3. Extract member insights and update PERSON profiles
  const members = new Map<string, { user: { id: string; email: string; displayName: string | null }; transcripts: string[] }>();
  for (const session of sessions) {
    if (!members.has(session.userId)) {
      members.set(session.userId, { user: session.user!, transcripts: [] });
    }
    const transcript = session.turns.map(t => `User: ${t.userMessage}\nAssistant: ${t.assistantMessage}`).join("\n");
    members.get(session.userId)!.transcripts.push(transcript);
  }

  // Pre-load existing PERSON articles for all conversing members in one query
  // instead of a per-member findUnique inside the loop below. Each slug is read
  // once here and written at most once in its own iteration, so the pre-loop
  // snapshot is equivalent to the previous per-iteration read.
  const memberPersonSlugs = [...members.keys()].map((userId) => `person-${userId}`);
  const existingPersonArticles = memberPersonSlugs.length
    ? await prisma.brainArticle.findMany({
        where: { workspaceId: params.workspaceId, slug: { in: memberPersonSlugs } },
      })
    : [];
  const existingPersonArticlesBySlug = new Map(existingPersonArticles.map((article) => [article.slug, article]));

  const memberUpdates = [];
  for (const [userId, data] of members.entries()) {
    const fullTranscript = data.transcripts.join("\n\n---\n\n").slice(0, 8000); // Take up to 8K chars

    const extraction = await defaultModelGateway.extract({
      model,
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      instruction: `Analyze this user's conversations from the past 24 hours. Extract:
1. Sentiment and mood (e.g., frustrated, excited, neutral)
2. Communication preferences or styles
3. Key concerns, tensions, or blockers they mentioned
4. People dynamics they brought up`,
      schemaHint: `{
        sentiment: string,
        preferences: string[],
        tensions: string[],
        peopleSignals: string[]
      }`,
      input: fullTranscript
    });

    const insights = extraction.output as any;

    const source = await prisma.brainSource.create({
      data: {
        workspaceId: params.workspaceId,
        sourceType: "CONVERSATION_INSIGHT",
        tier: 3,
        content: JSON.stringify(insights, null, 2),
        title: `Daily Insights for ${data.user.displayName || data.user.email} - ${params.dateISO.split("T")[0]}`,
        channel: "daily-digest",
        metadata: { userId, date: params.dateISO },
      }
    });

    // Check if PERSON article exists for this user
    const slug = `person-${userId}`;
    const existingArticle = existingPersonArticlesBySlug.get(slug) ?? null;

    const profileMergeResult = await defaultModelGateway.chat({
      model,
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      taskType: "AGENT",
      messages: [
        {
          role: "system",
          content: `You are maintaining a living user profile.
Here is the current profile:
${existingArticle?.bodyMd || "No profile yet."}

Here are new insights from today's conversations:
${JSON.stringify(insights)}

Produce an updated, complete profile in structured markdown format.
Rules:
- MERGE new information with existing data
- If preferences or mood have CHANGED, update them (don't append contradictions)
- Keep the "Recent Context" section current (remove outdated items)
- Maintain structured section headers exactly (e.g. Identity, Communication Preferences, Current Sentiment, Key Concerns & Tensions, Working Style, Relationship Dynamics, Recent Context)`
        }
      ]
    });

    const newBodyMd = profileMergeResult.content;

    if (existingArticle?.authority && existingArticle.authority !== "DRAFT") {
      logger.info("newspaper_profile_update_skipped", {
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        articleId: existingArticle.id,
        slug,
        reason: "non_draft_article",
      });
    } else if (existingArticle) {
      await updateArticle(agentActor, {
        workspaceId: params.workspaceId,
        slug,
        bodyMd: newBodyMd,
        sourceIds: [...(existingArticle.sourceIds || []), source.id],
        changeSummary: "Daily insight update",
        agentRunId: params.agentRunId ?? null,
      });
    } else {
      await createArticle(agentActor, {
        workspaceId: params.workspaceId,
        slug,
        title: data.user.displayName || data.user.email,
        type: "PERSON" as BrainArticleType,
        authority: "DRAFT",
        bodyMd: `# ${data.user.displayName || data.user.email}\n\n` + newBodyMd,
        sourceIds: [source.id],
      });
    }
    memberUpdates.push({ userId, insights });
  }

  // 4. Generate org-wide Digest
  const conversationTranscripts = sessions.map(s => s.turns.map(t => `${s.user.displayName}: ${t.userMessage}\nAssistant: ${t.assistantMessage}`).join("\n")).join("\n\n---\n\n");
  const slackTranscript = slackMessages.map((message) => {
    const speaker = message.externalUserId ?? "Slack";
    const channel = message.externalChannelId;
    const text = message.text ?? "";
    return `[Slack #${channel}] ${speaker}: ${text}`;
  }).join("\n");
  const allTranscripts = [
    conversationTranscripts ? `Corgtex conversations:\n${conversationTranscripts}` : "",
    slackTranscript ? `Slack public-channel messages:\n${slackTranscript}` : "",
    buildArtifacts.length > 0 ? `Built / PR activity for accomplishments and shipped work:\n${formatBuildArtifactDigestInput(buildArtifacts)}` : "",
  ].filter(Boolean).join("\n\n---\n\n").slice(0, 16000);

  const digestExtraction = await defaultModelGateway.extract({
    model,
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    instruction: `Generate a structured ${cadenceLabel(cadence)} Newspaper for the workspace based on the last ${lookbackDays} day(s) of conversations. Return concise, non-empty section arrays only when the source material supports them.`,
    schemaHint: `{
      intro: string | null,
      keyDecisions: string[],
      actionItems: string[],
      builtWork: string[],
      conversationHighlights: string[],
      teamPulse: string[],
      emergingTensions: string[]
    }`,
    input: allTranscripts,
  });
  const digest = normalizeNewspaperDigestPayload(digestExtraction.output);

  const digestTitle = `${cadenceLabel(cadence)} Newspaper - ${params.dateISO.split("T")[0]}`;
  const digestSlug = `${cadence.toLowerCase()}-newspaper-${params.dateISO.split("T")[0]}`;
  const runKey = params.workflowJobId ?? `${params.workspaceId}:${cadence.toLowerCase()}-newspaper:${params.dateISO.split("T")[0]}`;

  if (digest.sections.length === 0) {
    const reason = "No digest sections generated.";
    logger.info("newspaper_delivery_skipped", {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      cadence,
      reason: "empty_digest_sections",
    });
    for (const member of recipientMembers) {
      await recordNewspaperDelivery({
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        memberId: member.id,
        kind: "MEMBER_NEWSPAPER",
        cadence,
        runKey,
        recipientEmail: member.user.email,
        subject: `${digestTitle} - Your Personal Briefing`,
        status: "SKIPPED",
        error: reason,
      });
    }
    return {
      success: true,
      digestSlug,
      cadence,
      processedSessions: sessions.length,
      processedSlackMessages: slackMessages.length,
      updatedProfiles: memberUpdates.length,
      sentEmails: 0,
      failedEmails: 0,
      skippedEmails: recipientMembers.length,
    };
  }

  const digestBodyMd = renderNewspaperDigestMarkdown({ title: digestTitle, digest });
  const existingDigestArticle = await prisma.brainArticle.findUnique({
    where: {
      workspaceId_slug: {
        workspaceId: params.workspaceId,
        slug: digestSlug,
      },
    },
  });

  if (existingDigestArticle?.authority && existingDigestArticle.authority !== "DRAFT") {
    logger.info("newspaper_digest_article_write_skipped", {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      articleId: existingDigestArticle.id,
      slug: digestSlug,
      reason: "non_draft_article",
    });
  } else if (existingDigestArticle) {
    await updateArticle(agentActor, {
      workspaceId: params.workspaceId,
      slug: digestSlug,
      title: digestTitle,
      bodyMd: digestBodyMd,
      changeSummary: `Regenerated ${cadence.toLowerCase()} newspaper for ${params.dateISO.split("T")[0]}`,
      agentRunId: params.agentRunId ?? null,
    });
  } else {
    await createArticle(agentActor, {
      workspaceId: params.workspaceId,
      slug: digestSlug,
      title: digestTitle,
      type: "DIGEST" as BrainArticleType,
      authority: "DRAFT",
      bodyMd: digestBodyMd,
    });
  }

  // 5. Rebuild backlinks
  await rebuildBacklinks(agentActor, { workspaceId: params.workspaceId });

  // 6. Send personalized digest emails
  let sentEmails = 0;
  let failedEmails = 0;
  let skippedEmails = 0;

  // Pre-load recipient PERSON profiles in one query (after the profile-rebuild
  // writes above, so freshly-updated profiles are reflected) instead of a
  // per-recipient findUnique inside the loop below.
  const recipientPersonSlugs = recipientMembers.map((member) => `person-${member.user.id}`);
  const recipientPersonArticles = recipientPersonSlugs.length
    ? await prisma.brainArticle.findMany({
        where: { workspaceId: params.workspaceId, slug: { in: recipientPersonSlugs } },
        select: { slug: true, bodyMd: true },
      })
    : [];
  const recipientPersonArticleBySlug = new Map(recipientPersonArticles.map((article) => [article.slug, article]));

  for (const member of recipientMembers) {
    const personArticle = recipientPersonArticleBySlug.get(`person-${member.user.id}`) ?? null;

    const personalizationExtraction = await defaultModelGateway.extract({
      model,
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      instruction: `Personalize this structured newspaper for a specific member. Return short text fields only; do not return HTML.`,
      schemaHint: `{
        greeting: string | null,
        intro: string | null,
        memberNote: string | null,
        emphasizedSectionIds: string[]
      }`,
      input: JSON.stringify({
        recipient: member.user.displayName || member.user.email,
        profile: personArticle?.bodyMd || "No profile available.",
        digest,
      }),
    });
    const personalization = normalizeNewspaperPersonalizationPayload(personalizationExtraction.output);

    const subject = `${digestTitle} - Your Personal Briefing`;
    const html = await instrumentNewspaperHtmlLinks({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      runKey,
      html: renderNewspaperEmailHtml({
        title: digestTitle,
        workspaceName,
        recipientName: member.user.displayName || member.user.email,
        workspaceUrl: workspaceUrl(params.workspaceId),
        digest,
        personalization,
      }),
    });

    try {
      const emailResult = await sendEmail({
        to: member.user.email,
        subject,
        html,
      });
      if (emailResult.status === "SENT") {
        sentEmails++;
        await recordNewspaperDelivery({
          workspaceId: params.workspaceId,
          workflowJobId: params.workflowJobId ?? null,
          memberId: member.id,
          kind: "MEMBER_NEWSPAPER",
          cadence,
          runKey,
          recipientEmail: member.user.email,
          subject,
          status: "SENT",
          providerMessageId: emailResult.providerMessageId,
        });
      } else {
        skippedEmails++;
        await recordNewspaperDelivery({
          workspaceId: params.workspaceId,
          workflowJobId: params.workflowJobId ?? null,
          memberId: member.id,
          kind: "MEMBER_NEWSPAPER",
          cadence,
          runKey,
          recipientEmail: member.user.email,
          subject,
          status: "SKIPPED",
          error: emailResult.reason,
        });
      }
    } catch (error) {
      failedEmails++;
      const message = error instanceof Error ? error.message : "Unknown email error";
      await recordNewspaperDelivery({
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        memberId: member.id,
        kind: "MEMBER_NEWSPAPER",
        cadence,
        runKey,
        recipientEmail: member.user.email,
        subject,
        status: "FAILED",
        error: message,
      });
      logger.error("newspaper_delivery_failed", {
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        cadence,
        memberId: member.id,
        error: message,
      });
    }
  }

  logger.info("newspaper_delivery_completed", {
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId ?? null,
    cadence,
    recipients: recipientMembers.length,
    sentEmails,
    failedEmails,
    skippedEmails,
  });

  return {
    success: true,
    digestSlug,
    cadence,
    processedSessions: sessions.length,
    processedSlackMessages: slackMessages.length,
    updatedProfiles: memberUpdates.length,
    sentEmails,
    failedEmails,
    skippedEmails,
  };
}

export async function sendDemoWelcomeNewspaper(params: {
  workspaceId: string;
  demoLeadId: string;
  workflowJobId?: string;
}) {
  const lead = await prisma.demoLead.findFirst({
    where: {
      id: params.demoLeadId,
      workspaceId: params.workspaceId,
    },
    include: {
      workspace: { select: { name: true } },
    },
  });

  if (!lead) {
    return { success: true, skipped: true, message: "Demo lead not found." };
  }

  if (lead.welcomeEmailSentAt) {
    return { success: true, skipped: true, message: "Welcome newspaper already sent." };
  }

  const subject = "Welcome to Corgtex - your first newspaper";
  const runKey = params.workflowJobId ?? `demo-welcome:${lead.id}`;
  const html = await instrumentNewspaperHtmlLinks({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId ?? null,
    runKey,
    html: buildDemoWelcomeNewspaperHtml({ workspaceName: lead.workspace.name }),
  });
  let deliveryStatus: "SENT" | "SKIPPED" = "SENT";
  let providerMessageId: string | null = null;
  let deliveryError: string | null = null;

  try {
    const emailResult = await sendEmail({
      to: lead.email,
      subject,
      html,
    });
    if (emailResult.status === "SENT") {
      providerMessageId = emailResult.providerMessageId;
    } else {
      deliveryStatus = "SKIPPED";
      deliveryError = emailResult.reason;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown email error";
    await recordNewspaperDelivery({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      demoLeadId: lead.id,
      kind: "DEMO_WELCOME",
      runKey,
      recipientEmail: lead.email,
      subject,
      status: "FAILED",
      error: message,
    });
    logger.error("newspaper_delivery_failed", {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      kind: "DEMO_WELCOME",
      demoLeadId: lead.id,
      error: message,
    });
    throw error;
  }

  await prisma.$transaction(async (tx) => {
    await tx.demoLead.update({
      where: { id: lead.id },
      data: { welcomeEmailSentAt: new Date() },
    });

    await tx.crmActivity.create({
      data: {
        workspaceId: params.workspaceId,
        contactId: lead.convertedContactId,
        type: "EMAIL",
        title: "Sent welcome newspaper",
        bodyMd: [
          "Sent the Corgtex welcome newspaper.",
          "",
          "The email introduced the Corgtex newspaper as a first operating picture for shared memory, decisions, actions, meetings, company context, ownership and control, and human-reviewed AI work.",
        ].join("\n"),
      },
    });

    const now = new Date();
    await tx.newspaperDelivery.create({
      data: {
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        demoLeadId: lead.id,
        kind: "DEMO_WELCOME",
        runKey,
        recipientEmail: lead.email,
        subject,
        status: deliveryStatus,
        providerMessageId,
        error: deliveryError,
        sentAt: deliveryStatus === "SENT" ? now : null,
        skippedAt: deliveryStatus === "SKIPPED" ? now : null,
      },
    });
  });

  logger.info("newspaper_delivery_completed", {
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId ?? null,
    kind: "DEMO_WELCOME",
    demoLeadId: lead.id,
    status: deliveryStatus,
  });

  return { success: true, skipped: false };
}
