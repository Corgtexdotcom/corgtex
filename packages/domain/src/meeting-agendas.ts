import type { MeetingInsightType } from "@prisma/client";
import type { MeetingIntelligenceContext } from "./meeting-intelligence-context";

export const REGULAR_UPDATE_AGENDA_TEMPLATE_KEY = "regular_update_v1";

type AgendaTagKey =
  | "created_from_last_meeting"
  | "carried_forward"
  | "overdue"
  | "due_soon";

type AgendaSourceType = "Action" | "Decision" | "MeetingInsight" | "Proposal" | "Tension";

export type MeetingAgendaTag = {
  key: AgendaTagKey;
  label: string;
};

export type MeetingAgendaItem = {
  id: string;
  text: string;
  bodyMd?: string | null;
  owner?: string | null;
  circle?: string | null;
  status?: string | null;
  sourceType?: AgendaSourceType | null;
  sourceId?: string | null;
  sourceMeetingId?: string | null;
  tags?: MeetingAgendaTag[];
};

export type MeetingAgendaGroup = {
  key: string;
  title: string;
  items: MeetingAgendaItem[];
  collapsedByDefault?: boolean;
};

export type MeetingAgendaSection = {
  key: string;
  title: string;
  description?: string | null;
  items?: MeetingAgendaItem[];
  groups?: MeetingAgendaGroup[];
};

export type RegularUpdateMeetingAgenda = {
  templateKey: typeof REGULAR_UPDATE_AGENDA_TEMPLATE_KEY;
  version: 1;
  generationMode: "deterministic";
  title: string;
  generatedAt: string;
  participantOrder: Array<{
    memberId: string;
    name: string;
    email: string;
    circles: string[];
  }>;
  sections: MeetingAgendaSection[];
};

export type LegacyMeetingAgenda = {
  title: string;
  intro?: string | null;
  sections: Array<{
    title: string;
    durationMinutes?: number | null;
    items: Array<{
      text: string;
      sourceType?: string | null;
      sourceId?: string | null;
      owner?: string | null;
    }>;
  }>;
};

export type MeetingAgenda = RegularUpdateMeetingAgenda | LegacyMeetingAgenda;

export type MeetingAgendaTemplate = {
  key: typeof REGULAR_UPDATE_AGENDA_TEMPLATE_KEY;
  generationMode: "deterministic";
};

export const MEETING_AGENDA_TEMPLATES: Record<typeof REGULAR_UPDATE_AGENDA_TEMPLATE_KEY, MeetingAgendaTemplate> = {
  [REGULAR_UPDATE_AGENDA_TEMPLATE_KEY]: {
    key: REGULAR_UPDATE_AGENDA_TEMPLATE_KEY,
    generationMode: "deterministic",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function tag(key: AgendaTagKey): MeetingAgendaTag {
  const labels: Record<AgendaTagKey, string> = {
    created_from_last_meeting: "Created last meeting",
    carried_forward: "Carried forward",
    overdue: "Overdue",
    due_soon: "Due soon",
  };
  return { key, label: labels[key] };
}

function uniqueTags(tags: MeetingAgendaTag[]) {
  const seen = new Set<string>();
  return tags.filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

function sourceKey(sourceType?: string | null, sourceId?: string | null) {
  return sourceType && sourceId ? `${sourceType}:${sourceId}` : null;
}

function regularItemId(prefix: string, id: string) {
  return `${prefix}:${id}`;
}

function isCreatedFromPreviousMeeting(context: MeetingIntelligenceContext, sourceType: AgendaSourceType, sourceId: string) {
  const key = sourceKey(sourceType, sourceId);
  return Boolean(key && context.createdFromPreviousMeeting.some((item) => sourceKey(item.entityType, item.entityId) === key));
}

function dueTags(dueAt: string | null, meetingDate: Date) {
  if (!dueAt) return [];
  const dueDate = new Date(dueAt);
  if (Number.isNaN(dueDate.valueOf())) return [];
  if (dueDate < meetingDate) return [tag("overdue")];
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  if (dueDate.getTime() - meetingDate.getTime() <= sevenDays) return [tag("due_soon")];
  return [];
}

function parseDecisionItems(decisionsJson: unknown, meetingId: string): MeetingAgendaItem[] {
  if (!isRecord(decisionsJson) || !Array.isArray(decisionsJson.items)) return [];
  return decisionsJson.items
    .map((item, index): MeetingAgendaItem | null => {
      if (!isRecord(item)) return null;
      const title = asString(item.title);
      const bodyMd = asString(item.bodyMd);
      if (!title && !bodyMd) return null;
      return {
        id: regularItemId("decision", `${meetingId}:${index}`),
        text: title || bodyMd,
        bodyMd: bodyMd || null,
        sourceType: "Decision",
        sourceMeetingId: meetingId,
      };
    })
    .filter((item): item is MeetingAgendaItem => Boolean(item));
}

function emptyItem(key: string, text: string): MeetingAgendaItem {
  return { id: key, text };
}

export function isRegularUpdateAgenda(value: unknown): value is RegularUpdateMeetingAgenda {
  return isRecord(value)
    && value.templateKey === REGULAR_UPDATE_AGENDA_TEMPLATE_KEY
    && value.version === 1
    && Array.isArray(value.sections);
}

export function isRecurringMeetingContext(context: MeetingIntelligenceContext) {
  return Boolean(context.meeting.seriesId && context.meeting.seriesRecurrenceRule);
}

export function selectedMeetingAgendaTemplate(context: MeetingIntelligenceContext): MeetingAgendaTemplate | null {
  return isRecurringMeetingContext(context) ? MEETING_AGENDA_TEMPLATES[REGULAR_UPDATE_AGENDA_TEMPLATE_KEY] : null;
}

export function buildLegacyAgendaFallback(context: MeetingIntelligenceContext): LegacyMeetingAgenda {
  const sections: LegacyMeetingAgenda["sections"] = [
    {
      title: "Check-in",
      durationMinutes: 5,
      items: [{ text: "Brief check-in round." }],
    },
    {
      title: "Tensions to process",
      items: context.tensions.map((tension) => ({
        text: `${tension.title}${tension.upvotes ? ` (${tension.upvotes} upvotes)` : ""}`,
        sourceType: "Tension",
        sourceId: tension.id,
        owner: tension.owner,
      })),
    },
    {
      title: "Follow-ups from last meeting",
      items: context.followUps.map((followUp) => ({
        text: followUp.title,
        sourceType: "MeetingInsight",
        sourceId: followUp.id,
        owner: followUp.owner,
      })),
    },
    {
      title: "Pending actions",
      items: context.actions.map((action) => ({
        text: action.title,
        sourceType: "Action",
        sourceId: action.id,
        owner: action.owner,
      })),
    },
    {
      title: "Checkout",
      durationMinutes: 3,
      items: [{ text: "Confirm decisions, owners, and next follow-ups." }],
    },
  ].map((section) => ({
    ...section,
    items: section.items.length > 0 ? section.items : [{ text: "No items found." }],
  }));

  return {
    title: context.meeting.title || "Meeting agenda",
    intro: null,
    sections,
  };
}

export function normalizeLegacyAgenda(output: Record<string, unknown>, fallbackTitle: string, fallbackSections: LegacyMeetingAgenda["sections"]): LegacyMeetingAgenda {
  const sectionsRaw = Array.isArray(output.sections) ? output.sections : [];
  const sections = sectionsRaw.map((section): LegacyMeetingAgenda["sections"][number] | null => {
    if (!isRecord(section)) return null;
    const title = asString(section.title);
    const itemsRaw = Array.isArray(section.items) ? section.items : [];
    const items: LegacyMeetingAgenda["sections"][number]["items"] = [];
    for (const item of itemsRaw) {
      if (typeof item === "string") {
        const text = item.trim();
        if (text) items.push({ text });
        continue;
      }
      if (!isRecord(item)) continue;
      const text = asString(item.text);
      if (!text) continue;
      items.push({
        text,
        sourceType: asString(item.sourceType) || null,
        sourceId: asString(item.sourceId) || null,
        owner: asString(item.owner) || null,
      });
    }
    if (!title || items.length === 0) return null;
    return {
      title,
      items,
      durationMinutes: typeof section.durationMinutes === "number" ? section.durationMinutes : null,
    };
  }).filter((section): section is LegacyMeetingAgenda["sections"][number] => Boolean(section));

  return {
    title: asString(output.title) || fallbackTitle,
    intro: asString(output.intro) || null,
    sections: sections.length > 0 ? sections : fallbackSections,
  };
}

export function buildRegularUpdateAgenda(context: MeetingIntelligenceContext, now = new Date()): RegularUpdateMeetingAgenda {
  const meetingDate = context.meeting.recordedAt instanceof Date
    ? context.meeting.recordedAt
    : new Date(context.meeting.recordedAt);
  const previousMeeting = context.previousMeetings[0] ?? null;
  const previousMeetingId = previousMeeting?.id ?? null;
  const decisions = previousMeeting ? parseDecisionItems(previousMeeting.decisionsJson, previousMeeting.id) : [];
  const resolvedTensions = context.resolvedTensions
    .filter((item) => !previousMeetingId || item.meetingId === previousMeetingId)
    .map((item): MeetingAgendaItem => ({
      id: regularItemId("resolved-tension", item.id),
      text: item.title,
      bodyMd: item.bodyMd,
      sourceType: "Tension",
      sourceId: item.targetEntityId,
      sourceMeetingId: item.meetingId,
    }));

  const participantOrder = context.attendees.map((attendee) => ({
    memberId: attendee.memberId,
    name: attendee.name || attendee.email,
    email: attendee.email,
    circles: attendee.circles,
  }));
  const checkInItems = participantOrder.map((attendee): MeetingAgendaItem => ({
    id: regularItemId("attendee", attendee.memberId),
    text: attendee.name,
  }));
  const circleUpdateItems = participantOrder.map((attendee): MeetingAgendaItem => ({
    id: regularItemId("circle-update", attendee.memberId),
    text: attendee.name,
    circle: attendee.circles.join(", ") || null,
  }));

  const tensionItems = context.tensions.map((item): MeetingAgendaItem => ({
    id: regularItemId("tension", item.id),
    text: item.title,
    bodyMd: item.bodyMd,
    owner: item.owner,
    circle: item.circle,
    status: item.status,
    sourceType: "Tension",
    sourceId: item.id,
    tags: uniqueTags([
      ...(isCreatedFromPreviousMeeting(context, "Tension", item.id) ? [tag("created_from_last_meeting")] : []),
    ]),
  }));
  const proposalItems = context.proposals.map((item): MeetingAgendaItem => ({
    id: regularItemId("proposal", item.id),
    text: item.title,
    bodyMd: item.summary || item.bodyMd,
    owner: item.author,
    circle: item.circle,
    status: item.status,
    sourceType: "Proposal",
    sourceId: item.id,
    tags: uniqueTags([
      ...(isCreatedFromPreviousMeeting(context, "Proposal", item.id) ? [tag("created_from_last_meeting")] : []),
    ]),
  }));
  const actionItems = context.actions.map((item): MeetingAgendaItem => ({
    id: regularItemId("action", item.id),
    text: item.title,
    bodyMd: item.bodyMd,
    owner: item.owner,
    circle: item.circle,
    status: item.status,
    sourceType: "Action",
    sourceId: item.id,
    tags: uniqueTags([
      ...(isCreatedFromPreviousMeeting(context, "Action", item.id) ? [tag("created_from_last_meeting")] : []),
      ...dueTags(item.dueAt, meetingDate),
    ]),
  }));
  const followUpItems = context.followUps.map((item): MeetingAgendaItem => ({
    id: regularItemId("follow-up", item.id),
    text: item.title,
    bodyMd: item.bodyMd,
    owner: item.owner,
    sourceType: "MeetingInsight",
    sourceId: item.id,
    sourceMeetingId: item.meetingId,
    tags: [tag("carried_forward")],
  }));

  return {
    templateKey: REGULAR_UPDATE_AGENDA_TEMPLATE_KEY,
    version: 1,
    generationMode: "deterministic",
    title: context.meeting.title || context.meeting.seriesTitle || "Regular update meeting",
    generatedAt: now.toISOString(),
    participantOrder,
    sections: [
      {
        key: "check_in",
        title: "Check-in",
        description: "Name order only.",
        items: checkInItems.length > 0 ? checkInItems : [emptyItem("check-in:none", "No participants listed.")],
      },
      {
        key: "last_meeting_recap",
        title: "Last meeting recap",
        description: previousMeeting ? previousMeeting.summaryMd : "No previous meeting summary found.",
        groups: [
          {
            key: "decisions",
            title: "Decisions",
            items: decisions.length > 0 ? decisions : [emptyItem("decisions:none", "No decisions recorded.")],
          },
          {
            key: "resolved_tensions",
            title: "Resolved tensions",
            items: resolvedTensions.length > 0 ? resolvedTensions : [emptyItem("resolved-tensions:none", "No resolved tensions recorded.")],
          },
        ],
      },
      {
        key: "circle_updates",
        title: "Circle updates",
        description: "Use the same order as check-in.",
        items: circleUpdateItems.length > 0 ? circleUpdateItems : [emptyItem("circle-updates:none", "No participant circle updates listed.")],
      },
      {
        key: "work_queue",
        title: "Work queue",
        groups: [
          {
            key: "tensions",
            title: "Tensions",
            items: tensionItems.length > 0 ? tensionItems : [emptyItem("tensions:none", "No open tensions found.")],
          },
          {
            key: "proposals",
            title: "Proposals",
            items: proposalItems.length > 0 ? proposalItems : [emptyItem("proposals:none", "No open proposals found.")],
          },
          {
            key: "actions_followups",
            title: "Action items and follow-ups",
            collapsedByDefault: actionItems.length + followUpItems.length > 5,
            items: actionItems.length + followUpItems.length > 0
              ? [...actionItems, ...followUpItems]
              : [emptyItem("actions-followups:none", "No pending action items or follow-ups found.")],
          },
        ],
      },
      {
        key: "checkout",
        title: "Checkout",
        items: [
          emptyItem("checkout:decisions", "Confirm decisions made."),
          emptyItem("checkout:owners", "Confirm owners and next steps."),
          emptyItem("checkout:carry-forward", "Confirm open items to carry forward."),
        ],
      },
    ],
  };
}

export function agendaSectionTitles(agendaJson: unknown) {
  const agenda = normalizeMeetingAgendaForDisplay(agendaJson, "Meeting agenda");
  return agenda?.sections.map((section) => section.title) ?? [];
}

export function normalizeMeetingAgendaForDisplay(agendaJson: unknown, fallbackTitle: string): MeetingAgenda | null {
  if (isRegularUpdateAgenda(agendaJson)) return agendaJson;
  if (!isRecord(agendaJson)) return null;
  const fallback = normalizeLegacyAgenda({}, fallbackTitle, []);
  const agenda = normalizeLegacyAgenda(agendaJson, fallbackTitle, fallback.sections);
  return agenda.sections.length > 0 ? agenda : null;
}

export function meetingAgendaSections(agenda: MeetingAgenda): MeetingAgendaSection[] {
  if (isRegularUpdateAgenda(agenda)) return agenda.sections;
  return agenda.sections.map((section, index) => ({
    key: `legacy:${index}`,
    title: section.title,
    items: section.items.map((item, itemIndex) => ({
      id: `legacy:${index}:${itemIndex}`,
      text: item.text,
      owner: item.owner,
      sourceType: item.sourceType as AgendaSourceType | null | undefined,
      sourceId: item.sourceId,
    })),
  }));
}

function truncate(text: string, max = 2900) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function displayDate(date: Date, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

function itemLine(item: MeetingAgendaItem, index: number) {
  const owner = item.owner ? ` (${item.owner})` : "";
  const tags = item.tags && item.tags.length > 0 ? ` [${item.tags.map((entry) => entry.label).join(", ")}]` : "";
  return `${index + 1}. ${item.text}${owner}${tags}`;
}

function slackSection(title: string, lines: string[]) {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncate(`*${title}*\n${lines.length > 0 ? lines.join("\n") : "_None._"}`),
    },
  };
}

export function renderAgendaSlackBlocks(params: {
  meeting: { title: string | null; recordedAt: Date; scheduledEndAt: Date | null };
  agenda: MeetingAgenda;
  attendeeMentions: string[];
  timezone: string;
}) {
  const when = params.meeting.scheduledEndAt
    ? `${displayDate(params.meeting.recordedAt, params.timezone)}-${new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: params.timezone,
    }).format(params.meeting.scheduledEndAt)}`
    : displayDate(params.meeting.recordedAt, params.timezone);
  const sections = meetingAgendaSections(params.agenda);

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Tomorrow's agenda: ${params.meeting.title || params.agenda.title}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*When:* ${when}`,
          params.attendeeMentions.length > 0 ? `*Attendees:* ${params.attendeeMentions.join(" ")}` : null,
          !isRegularUpdateAgenda(params.agenda) && params.agenda.intro ? `\n${params.agenda.intro}` : null,
        ].filter(Boolean).join("\n"),
      },
    },
    { type: "divider" },
    ...sections.flatMap((section) => {
      if (section.groups && section.groups.length > 0) {
        return [
          slackSection(section.title, section.description ? [section.description] : []),
          ...section.groups.map((group) => slackSection(group.title, group.items.map(itemLine))),
        ];
      }
      return [slackSection(section.title, (section.items ?? []).map(itemLine))];
    }),
  ];
}
