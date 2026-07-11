import { computeNewspaperLayout, type NewspaperSurface } from "./newspaper-layout";

export type NewspaperEmailSectionId =
  | "adviceRequests"
  | "meetingBriefs"
  | "decisionsAndProposals"
  | "resolvedTensions"
  | "openActions"
  | "goalsProgress"
  | "rolesAndPeople"
  | "keyDecisions"
  | "actionItems"
  | "builtWork"
  | "conversationHighlights"
  | "teamPulse"
  | "emergingTensions"
  | "otherUpdates";

export type NewspaperDigestSection = {
  id: NewspaperEmailSectionId;
  title: string;
  items: string[];
};

export type NormalizedNewspaperDigest = {
  intro: string | null;
  sections: NewspaperDigestSection[];
};

export const NEWSPAPER_SECTION_DEFINITIONS: Array<{
  id: NewspaperEmailSectionId;
  title: string;
  aliases: string[];
}> = [
  { id: "adviceRequests", title: "Requests Awaiting Your Input", aliases: ["inputRequests", "requestsAwaitingInput", "pendingAdviceRequests"] },
  { id: "meetingBriefs", title: "Meeting Briefs", aliases: ["meetings", "meetingSummaries", "meetingBriefings"] },
  { id: "decisionsAndProposals", title: "Decisions & Proposals", aliases: ["decisions", "proposals"] },
  { id: "resolvedTensions", title: "Resolved Tensions", aliases: ["closedTensions", "resolvedIssues"] },
  { id: "openActions", title: "Open Actions", aliases: ["assignedActions", "openActionItems", "actions"] },
  { id: "goalsProgress", title: "Goals & Quarterly Progress", aliases: ["goals", "goalUpdates", "quarterlyGoals", "progress"] },
  { id: "rolesAndPeople", title: "Roles & People", aliases: ["roleChanges", "peopleChanges", "newMembers", "roles"] },
  { id: "keyDecisions", title: "Key Decisions Made", aliases: ["keyDecisionsMade"] },
  { id: "actionItems", title: "Action Items Identified", aliases: ["actions", "nextActions"] },
  { id: "builtWork", title: "Built / Shipped Work", aliases: ["shippedWork", "buildArtifacts"] },
  { id: "conversationHighlights", title: "Conversation Highlights", aliases: ["highlights", "summary"] },
  { id: "teamPulse", title: "Team Pulse", aliases: ["pulse", "sentiment"] },
  { id: "emergingTensions", title: "Emerging Tensions", aliases: ["tensions", "risks"] },
  { id: "otherUpdates", title: "Other Updates", aliases: ["misc", "other", "brainUpdates", "documentUpdates"] },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function textFromRecord(value: Record<string, unknown>) {
  const title = asText(value.title) ?? asText(value.heading) ?? asText(value.label);
  const body = asText(value.body) ?? asText(value.bodyMd) ?? asText(value.summary) ?? asText(value.text) ?? asText(value.rationale);
  if (title && body && title !== body) return `${title}: ${body}`;
  return title ?? body;
}

function splitTextItems(value: string) {
  const bulletLines = value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);

  if (bulletLines.length > 1) return bulletLines;

  return value
    .split(/\n{2,}/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function normalizeItems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeItems(item));
  }

  if (typeof value === "string") {
    return splitTextItems(value);
  }

  if (isRecord(value)) {
    const text = textFromRecord(value);
    return text ? [text] : [];
  }

  return [];
}

function normalizeSectionValue(value: unknown): string[] {
  if (isRecord(value)) {
    const nestedItems = normalizeItems(value.items ?? value.entries ?? value.bullets ?? value.points);
    if (nestedItems.length > 0) return nestedItems;
  }

  return normalizeItems(value);
}

function sectionItemsFromRecord(record: Record<string, unknown>, id: NewspaperEmailSectionId, aliases: string[]) {
  const keys = [id, ...aliases];
  const directItems = keys.flatMap((key) => normalizeSectionValue(record[key]));

  if (directItems.length > 0) return directItems;

  const sections = record.sections;
  if (Array.isArray(sections)) {
    const matchingSection = sections.find((section) => {
      if (!isRecord(section)) return false;
      const sectionId = asText(section.id)?.replace(/\s+/g, "");
      const title = asText(section.title)?.toLowerCase();
      return sectionId === id || title === NEWSPAPER_SECTION_DEFINITIONS.find((definition) => definition.id === id)?.title.toLowerCase();
    });
    if (isRecord(matchingSection)) {
      return normalizeSectionValue(matchingSection);
    }
  }

  if (isRecord(sections)) {
    return keys.flatMap((key) => normalizeSectionValue(sections[key]));
  }

  return [];
}

export function capNewspaperDigestSections(
  sections: NewspaperDigestSection[],
  surface: NewspaperSurface = "email",
) {
  const layout = computeNewspaperLayout(sections.map((section, index) => ({
    id: section.id,
    priority: index + 1,
    itemCount: section.items.length,
    estimatedTextLength: section.items.reduce((sum, item) => sum + item.length, 0),
    surface,
  })));
  const byId = new Map(sections.map((section) => [section.id, section]));

  return layout.visibleSections.flatMap((section) => {
    const digestSection = byId.get(section.id);
    if (!digestSection) return [];
    return [{
      ...digestSection,
      items: digestSection.items.slice(0, section.itemCap),
    }];
  });
}

export function normalizeNewspaperDigestPayload(input: unknown): NormalizedNewspaperDigest {
  const record = isRecord(input) ? input : {};
  const intro = asText(record.intro) ?? asText(record.overview) ?? null;
  const sections = NEWSPAPER_SECTION_DEFINITIONS.flatMap((definition) => {
    const items = sectionItemsFromRecord(record, definition.id, definition.aliases)
      .map((item) => item.slice(0, 1000).trim())
      .filter(Boolean);
    if (items.length === 0) return [];
    return [{ id: definition.id, title: definition.title, items }];
  });

  const fallbackSummary = asText(record.summary);
  const normalizedSections = sections.length > 0 || !fallbackSummary
    ? sections
    : [{
      id: "conversationHighlights" as const,
      title: "Conversation Highlights",
      items: [fallbackSummary],
    }];

  return {
    intro,
    sections: capNewspaperDigestSections(normalizedSections),
  };
}

export function normalizeNewspaperEditionDigest(edition: { digestJson: unknown }) {
  return normalizeNewspaperDigestPayload(edition.digestJson);
}

function markdownListItem(value: string) {
  return `- ${value.replace(/\r?\n/g, " ").trim()}`;
}

export function renderNewspaperDigestMarkdown(params: {
  title: string;
  digest: NormalizedNewspaperDigest;
}) {
  const lines = [`# ${params.title}`];
  if (params.digest.intro) {
    lines.push("", params.digest.intro);
  }

  for (const section of params.digest.sections) {
    lines.push("", `## ${section.title}`, "", ...section.items.map(markdownListItem));
  }

  return lines.join("\n").trim();
}
