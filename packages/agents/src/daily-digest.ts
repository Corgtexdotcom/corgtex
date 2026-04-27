import { prisma, sendEmail } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { defaultModelGateway, resolveModel } from "@corgtex/models";
import { AGENT_REGISTRY, getAgentModelOverride } from "@corgtex/domain";
import { 
  batchIngestDailyConversations, 
  createArticle, 
  listSlackMessagesForDigest,
  updateArticle, 
  rebuildBacklinks 
} from "@corgtex/domain";
import type { BrainArticleType } from "@prisma/client";

export async function runDailyDigest(params: {
  workspaceId: string;
  workflowJobId?: string;
  agentRunId?: string;
  dateISO: string;
  model?: string;
}) {
  const agentActor: AppActor = {
    kind: "agent",
    authProvider: "bootstrap",
    label: "daily-digest-agent",
  };

  const since = new Date(new Date(params.dateISO).getTime() - 24 * 60 * 60 * 1000);
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

  if (sessions.length === 0 && slackMessages.length === 0) {
    return { success: true, message: "No conversations or Slack messages to digest." };
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
    const existingArticle = await prisma.brainArticle.findUnique({
      where: { workspaceId_slug: { workspaceId: params.workspaceId, slug } }
    });

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

    if (existingArticle) {
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
  ].filter(Boolean).join("\n\n---\n\n").slice(0, 12000);

  const digestResult = await defaultModelGateway.chat({
    model,
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    taskType: "AGENT",
    messages: [
      {
        role: "system",
        content: `You are generating a Daily Digest / Newspaper for the workspace based on yesterday's conversations.
Format it as a markdown article containing these sections:
- ✧ Key Decisions Made
- ✓ Action Items Identified
- ▫ Conversation Highlights
- ● Team Pulse (aggregate sentiment)
- △ Emerging Tensions (recurring themes)`
      },
      {
        role: "user",
        content: `Conversations:\n${allTranscripts}\n\nGenerate the digest.`
      }
    ]
  });

  const digestTitle = `Daily Digest - ${params.dateISO.split("T")[0]}`;
  const digestSlug = `digest-${params.dateISO.split("T")[0]}`;

  await createArticle(agentActor, {
    workspaceId: params.workspaceId,
    slug: digestSlug,
    title: digestTitle,
    type: "DIGEST" as BrainArticleType,
    authority: "DRAFT",
    bodyMd: digestResult.content,
  });

  // 5. Rebuild backlinks
  await rebuildBacklinks(agentActor, { workspaceId: params.workspaceId });

  // 6. Send personalized digest emails
  const activeMembers = await prisma.member.findMany({
    where: { workspaceId: params.workspaceId, isActive: true },
    include: { user: { select: { email: true, displayName: true, id: true } } },
  });

  for (const member of activeMembers) {
    const personArticle = await prisma.brainArticle.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId: params.workspaceId,
          slug: `person-${member.user.id}`,
        },
      },
      select: { bodyMd: true },
    });

    const personalizedDigest = await defaultModelGateway.chat({
      model,
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      taskType: "AGENT",
      messages: [
        {
          role: "system",
          content: `Personalize this org-wide digest for a specific team member.
Their profile: ${personArticle?.bodyMd || "No profile available."}
Tailor the opening greeting, highlight items most relevant to them,
and adjust the tone to match their communication preferences.
Output clean HTML suitable for email (use inline styles).`
        },
        {
          role: "user",
          content: `Digest:\n${digestResult.content}\n\nPersonalize for: ${member.user.displayName || member.user.email}`
        }
      ]
    });

    await sendEmail({
      to: member.user.email,
      subject: `✉ ${digestTitle} — Your Personal Briefing`,
      html: personalizedDigest.content,
    });
  }

  return {
    success: true,
    digestSlug,
    processedSessions: sessions.length,
    processedSlackMessages: slackMessages.length,
    updatedProfiles: memberUpdates.length
  };
}
