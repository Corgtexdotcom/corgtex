import { assertMeetingTranscriptWorkerCurrent } from "./native-meeting-workflow-principal";
import { createHash, randomUUID } from "node:crypto";
import { CrmActivityType, type MeetingInsight, type OAuthProvider, type Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, readableArtifactIds, recordArtifactInputLineage, type LineageInput, type LineageRoot } from "./source-lineage";
import { readCrmRows } from "./crm-lineage";
import { meetingTranscriptInputProjection } from "./meeting-intelligence-context";
import { lockCrmLinkClosure } from "./crm-archive-guards";
import { invariant } from "./errors";

const CRM_EMAIL_SOURCE = "oauth_email";
const CRM_CALENDAR_SOURCE = "oauth_calendar";
const CRM_MEETING_INTELLIGENCE_SOURCE = "meeting_intelligence";

const FREE_EMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
]);

type EmailTouchpoint = {
  id: string;
  provider: OAuthProvider;
  subject: string;
  from: string | null;
  receivedAt: Date | null;
  webUrl: string | null;
  snippet: string;
  filter: string;
};

type CalendarTouchpoint = {
  id: string;
  provider: OAuthProvider;
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  attendees: string[];
  organizerEmail: string | null;
  meetingUrl: string | null;
  htmlLink: string | null;
  status: string | null;
};

type RelationshipMatch = {
  accountId: string | null;
  accountName: string | null;
  contactId: string | null;
  contactName: string | null;
  email: string;
  company: string | null;
  domain: string | null;
};

type CrmInsightPayload = {
  recordType?: string;
  email?: string | null;
  name?: string | null;
  company?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  dealTitle?: string | null;
  valueCents?: number | null;
  currency?: string | null;
  activityType?: string | null;
  source?: string | null;
};

function normalizedDomain(value: string | null | undefined) {
  const domain = value
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    ?.replace(/:\d+$/, "");
  return domain && domain.includes(".") ? domain : null;
}

export function parseEmailAddress(value: string | null | undefined) {
  const raw = value?.trim();
  if (!raw) return null;
  const angleMatch = raw.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  const candidate = (angleMatch?.[1] ?? raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0])?.toLowerCase();
  return candidate && candidate.includes("@") ? candidate : null;
}

function emailDomain(email: string | null | undefined) {
  const parsed = parseEmailAddress(email);
  if (!parsed) return null;
  return normalizedDomain(parsed.split("@")[1]);
}

function isBusinessDomain(domain: string | null | undefined) {
  const normalized = normalizedDomain(domain);
  return Boolean(normalized && !FREE_EMAIL_DOMAINS.has(normalized));
}

function titleFromDomain(domain: string) {
  const root = domain.split(".")[0] || domain;
  return root
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || domain;
}

function validDate(value: Date | null | undefined) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function sourceExternalId(prefix: string, connectionId: string, provider: OAuthProvider, id: string) {
  return `${prefix}:${connectionId}:${provider.toLowerCase()}:${id}`;
}

export function isSafeCrmEmailFilter(filter: string | null | undefined) {
  const trimmed = filter?.trim();
  if (!trimmed) return false;
  const clauses = [...trimmed.matchAll(/\b(?:from|to|cc|bcc):(?:"([^"]+)"|'([^']+)'|([^\s)]+))/gi)];
  return clauses.some((match) => {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    const parsed = parseEmailAddress(token);
    const domain = parsed ? emailDomain(parsed) : normalizedDomain(token.replace(/^@/, ""));
    return isBusinessDomain(domain);
  });
}

export function safeCrmEmailFilters(filters: string[]) {
  const seen = new Set<string>();
  const safe: string[] = [];
  for (const filter of filters) {
    const trimmed = filter.trim();
    if (!trimmed || !isSafeCrmEmailFilter(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push(trimmed);
  }
  return safe;
}

async function findRelationshipMatch(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  rawEmail: string | null | undefined,
): Promise<RelationshipMatch | null> {
  const email = parseEmailAddress(rawEmail);
  if (!email) return null;
  const domain = emailDomain(email);

  const contact = await tx.crmContact.findFirst({
    where: {
      workspaceId,
      email,
      archivedAt: null,
      OR: [{ accountId: null }, { account: { archivedAt: null } }],
    },
    select: {
      id: true,
      name: true,
      email: true,
      company: true,
      account: { select: { id: true, name: true, domain: true } },
    },
  });
  if (contact) {
    return {
      accountId: contact.account?.id ?? null,
      accountName: contact.account?.name ?? null,
      contactId: contact.id,
      contactName: contact.name,
      email: contact.email,
      company: contact.company,
      domain: contact.account?.domain ?? domain,
    };
  }

  if (!isBusinessDomain(domain)) return null;
  const account = await tx.crmAccount.findFirst({
    where: { workspaceId, domain, archivedAt: null },
    select: { id: true, name: true, domain: true },
  });
  if (!account) return null;

  return {
    accountId: account.id,
    accountName: account.name,
    contactId: null,
    contactName: null,
    email,
    company: account.name,
    domain: account.domain ?? domain,
  };
}

function emailActivityBody(message: EmailTouchpoint, fromEmail: string) {
  return [
    `From: ${fromEmail}`,
    message.receivedAt ? `Received: ${message.receivedAt.toISOString()}` : null,
    message.webUrl ? `Source: ${message.webUrl}` : null,
    "",
    message.snippet.trim(),
  ].filter((entry) => entry !== null).join("\n");
}

function calendarActivityBody(event: CalendarTouchpoint) {
  return [
    event.description?.trim() || null,
    `Starts: ${event.startTime.toISOString()}`,
    `Ends: ${event.endTime.toISOString()}`,
    event.organizerEmail ? `Organizer: ${event.organizerEmail}` : null,
    event.attendees.length > 0 ? `Attendees: ${event.attendees.join(", ")}` : null,
    event.meetingUrl ? `Meeting URL: ${event.meetingUrl}` : null,
    event.htmlLink ? `Calendar link: ${event.htmlLink}` : null,
  ].filter(Boolean).join("\n");
}

async function existingActivityBatch(tx: Prisma.TransactionClient, workspaceId: string, source: string, externalIds: string[]) {
  const activities = await tx.crmActivity.findMany({ where: { workspaceId, source, sourceExternalId: { in: [...new Set(externalIds)] } },
    select: { id: true, sourceExternalId: true }, orderBy: { id: "asc" } });
  return new Map(activities.map((activity) => [activity.sourceExternalId, activity]));
}

async function isActiveRelationshipMatch(tx: Prisma.TransactionClient, workspaceId: string, match: RelationshipMatch) {
  if (match.contactId) return Boolean(await tx.crmContact.findFirst({ where: {
    id: match.contactId, workspaceId, email: match.email, archivedAt: null,
    ...(match.accountId ? { accountId: match.accountId, account: { archivedAt: null } } : { accountId: null }),
  }, select: { id: true } }));
  return Boolean(match.accountId && await tx.crmAccount.findFirst({
    where: { id: match.accountId, workspaceId, domain: match.domain, archivedAt: null }, select: { id: true },
  }));
}

export async function materializeCrmEmailTouchpoints(params: {
  workspaceId: string;
  connectionId: string;
  messages: EmailTouchpoint[];
}) {
  const safeFilters = new Set(safeCrmEmailFilters(params.messages.map((message) => message.filter)).map((filter) => filter.toLowerCase()));
  const summary = {
    scanned: params.messages.length,
    skippedUnsafeFilter: 0,
    skippedUnmatched: 0,
    activitiesCreated: 0,
    activitiesUpdated: 0,
    conversationsCreated: 0,
    conversationsUpdated: 0,
  };

  await prisma.$transaction(async (tx) => {
    const externalIds = params.messages.filter((message) => safeFilters.has(message.filter.trim().toLowerCase()))
      .map((message) => sourceExternalId("oauth-email", params.connectionId, message.provider, message.id));
    const existingActivities = await existingActivityBatch(tx, params.workspaceId, CRM_EMAIL_SOURCE, externalIds);
    const matched: Array<{ message: EmailTouchpoint; fromEmail: string; match: RelationshipMatch; externalId: string }> = [];
    for (const message of params.messages) {
      if (!safeFilters.has(message.filter.trim().toLowerCase())) {
        summary.skippedUnsafeFilter += 1;
        continue;
      }
      const fromEmail = parseEmailAddress(message.from);
      const match = await findRelationshipMatch(tx, params.workspaceId, fromEmail);
      if (!fromEmail || !match) {
        summary.skippedUnmatched += 1;
        continue;
      }
      const externalId = sourceExternalId("oauth-email", params.connectionId, message.provider, message.id);
      matched.push({ message, fromEmail, match, externalId });
    }
    await lockCrmLinkClosure(tx, params.workspaceId, ...[...existingActivities.values()].map(({ id }) => ({ activityId: id })),
      ...matched.map(({ match }) => ({ contactId: match.contactId, accountId: match.accountId })));
    for (const { message, fromEmail, match, externalId } of matched) {
      if (!await isActiveRelationshipMatch(tx, params.workspaceId, match)) {
        summary.skippedUnmatched += 1;
        continue;
      }
      const occurredAt = validDate(message.receivedAt);
      const existingActivity = existingActivities.get(externalId);
      const activityData = {
        accountId: match.accountId,
        contactId: match.contactId,
        title: `Email: ${message.subject.trim() || "Untitled email"}`,
        bodyMd: emailActivityBody(message, fromEmail),
        type: CrmActivityType.EMAIL,
        sourceUrl: message.webUrl,
        sourceOccurredAt: occurredAt,
      };
      if (existingActivity) {
        const updated = await tx.crmActivity.updateMany({
          where: { id: existingActivity.id, workspaceId: params.workspaceId, archivedAt: null },
          data: activityData,
        });
        summary.activitiesUpdated += updated.count;
      } else {
        const created = await tx.crmActivity.create({
          data: {
            workspaceId: params.workspaceId,
            ...activityData,
            source: CRM_EMAIL_SOURCE,
            sourceExternalId: externalId,
          },
        });
        existingActivities.set(externalId, created);
        summary.activitiesCreated += 1;
      }

      const existingConversation = await tx.crmConversation.findUnique({
        where: {
          workspaceId_source_sourceExternalId: {
            workspaceId: params.workspaceId,
            source: CRM_EMAIL_SOURCE,
            sourceExternalId: externalId,
          },
        },
        select: { id: true },
      });
      const conversationData = {
        accountId: match.accountId,
        contactId: match.contactId,
        subject: message.subject.trim() || "Untitled email",
        sourceUrl: message.webUrl,
        sourceOccurredAt: occurredAt,
      };
      if (existingConversation) {
        await tx.crmConversation.update({ where: { id: existingConversation.id }, data: conversationData });
        summary.conversationsUpdated += 1;
      } else {
        await tx.crmConversation.create({
          data: {
            workspaceId: params.workspaceId,
            ...conversationData,
            source: CRM_EMAIL_SOURCE,
            sourceExternalId: externalId,
            messages: {
              create: {
                senderType: "LEAD",
                senderEmail: fromEmail,
                bodyMd: message.snippet.trim(),
                ...(occurredAt ? { createdAt: occurredAt } : {}),
              },
            },
          },
        });
        summary.conversationsCreated += 1;
      }
    }
  });

  return summary;
}

export async function materializeCrmCalendarTouchpoints(params: {
  workspaceId: string;
  connectionId: string;
  events: CalendarTouchpoint[];
}) {
  const summary = {
    scanned: params.events.length,
    skippedCancelled: 0,
    skippedUnmatched: 0,
    activitiesCreated: 0,
    activitiesUpdated: 0,
  };

  await prisma.$transaction(async (tx) => {
    const externalIds = params.events.filter((event) => event.status?.toLowerCase() !== "cancelled")
      .map((event) => sourceExternalId("oauth-calendar", params.connectionId, event.provider, event.id));
    const existingActivities = await existingActivityBatch(tx, params.workspaceId, CRM_CALENDAR_SOURCE, externalIds);
    const matched: Array<{ event: CalendarTouchpoint; match: RelationshipMatch; externalId: string }> = [];
    for (const event of params.events) {
      if (event.status?.toLowerCase() === "cancelled") {
        summary.skippedCancelled += 1;
        continue;
      }
      const candidates = [event.organizerEmail, ...event.attendees].filter(Boolean) as string[];
      let match: RelationshipMatch | null = null;
      for (const email of candidates) {
        match = await findRelationshipMatch(tx, params.workspaceId, email);
        if (match) break;
      }
      if (!match) {
        summary.skippedUnmatched += 1;
        continue;
      }
      const externalId = sourceExternalId("oauth-calendar", params.connectionId, event.provider, event.id);
      matched.push({ event, match, externalId });
    }
    await lockCrmLinkClosure(tx, params.workspaceId, ...[...existingActivities.values()].map(({ id }) => ({ activityId: id })),
      ...matched.map(({ match }) => ({ contactId: match.contactId, accountId: match.accountId })));
    for (const { event, match, externalId } of matched) {
      if (!await isActiveRelationshipMatch(tx, params.workspaceId, match)) {
        summary.skippedUnmatched += 1;
        continue;
      }
      const existingActivity = existingActivities.get(externalId);
      const activityData = {
        accountId: match.accountId,
        contactId: match.contactId,
        title: `Meeting: ${event.title.trim() || "Untitled event"}`,
        bodyMd: calendarActivityBody(event),
        type: CrmActivityType.MEETING,
        sourceUrl: event.htmlLink ?? event.meetingUrl,
        sourceOccurredAt: event.startTime,
      };
      if (existingActivity) {
        const updated = await tx.crmActivity.updateMany({
          where: { id: existingActivity.id, workspaceId: params.workspaceId, archivedAt: null },
          data: activityData,
        });
        summary.activitiesUpdated += updated.count;
      } else {
        const created = await tx.crmActivity.create({
          data: {
            workspaceId: params.workspaceId,
            ...activityData,
            source: CRM_CALENDAR_SOURCE,
            sourceExternalId: externalId,
          },
        });
        existingActivities.set(externalId, created);
        summary.activitiesCreated += 1;
      }
    }
  });

  return summary;
}

function meetingInsightDedupeKey(parts: string[]) {
  const raw = parts.map((part) => part.toLowerCase().replace(/\s+/g, " ").trim()).join("|");
  return `crm:${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

function externalParticipantEmails(meeting: { participantEmails: string[] }) {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const value of meeting.participantEmails) {
    const email = parseEmailAddress(value);
    const domain = emailDomain(email);
    if (!email || !isBusinessDomain(domain) || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

function hasOpportunitySignal(text: string) {
  return /\b(pilot|proposal|opportunity|deal|contract|budget|pricing|procurement|purchase|client|customer)\b/i.test(text);
}

function hasFollowUpSignal(text: string) {
  return /\b(follow up|next step|send|schedule|circle back|check in|reach out|reply|email)\b/i.test(text);
}

function crmMetadata(crm: CrmInsightPayload): Prisma.InputJsonValue {
  return { crm } as Prisma.InputJsonValue;
}

export async function createCrmMeetingReviewInsights(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const original = await prisma.meeting.findFirst({ where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null } });
  if (!original) return [] as MeetingInsight[];
  const hasSummary = (await readableArtifactIds(actor, params.workspaceId, "Meeting", [original])).has(original.id);
  const raw = meetingTranscriptInputProjection(original) as Record<string, unknown> & { id: string };
  if (!(await readableArtifactIds(actor, params.workspaceId, "MeetingTranscript", [raw])).has(original.id)) return [] as MeetingInsight[];
  const meeting = { ...original, summaryMd: hasSummary ? original.summaryMd : null };
  const initialInputs = [{ kind: hasSummary ? "Meeting" as const : "MeetingTranscript" as const, id: meeting.id,
    snapshot: hasSummary ? original : raw }];
  const initialRoots = await captureArtifactInputProof(actor, params.workspaceId, initialInputs);
  const text = [meeting.title, meeting.summaryMd, meeting.transcript].filter(Boolean).join("\n\n");
  const emails = externalParticipantEmails(meeting);
  if (emails.length === 0) return [] as MeetingInsight[];

  return prisma.$transaction(async (tx) => {
    await assertMeetingTranscriptWorkerCurrent(actor, params.workspaceId, tx);
    await tx.$queryRaw`SELECT id FROM "Meeting" WHERE id = ${meeting.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const current = await tx.meeting.findFirst({ where: { id: meeting.id, workspaceId: params.workspaceId, archivedAt: null } });
    invariant(current && lineageContentFingerprint("Meeting", current) === lineageContentFingerprint("Meeting", original),
      409, "SOURCE_CHANGED", "Meeting changed while gathering CRM suggestions.");
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, initialRoots, tx),
      409, "SOURCE_CHANGED", "Meeting CRM inputs changed before persistence.");
    const created: MeetingInsight[] = [];
    const matches: RelationshipMatch[] = [];
    const inputs: LineageInput[] = initialInputs.map(({ kind, id }) => ({ kind, id }));
    const roots: LineageRoot[] = [...initialRoots];
    const capture = async (kind: "CrmContact" | "CrmAccount", row: Record<string, unknown> & { id: string }) => {
      const input = { kind, id: row.id };
      roots.push(...await captureArtifactInputProof(actor, params.workspaceId, [{ ...input, snapshot: row }], tx));
      inputs.push(input);
    };
    const matchedRelationship = async (email: string): Promise<RelationshipMatch | null> => {
      const contact = await tx.crmContact.findFirst({ where: { workspaceId: params.workspaceId, email, archivedAt: null,
        OR: [{ accountId: null }, { account: { archivedAt: null } }] }, include: { account: true } });
      if (contact && (await readableArtifactIds(actor, params.workspaceId, "CrmContact", [contact], tx)).has(contact.id)
        && (!contact.account || (await readableArtifactIds(actor, params.workspaceId, "CrmAccount", [contact.account], tx)).has(contact.account.id))) {
        await capture("CrmContact", contact);
        if (contact.account) await capture("CrmAccount", contact.account);
        return { accountId: contact.account?.id ?? null, accountName: contact.account?.name ?? null,
          contactId: contact.id, contactName: contact.name, email: contact.email, company: contact.company,
          domain: contact.account?.domain ?? emailDomain(email) };
      }
      const domain = emailDomain(email);
      if (!isBusinessDomain(domain)) return null;
      const account = await tx.crmAccount.findFirst({ where: { workspaceId: params.workspaceId, domain, archivedAt: null } });
      if (!account || !(await readableArtifactIds(actor, params.workspaceId, "CrmAccount", [account], tx)).has(account.id)) return null;
      await capture("CrmAccount", account);
      return { accountId: account.id, accountName: account.name, contactId: null, contactName: null,
        email, company: account.name, domain: account.domain ?? domain };
    };
    const outcomes: Array<{ email: string; match: RelationshipMatch | null; account: Awaited<ReturnType<typeof tx.crmAccount.findFirst>> }> = [];
    for (const email of emails) {
      const match = await matchedRelationship(email);
      if (match) {
        matches.push(match);
        outcomes.push({ email, match, account: null });
        continue;
      }
      const domain = emailDomain(email);
      const candidateAccount = domain
        ? await tx.crmAccount.findFirst({
          where: { workspaceId: params.workspaceId, domain, archivedAt: null },
        })
        : null;
      const account = candidateAccount && (await readableArtifactIds(actor, params.workspaceId, "CrmAccount", [candidateAccount], tx)).has(candidateAccount.id) ? candidateAccount : null;
      if (account) await capture("CrmAccount", account);
      outcomes.push({ email, match: null, account });
    }
    const receiptState = createHash("sha256").update(JSON.stringify([...new Map(roots.map((root) => [`${root.kind}:${root.id}:${root.fingerprint}`, root])).values()]
      .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)))).digest("hex");
    const activeKeys: string[] = [];
    const keyFor = async (parts: string[]) => {
      const base = meetingInsightDedupeKey(["receipt-v1", receiptState, ...parts]);
      const priorRows = await readCrmRows(actor, params.workspaceId, "MeetingInsight", (page) => tx.meetingInsight.findMany({
        where: { workspaceId: params.workspaceId, meetingId: meeting.id,
          OR: [{ dedupeKey: base }, { dedupeKey: { startsWith: `${base}:` } }] },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page,
      }), tx);
      const prior = priorRows.find((row) => row.supersededAt == null);
      // Unknown prior bodies never affect the generated body or visible replay counts.
      const key = prior?.dedupeKey ?? `${base}:${randomUUID()}`;
      activeKeys.push(key);
      return key;
    };
    for (const { email, match, account } of outcomes) {
      if (match) continue;
      const domain = emailDomain(email);
      const company = account?.name ?? (domain ? titleFromDomain(domain) : null);
      const dedupeKey = await keyFor([meeting.id, "crm-contact", email]);
      const count = await tx.meetingInsight.createMany({
        data: [{
          workspaceId: params.workspaceId,
          meetingId: meeting.id,
          type: "CRM_CONTACT",
          status: "SUGGESTED",
          title: `Review CRM contact for ${email}`,
          bodyMd: [
            `Meeting participant ${email} is not yet a CRM contact.`,
            company ? `Suggested company: ${company}` : null,
            "Approve this to create a relationship contact. No email will be sent.",
          ].filter(Boolean).join("\n\n"),
          confidence: account ? 0.78 : 0.62,
          sourceQuote: email,
          dedupeKey,
          sourceRecordedAt: meeting.recordedAt,
          metadataJson: crmMetadata({
            recordType: "CRM_CONTACT",
            email,
            company,
            accountId: account?.id ?? null,
            source: CRM_MEETING_INTELLIGENCE_SOURCE,
          }),
        }],
        skipDuplicates: true,
      });
      if (count.count > 0) {
        const insight = await tx.meetingInsight.findFirst({ where: { workspaceId: params.workspaceId, meetingId: meeting.id, dedupeKey } });
        if (insight) created.push(insight);
      }
    }

    const persist = async () => {
      await tx.meetingInsight.updateMany({ where: { workspaceId: params.workspaceId, meetingId: meeting.id,
        type: { in: ["CRM_CONTACT", "CRM_DEAL", "CRM_ACTIVITY"] }, status: "SUGGESTED", reviewedAt: null, supersededAt: null,
        dedupeKey: { startsWith: "crm:", notIn: activeKeys }, metadataJson: { path: ["crm", "source"], equals: CRM_MEETING_INTELLIGENCE_SOURCE } },
      data: { supersededAt: new Date() } });
      invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots, tx),
        409, "SOURCE_CHANGED", "CRM suggestion inputs changed during persistence.");
      for (const insight of created) await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "MeetingInsight", id: insight.id }, content: insight, origin: "DERIVED", inputs,
        inheritedRoots: roots, transitiveOnlyKinds: ["Meeting"],
      });
      await assertMeetingTranscriptWorkerCurrent(actor, params.workspaceId, tx);
      return created;
    };
    const primaryMatch = matches[0];
    if (!primaryMatch) return persist();

    const meetingActivityKey = await keyFor([meeting.id, "crm-activity", primaryMatch.accountId ?? primaryMatch.contactId ?? primaryMatch.email]);
    const activityCount = await tx.meetingInsight.createMany({
      data: [{
        workspaceId: params.workspaceId,
        meetingId: meeting.id,
        type: "CRM_ACTIVITY",
        status: "SUGGESTED",
        title: `Log relationship meeting: ${meeting.title || "Untitled meeting"}`,
        bodyMd: "Approve this to add the meeting to the matched relationship timeline.",
        confidence: 0.7,
        dedupeKey: meetingActivityKey,
        sourceRecordedAt: meeting.recordedAt,
        metadataJson: crmMetadata({
          recordType: "CRM_ACTIVITY",
          accountId: primaryMatch.accountId,
          contactId: primaryMatch.contactId,
          activityType: "MEETING",
          source: CRM_MEETING_INTELLIGENCE_SOURCE,
        }),
      }],
      skipDuplicates: true,
    });
    if (activityCount.count > 0) {
      const insight = await tx.meetingInsight.findFirst({ where: { workspaceId: params.workspaceId, meetingId: meeting.id, dedupeKey: meetingActivityKey } });
      if (insight) created.push(insight);
    }

    if (hasOpportunitySignal(text) && primaryMatch.contactId) {
      const dedupeKey = await keyFor([meeting.id, "crm-deal", primaryMatch.contactId, meeting.title ?? ""]);
      const count = await tx.meetingInsight.createMany({
        data: [{
          workspaceId: params.workspaceId,
          meetingId: meeting.id,
          type: "CRM_DEAL",
          status: "SUGGESTED",
          title: `Review opportunity from ${meeting.title || "meeting"}`,
          bodyMd: "The meeting appears to mention commercial opportunity, pilot, proposal, pricing, or client conversion context. Approve this to create an opportunity in Relationships.",
          confidence: 0.64,
          dedupeKey,
          sourceRecordedAt: meeting.recordedAt,
          metadataJson: crmMetadata({
            recordType: "CRM_DEAL",
            accountId: primaryMatch.accountId,
            contactId: primaryMatch.contactId,
            dealTitle: `Opportunity from ${meeting.title || "meeting"}`,
            source: CRM_MEETING_INTELLIGENCE_SOURCE,
          }),
        }],
        skipDuplicates: true,
      });
      if (count.count > 0) {
        const insight = await tx.meetingInsight.findFirst({ where: { workspaceId: params.workspaceId, meetingId: meeting.id, dedupeKey } });
        if (insight) created.push(insight);
      }
    }

    if (hasFollowUpSignal(text)) {
      const dedupeKey = await keyFor([meeting.id, "crm-follow-up", primaryMatch.accountId ?? primaryMatch.contactId ?? primaryMatch.email]);
      const count = await tx.meetingInsight.createMany({
        data: [{
          workspaceId: params.workspaceId,
          meetingId: meeting.id,
          type: "CRM_ACTIVITY",
          status: "SUGGESTED",
          title: `Review relationship follow-up: ${meeting.title || "meeting"}`,
          bodyMd: "The meeting appears to include relationship follow-up work. Approve this to add a tracked CRM task/reminder. It will not send an email.",
          confidence: 0.66,
          dedupeKey,
          sourceRecordedAt: meeting.recordedAt,
          metadataJson: crmMetadata({
            recordType: "CRM_ACTIVITY",
            accountId: primaryMatch.accountId,
            contactId: primaryMatch.contactId,
            activityType: "TASK",
            source: CRM_MEETING_INTELLIGENCE_SOURCE,
          }),
        }],
        skipDuplicates: true,
      });
      if (count.count > 0) {
        const insight = await tx.meetingInsight.findFirst({ where: { workspaceId: params.workspaceId, meetingId: meeting.id, dedupeKey } });
        if (insight) created.push(insight);
      }
    }

    return persist();
  });
}

export function crmInsightPayload(metadataJson: unknown): CrmInsightPayload {
  const metadata = metadataJson && typeof metadataJson === "object" && !Array.isArray(metadataJson)
    ? metadataJson as Record<string, unknown>
    : {};
  const crm = metadata.crm && typeof metadata.crm === "object" && !Array.isArray(metadata.crm)
    ? metadata.crm as Record<string, unknown>
    : {};
  return {
    recordType: typeof crm.recordType === "string" ? crm.recordType : undefined,
    email: typeof crm.email === "string" ? crm.email : null,
    name: typeof crm.name === "string" ? crm.name : null,
    company: typeof crm.company === "string" ? crm.company : null,
    accountId: typeof crm.accountId === "string" ? crm.accountId : null,
    contactId: typeof crm.contactId === "string" ? crm.contactId : null,
    dealId: typeof crm.dealId === "string" ? crm.dealId : null,
    dealTitle: typeof crm.dealTitle === "string" ? crm.dealTitle : null,
    valueCents: typeof crm.valueCents === "number" && Number.isInteger(crm.valueCents) ? crm.valueCents : null,
    currency: typeof crm.currency === "string" ? crm.currency : null,
    activityType: typeof crm.activityType === "string" ? crm.activityType : null,
    source: typeof crm.source === "string" ? crm.source : null,
  };
}

export function requireCrmInsightEmail(payload: CrmInsightPayload) {
  const email = parseEmailAddress(payload.email);
  invariant(email, 400, "INVALID_INPUT", "CRM contact insight requires a valid email.");
  return email;
}
