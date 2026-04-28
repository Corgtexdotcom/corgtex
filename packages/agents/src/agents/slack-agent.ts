import type { AgentTriggerType } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { answerKnowledgeQuestion } from "@corgtex/knowledge";
import {
  createWorkItemFromCommunicationSource,
  deliverSlackAgentResponse,
  fetchSlackThreadMessages,
  listMembers,
  type SlackAgentJobPayload,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import type { HumanActor } from "@corgtex/shared";
import { executeAgentRun, asString } from "../runtime";
import { runAdviceRoutingAgent } from "./advice-routing";

type SlackAgentIntent =
  | "brief"
  | "create_action"
  | "create_tension"
  | "create_proposal"
  | "capture_note"
  | "capabilities"
  | "answer_question"
  | "summarize_thread"
  | "unsupported";

type SlackAgentExtraction = {
  intent: SlackAgentIntent;
  confidence: number;
  title: string;
  bodyMd: string;
  assigneeHint: string | null;
  dueDateISO: string | null;
  publish: boolean;
  needsAdviceRouting: boolean;
  answer: string | null;
  couldNot: string[];
  next: string | null;
};

const INTENTS = new Set<SlackAgentIntent>([
  "brief",
  "create_action",
  "create_tension",
  "create_proposal",
  "capture_note",
  "capabilities",
  "answer_question",
  "summarize_thread",
  "unsupported",
]);

const UNSUPPORTED_OPERATION_RE =
  /\b(delete|remove|archive|deactivate|invite|change role|grant|revoke|permission|submit spend|create spend|approve spend|pay|payment|reimburse|expense|notify everyone|broadcast|message everyone)\b/i;

const CAPABILITIES_PROMPT_RE =
  /(^|\b)(help|commands?|capabilities|examples?|what can (you|corgtex) do|how (can|do) i use (you|corgtex)|what does (this|the) slack integration do)(\b|$)/i;

function clampConfidence(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeExtraction(output: Record<string, unknown>, fallbackPrompt: string): SlackAgentExtraction {
  const rawIntent = asString(output.intent) as SlackAgentIntent;
  const intent = INTENTS.has(rawIntent) ? rawIntent : "unsupported";
  const title = asString(output.title) || fallbackPrompt.slice(0, 120) || "Slack request";
  const bodyMd = asString(output.bodyMd) || asString(output.body) || fallbackPrompt;
  const couldNot = Array.isArray(output.couldNot)
    ? output.couldNot.map((entry) => asString(entry)).filter(Boolean)
    : [];

  return {
    intent,
    confidence: clampConfidence(output.confidence),
    title,
    bodyMd,
    assigneeHint: asString(output.assigneeHint) || null,
    dueDateISO: asString(output.dueDateISO) || null,
    publish: Boolean(output.publish ?? output.open),
    needsAdviceRouting: Boolean(output.needsAdviceRouting),
    answer: asString(output.answer) || null,
    couldNot,
    next: asString(output.next) || null,
  };
}

function isUnsupportedOperation(prompt: string, extraction: SlackAgentExtraction) {
  return extraction.intent === "unsupported" || UNSUPPORTED_OPERATION_RE.test(prompt);
}

function isCapabilitiesPrompt(prompt: string) {
  return CAPABILITIES_PROMPT_RE.test(prompt.replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/gi, " "));
}

function renderCapabilitiesResponse() {
  return {
    done: [
      "I can turn plain Slack text into Corgtex work: actions, tensions, proposals, notes, briefs, questions, and thread summaries.",
      "Use `/corgtex ...`, mention `@Corgtex ...`, or use the message shortcut on a Slack message or thread.",
      "When confidence is high, I can create and open/publish supported Corgtex items; when it is lower, I create drafts or ask a clarifying question.",
    ],
    couldNot: [
      "I do not run deletes, role changes, invites, permission changes, spend/payment actions, or broad notifications from Slack.",
    ],
    next: "Try `/corgtex Jan should follow up with Milan tomorrow` or `@Corgtex turn this thread into a proposal`.",
  };
}

function parseDueDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function rawProfileTimezone(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "UTC";
  const raw = value as Record<string, unknown>;
  return asString(raw.tz) || asString(raw.timezone) || "UTC";
}

function renderSlackResponse(params: {
  done: string[];
  couldNot: string[];
  next?: string | null;
}) {
  const done = params.done.length > 0 ? params.done : ["No changes made."];
  const couldNot = params.couldNot.length > 0 ? params.couldNot : ["Nothing."];
  const next = params.next?.trim() || "No follow-up needed.";
  const text = `Done:\n${done.map((item) => `- ${item}`).join("\n")}\n\nCould not:\n${couldNot.map((item) => `- ${item}`).join("\n")}\n\nNext:\n- ${next}`;

  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Done:*\n${done.map((item) => `- ${item}`).join("\n")}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Could not:*\n${couldNot.map((item) => `- ${item}`).join("\n")}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Next:*\n- ${next}` } },
    ],
  };
}

function slackLink(url: string, label: string) {
  return `<${url}|${label.replace(/[<>|]/g, "")}>`;
}

async function loadActor(userId: string): Promise<HumanActor | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, globalRole: true },
  });
  return user ? { kind: "user", user } : null;
}

function matchMemberId(params: {
  assigneeHint: string | null;
  members: Awaited<ReturnType<typeof listMembers>>;
  externalUsers: Array<{
    externalUserId: string;
    userId: string | null;
    memberId: string | null;
    email: string | null;
    displayName: string | null;
  }>;
}) {
  const hint = params.assigneeHint?.trim();
  if (!hint) return { memberId: null, error: null };

  const slackMention = hint.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i);
  if (slackMention) {
    const external = params.externalUsers.find((user) => user.externalUserId === slackMention[1]);
    if (external?.memberId) return { memberId: external.memberId, error: null };
    if (external?.userId) {
      const member = params.members.find((entry) => entry.userId === external.userId);
      if (member) return { memberId: member.id, error: null };
    }
  }

  const normalized = hint.toLowerCase();
  const matches = params.members.filter((member) => {
    const displayName = member.user.displayName?.toLowerCase() ?? "";
    const email = member.user.email.toLowerCase();
    return member.id === hint || member.userId === hint || displayName === normalized || email === normalized;
  });

  if (matches.length === 1) return { memberId: matches[0].id, error: null };
  if (matches.length > 1) return { memberId: null, error: `Assignee "${hint}" matched more than one Corgtex member.` };
  return { memberId: null, error: `Assignee "${hint}" did not match a Corgtex member.` };
}

async function deliverSafely(payload: SlackAgentJobPayload, response: ReturnType<typeof renderSlackResponse>) {
  try {
    await deliverSlackAgentResponse(payload, response);
    return { delivered: true };
  } catch (error) {
    return {
      delivered: false,
      error: error instanceof Error ? error.message : "Unknown Slack delivery error.",
    };
  }
}

export async function runSlackAgent(params: SlackAgentJobPayload & {
  workflowJobId?: string;
  triggerType?: AgentTriggerType;
}) {
  const triggerRef = params.inboundEventId ?? params.sourceMessageId ?? params.workflowJobId ?? `${params.source}:${params.messageTs ?? params.prompt}`;

  return executeAgentRun({
    agentKey: "slack-agent",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef,
    goal: "Interpret a plain Slack request, execute bounded Corgtex work when confident, and reply with what changed.",
    payload: {
      source: params.source,
      prompt: params.prompt,
      channelId: params.channelId ?? null,
      threadTs: params.threadTs ?? null,
      messageTs: params.messageTs ?? null,
      sourceMessageId: params.sourceMessageId ?? null,
    },
    plan: ["load-slack-context", "extract-intent", "execute-safe-work", "reply-in-slack"],
    buildContext: async (helpers) => helpers.tool("slack-context.load", {
      source: params.source,
      sourceMessageId: params.sourceMessageId ?? null,
    }, async () => {
      const [
        actor,
        members,
        externalUser,
        externalUsers,
        openActions,
        openTensions,
        openProposals,
        sourceMessage,
        threadMessages,
      ] = await Promise.all([
        loadActor(params.actorUserId),
        listMembers(params.workspaceId),
        prisma.communicationExternalUser.findUnique({
          where: { installationId_externalUserId: { installationId: params.installationId, externalUserId: params.externalUserId } },
          select: { rawProfile: true },
        }),
        prisma.communicationExternalUser.findMany({
          where: { installationId: params.installationId, workspaceId: params.workspaceId },
          select: { externalUserId: true, userId: true, memberId: true, email: true, displayName: true },
        }),
        prisma.action.findMany({
          where: { workspaceId: params.workspaceId, status: { in: ["OPEN", "IN_PROGRESS"] } },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, title: true, status: true },
        }),
        prisma.tension.findMany({
          where: { workspaceId: params.workspaceId, status: "OPEN" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, title: true, status: true },
        }),
        prisma.proposal.findMany({
          where: { workspaceId: params.workspaceId, status: "OPEN" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, title: true, status: true },
        }),
        params.sourceMessageId
          ? prisma.communicationMessage.findUnique({
            where: { id: params.sourceMessageId },
            select: { id: true, text: true, externalUserId: true, externalChannelId: true, externalMessageId: true, threadExternalId: true },
          })
          : Promise.resolve(null),
        params.channelId && params.threadTs
          ? fetchSlackThreadMessages(params.installationId, { channelId: params.channelId, threadTs: params.threadTs })
          : Promise.resolve([]),
      ]);

      return {
        actor,
        members,
        externalUsers,
        userTimezone: rawProfileTimezone(externalUser?.rawProfile),
        openActions,
        openTensions,
        openProposals,
        sourceMessage,
        threadMessages,
      };
    }),
    execute: async (context, helpers, runId, model) => {
      const actor = context.actor as HumanActor | null;
      if (!actor) {
        const response = renderSlackResponse({
          done: [],
          couldNot: ["I could not match the Slack user to a Corgtex account."],
          next: "Open Corgtex settings and confirm your Slack email matches your Corgtex account.",
        });
        const delivery = await helpers.tool("slack.reply", { reason: "missing_actor" }, () => deliverSafely(params, response));
        return { resultJson: { status: "NO_ACTOR", delivery } };
      }

      if (isCapabilitiesPrompt(params.prompt)) {
        const parts = renderCapabilitiesResponse();
        const response = renderSlackResponse(parts);
        const delivery = await helpers.tool("slack.reply", {
          reason: "capabilities",
          source: params.source,
          channelId: params.channelId ?? null,
          responseUrl: Boolean(params.responseUrlEnc),
        }, () => deliverSafely(params, response));

        return {
          resultJson: {
            intent: "capabilities",
            confidence: 1,
            created: [],
            ...parts,
            delivery,
          },
        };
      }

      const extraction = await helpers.tool("model.extract", { prompt: params.prompt }, async () => defaultModelGateway.extract({
        model,
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId,
        agentRunId: runId,
        instruction: [
          "Classify a plain Slack request for Corgtex.",
          "Return JSON only with intent, confidence, title, bodyMd, assigneeHint, dueDateISO, publish, needsAdviceRouting, answer, couldNot, and next.",
          "Allowed intents: brief, create_action, create_tension, create_proposal, capture_note, capabilities, answer_question, summarize_thread, unsupported.",
          "Use unsupported for destructive, admin, financial, permission, invite, role, delete, archive, payment, or broad-notification requests.",
          "For action due dates, resolve relative dates using the provided userTimezone and current time; otherwise use UTC.",
        ].join(" "),
        schemaHint: "{ intent: string, confidence: number, title: string, bodyMd: string, assigneeHint: string|null, dueDateISO: string|null, publish: boolean, needsAdviceRouting: boolean, answer: string|null, couldNot: string[], next: string|null }",
        input: JSON.stringify({
          now: new Date().toISOString(),
          userTimezone: context.userTimezone ?? "UTC",
          source: params.source,
          prompt: params.prompt,
          selectedMessage: context.sourceMessage ?? null,
          threadMessages: context.threadMessages ?? [],
          members: (context.members as Awaited<ReturnType<typeof listMembers>>).map((member) => ({
            memberId: member.id,
            userId: member.userId,
            displayName: member.user.displayName,
            email: member.user.email,
          })),
          openActions: context.openActions,
          openTensions: context.openTensions,
          openProposals: context.openProposals,
        }),
      }));

      const parsed = normalizeExtraction(extraction.output, params.prompt);
      const done: string[] = [];
      const couldNot = [...parsed.couldNot];
      let next = parsed.next;
      const created: Array<{ entityType: string; entityId: string; webUrl: string; opened: boolean }> = [];

      if (isUnsupportedOperation(params.prompt, parsed)) {
        couldNot.push("That request is outside Slack-agent v1 because it is destructive, administrative, financial, permission-related, or broadly notifying people.");
      } else if (parsed.confidence < 0.55) {
        couldNot.push("I was not confident enough to change Corgtex from that Slack message.");
        next = next ?? "Reply with the item type, owner, and expected outcome.";
      } else if (parsed.intent === "brief") {
        const actions = Array.isArray(context.openActions) ? context.openActions.length : 0;
        const tensions = Array.isArray(context.openTensions) ? context.openTensions.length : 0;
        const proposals = Array.isArray(context.openProposals) ? context.openProposals.length : 0;
        done.push(`Prepared a brief: ${actions} open actions, ${tensions} open tensions, and ${proposals} open proposals.`);
      } else if (parsed.intent === "answer_question") {
        const answer = await helpers.tool("knowledge.answer", { prompt: params.prompt }, () => answerKnowledgeQuestion({
          workspaceId: params.workspaceId,
          question: params.prompt,
          workflowJobId: params.workflowJobId,
          agentRunId: runId,
        }));
        done.push(answer.answer);
      } else if (parsed.intent === "capabilities") {
        const parts = renderCapabilitiesResponse();
        done.push(...parts.done);
        couldNot.push(...parts.couldNot);
        next = next ?? parts.next;
      } else if (parsed.intent === "summarize_thread") {
        const threadMessages = Array.isArray(context.threadMessages) ? context.threadMessages : [];
        if (threadMessages.length === 0) {
          couldNot.push("I could not load thread context to summarize.");
        } else {
          const summary = await helpers.tool("model.chat", { purpose: "summarize_slack_thread" }, () => defaultModelGateway.chat({
            model,
            workspaceId: params.workspaceId,
            workflowJobId: params.workflowJobId,
            agentRunId: runId,
            taskType: "AGENT",
            messages: [
              { role: "system", content: "Summarize this Slack thread concisely for a Corgtex workspace operator. Include decisions, open questions, and action candidates when present." },
              { role: "user", content: JSON.stringify(threadMessages) },
            ],
          }));
          done.push(summary.content);
        }
      } else {
        const members = context.members as Awaited<ReturnType<typeof listMembers>>;
        const assignee = matchMemberId({
          assigneeHint: parsed.assigneeHint,
          members,
          externalUsers: context.externalUsers as Array<{
            externalUserId: string;
            userId: string | null;
            memberId: string | null;
            email: string | null;
            displayName: string | null;
          }>,
        });
        if (assignee.error) couldNot.push(assignee.error);

        const open = parsed.confidence >= 0.8;
        const dueAt = parseDueDate(parsed.dueDateISO);
        const kind = parsed.intent === "create_action"
          ? "ACTION"
          : parsed.intent === "create_tension"
            ? "TENSION"
            : parsed.intent === "create_proposal"
              ? "PROPOSAL"
              : parsed.intent === "capture_note"
                ? "BRAIN_NOTE"
                : null;

        if (!kind) {
          couldNot.push("I could not map that request to a supported Slack-agent v1 action.");
        } else {
          const item = await helpers.tool("corgtex.create", {
            kind,
            title: parsed.title,
            open,
            assigneeMemberId: assignee.memberId,
            dueDateISO: parsed.dueDateISO,
          }, () => createWorkItemFromCommunicationSource(actor, {
            workspaceId: params.workspaceId,
            provider: "SLACK",
            installationId: params.installationId,
            kind,
            title: parsed.title,
            bodyMd: parsed.bodyMd,
            sourceMessageId: params.sourceMessageId ?? null,
            externalUserId: params.externalUserId,
            assigneeMemberId: assignee.memberId,
            dueAt,
            open,
          }));

          created.push(item);
          const state = kind === "BRAIN_NOTE"
            ? "captured"
            : item.opened
              ? "created and opened"
              : "created a private draft";
          done.push(`${state} ${item.entityType} ${slackLink(item.webUrl, parsed.title)}.`);

          if (item.entityType === "Proposal" && item.opened && parsed.needsAdviceRouting) {
            await helpers.tool("advice-routing.start", { proposalId: item.entityId }, () => runAdviceRoutingAgent({
              workspaceId: params.workspaceId,
              proposalId: item.entityId,
              triggerRef: `slack-agent:${runId}:${item.entityId}`,
              triggerType: "EVENT",
            }));
            done.push("Started advice-routing for the proposal.");
          }
        }
      }

      const response = renderSlackResponse({ done, couldNot, next });
      const delivery = await helpers.tool("slack.reply", {
        source: params.source,
        channelId: params.channelId ?? null,
        responseUrl: Boolean(params.responseUrlEnc),
      }, () => deliverSafely(params, response));

      return {
        resultJson: {
          intent: parsed.intent,
          confidence: parsed.confidence,
          created,
          done,
          couldNot,
          next,
          delivery,
        },
      };
    },
  });
}
