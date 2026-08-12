import { randomUUID } from "node:crypto";
import { env, prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireGlobalOperator, requireWorkspaceMembership } from "./auth";
import {
  archiveFilterWhere,
  archiveWorkspaceArtifact,
  type ArchiveFilter,
} from "./archive";
import { activeCrmParentWhere, lockCrmLinkClosure, lockCrmLinks, type CrmLinks } from "./crm-archive-guards";
import { invariant } from "./errors";
import { CrmDealStage, CrmActivityType } from "@prisma/client";
import type { CustomerAccountStatus, CustomerDeploymentStatus, Prisma } from "@prisma/client";
import { registerCustomerDeployment } from "./customer-lifecycle";

const DEFAULT_DEMO_WORKSPACE = {
  slug: "corgtex",
  name: "Corgtex",
  description: "Internal company operating environment for Corgtex",
};

export const DEFAULT_CRM_RELATIONSHIP_TYPE = "PROSPECT";
export const DEFAULT_CRM_LIFECYCLE_STAGE = "DISCOVERY";
export const SUGGESTED_CRM_RELATIONSHIP_TYPES = [
  "PROSPECT",
  "CLIENT",
  "PARTNER",
  "VENDOR",
  "INVESTOR",
  "OTHER",
] as const;
export const SUGGESTED_CRM_LIFECYCLE_STAGES = [
  "DISCOVERY",
  "QUALIFYING",
  "PILOT",
  "ACTIVE",
  "ON_HOLD",
  "LOST",
  "DORMANT",
] as const;
export const CRM_COMMUNICATION_SUGGESTION_STATUSES = [
  "SUGGESTED",
  "REQUESTED",
  "SENT",
  "DECLINED",
  "FAILED",
] as const;
export type CrmCommunicationSuggestionStatus = (typeof CRM_COMMUNICATION_SUGGESTION_STATUSES)[number];
export const CRM_INQUIRY_PERSONAS = [
  "OWNER",
  "EMPLOYEE",
  "TRANSFORMER",
  "INVESTOR",
  "PARTNER",
  "GENERAL",
] as const;
export type CrmInquiryPersona = (typeof CRM_INQUIRY_PERSONAS)[number];

const CRM_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const CRM_ACTIVITY_SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const CRM_COMMUNICATION_CHANNEL_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
const CRM_COMMUNICATION_SUGGESTION_STATUS_SET = new Set<string>(CRM_COMMUNICATION_SUGGESTION_STATUSES);
const CRM_INQUIRY_PERSONA_SET = new Set<string>(CRM_INQUIRY_PERSONAS);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
const CLOSED_CRM_DEAL_STAGES = new Set<CrmDealStage>([
  CrmDealStage.CLOSED_WON,
  CrmDealStage.CLOSED_LOST,
]);

function normalizeCrmCode(value: string | null | undefined, fallback: string, label: string) {
  const normalized = (value?.trim() || fallback)
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  invariant(CRM_CODE_PATTERN.test(normalized), 400, "INVALID_INPUT", `${label} must be an uppercase code.`);
  return normalized;
}

function normalizeCrmActivitySource(value?: string | null) {
  const source = value?.trim().toLowerCase() || "manual";
  invariant(CRM_ACTIVITY_SOURCE_PATTERN.test(source), 400, "INVALID_INPUT", "Activity source must be a lowercase code.");
  return source;
}

function normalizeCrmInquirySource(value?: string | null) {
  const source = value?.trim().toLowerCase() || "";
  invariant(CRM_ACTIVITY_SOURCE_PATTERN.test(source), 400, "INVALID_INPUT", "Inquiry source must be a lowercase code.");
  return source;
}

function normalizeCrmInquiryExternalId(value?: string | null) {
  const sourceExternalId = value?.trim() || "";
  invariant(sourceExternalId.length > 0 && sourceExternalId.length <= 200, 400, "INVALID_INPUT", "Source external id is required.");
  return sourceExternalId;
}

function normalizeCrmInquiryPersona(value?: string | null): CrmInquiryPersona {
  const persona = value?.trim().toUpperCase() || "";
  invariant(CRM_INQUIRY_PERSONA_SET.has(persona), 400, "INVALID_INPUT", "Unsupported CRM inquiry persona.");
  return persona as CrmInquiryPersona;
}

function normalizeCrmInquiryEmail(value?: string | null) {
  const email = value?.trim().toLowerCase() || "";
  invariant(EMAIL_PATTERN.test(email), 400, "INVALID_INPUT", "Valid email is required.");
  return email;
}

function trimOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeCommunicationChannel(value?: string | null) {
  const channel = (value?.trim() || "EMAIL").toUpperCase().replace(/[\s-]+/g, "_");
  invariant(CRM_COMMUNICATION_CHANNEL_PATTERN.test(channel), 400, "INVALID_INPUT", "Communication channel must be an uppercase code.");
  return channel;
}

export function normalizeCommunicationSuggestionStatus(value?: string | null): CrmCommunicationSuggestionStatus {
  const status = (value?.trim() || "SUGGESTED").toUpperCase().replace(/[\s-]+/g, "_");
  invariant(CRM_COMMUNICATION_SUGGESTION_STATUS_SET.has(status), 400, "INVALID_INPUT", "Unsupported communication suggestion status.");
  return status as CrmCommunicationSuggestionStatus;
}

function normalizeCrmActivityDate(value: Date | null | undefined, label: string) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  invariant(!Number.isNaN(date.getTime()), 400, "INVALID_INPUT", `${label} must be a valid date.`);
  return date;
}

export function normalizeCrmRelationshipType(value?: string | null) {
  return normalizeCrmCode(value, DEFAULT_CRM_RELATIONSHIP_TYPE, "Relationship type");
}

export function normalizeCrmLifecycleStage(value?: string | null) {
  return normalizeCrmCode(value, DEFAULT_CRM_LIFECYCLE_STAGE, "Lifecycle stage");
}

export function normalizeCrmAccountSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  invariant(slug.length > 0, 400, "INVALID_INPUT", "Account slug could not be derived.");
  return slug;
}

function normalizeCrmAccountDomain(value?: string | null) {
  const domain = value
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    ?.replace(/:\d+$/, "");
  if (!domain || !domain.includes(".")) return null;
  return domain;
}

function emailDomain(email: string) {
  const [, domainPart] = email.trim().toLowerCase().split("@");
  return normalizeCrmAccountDomain(domainPart);
}

function titleFromDomain(domain: string) {
  const root = domain.split(".")[0] || domain;
  return root
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || domain;
}

function crmAccountCandidate(params: {
  email?: string | null;
  company?: string | null;
  website?: string | null;
  source?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
}) {
  const company = params.company?.trim() || null;
  const rawDomain = normalizeCrmAccountDomain(params.website) || (params.email ? emailDomain(params.email) : null);
  const domain = rawDomain && !FREE_EMAIL_DOMAINS.has(rawDomain) ? rawDomain : null;
  if (!company && !domain) return null;

  const name = company || titleFromDomain(domain!);
  return {
    name,
    slug: normalizeCrmAccountSlug(company || domain!),
    domain,
    relationshipType: normalizeCrmRelationshipType(params.relationshipType),
    lifecycleStage: normalizeCrmLifecycleStage(params.lifecycleStage),
    source: params.source?.trim() || "manual",
  };
}

function normalizeCrmTags(tags?: readonly (string | null | undefined)[] | null) {
  return [...new Set((tags ?? [])
    .map((tag) => tag?.trim())
    .filter((tag): tag is string => Boolean(tag)))];
}

function mergeCrmTags(...tagLists: readonly (readonly string[] | null | undefined)[]) {
  return normalizeCrmTags(tagLists.flatMap((tags) => tags ?? []));
}

async function findExistingCrmAccount(tx: any, workspaceId: string, candidate: { slug: string; domain: string | null }) {
  const or = [{ slug: candidate.slug }];
  if (candidate.domain) {
    or.push({ domain: candidate.domain } as any);
  }
  return tx.crmAccount.findFirst({
    where: {
      workspaceId,
      archivedAt: null,
      OR: or,
    },
  });
}

async function ensureCrmAccount(tx: any, workspaceId: string, params: {
  email?: string | null;
  company?: string | null;
  website?: string | null;
  source?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
  tags?: string[];
}, lockedAccountIds: readonly string[] = []) {
  const candidate = crmAccountCandidate(params);
  if (!candidate) return null;
  const tags = normalizeCrmTags(params.tags);

  let existing = await findExistingCrmAccount(tx, workspaceId, candidate);
  if (existing) {
    if (!lockedAccountIds.includes(existing.id)) await lockCrmLinks(tx, { accountId: existing.id });
    existing = await requireCrmAccount(tx, workspaceId, existing.id);
    const mergedTags = mergeCrmTags(existing.tags, tags);
    const data: Record<string, unknown> = {};
    if (!existing.domain && candidate.domain) {
      data.domain = candidate.domain;
    }
    if (mergedTags.length > (existing.tags ?? []).length) {
      data.tags = mergedTags;
    }
    if (Object.keys(data).length > 0) {
      return tx.crmAccount.update({
        where: { id: existing.id },
        data,
      });
    }
    return existing;
  }

  const id = randomUUID();
  await lockCrmLinks(tx, { accountId: id });
  return tx.crmAccount.create({
    data: {
      id,
      workspaceId,
      ...candidate,
      tags,
    },
  });
}

async function requireCrmAccount(tx: any, workspaceId: string, accountId: string) {
  const account = await tx.crmAccount.findUnique({ where: { id: accountId } });
  invariant(account && account.workspaceId === workspaceId && !account.archivedAt, 404, "NOT_FOUND", "Account not found.");
  return account;
}

async function requireCrmActivityOwner(tx: any, workspaceId: string, ownerUserId?: string | null) {
  if (!ownerUserId) return null;
  const member = await tx.member.findFirst({
    where: { workspaceId, userId: ownerUserId, isActive: true },
    select: { id: true },
  });
  invariant(member, 404, "NOT_FOUND", "Activity owner not found.");
  return member;
}

async function resolveCrmActivityLinks(tx: any, params: {
  workspaceId: string;
  accountId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
}, existing?: { accountId: string | null; contactId: string | null; dealId: string | null }, locksHeld = false) {
  let accountId = params.accountId !== undefined ? params.accountId : existing?.accountId ?? null;
  const contactId = params.contactId !== undefined ? params.contactId : existing?.contactId ?? null;
  const dealId = params.dealId !== undefined ? params.dealId : existing?.dealId ?? null;
  if (!locksHeld) await lockCrmLinkClosure(tx, params.workspaceId, { accountId, contactId, dealId });

  if (contactId) {
    const contact = await tx.crmContact.findFirst({ where: {
      id: contactId, workspaceId: params.workspaceId, ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]),
    } });
    invariant(contact, 404, "NOT_FOUND", "Contact not found.");
    if (accountId && contact.accountId) {
      invariant(accountId === contact.accountId, 400, "INVALID_INPUT", "Activity account must match the linked contact.");
    }
    accountId = accountId || contact.accountId || null;
  }
  if (dealId) {
    const deal = await tx.crmDeal.findFirst({ where: {
      id: dealId, workspaceId: params.workspaceId, ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact"], "active", ["contact"]),
    } });
    invariant(deal, 404, "NOT_FOUND", "Deal not found.");
    if (accountId && deal.accountId) {
      invariant(accountId === deal.accountId, 400, "INVALID_INPUT", "Activity account must match the linked deal.");
    }
    accountId = accountId || deal.accountId || null;
  }
  if (accountId) {
    await requireCrmAccount(tx, params.workspaceId, accountId);
  }

  invariant(accountId || contactId || dealId, 400, "INVALID_INPUT", "Activity must be linked to an account, contact, or deal.");

  return { accountId, contactId, dealId };
}

async function resolveCommunicationSuggestionLinks(tx: any, params: {
  workspaceId: string;
  accountId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  activityId?: string | null;
}, existing?: { accountId: string | null; contactId: string | null; dealId: string | null; activityId: string | null }) {
  let accountId = params.accountId !== undefined ? params.accountId : existing?.accountId ?? null;
  let contactId = params.contactId !== undefined ? params.contactId : existing?.contactId ?? null;
  let dealId = params.dealId !== undefined ? params.dealId : existing?.dealId ?? null;
  const activityId = params.activityId !== undefined ? params.activityId : existing?.activityId ?? null;

  if (activityId) {
    const activity = await tx.crmActivity.findFirst({ where: {
      id: activityId, workspaceId: params.workspaceId, ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact", "deal"]),
    } });
    invariant(activity, 404, "NOT_FOUND", "Activity not found.");
    if (accountId && activity.accountId) {
      invariant(accountId === activity.accountId, 400, "INVALID_INPUT", "Suggestion account must match the linked activity.");
    }
    if (contactId && activity.contactId) {
      invariant(contactId === activity.contactId, 400, "INVALID_INPUT", "Suggestion contact must match the linked activity.");
    }
    if (dealId && activity.dealId) {
      invariant(dealId === activity.dealId, 400, "INVALID_INPUT", "Suggestion deal must match the linked activity.");
    }
    accountId = accountId || activity.accountId || null;
    contactId = contactId || activity.contactId || null;
    dealId = dealId || activity.dealId || null;
  }

  const links = await resolveCrmActivityLinks(tx, {
    workspaceId: params.workspaceId,
    accountId,
    contactId,
    dealId,
  }, undefined, true);

  return { ...links, activityId };
}

function dealClosedAtForStage(stage: CrmDealStage) {
  return CLOSED_CRM_DEAL_STAGES.has(stage) ? new Date() : null;
}

async function recordDealStageTransition(tx: any, params: {
  workspaceId: string;
  dealId: string;
  fromStage: CrmDealStage | null;
  toStage: CrmDealStage;
  actorUserId?: string | null;
  createdAt?: Date;
}) {
  return tx.crmDealStageTransition.create({
    data: {
      workspaceId: params.workspaceId,
      dealId: params.dealId,
      fromStage: params.fromStage,
      toStage: params.toStage,
      actorUserId: params.actorUserId ?? null,
      ...(params.createdAt ? { createdAt: params.createdAt } : {}),
    },
  });
}

async function prepareCrmAccountLinkSync(tx: any, params: {
  workspaceId: string;
  contacts: Array<{ id: string; accountId?: string | null }>;
  accountIds?: Array<string | null | undefined>;
}) {
  const activityIds = await tx.crmActivity.findMany({
    where: { workspaceId: params.workspaceId, contactId: { in: params.contacts.map(({ id }) => id) }, accountId: null, archivedAt: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  await lockCrmLinks(tx, ...activityIds.map((activity: { id: string }) => ({ activityId: activity.id })),
    ...params.contacts.map(({ id, accountId }) => ({ contactId: id, accountId })),
    ...(params.accountIds ?? []).map((accountId) => ({ accountId })));
  return activityIds.map((activity: { id: string }) => activity.id);
}

async function syncCrmAccountLinksForContact(tx: any, params: {
  workspaceId: string;
  contactId: string;
  email?: string | null;
  accountId: string;
  activityIds?: string[];
  locksHeld?: boolean;
}) {
  const activityIds: string[] = params.activityIds ?? await tx.crmActivity.findMany({
    where: { workspaceId: params.workspaceId, contactId: params.contactId, accountId: null, archivedAt: null },
    select: { id: true }, orderBy: { id: "asc" },
  }).then((rows: Array<{ id: string }>) => rows.map(({ id }) => id));
  if (!params.locksHeld) await lockCrmLinks(tx, ...activityIds.map((activityId) => ({ activityId })),
    { contactId: params.contactId, accountId: params.accountId });
  const contact = await tx.crmContact.findFirst({ where: { id: params.contactId, workspaceId: params.workspaceId,
    archivedAt: null, accountId: params.accountId, account: { archivedAt: null } }, select: { id: true } });
  invariant(contact, 404, "NOT_FOUND", "Contact not found.");

  const [deals, activities, conversations] = await Promise.all([
    tx.crmDeal.updateMany({
      where: { workspaceId: params.workspaceId, contactId: params.contactId, accountId: null },
      data: { accountId: params.accountId },
    }),
    tx.crmActivity.updateMany({
      where: {
        id: { in: activityIds },
        workspaceId: params.workspaceId,
        contactId: params.contactId,
        accountId: null,
        archivedAt: null,
      },
      data: { accountId: params.accountId },
    }),
    tx.crmConversation.updateMany({
      where: { workspaceId: params.workspaceId, contactId: params.contactId, accountId: null },
      data: { accountId: params.accountId },
    }),
  ]);

  let prospectWorkspaces = { count: 0 };
  if (params.email) {
    const lead = await tx.demoLead.findFirst({
      where: { workspaceId: params.workspaceId, email: params.email },
      select: { id: true },
    });
    if (lead) {
      prospectWorkspaces = await tx.crmProspectWorkspace.updateMany({
        where: { crmWorkspaceId: params.workspaceId, demoLeadId: lead.id, accountId: null },
        data: { accountId: params.accountId },
      });
    }
  }

  return {
    deals: deals.count,
    activities: activities.count,
    conversations: conversations.count,
    prospectWorkspaces: prospectWorkspaces.count,
  };
}

export async function captureDemoLead(params: {
  email: string;
  source?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  workspaceDescription?: string;
}) {
  const email = params.email.trim().toLowerCase();
  invariant(email.length > 0 && email.includes("@"), 400, "INVALID_INPUT", "Valid email is required.");

  const workspaceSlug = params.workspaceSlug?.trim() || DEFAULT_DEMO_WORKSPACE.slug;
  const workspaceName = params.workspaceName?.trim() || DEFAULT_DEMO_WORKSPACE.name;
  const workspaceDescription = params.workspaceDescription?.trim() || DEFAULT_DEMO_WORKSPACE.description;
  const source = params.source?.trim() || "demo_gate";
  const [localPart, domainPart] = email.split("@");
  const name = localPart.replace(/[^a-zA-Z0-9]/g, " ");

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.upsert({
      where: { slug: workspaceSlug },
      update: {},
      create: {
        slug: workspaceSlug,
        name: workspaceName,
        description: workspaceDescription,
      },
    });

    const demoLead = await tx.demoLead.upsert({
      where: {
        workspaceId_email: {
          workspaceId: workspace.id,
          email,
        },
      },
      update: {
        lastSeenAt: new Date(),
        visitCount: { increment: 1 },
      },
      create: {
        workspaceId: workspace.id,
        email,
        source,
        qualifyToken: randomUUID(),
      },
    });

    const contactLinks = await tx.crmContact.findUnique({ where: { workspaceId_email: { workspaceId: workspace.id, email } } });
    const candidate = crmAccountCandidate({ email, source });
    const matchedAccount = candidate ? await findExistingCrmAccount(tx, workspace.id, candidate) : null;
    if (contactLinks || matchedAccount) await lockCrmLinks(tx,
      { contactId: contactLinks?.id, accountId: contactLinks?.accountId }, { accountId: matchedAccount?.id });
    const existingContact = contactLinks ? await tx.crmContact.findFirst({ where: {
      id: contactLinks.id, workspaceId: workspace.id, ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]),
    } }) : null;
    invariant(!contactLinks || existingContact, 409, "ARCHIVED_PARENT", "Restore the matching contact and account before capturing this lead.");

    const account = await ensureCrmAccount(tx, workspace.id, {
      email,
      source,
    }, [contactLinks?.accountId, matchedAccount?.id].filter((id): id is string => Boolean(id)));

    const contact = existingContact
      ? await tx.crmContact.update({ where: { id: existingContact.id }, data: {
        lastSeenAt: new Date(),
        ...(account ? { accountId: account.id } : {}),
      } })
      : await tx.crmContact.create({ data: {
        workspaceId: workspace.id,
        accountId: account?.id ?? null,
        email,
        name,
        company: domainPart,
        source,
      } });

    if (!demoLead.welcomeEmailSentAt) {
      await appendEvents(tx, [
        {
          workspaceId: workspace.id,
          type: "demo-lead.captured",
          aggregateType: "DemoLead",
          aggregateId: demoLead.id,
          payload: {
            demoLeadId: demoLead.id,
            email,
            source,
          },
        },
      ]);
    }

    return { workspace, demoLead, contact };
  });
}

export type CaptureCrmInquiryInput = {
  workspaceSlug: string;
  source: string;
  sourceExternalId: string;
  persona: CrmInquiryPersona | string;
  name: string;
  email: string;
  phone?: string | null;
  company?: string | null;
  website?: string | null;
  title?: string | null;
  location?: string | null;
  message?: string | null;
  answers?: Record<string, unknown> | null;
  sourceUrl?: string | null;
  referrerUrl?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  utmId?: string | null;
  consentToContact: boolean;
};

export type CaptureCrmInquiryResult = {
  duplicate: boolean;
  submissionId: string;
  workspaceId: string;
  contactId: string | null;
  accountId: string | null;
  conversationId: string;
  messageId: string | null;
  activityId: string | null;
  dealId: string | null;
};

function crmInquiryTags(source: string, persona: CrmInquiryPersona) {
  return [`source:${source}`, `persona:${persona.toLowerCase()}`];
}

function shouldCreateCrmInquiryDeal(persona: CrmInquiryPersona) {
  return persona === "OWNER" || persona === "INVESTOR";
}

function nextBusinessDay(from = new Date()) {
  const dueAt = new Date(from);
  dueAt.setUTCDate(dueAt.getUTCDate() + 1);
  while (dueAt.getUTCDay() === 0 || dueAt.getUTCDay() === 6) {
    dueAt.setUTCDate(dueAt.getUTCDate() + 1);
  }
  dueAt.setUTCHours(17, 0, 0, 0);
  return dueAt;
}

function crmInquiryUtm(params: CaptureCrmInquiryInput) {
  return {
    source: trimOptionalText(params.utmSource),
    medium: trimOptionalText(params.utmMedium),
    campaign: trimOptionalText(params.utmCampaign),
    term: trimOptionalText(params.utmTerm),
    content: trimOptionalText(params.utmContent),
    id: trimOptionalText(params.utmId),
  };
}

function crmInquiryAnswersMd(answers?: Record<string, unknown> | null) {
  if (!answers || Object.keys(answers).length === 0) return null;
  return Object.entries(answers)
    .map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function crmInquiryMessageMd(params: CaptureCrmInquiryInput & {
  source: string;
  persona: CrmInquiryPersona;
  email: string;
}) {
  const lines = [
    `New ${params.persona.toLowerCase()} inquiry from ${trimOptionalText(params.name) ?? params.email}.`,
    "",
    `Email: ${params.email}`,
  ];
  const details = [
    ["Name", trimOptionalText(params.name)],
    ["Phone", trimOptionalText(params.phone)],
    ["Company", trimOptionalText(params.company)],
    ["Website", trimOptionalText(params.website)],
    ["Title", trimOptionalText(params.title)],
    ["Location", trimOptionalText(params.location)],
    ["Source URL", trimOptionalText(params.sourceUrl)],
    ["Referrer URL", trimOptionalText(params.referrerUrl)],
  ] as const;
  for (const [label, value] of details) {
    if (value) lines.push(`${label}: ${value}`);
  }
  const utm = crmInquiryUtm(params);
  const utmLines = Object.entries(utm)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${value}`);
  if (utmLines.length > 0) {
    lines.push(`UTM: ${utmLines.join(", ")}`);
  }
  const message = trimOptionalText(params.message);
  if (message) {
    lines.push("", "Message:", message);
  }
  const answers = crmInquiryAnswersMd(params.answers);
  if (answers) {
    lines.push("", "Answers:", answers);
  }
  return lines.join("\n");
}

function crmInquiryDealTitle(params: {
  persona: CrmInquiryPersona;
  name: string | null;
  company: string | null;
  email: string;
}) {
  const label = params.company ?? params.name ?? params.email;
  return `${label} ${params.persona.toLowerCase()} inquiry`;
}

function crmInquiryEventPayload(params: {
  input: CaptureCrmInquiryInput;
  workspaceId: string;
  source: string;
  sourceExternalId: string;
  persona: CrmInquiryPersona;
  email: string;
  contactId: string;
  accountId: string | null;
  conversationId: string;
  messageId: string;
  activityId: string;
  dealId: string | null;
}) {
  return toInputJson({
    source: params.source,
    sourceExternalId: params.sourceExternalId,
    persona: params.persona,
    email: params.email,
    contactId: params.contactId,
    accountId: params.accountId,
    conversationId: params.conversationId,
    messageId: params.messageId,
    activityId: params.activityId,
    dealId: params.dealId,
    sourceUrl: trimOptionalText(params.input.sourceUrl),
    referrerUrl: trimOptionalText(params.input.referrerUrl),
    utm: crmInquiryUtm(params.input),
    answers: params.input.answers ?? null,
  });
}

export async function captureCrmInquiry(params: CaptureCrmInquiryInput): Promise<CaptureCrmInquiryResult> {
  const workspaceSlug = params.workspaceSlug.trim();
  invariant(workspaceSlug.length > 0, 400, "INVALID_INPUT", "Workspace slug is required.");
  invariant(params.consentToContact === true, 400, "CONSENT_REQUIRED", "Consent to contact is required.");

  const source = normalizeCrmInquirySource(params.source);
  const sourceExternalId = normalizeCrmInquiryExternalId(params.sourceExternalId);
  const persona = normalizeCrmInquiryPersona(params.persona);
  const email = normalizeCrmInquiryEmail(params.email);
  const name = trimOptionalText(params.name);
  invariant(name, 400, "INVALID_INPUT", "Name is required.");

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.findUnique({
      where: { slug: workspaceSlug },
      select: { id: true, slug: true },
    });
    invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");

    const existingConversation = await tx.crmConversation.findUnique({
      where: {
        workspaceId_source_sourceExternalId: {
          workspaceId: workspace.id,
          source,
          sourceExternalId,
        },
      },
      select: {
        id: true,
        accountId: true,
        contactId: true,
        dealId: true,
      },
    });
    if (existingConversation) {
      const existingActivity = await tx.crmActivity.findUnique({
        where: {
          workspaceId_source_sourceExternalId: {
            workspaceId: workspace.id,
            source,
            sourceExternalId: `${sourceExternalId}:follow-up`,
          },
        },
        select: { id: true },
      });
      return {
        duplicate: true,
        submissionId: existingConversation.id,
        workspaceId: workspace.id,
        contactId: existingConversation.contactId,
        accountId: existingConversation.accountId,
        conversationId: existingConversation.id,
        messageId: null,
        activityId: existingActivity?.id ?? null,
        dealId: existingConversation.dealId,
      };
    }

    const tags = crmInquiryTags(source, persona);
    let existingContact = await tx.crmContact.findUnique({
      where: {
        workspaceId_email: {
          workspaceId: workspace.id,
          email,
        },
      },
    });
    const candidate = crmAccountCandidate({ email, company: params.company, website: params.website, source,
      relationshipType: persona === "PARTNER" ? "PARTNER" : persona === "INVESTOR" ? "INVESTOR" : "PROSPECT",
      lifecycleStage: "DISCOVERY" });
    const matchedAccount = candidate ? await findExistingCrmAccount(tx, workspace.id, candidate) : null;
    invariant(!existingContact?.archivedAt, 409, "ARCHIVED_PARENT", "Restore the matching contact before capturing this inquiry.");
    if (existingContact || matchedAccount) {
      await lockCrmLinks(tx, { contactId: existingContact?.id, accountId: existingContact?.accountId },
        { accountId: matchedAccount?.id });
    }
    if (existingContact) {
      existingContact = await tx.crmContact.findFirst({ where: { id: existingContact.id, workspaceId: workspace.id,
        ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]) } });
      invariant(existingContact, 409, "ARCHIVED_PARENT", "Restore the matching contact and account before capturing this inquiry.");
    }

    const account = await ensureCrmAccount(tx, workspace.id, {
      email,
      company: params.company,
      website: params.website,
      source,
      relationshipType: persona === "PARTNER" ? "PARTNER" : persona === "INVESTOR" ? "INVESTOR" : "PROSPECT",
      lifecycleStage: "DISCOVERY",
      tags,
    }, matchedAccount ? [matchedAccount.id] : []);

    const contactBaseData = {
      accountId: account?.id ?? existingContact?.accountId ?? null,
      email,
      name,
      source,
      tags: mergeCrmTags(existingContact?.tags, tags),
      lastSeenAt: new Date(),
    };
    const contactCreateData = {
      ...contactBaseData,
      company: trimOptionalText(params.company),
      title: trimOptionalText(params.title),
      phone: trimOptionalText(params.phone),
    };
    const contactUpdateData = {
      ...contactBaseData,
      ...(params.company !== undefined ? { company: trimOptionalText(params.company) } : {}),
      ...(params.title !== undefined ? { title: trimOptionalText(params.title) } : {}),
      ...(params.phone !== undefined ? { phone: trimOptionalText(params.phone) } : {}),
    };
    const contact = existingContact
      ? await tx.crmContact.update({
        where: { id: existingContact.id },
        data: contactUpdateData,
      })
      : await tx.crmContact.create({
        data: {
          workspaceId: workspace.id,
          ...contactCreateData,
        },
      });

    let deal = null;
    if (shouldCreateCrmInquiryDeal(persona)) {
      deal = await tx.crmDeal.create({
        data: {
          workspaceId: workspace.id,
          accountId: account?.id ?? contact.accountId ?? null,
          contactId: contact.id,
          title: crmInquiryDealTitle({
            persona,
            name,
            company: trimOptionalText(params.company),
            email,
          }),
          stage: CrmDealStage.LEAD,
          notes: trimOptionalText(params.message),
        },
      });
      await recordDealStageTransition(tx, {
        workspaceId: workspace.id,
        dealId: deal.id,
        fromStage: null,
        toStage: CrmDealStage.LEAD,
        actorUserId: null,
        createdAt: deal.createdAt,
      });
    }

    const conversation = await tx.crmConversation.create({
      data: {
        workspaceId: workspace.id,
        accountId: account?.id ?? contact.accountId ?? null,
        contactId: contact.id,
        dealId: deal?.id ?? null,
        subject: `CRM inquiry: ${persona.toLowerCase()} from ${name}`,
        source,
        sourceExternalId,
        sourceUrl: trimOptionalText(params.sourceUrl),
        sourceOccurredAt: new Date(),
      },
    });

    const message = await tx.crmConversationMessage.create({
      data: {
        conversationId: conversation.id,
        senderType: "LEAD",
        senderEmail: email,
        bodyMd: crmInquiryMessageMd({
          ...params,
          source,
          persona,
          email,
        }),
      },
    });

    const activity = await tx.crmActivity.create({
      data: {
        workspaceId: workspace.id,
        accountId: account?.id ?? contact.accountId ?? null,
        contactId: contact.id,
        dealId: deal?.id ?? null,
        type: CrmActivityType.TASK,
        title: `Follow up with ${name}`,
        bodyMd: `Respond to the ${persona.toLowerCase()} inquiry captured from ${source}.`,
        source,
        sourceExternalId: `${sourceExternalId}:follow-up`,
        sourceUrl: trimOptionalText(params.sourceUrl),
        sourceOccurredAt: new Date(),
        dueAt: nextBusinessDay(),
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: workspace.id,
        type: "crm.inquiry.captured",
        aggregateType: "CrmConversation",
        aggregateId: conversation.id,
        payload: crmInquiryEventPayload({
          input: params,
          workspaceId: workspace.id,
          source,
          sourceExternalId,
          persona,
          email,
          contactId: contact.id,
          accountId: account?.id ?? contact.accountId ?? null,
          conversationId: conversation.id,
          messageId: message.id,
          activityId: activity.id,
          dealId: deal?.id ?? null,
        }),
      },
    ]);

    return {
      duplicate: false,
      submissionId: conversation.id,
      workspaceId: workspace.id,
      contactId: contact.id,
      accountId: account?.id ?? contact.accountId ?? null,
      conversationId: conversation.id,
      messageId: message.id,
      activityId: activity.id,
      dealId: deal?.id ?? null,
    };
  });
}

// --- ACCOUNTS ---

function listFilterValues(values?: readonly (string | null | undefined)[] | null) {
  return [...new Set((values ?? []).map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export async function listCrmAccounts(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  skip?: number;
  query?: string;
  relationshipType?: string;
  relationshipTypes?: string[];
  lifecycleStage?: string;
  lifecycleStages?: string[];
  archiveFilter?: ArchiveFilter;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;

  let where: any = { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) };
  const relationshipTypes = listFilterValues([...(opts?.relationshipTypes ?? []), opts?.relationshipType])
    .map((value) => normalizeCrmRelationshipType(value));
  const lifecycleStages = listFilterValues([...(opts?.lifecycleStages ?? []), opts?.lifecycleStage])
    .map((value) => normalizeCrmLifecycleStage(value));
  if (relationshipTypes.length > 0) {
    where.relationshipType = { in: relationshipTypes };
  } else if (opts?.relationshipType) {
    where.relationshipType = normalizeCrmRelationshipType(opts.relationshipType);
  }
  if (lifecycleStages.length > 0) {
    where.lifecycleStage = { in: lifecycleStages };
  } else if (opts?.lifecycleStage) {
    where.lifecycleStage = normalizeCrmLifecycleStage(opts.lifecycleStage);
  }
  if (opts?.query) {
    where = {
      ...where,
      OR: [
        { name: { contains: opts.query, mode: "insensitive" } },
        { domain: { contains: opts.query, mode: "insensitive" } },
      ],
    };
  }

  const [items, total] = await Promise.all([
    prisma.crmAccount.findMany({
      where,
      include: {
        _count: {
          select: {
            contacts: { where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account"], opts?.archiveFilter) } },
            deals: { where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact"], opts?.archiveFilter, ["contact"]) } },
            activities: { where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact", "deal"], opts?.archiveFilter) } },
            crmConversations: { where: activeCrmParentWhere(["account", "contact", "deal"], opts?.archiveFilter) },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    }),
    prisma.crmAccount.count({ where }),
  ]);

  return { items, total, take, skip };
}

export async function getCrmAccount(actor: AppActor, params: { workspaceId: string; accountId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const account = await prisma.crmAccount.findUnique({
    where: { id: params.accountId },
    include: {
      contacts: {
        where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]) },
        orderBy: { lastSeenAt: "desc" },
      },
      deals: {
        where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact"], "active", ["contact"]) },
        orderBy: { updatedAt: "desc" },
        include: {
          contact: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          activities: {
            where: {
              type: CrmActivityType.TASK,
              completedAt: null,
              ...archiveFilterWhere(),
              ...activeCrmParentWhere(["account", "contact", "deal"]),
            },
            orderBy: [
              { dueAt: { sort: "asc", nulls: "last" } },
              { createdAt: "desc" },
            ],
            take: 1,
            select: {
              id: true,
              title: true,
              createdAt: true,
              dueAt: true,
              completedAt: true,
              ownerUserId: true,
              source: true,
              type: true,
            },
          },
          stageTransitions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, fromStage: true, toStage: true, createdAt: true },
          },
        },
      },
      activities: {
        where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact", "deal"]) },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          contact: {
            select: { id: true, name: true, email: true, company: true },
          },
          deal: {
            select: { id: true, title: true, stage: true, valueCents: true },
          },
        },
      },
      crmConversations: {
        where: activeCrmParentWhere(["account", "contact", "deal"]),
        orderBy: { updatedAt: "desc" },
        take: 25,
        include: {
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
      prospectWorkspaces: {
        where: activeCrmParentWhere(["account"]),
        orderBy: { provisionedAt: "desc" },
        take: 25,
        include: {
          targetWorkspace: { select: { id: true, slug: true, name: true } },
        },
      },
    },
  });

  invariant(account && account.workspaceId === params.workspaceId && !account.archivedAt, 404, "NOT_FOUND", "Account not found.");
  return account;
}

export async function createCrmAccount(actor: AppActor, params: {
  workspaceId: string;
  name: string;
  domain?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
  descriptionMd?: string | null;
  source?: string | null;
  tags?: string[];
  ownerUserId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const name = params.name.trim();
  invariant(name.length > 0, 400, "INVALID_INPUT", "Account name is required.");
  const domain = normalizeCrmAccountDomain(params.domain);
  const slug = normalizeCrmAccountSlug(domain || name);
  const relationshipType = normalizeCrmRelationshipType(params.relationshipType);
  const lifecycleStage = normalizeCrmLifecycleStage(params.lifecycleStage);

  return prisma.$transaction(async (tx) => {
    const duplicate = await findExistingCrmAccount(tx, params.workspaceId, { slug, domain });
    invariant(!duplicate, 409, "CONFLICT", "Account already exists.");

    const account = await tx.crmAccount.create({
      data: {
        workspaceId: params.workspaceId,
        name,
        slug,
        domain,
        relationshipType,
        lifecycleStage,
        descriptionMd: params.descriptionMd?.trim() || null,
        source: params.source?.trim() || "manual",
        tags: params.tags || [],
        ownerUserId: params.ownerUserId || null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.account.created",
        entityType: "CrmAccount",
        entityId: account.id,
        meta: { name: account.name, relationshipType: account.relationshipType, lifecycleStage: account.lifecycleStage },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.account.created",
        aggregateType: "CrmAccount",
        aggregateId: account.id,
        payload: { accountId: account.id, name: account.name },
      },
    ]);

    return account;
  });
}

export async function updateCrmAccount(actor: AppActor, params: {
  workspaceId: string;
  accountId: string;
  name?: string;
  domain?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
  descriptionMd?: string | null;
  tags?: string[];
  ownerUserId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const account = await requireCrmAccount(tx, params.workspaceId, params.accountId);
    const data: any = {};

    if (params.name !== undefined) {
      const name = params.name.trim();
      invariant(name.length > 0, 400, "INVALID_INPUT", "Account name is required.");
      data.name = name;
      if (!account.domain) {
        data.slug = normalizeCrmAccountSlug(name);
      }
    }
    if (params.domain !== undefined) {
      const domain = normalizeCrmAccountDomain(params.domain);
      data.domain = domain;
      data.slug = normalizeCrmAccountSlug(domain || data.name || account.name);
    }
    if (params.relationshipType !== undefined) data.relationshipType = normalizeCrmRelationshipType(params.relationshipType);
    if (params.lifecycleStage !== undefined) data.lifecycleStage = normalizeCrmLifecycleStage(params.lifecycleStage);
    if (params.descriptionMd !== undefined) data.descriptionMd = params.descriptionMd?.trim() || null;
    if (params.tags !== undefined) data.tags = params.tags;
    if (params.ownerUserId !== undefined) data.ownerUserId = params.ownerUserId;

    if (data.slug && data.slug !== account.slug) {
      const duplicate = await findExistingCrmAccount(tx, params.workspaceId, { slug: data.slug, domain: data.domain ?? account.domain });
      invariant(!duplicate || duplicate.id === account.id, 409, "CONFLICT", "Account already exists.");
    }

    const updated = await tx.crmAccount.update({
      where: { id: params.accountId },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.account.updated",
        entityType: "CrmAccount",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}

export async function convertCrmAccountToClient(actor: AppActor, params: {
  workspaceId: string;
  accountId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const account = await requireCrmAccount(tx, params.workspaceId, params.accountId);
    const updated = await tx.crmAccount.update({
      where: { id: account.id },
      data: {
        relationshipType: "CLIENT",
        lifecycleStage: "ACTIVE",
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.account.converted_to_client",
        entityType: "CrmAccount",
        entityId: updated.id,
        meta: {
          previousRelationshipType: account.relationshipType,
          previousLifecycleStage: account.lifecycleStage,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.account.converted_to_client",
        aggregateType: "CrmAccount",
        aggregateId: updated.id,
        payload: {
          accountId: updated.id,
          previousRelationshipType: account.relationshipType,
          previousLifecycleStage: account.lifecycleStage,
        },
      },
    ]);

    return updated;
  });
}

async function archiveCrmAccountWithReason(actor: AppActor, params: { workspaceId: string; accountId: string; reason: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "CrmAccount",
    entityId: params.accountId,
    reason: params.reason,
  });

  return { id: params.accountId };
}

export async function archiveCrmAccount(actor: AppActor, params: { workspaceId: string; accountId: string }) {
  return archiveCrmAccountWithReason(actor, {
    ...params,
    reason: "Archived from CRM account archive action.",
  });
}

export async function deleteCrmAccount(actor: AppActor, params: { workspaceId: string; accountId: string }) {
  return archiveCrmAccountWithReason(actor, {
    ...params,
    reason: "Archived from account delete path.",
  });
}

export async function backfillCrmAccountsForWorkspace(actor: AppActor, params: { workspaceId: string; take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const take = params.take ?? 1000;

  const contacts = await prisma.crmContact.findMany({ where: { workspaceId: params.workspaceId, archivedAt: null, accountId: null },
    orderBy: { createdAt: "asc" }, take, select: { id: true, email: true, company: true, source: true } });
  const summary = { scanned: contacts.length, accountsCreated: 0, contactsLinked: 0, dealsLinked: 0,
    activitiesLinked: 0, conversationsLinked: 0, prospectWorkspacesLinked: 0, skipped: 0 };

  for (const contact of contacts) {
    const result = await prisma.$transaction(async (tx) => {
      const candidate = crmAccountCandidate({
        email: contact.email,
        company: contact.company,
        source: contact.source,
      });
      if (!candidate) return null;

      const beforeAccount = await findExistingCrmAccount(tx, params.workspaceId, candidate);
      const activityIds = await prepareCrmAccountLinkSync(tx, {
        workspaceId: params.workspaceId, contacts: [{ id: contact.id }], accountIds: [beforeAccount?.id],
      });
      const activeContact = await tx.crmContact.findFirst({ where: {
        id: contact.id, workspaceId: params.workspaceId, archivedAt: null, accountId: null,
      } });
      if (!activeContact) return null;
      const account = await ensureCrmAccount(tx, params.workspaceId, {
        email: contact.email,
        company: contact.company,
        source: contact.source,
      }, beforeAccount ? [beforeAccount.id] : []);
      if (!account) return null;

      await tx.crmContact.update({
        where: { id: contact.id },
        data: { accountId: account.id },
      });
      const linked = await syncCrmAccountLinksForContact(tx, {
        workspaceId: params.workspaceId,
        contactId: contact.id,
        email: contact.email,
        accountId: account.id,
        activityIds,
        locksHeld: true,
      });
      return { linked, created: !beforeAccount };
    });
    if (!result) { summary.skipped += 1; continue; }
    summary.accountsCreated += Number(result.created);
    summary.contactsLinked += 1;
    summary.dealsLinked += result.linked.deals;
    summary.activitiesLinked += result.linked.activities;
    summary.conversationsLinked += result.linked.conversations;
    summary.prospectWorkspacesLinked += result.linked.prospectWorkspaces;
  }
  return summary;
}

// --- CONTACTS ---

export async function listContacts(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number; query?: string; accountId?: string; archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  
  let where: any = {
    workspaceId,
    ...archiveFilterWhere(opts?.archiveFilter),
    ...activeCrmParentWhere(["account"], opts?.archiveFilter),
  };
  if (opts?.accountId) {
    where.accountId = opts.accountId;
  }
  if (opts?.query) {
    where = {
      ...where,
      OR: [
        { email: { contains: opts.query, mode: "insensitive" } },
        { name: { contains: opts.query, mode: "insensitive" } },
        { company: { contains: opts.query, mode: "insensitive" } },
      ],
    };
  }

  const [items, total] = await Promise.all([
    prisma.crmContact.findMany({
      where,
      include: {
        account: {
          select: { id: true, name: true, slug: true, domain: true, relationshipType: true, lifecycleStage: true, archivedAt: true },
        },
        _count: {
          select: {
            deals: { where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact"], opts?.archiveFilter, ["contact"]) } },
            activities: { where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact", "deal"], opts?.archiveFilter) } },
          },
        },
      },
      orderBy: { lastSeenAt: "desc" },
      take,
      skip,
    }),
    prisma.crmContact.count({ where }),
  ]);
  
  return { items, total, take, skip };
}

export async function getContact(actor: AppActor, params: { workspaceId: string; contactId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  
  const contact = await prisma.crmContact.findUnique({
    where: { id: params.contactId },
    include: {
      account: true,
      deals: {
        where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact"], "active", ["contact"]) },
        orderBy: { updatedAt: "desc" },
      },
      activities: {
        where: { ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact", "deal"]) },
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  });
  
  invariant(
    contact && contact.workspaceId === params.workspaceId && !contact.archivedAt && (!contact.accountId || !contact.account?.archivedAt),
    404,
    "NOT_FOUND",
    "Contact not found.",
  );
  return contact;
}

export async function createContact(actor: AppActor, params: {
  workspaceId: string;
  email: string;
  name?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  source?: string;
  tags?: string[];
  accountId?: string | null;
  relationshipType?: string | null;
  lifecycleStage?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const email = params.email.trim().toLowerCase();
  invariant(email.length > 0 && email.includes("@"), 400, "INVALID_INPUT", "Valid email is required.");

  return prisma.$transaction(async (tx) => {
    let account = null;
    if (params.accountId !== undefined) {
      if (params.accountId) await lockCrmLinks(tx, { accountId: params.accountId });
      account = params.accountId ? await requireCrmAccount(tx, params.workspaceId, params.accountId) : null;
    } else {
      account = await ensureCrmAccount(tx, params.workspaceId, {
        email,
        company: params.company,
        source: params.source,
        relationshipType: params.relationshipType,
        lifecycleStage: params.lifecycleStage,
      });
    }

    const contact = await tx.crmContact.create({
      data: {
        workspaceId: params.workspaceId,
        accountId: account?.id ?? null,
        email,
        name: params.name?.trim() || null,
        company: params.company?.trim() || null,
        title: params.title?.trim() || null,
        phone: params.phone?.trim() || null,
        source: params.source || "manual",
        tags: params.tags || [],
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.contact.created",
        entityType: "CrmContact",
        entityId: contact.id,
        meta: { email: contact.email },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.contact.created",
        aggregateType: "CrmContact",
        aggregateId: contact.id,
        payload: { contactId: contact.id, email: contact.email },
      },
    ]);

    return contact;
  });
}

export async function updateContact(actor: AppActor, params: {
  workspaceId: string;
  contactId: string;
  email?: string;
  name?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  tags?: string[];
  accountId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    let contact = await tx.crmContact.findUnique({ where: { id: params.contactId } });
    invariant(contact && contact.workspaceId === params.workspaceId && !contact.archivedAt, 404, "NOT_FOUND", "Contact not found.");

    const data: any = {};
    if (params.email !== undefined) {
      const email = params.email.trim().toLowerCase();
      invariant(email.length > 0 && email.includes("@"), 400, "INVALID_INPUT", "Valid email is required.");
      data.email = email;
    }
    if (params.name !== undefined) data.name = params.name?.trim() || null;
    if (params.company !== undefined) data.company = params.company?.trim() || null;
    if (params.title !== undefined) data.title = params.title?.trim() || null;
    if (params.phone !== undefined) data.phone = params.phone?.trim() || null;
    if (params.tags !== undefined) data.tags = params.tags;
    const replacementAccountId = params.accountId !== undefined ? params.accountId : contact.accountId;
    const activityIds = await prepareCrmAccountLinkSync(tx, {
      workspaceId: params.workspaceId, contacts: [contact], accountIds: [replacementAccountId],
    });
    contact = await tx.crmContact.findFirst({ where: {
      id: params.contactId, workspaceId: params.workspaceId, ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]),
    } });
    invariant(contact, 404, "NOT_FOUND", "Contact not found.");
    if (params.accountId !== undefined) {
      data.accountId = params.accountId ? (await requireCrmAccount(tx, params.workspaceId, params.accountId)).id : null;
    }

    const updated = await tx.crmContact.update({
      where: { id: params.contactId },
      data,
    });

    if (updated.accountId) {
      await syncCrmAccountLinksForContact(tx, {
        workspaceId: params.workspaceId,
        contactId: updated.id,
        email: updated.email,
        accountId: updated.accountId,
        activityIds,
        locksHeld: true,
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.contact.updated",
        entityType: "CrmContact",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}

async function archiveContactWithReason(actor: AppActor, params: { workspaceId: string; contactId: string; reason: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "CrmContact",
    entityId: params.contactId,
    reason: params.reason,
  });

  return { id: params.contactId };
}

export async function archiveContact(actor: AppActor, params: { workspaceId: string; contactId: string }) {
  return archiveContactWithReason(actor, {
    ...params,
    reason: "Archived from CRM contact archive action.",
  });
}

export async function deleteContact(actor: AppActor, params: { workspaceId: string; contactId: string }) {
  return archiveContactWithReason(actor, {
    ...params,
    reason: "Archived from contact delete path.",
  });
}

// --- DEALS ---

export async function listDeals(actor: AppActor, workspaceId: string, opts?: { take?: number; skip?: number; stage?: CrmDealStage; stages?: CrmDealStage[]; accountId?: string; contactId?: string; archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const take = opts?.take ?? 100;
  const skip = opts?.skip ?? 0;
  
  const where: any = {
    workspaceId,
    ...archiveFilterWhere(opts?.archiveFilter),
    ...activeCrmParentWhere(["account", "contact"], opts?.archiveFilter, ["contact"]),
  };
  if (opts?.accountId) {
    where.accountId = opts.accountId;
  }
  if (opts?.contactId) {
    where.contactId = opts.contactId;
  }
  const stages = listFilterValues([...(opts?.stages ?? []), opts?.stage]) as CrmDealStage[];
  if (stages.length > 0) {
    where.stage = { in: stages };
  } else if (opts?.stage) {
    where.stage = opts.stage;
  }

  const [items, total] = await Promise.all([
    prisma.crmDeal.findMany({
      where,
      include: {
        account: {
          select: { id: true, name: true, slug: true, domain: true, relationshipType: true, lifecycleStage: true, archivedAt: true },
        },
        contact: {
          select: { id: true, name: true, company: true, email: true, avatarUrl: true, archivedAt: true },
        },
        activities: {
          where: {
            type: CrmActivityType.TASK,
            completedAt: null,
            ...archiveFilterWhere(),
            ...activeCrmParentWhere(["account", "contact", "deal"]),
          },
          orderBy: [
            { dueAt: { sort: "asc", nulls: "last" } },
            { createdAt: "desc" },
          ],
          take: 1,
          select: {
            id: true,
            title: true,
            createdAt: true,
            dueAt: true,
            completedAt: true,
            ownerUserId: true,
            source: true,
            type: true,
          },
        },
        stageTransitions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, fromStage: true, toStage: true, createdAt: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    }),
    prisma.crmDeal.count({ where }),
  ]);
  
  return { items, total, take, skip };
}

export async function createDeal(actor: AppActor, params: {
  workspaceId: string;
  contactId: string;
  title: string;
  stage?: CrmDealStage;
  valueCents?: number | null;
  currency?: string;
  ownerUserId?: string | null;
  accountId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Deal title is required.");

  return prisma.$transaction(async (tx) => {
    await lockCrmLinkClosure(tx, params.workspaceId, { contactId: params.contactId, accountId: params.accountId });
    const contact = await tx.crmContact.findFirst({ where: { id: params.contactId, workspaceId: params.workspaceId,
      ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]) } });
    invariant(contact, 404, "NOT_FOUND", "Contact not found.");
    let accountId = contact.accountId ? (await requireCrmAccount(tx, params.workspaceId, contact.accountId)).id : null;
    if (params.accountId !== undefined) {
      accountId = params.accountId ? (await requireCrmAccount(tx, params.workspaceId, params.accountId)).id : null;
    }
    const stage = params.stage ?? CrmDealStage.LEAD;

    const deal = await tx.crmDeal.create({
      data: {
        workspaceId: params.workspaceId,
        accountId,
        contactId: params.contactId,
        title,
        stage,
        valueCents: params.valueCents ?? null,
        currency: params.currency || "USD",
        closedAt: dealClosedAtForStage(stage),
        ownerUserId: params.ownerUserId || null,
      },
    });

    await recordDealStageTransition(tx, {
      workspaceId: params.workspaceId,
      dealId: deal.id,
      fromStage: null,
      toStage: stage,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      createdAt: deal.createdAt,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.deal.created",
        entityType: "CrmDeal",
        entityId: deal.id,
        meta: { title: deal.title },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.deal.created",
        aggregateType: "CrmDeal",
        aggregateId: deal.id,
        payload: { dealId: deal.id, title: deal.title },
      },
    ]);

    return deal;
  });
}

export async function updateDeal(actor: AppActor, params: {
  workspaceId: string;
  dealId: string;
  title?: string;
  stage?: CrmDealStage;
  valueCents?: number | null;
  currency?: string;
  ownerUserId?: string | null;
  notes?: string | null;
  accountId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const links = await tx.crmDeal.findUnique({ where: { id: params.dealId } });
    invariant(links && links.workspaceId === params.workspaceId && !links.archivedAt, 404, "NOT_FOUND", "Deal not found.");
    await lockCrmLinks(tx, { dealId: links.id, contactId: links.contactId, accountId: links.accountId }, { accountId: params.accountId });
    const deal = tx.crmDeal.findFirst ? await tx.crmDeal.findFirst({ where: {
      id: params.dealId, workspaceId: params.workspaceId, ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact"]),
    } }) : links;
    invariant(deal, 404, "NOT_FOUND", "Deal not found.");

    const data: any = {};
    let stageChanged = false;
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Deal title is required.");
      data.title = title;
    }
    if (params.stage !== undefined) {
      stageChanged = params.stage !== deal.stage;
      if (stageChanged) {
        data.stage = params.stage;
        data.closedAt = dealClosedAtForStage(params.stage);
      }
    }
    if (params.valueCents !== undefined) data.valueCents = params.valueCents;
    if (params.currency !== undefined) data.currency = params.currency;
    if (params.ownerUserId !== undefined) data.ownerUserId = params.ownerUserId;
    if (params.notes !== undefined) data.notes = params.notes?.trim() || null;
    if (params.accountId !== undefined) {
      data.accountId = params.accountId ? (await requireCrmAccount(tx, params.workspaceId, params.accountId)).id : null;
    }

    if (Object.keys(data).length === 0) {
      return deal;
    }

    const updated = await tx.crmDeal.update({
      where: { id: params.dealId },
      data,
    });

    if (stageChanged && params.stage) {
      await recordDealStageTransition(tx, {
        workspaceId: params.workspaceId,
        dealId: params.dealId,
        fromStage: deal.stage,
        toStage: params.stage,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.deal.updated",
        entityType: "CrmDeal",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}

async function archiveDealWithReason(actor: AppActor, params: { workspaceId: string; dealId: string; reason: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "CrmDeal",
    entityId: params.dealId,
    reason: params.reason,
  });

  return { id: params.dealId };
}

export async function archiveCrmDeal(actor: AppActor, params: { workspaceId: string; dealId: string }) {
  return archiveDealWithReason(actor, { ...params, reason: "Archived from CRM deal archive action." });
}

export async function deleteDeal(actor: AppActor, params: { workspaceId: string; dealId: string }) {
  return archiveDealWithReason(actor, { ...params, reason: "Archived from deal delete path." });
}

// --- ACTIVITIES ---

export async function listCrmActivities(actor: AppActor, workspaceId: string, opts?: {
  accountId?: string;
  contactId?: string;
  dealId?: string;
  type?: CrmActivityType;
  types?: CrmActivityType[];
  ownerUserId?: string;
  source?: string;
  dueFrom?: Date;
  dueTo?: Date;
  completion?: "open" | "completed" | "all";
  completions?: Array<"open" | "completed" | "all">;
  sort?: "recent" | "due";
  take?: number;
  skip?: number;
  archiveFilter?: ArchiveFilter;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  const where: any = {
    workspaceId,
    ...archiveFilterWhere(opts?.archiveFilter),
    ...activeCrmParentWhere(["account", "contact", "deal"], opts?.archiveFilter),
  };
  if (opts?.accountId) where.accountId = opts.accountId;
  if (opts?.contactId) where.contactId = opts.contactId;
  if (opts?.dealId) where.dealId = opts.dealId;
  const types = listFilterValues([...(opts?.types ?? []), opts?.type]) as CrmActivityType[];
  if (types.length > 0) where.type = { in: types };
  else if (opts?.type) where.type = opts.type;
  if (opts?.ownerUserId) where.ownerUserId = opts.ownerUserId;
  if (opts?.source) where.source = normalizeCrmActivitySource(opts.source);
  const completions = listFilterValues([...(opts?.completions ?? []), opts?.completion])
    .filter((value): value is "open" | "completed" | "all" => value === "open" || value === "completed" || value === "all");
  if (completions.length === 1 && completions[0] === "open") where.completedAt = null;
  if (completions.length === 1 && completions[0] === "completed") where.completedAt = { not: null };
  if (opts?.dueFrom || opts?.dueTo) {
    where.dueAt = {};
    if (opts.dueFrom) where.dueAt.gte = normalizeCrmActivityDate(opts.dueFrom, "Due from");
    if (opts.dueTo) where.dueAt.lte = normalizeCrmActivityDate(opts.dueTo, "Due to");
  }
  const orderBy: Prisma.CrmActivityOrderByWithRelationInput | Prisma.CrmActivityOrderByWithRelationInput[] = opts?.sort === "due"
    ? [
        { dueAt: { sort: "asc", nulls: "last" } },
        { createdAt: "desc" },
      ]
    : { createdAt: "desc" };

  const [items, total] = await Promise.all([
    prisma.crmActivity.findMany({
      where,
      include: {
        account: {
          select: { id: true, name: true, slug: true, relationshipType: true, lifecycleStage: true, archivedAt: true },
        },
        contact: {
          select: { id: true, name: true, email: true, company: true, archivedAt: true },
        },
        deal: {
          select: { id: true, title: true, stage: true, valueCents: true, archivedAt: true },
        },
      },
      orderBy,
      take,
      skip,
    }),
    prisma.crmActivity.count({ where }),
  ]);

  return { items, total, take, skip };
}

async function requireActiveCrmActivity(tx: any, workspaceId: string, activityId: string, replacements: CrmLinks = {}) {
  const links = await tx.crmActivity.findUnique({ where: { id: activityId } });
  invariant(links && links.workspaceId === workspaceId && !links.archivedAt, 404, "NOT_FOUND", "Activity not found.");
  await lockCrmLinkClosure(tx, workspaceId, { ...links, activityId }, replacements);
  const activity = tx.crmActivity.findFirst ? await tx.crmActivity.findFirst({ where: {
    id: activityId, workspaceId, ...archiveFilterWhere(), ...activeCrmParentWhere(["account", "contact", "deal"]),
  } }) : links;
  invariant(activity, 404, "NOT_FOUND", "Activity not found.");
  return activity;
}

export async function createActivity(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  type?: CrmActivityType;
  bodyMd?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  accountId?: string | null;
  ownerUserId?: string | null;
  source?: string | null;
  dueAt?: Date | null;
  completedAt?: Date | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Activity title is required.");
  const dueAt = normalizeCrmActivityDate(params.dueAt, "Due date");
  const completedAt = normalizeCrmActivityDate(params.completedAt, "Completed date");
  const ownerUserId = params.ownerUserId ?? null;

  return prisma.$transaction(async (tx) => {
    await requireCrmActivityOwner(tx, params.workspaceId, ownerUserId);
    const links = await resolveCrmActivityLinks(tx, {
      workspaceId: params.workspaceId,
      accountId: params.accountId ?? null,
      contactId: params.contactId ?? null,
      dealId: params.dealId ?? null,
    });

    const activity = await tx.crmActivity.create({
      data: {
        workspaceId: params.workspaceId,
        accountId: links.accountId,
        title,
        type: params.type || CrmActivityType.NOTE,
        bodyMd: params.bodyMd?.trim() || null,
        contactId: links.contactId,
        dealId: links.dealId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        ownerUserId,
        source: normalizeCrmActivitySource(params.source),
        dueAt,
        completedAt,
        completedByUserId: completedAt && actor.kind === "user" ? actor.user.id : null,
      },
    });

    return activity;
  });
}

export async function updateActivity(actor: AppActor, params: {
  workspaceId: string;
  activityId: string;
  title?: string;
  type?: CrmActivityType;
  bodyMd?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  accountId?: string | null;
  ownerUserId?: string | null;
  source?: string | null;
  dueAt?: Date | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const activity = await requireActiveCrmActivity(tx, params.workspaceId, params.activityId, {
      accountId: params.accountId, contactId: params.contactId, dealId: params.dealId,
    });

    const data: any = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Activity title is required.");
      data.title = title;
    }
    if (params.type !== undefined) data.type = params.type;
    if (params.bodyMd !== undefined) data.bodyMd = params.bodyMd?.trim() || null;
    if (params.source !== undefined) data.source = normalizeCrmActivitySource(params.source);
    if (params.dueAt !== undefined) data.dueAt = normalizeCrmActivityDate(params.dueAt, "Due date");
    if (params.ownerUserId !== undefined) {
      await requireCrmActivityOwner(tx, params.workspaceId, params.ownerUserId);
      data.ownerUserId = params.ownerUserId;
    }

    if (params.accountId !== undefined || params.contactId !== undefined || params.dealId !== undefined) {
      const links = await resolveCrmActivityLinks(tx, {
        workspaceId: params.workspaceId,
        accountId: params.accountId,
        contactId: params.contactId,
        dealId: params.dealId,
      }, {
        accountId: activity.accountId,
        contactId: activity.contactId,
        dealId: activity.dealId,
      }, true);
      data.accountId = links.accountId;
      data.contactId = links.contactId;
      data.dealId = links.dealId;
    }

    const updated = await tx.crmActivity.update({
      where: { id: params.activityId },
      data,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.activity.updated",
        entityType: "CrmActivity",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}

export async function completeActivity(actor: AppActor, params: {
  workspaceId: string;
  activityId: string;
  completedAt?: Date | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const activity = await requireActiveCrmActivity(tx, params.workspaceId, params.activityId);
    if (activity.completedAt) return activity;

    const completedAt = normalizeCrmActivityDate(params.completedAt, "Completed date") ?? new Date();
    const updated = await tx.crmActivity.update({
      where: { id: params.activityId },
      data: {
        completedAt,
        completedByUserId: actor.kind === "user" ? actor.user.id : null,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.activity.completed",
        entityType: "CrmActivity",
        entityId: updated.id,
        meta: { source: activity.source },
      },
    });

    return updated;
  });
}

export async function archiveCrmActivity(actor: AppActor, params: { workspaceId: string; activityId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "CrmActivity",
    entityId: params.activityId,
    reason: "Archived from CRM activity archive action.",
  });
  return { id: params.activityId };
}

const communicationSuggestionInclude = {
  account: {
    select: { id: true, name: true, slug: true, relationshipType: true, lifecycleStage: true, archivedAt: true },
  },
  contact: {
    select: { id: true, name: true, email: true, company: true, archivedAt: true },
  },
  deal: {
    select: { id: true, title: true, stage: true, valueCents: true, archivedAt: true },
  },
  activity: {
    select: { id: true, title: true, type: true, dueAt: true, completedAt: true, archivedAt: true },
  },
};

function assertSuggestionEditable(suggestion: { status: string }) {
  invariant(suggestion.status !== "SENT" && suggestion.status !== "DECLINED", 400, "INVALID_STATE", "Finalized suggestions cannot be edited.");
}

function suggestionTimestampData(status: CrmCommunicationSuggestionStatus, now: Date, failureReason?: string | null) {
  if (status === "REQUESTED") return { requestedAt: now, sentAt: null, declinedAt: null, failedAt: null, failureReason: null };
  if (status === "SENT") return { sentAt: now, declinedAt: null, failedAt: null, failureReason: null };
  if (status === "DECLINED") return { declinedAt: now, failedAt: null, failureReason: null };
  if (status === "FAILED") return { failedAt: now, failureReason: failureReason?.trim() || "External execution failed." };
  return { requestedAt: null, sentAt: null, declinedAt: null, failedAt: null, failureReason: null };
}

async function requireCommunicationSuggestion(tx: any, workspaceId: string, suggestionId: string, replacements: CrmLinks = {}) {
  const links = await tx.crmCommunicationSuggestion.findUnique({ where: { id: suggestionId } });
  invariant(links && links.workspaceId === workspaceId, 404, "NOT_FOUND", "Communication suggestion not found.");
  await lockCrmLinkClosure(tx, workspaceId, links, replacements);
  const suggestion = tx.crmCommunicationSuggestion.findFirst ? await tx.crmCommunicationSuggestion.findFirst({ where: {
    id: suggestionId, workspaceId, ...activeCrmParentWhere(["account", "contact", "deal", "activity"]),
  } }) : links;
  invariant(suggestion, 404, "NOT_FOUND", "Communication suggestion not found.");
  return suggestion;
}

export async function listCommunicationSuggestions(actor: AppActor, workspaceId: string, opts?: {
  accountId?: string;
  contactId?: string;
  dealId?: string;
  activityId?: string;
  ownerUserId?: string;
  status?: string;
  statuses?: string[];
  take?: number;
  skip?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const where: any = { workspaceId, ...activeCrmParentWhere(["account", "contact", "deal", "activity"]) };
  if (opts?.accountId) where.accountId = opts.accountId;
  if (opts?.contactId) where.contactId = opts.contactId;
  if (opts?.dealId) where.dealId = opts.dealId;
  if (opts?.activityId) where.activityId = opts.activityId;
  if (opts?.ownerUserId) where.ownerUserId = opts.ownerUserId;
  const statuses = listFilterValues([...(opts?.statuses ?? []), opts?.status])
    .map((value) => normalizeCommunicationSuggestionStatus(value));
  if (statuses.length > 0) where.status = { in: statuses };
  else if (opts?.status) where.status = normalizeCommunicationSuggestionStatus(opts.status);
  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;

  const [items, total] = await Promise.all([
    prisma.crmCommunicationSuggestion.findMany({
      where,
      include: communicationSuggestionInclude,
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    }),
    prisma.crmCommunicationSuggestion.count({ where }),
  ]);

  return { items, total, take, skip };
}

export async function createCommunicationSuggestion(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  bodyMd: string;
  subject?: string | null;
  recipientEmail?: string | null;
  recipientName?: string | null;
  channel?: string | null;
  source?: string | null;
  ownerUserId?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  activityId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const title = params.title.trim();
  const bodyMd = params.bodyMd.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Suggestion title is required.");
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Suggestion body is required.");
  const ownerUserId = params.ownerUserId ?? null;

  return prisma.$transaction(async (tx) => {
    await requireCrmActivityOwner(tx, params.workspaceId, ownerUserId);
    await lockCrmLinkClosure(tx, params.workspaceId, params);
    const links = await resolveCommunicationSuggestionLinks(tx, {
      workspaceId: params.workspaceId,
      accountId: params.accountId ?? null,
      contactId: params.contactId ?? null,
      dealId: params.dealId ?? null,
      activityId: params.activityId ?? null,
    });

    let recipientEmail = params.recipientEmail?.trim().toLowerCase() || null;
    let recipientName = params.recipientName?.trim() || null;
    if (links.contactId && (!recipientEmail || !recipientName)) {
      const contact = await tx.crmContact.findUnique({ where: { id: links.contactId } });
      recipientEmail = recipientEmail || contact?.email || null;
      recipientName = recipientName || contact?.name || null;
    }

    const suggestion = await tx.crmCommunicationSuggestion.create({
      data: {
        workspaceId: params.workspaceId,
        ...links,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        ownerUserId,
        channel: normalizeCommunicationChannel(params.channel),
        source: normalizeCrmActivitySource(params.source),
        status: "SUGGESTED",
        title,
        subject: params.subject?.trim() || null,
        bodyMd,
        recipientEmail,
        recipientName,
      },
      include: communicationSuggestionInclude,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.communication_suggestion.created",
        entityType: "CrmCommunicationSuggestion",
        entityId: suggestion.id,
        meta: { status: suggestion.status, channel: suggestion.channel },
      },
    });

    return suggestion;
  });
}

export async function updateCommunicationSuggestion(actor: AppActor, params: {
  workspaceId: string;
  suggestionId: string;
  title?: string;
  bodyMd?: string;
  subject?: string | null;
  recipientEmail?: string | null;
  recipientName?: string | null;
  channel?: string | null;
  ownerUserId?: string | null;
  source?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  activityId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const replacementLinks = { accountId: params.accountId, contactId: params.contactId,
      dealId: params.dealId, activityId: params.activityId };
    const suggestion = await requireCommunicationSuggestion(tx, params.workspaceId, params.suggestionId, replacementLinks);
    assertSuggestionEditable(suggestion);

    const data: any = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Suggestion title is required.");
      data.title = title;
    }
    if (params.bodyMd !== undefined) {
      const bodyMd = params.bodyMd.trim();
      invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Suggestion body is required.");
      data.bodyMd = bodyMd;
    }
    if (params.subject !== undefined) data.subject = params.subject?.trim() || null;
    if (params.recipientEmail !== undefined) data.recipientEmail = params.recipientEmail?.trim().toLowerCase() || null;
    if (params.recipientName !== undefined) data.recipientName = params.recipientName?.trim() || null;
    if (params.channel !== undefined) data.channel = normalizeCommunicationChannel(params.channel);
    if (params.source !== undefined) data.source = normalizeCrmActivitySource(params.source);
    if (params.ownerUserId !== undefined) {
      await requireCrmActivityOwner(tx, params.workspaceId, params.ownerUserId);
      data.ownerUserId = params.ownerUserId;
    }

    if (
      params.accountId !== undefined ||
      params.contactId !== undefined ||
      params.dealId !== undefined ||
      params.activityId !== undefined
    ) {
      const links = await resolveCommunicationSuggestionLinks(tx, {
        workspaceId: params.workspaceId,
        accountId: params.accountId,
        contactId: params.contactId,
        dealId: params.dealId,
        activityId: params.activityId,
      }, {
        accountId: suggestion.accountId,
        contactId: suggestion.contactId,
        dealId: suggestion.dealId,
        activityId: suggestion.activityId,
      });
      Object.assign(data, links);
    }

    const updated = await tx.crmCommunicationSuggestion.update({
      where: { id: suggestion.id },
      data,
      include: communicationSuggestionInclude,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.communication_suggestion.updated",
        entityType: "CrmCommunicationSuggestion",
        entityId: updated.id,
        meta: { fields: Object.keys(data) },
      },
    });

    return updated;
  });
}

export async function requestCommunicationSuggestionExecution(actor: AppActor, params: {
  workspaceId: string;
  suggestionId: string;
  externalRequestId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const suggestion = await requireCommunicationSuggestion(tx, params.workspaceId, params.suggestionId);
    assertSuggestionEditable(suggestion);
    const updated = await tx.crmCommunicationSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: "REQUESTED",
        externalRequestId: params.externalRequestId?.trim() || suggestion.externalRequestId || randomUUID(),
        ...suggestionTimestampData("REQUESTED", new Date()),
      },
      include: communicationSuggestionInclude,
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.communication_suggestion.requested",
        entityType: "CrmCommunicationSuggestion",
        entityId: updated.id,
        meta: { note: "External execution request tracked; no email sent by Corgtex." },
      },
    });
    return updated;
  });
}

export async function markCommunicationSuggestionSent(actor: AppActor, params: {
  workspaceId: string;
  suggestionId: string;
  sentAt?: Date | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const suggestion = await requireCommunicationSuggestion(tx, params.workspaceId, params.suggestionId);
    if (suggestion.status === "SENT") {
      return tx.crmCommunicationSuggestion.findUnique({
        where: { id: suggestion.id },
        include: communicationSuggestionInclude,
      });
    }
    invariant(suggestion.status !== "DECLINED", 400, "INVALID_STATE", "Declined suggestions cannot be marked sent.");
    const sentAt = normalizeCrmActivityDate(params.sentAt, "Sent date") ?? new Date();
    const updated = await tx.crmCommunicationSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: "SENT",
        sentAt,
        declinedAt: null,
        failedAt: null,
        failureReason: null,
      },
      include: communicationSuggestionInclude,
    });

    await tx.crmActivity.create({
      data: {
        workspaceId: params.workspaceId,
        accountId: suggestion.accountId,
        contactId: suggestion.contactId,
        dealId: suggestion.dealId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        type: CrmActivityType.EMAIL,
        title: suggestion.subject?.trim() || suggestion.title,
        bodyMd: suggestion.bodyMd,
        source: "communication_suggestion",
        createdAt: sentAt,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.communication_suggestion.sent",
        entityType: "CrmCommunicationSuggestion",
        entityId: updated.id,
        meta: { emailSentByCorgtex: false },
      },
    });

    return updated;
  });
}

export async function declineCommunicationSuggestion(actor: AppActor, params: {
  workspaceId: string;
  suggestionId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const suggestion = await requireCommunicationSuggestion(tx, params.workspaceId, params.suggestionId);
    if (suggestion.status === "DECLINED") {
      return tx.crmCommunicationSuggestion.findUnique({
        where: { id: suggestion.id },
        include: communicationSuggestionInclude,
      });
    }
    invariant(suggestion.status !== "SENT", 400, "INVALID_STATE", "Sent suggestions cannot be declined.");
    const updated = await tx.crmCommunicationSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: "DECLINED",
        ...suggestionTimestampData("DECLINED", new Date()),
      },
      include: communicationSuggestionInclude,
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.communication_suggestion.declined",
        entityType: "CrmCommunicationSuggestion",
        entityId: updated.id,
        meta: {},
      },
    });
    return updated;
  });
}

export async function failCommunicationSuggestion(actor: AppActor, params: {
  workspaceId: string;
  suggestionId: string;
  failureReason?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const suggestion = await requireCommunicationSuggestion(tx, params.workspaceId, params.suggestionId);
    invariant(suggestion.status !== "SENT" && suggestion.status !== "DECLINED", 400, "INVALID_STATE", "Finalized suggestions cannot be failed.");
    const updated = await tx.crmCommunicationSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: "FAILED",
        ...suggestionTimestampData("FAILED", new Date(), params.failureReason),
      },
      include: communicationSuggestionInclude,
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.communication_suggestion.failed",
        entityType: "CrmCommunicationSuggestion",
        entityId: updated.id,
        meta: { failureReason: updated.failureReason },
      },
    });
    return updated;
  });
}

// --- QUALIFICATIONS ---

export async function submitQualification(params: {
  token: string;
  companyName: string;
  website: string;
  roleTitle?: string;
  aiExperience: string;
  helpNeeded: string;
}) {
  const lead = await prisma.demoLead.findUnique({
    where: { qualifyToken: params.token },
    include: { workspace: true },
  });
  invariant(lead, 400, "INVALID_INPUT", "Invalid qualification token.");

  return prisma.$transaction(async (tx) => {
    const qualification = await tx.crmQualification.create({
      data: {
        workspaceId: lead.workspaceId,
        demoLeadId: lead.id,
        responseChannel: "form",
        companyName: params.companyName.trim(),
        website: params.website.trim(),
        roleTitle: params.roleTitle?.trim() || null,
        aiExperience: params.aiExperience.trim(),
        helpNeeded: params.helpNeeded.trim(),
        status: "PENDING_REVIEW",
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: lead.workspaceId,
        type: "crm.qualification.submitted",
        aggregateType: "CrmQualification",
        aggregateId: qualification.id,
        payload: { qualificationId: qualification.id, email: lead.email },
      },
    ]);

    return qualification;
  });
}

export async function receiveEmailReply(params: {
  fromEmail: string;
  subject: string;
  bodyText: string;
}) {
  const email = params.fromEmail.trim().toLowerCase();
  
  const lead = await prisma.demoLead.findFirst({
    where: { email },
    orderBy: { createdAt: 'desc' },
  });
  
  invariant(lead, 404, "NOT_FOUND", "No matching DemoLead found for inbound reply.");

  return prisma.$transaction(async (tx) => {
    const qualification = await tx.crmQualification.create({
      data: {
        workspaceId: lead.workspaceId,
        demoLeadId: lead.id,
        responseChannel: "email_reply",
        rawEmailReply: params.bodyText.trim(),
        rawEmailSubject: params.subject.trim(),
        status: "PENDING_REVIEW",
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: lead.workspaceId,
        type: "crm.qualification.submitted",
        aggregateType: "CrmQualification",
        aggregateId: qualification.id,
        payload: { qualificationId: qualification.id, email: lead.email, channel: "email_reply" },
      },
    ]);

    return qualification;
  });
}

export async function listQualifications(actor: AppActor, workspaceId: string, opts?: { status?: string; take?: number; skip?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  
  const where: any = { workspaceId };
  if (opts?.status) {
    where.status = opts.status;
  }

  const [items, total] = await Promise.all([
    prisma.crmQualification.findMany({
      where,
      include: {
        demoLead: {
          select: { email: true, source: true, createdAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.crmQualification.count({ where }),
  ]);
  
  return { items, total, take, skip };
}

export async function approveQualification(actor: AppActor, params: { workspaceId: string; qualificationId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const qual = await prisma.crmQualification.findUnique({
    where: { id: params.qualificationId },
    include: { demoLead: true },
  });
  invariant(qual && qual.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Qualification not found.");
  invariant(qual.status === "PENDING_REVIEW", 400, "INVALID_STATE", "Qualification is not pending review.");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.crmQualification.update({
      where: { id: qual.id },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      },
    });

    const accountParams = { email: qual.demoLead.email, company: qual.companyName,
      website: qual.website, source: "qualification" };
    const candidate = crmAccountCandidate(accountParams);
    const beforeAccount = candidate ? await findExistingCrmAccount(tx, params.workspaceId, candidate) : null;
    const contacts = qual.companyName || candidate ? await tx.crmContact.findMany({
        where: { workspaceId: params.workspaceId, email: qual.demoLead.email,
          ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]) },
        select: { id: true, email: true, accountId: true },
      }) : [];
    const activityIds = await prepareCrmAccountLinkSync(tx, {
      workspaceId: params.workspaceId, contacts, accountIds: [beforeAccount?.id],
    });
    const account = await ensureCrmAccount(tx, params.workspaceId, accountParams, beforeAccount ? [beforeAccount.id] : []);

    if (qual.companyName || account) {
      const contactData: any = {};
      if (qual.companyName) contactData.company = qual.companyName;
      if (account) contactData.accountId = account.id;
      await tx.crmContact.updateMany({
        where: { workspaceId: params.workspaceId, email: qual.demoLead.email,
          ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]) },
        data: contactData,
      });

      if (account) {
        await tx.crmConversation.updateMany({
          where: { workspaceId: params.workspaceId, demoLeadId: qual.demoLead.id, accountId: null },
          data: { accountId: account.id },
        });
        await tx.crmProspectWorkspace.updateMany({
          where: { crmWorkspaceId: params.workspaceId, demoLeadId: qual.demoLead.id, accountId: null },
          data: { accountId: account.id },
        });
        for (const contact of contacts) await syncCrmAccountLinksForContact(tx, {
          workspaceId: params.workspaceId, contactId: contact.id, email: contact.email, accountId: account.id,
          activityIds, locksHeld: true,
        });
      }
    }

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.qualification.approved",
        aggregateType: "CrmQualification",
        aggregateId: qual.id,
        payload: { qualificationId: qual.id, email: qual.demoLead.email },
      },
    ]);

    return updated;
  });
}

export async function rejectQualification(actor: AppActor, params: { workspaceId: string; qualificationId: string; note?: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const qual = await prisma.crmQualification.findUnique({ 
    where: { id: params.qualificationId },
    include: { demoLead: true } 
  });
  invariant(qual && qual.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Qualification not found.");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.crmQualification.update({
      where: { id: qual.id },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
        reviewNote: params.note || null,
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.qualification.rejected",
        aggregateType: "CrmQualification",
        aggregateId: qual.id,
        payload: { qualificationId: qual.id, email: qual.demoLead.email },
      },
    ]);

    return updated;
  });
}

export async function sendSchedulingLinkEmail(qualificationId: string) {
  const qual = await prisma.crmQualification.findUnique({
    where: { id: qualificationId },
    include: { demoLead: true },
  });
  invariant(qual, 404, "NOT_FOUND", "Qualification not found");
  invariant(qual.status === "APPROVED", 400, "INVALID_STATE", "Qualification must be approved to send scheduling link.");
  if (qual.schedulingEmailSentAt) return;

  // assume valid usage
  await prisma.crmQualification.update({
    where: { id: qual.id },
    data: { schedulingEmailSentAt: new Date() },
  });
}

// --- CONVERSATIONS ---

async function lockAndFindActiveCrmConversation(tx: any, workspaceId: string, conversation: CrmLinks & { id: string }) {
  await lockCrmLinkClosure(tx, workspaceId, conversation);
  return tx.crmConversation.findFirst({ where: { id: conversation.id, workspaceId,
    ...activeCrmParentWhere(["account", "contact", "deal"]) }, include: { account: true, contact: true, demoLead: true } });
}

export async function syncEmailReplyToConversation(params: {
  fromEmail: string;
  subject: string;
  bodyText: string;
}) {
  const email = params.fromEmail.trim().toLowerCase();
  return prisma.$transaction(async (tx) => {
    const lead = await tx.demoLead.findFirst({ where: { email }, orderBy: { createdAt: "desc" } });
    if (!lead) return null;
    const existing = await tx.crmConversation.findFirst({ where: { workspaceId: lead.workspaceId, demoLeadId: lead.id } });
    let conversation = existing ? await lockAndFindActiveCrmConversation(tx, lead.workspaceId, existing) : null;
    if (existing && !conversation) return null;
    if (!conversation) {
      const contactLinks = await tx.crmContact.findUnique({ where: { workspaceId_email: { workspaceId: lead.workspaceId, email } } });
      if (!contactLinks) return null;
      await lockCrmLinkClosure(tx, lead.workspaceId, { contactId: contactLinks.id, accountId: contactLinks.accountId });
      const contact = await tx.crmContact.findFirst({ where: { id: contactLinks.id, workspaceId: lead.workspaceId,
        ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]) } });
      if (!contact) return null;
      conversation = await tx.crmConversation.create({ data: { workspaceId: lead.workspaceId, accountId: contact.accountId ?? null,
        demoLeadId: lead.id, contactId: contact.id, subject: params.subject.trim() } });
    }
    const message = await tx.crmConversationMessage.create({ data: { conversationId: conversation.id, senderType: "LEAD",
      senderEmail: email, bodyMd: params.bodyText.trim() } });
    await tx.crmConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    return message;
  });
}

export async function createConversationMessage(actor: AppActor, params: {
  workspaceId: string;
  conversationId: string;
  bodyMd: string;
  senderType: "LEAD" | "ADMIN" | "SYSTEM";
  senderEmail?: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const links = await tx.crmConversation.findUnique({ where: { id: params.conversationId } });
    invariant(links && links.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Conversation not found.");
    const conversation = await lockAndFindActiveCrmConversation(tx, params.workspaceId, links);
    invariant(conversation, 404, "NOT_FOUND", "Conversation not found.");
    const message = await tx.crmConversationMessage.create({
      data: {
        conversationId: conversation.id,
        senderType: params.senderType,
        senderEmail: params.senderEmail || (params.senderType === "ADMIN" && actor.kind === "user" ? actor.user.email : null),
        senderUserId: params.senderType === "ADMIN" && actor.kind === "user" ? actor.user.id : null,
        bodyMd: params.bodyMd.trim(),
        isRead: params.senderType === "ADMIN",
      },
    });

    await tx.crmConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    return message;
  });
}

export async function getCrmConversation(actor: AppActor, params: { workspaceId: string; conversationId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const conversation = await prisma.crmConversation.findFirst({
    where: {
      id: params.conversationId,
      workspaceId: params.workspaceId,
      ...activeCrmParentWhere(["account", "contact", "deal"]),
    },
    include: {
      account: true,
      contact: true,
      demoLead: true,
      deal: true,
      messages: {
        orderBy: { createdAt: "asc" },
        include: { senderUser: { select: { id: true, email: true } } },
      },
    },
  });
  invariant(conversation, 404, "NOT_FOUND", "Conversation not found.");

  return conversation;
}

export async function listCrmConversations(actor: AppActor, workspaceId: string, opts?: { accountId?: string; contactId?: string; demoLeadId?: string; take?: number; skip?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  
  const where: any = { workspaceId, ...activeCrmParentWhere(["account", "contact", "deal"]) };
  if (opts?.accountId) where.accountId = opts.accountId;
  if (opts?.contactId) where.contactId = opts.contactId;
  if (opts?.demoLeadId) where.demoLeadId = opts.demoLeadId;

  const [items, total] = await Promise.all([
    prisma.crmConversation.findMany({
      where,
      include: {
        account: { select: { id: true, name: true, slug: true, relationshipType: true, lifecycleStage: true, archivedAt: true } },
        contact: { select: { id: true, name: true, email: true, company: true, archivedAt: true } },
        demoLead: { select: { id: true, email: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    }),
    prisma.crmConversation.count({ where }),
  ]);
  
  return { items, total, take, skip };
}

// --- PROVISIONING ---

export async function listCrmProspectWorkspaces(actor: AppActor, workspaceId: string, opts?: {
  accountId?: string;
  status?: string;
  take?: number;
  skip?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const take = opts?.take ?? 50;
  const skip = opts?.skip ?? 0;
  const where: any = { crmWorkspaceId: workspaceId, ...activeCrmParentWhere(["account"]) };
  if (opts?.accountId) where.accountId = opts.accountId;
  if (opts?.status) where.status = opts.status;

  const [items, total] = await Promise.all([
    prisma.crmProspectWorkspace.findMany({
      where,
      include: {
        account: {
          select: { id: true, name: true, slug: true, relationshipType: true, lifecycleStage: true, archivedAt: true },
        },
        demoLead: true,
        targetWorkspace: { select: { id: true, slug: true, name: true } },
      },
      orderBy: { provisionedAt: "desc" },
      take,
      skip,
    }),
    prisma.crmProspectWorkspace.count({ where }),
  ]);

  return { items, total, take, skip };
}

export async function provisionProspectWorkspace(actor: AppActor, params: {
  demoLeadId: string;
  adminEmail: string;
  crmWorkspaceId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.crmWorkspaceId });
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only human users can provision prospect workspaces.");

  return prisma.$transaction(async (tx) => {
    const lead = await tx.demoLead.findUnique({ where: { id: params.demoLeadId } });
    invariant(lead && lead.workspaceId === params.crmWorkspaceId, 404, "NOT_FOUND", "Demo lead not found");
    const existing = await tx.crmProspectWorkspace.findFirst({
      where: { demoLeadId: lead.id, crmWorkspaceId: params.crmWorkspaceId },
    });
    if (existing) return existing;
    const contactLinks = await tx.crmContact.findFirst({
      where: { workspaceId: params.crmWorkspaceId, email: lead.email,
        ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]) },
      select: { id: true, accountId: true },
    });
    if (contactLinks) await lockCrmLinks(tx, { contactId: contactLinks.id, accountId: contactLinks.accountId });
    const contact = contactLinks ? await tx.crmContact.findFirst({ where: {
      id: contactLinks.id, workspaceId: params.crmWorkspaceId,
      ...archiveFilterWhere(), ...activeCrmParentWhere(["account"]),
    }, select: { accountId: true } }) : null;
    invariant(!contactLinks || contact, 409, "ARCHIVED_PARENT", "Restore the matching contact and account before provisioning.");
    const newWorkspaceName = `Demo Workspace (${lead.email})`;
    const newWorkspaceSlug = `demo-${Date.now()}`;
    const targetWorkspace = await tx.workspace.create({
      data: {
        name: newWorkspaceName,
        slug: newWorkspaceSlug,
      },
    });

    const prospectWorkspace = await tx.crmProspectWorkspace.create({
      data: {
        crmWorkspaceId: params.crmWorkspaceId,
        accountId: contact?.accountId ?? null,
        demoLeadId: lead.id,
        targetWorkspaceId: targetWorkspace.id,
        adminEmail: params.adminEmail,
        status: "ACTIVE",
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.crmWorkspaceId,
        type: "crm.prospect_workspace.provisioned",
        aggregateType: "CrmProspectWorkspace",
        aggregateId: prospectWorkspace.id,
        payload: { targetWorkspaceId: targetWorkspace.id, adminEmail: params.adminEmail },
      },
    ]);

    return prospectWorkspace;
  });
}

export async function registerCrmAccountCustomerLifecycle(actor: AppActor, params: {
  workspaceId: string;
  accountId: string;
  prospectWorkspaceId: string;
  accountStatus?: CustomerAccountStatus;
  deploymentStatus?: CustomerDeploymentStatus;
  supportOwnerEmail?: string | null;
  notes?: string | null;
  primary?: boolean;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  requireGlobalOperator(actor);

  return prisma.$transaction(async (tx) => {
    const account = await requireCrmAccount(tx, params.workspaceId, params.accountId);
    const prospectWorkspace = await tx.crmProspectWorkspace.findUnique({
      where: { id: params.prospectWorkspaceId },
      include: {
        targetWorkspace: {
          select: { id: true, slug: true, name: true, description: true },
        },
      },
    });
    invariant(
      prospectWorkspace && prospectWorkspace.crmWorkspaceId === params.workspaceId,
      404,
      "NOT_FOUND",
      "Prospect workspace not found.",
    );
    invariant(
      prospectWorkspace.accountId === account.id,
      400,
      "INVALID_STATE",
      "Prospect workspace is not linked to this account.",
    );

    const targetWorkspace = prospectWorkspace.targetWorkspace;
    const result = await registerCustomerDeployment({
      accountSlug: account.slug,
      accountDisplayName: account.name,
      accountStatus: params.accountStatus ?? "ACTIVE",
      managementAuthority: "CORGTEX",
      label: targetWorkspace.name,
      url: `${env.APP_URL.replace(/\/$/, "")}/workspaces/${targetWorkspace.id}`,
      environment: "production",
      notes: params.notes ?? `CRM customer lifecycle registration for ${account.name}.`,
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: params.deploymentStatus ?? "ACTIVE",
      customerSlug: account.slug,
      supportOwnerEmail: params.supportOwnerEmail,
      managedWorkspaceId: targetWorkspace.id,
      remoteWorkspaceSlug: targetWorkspace.slug,
      remoteWorkspaceId: targetWorkspace.id,
      primary: params.primary ?? true,
    }, tx);

    const updatedAccount = await tx.crmAccount.update({
      where: { id: account.id },
      data: {
        relationshipType: "CLIENT",
        lifecycleStage: "ACTIVE",
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "crm.account.customer_lifecycle_registered",
        entityType: "CrmAccount",
        entityId: account.id,
        meta: {
          prospectWorkspaceId: prospectWorkspace.id,
          targetWorkspaceId: targetWorkspace.id,
          customerAccountId: result.account.id,
          customerDeploymentId: result.deployment.id,
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "crm.account.customer_lifecycle_registered",
        aggregateType: "CrmAccount",
        aggregateId: account.id,
        payload: {
          accountId: account.id,
          prospectWorkspaceId: prospectWorkspace.id,
          targetWorkspaceId: targetWorkspace.id,
          customerAccountId: result.account.id,
          customerDeploymentId: result.deployment.id,
        },
      },
    ]);

    return {
      account: updatedAccount,
      prospectWorkspace,
      customerAccount: result.account,
      customerDeployment: result.deployment,
    };
  });
}
