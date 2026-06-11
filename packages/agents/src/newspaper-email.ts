import { computeNewspaperLayout } from "@corgtex/domain";

export type NewspaperEmailSectionId =
  | "keyDecisions"
  | "actionItems"
  | "builtWork"
  | "conversationHighlights"
  | "teamPulse"
  | "emergingTensions";

export type NewspaperDigestSection = {
  id: NewspaperEmailSectionId;
  title: string;
  items: string[];
};

export type NormalizedNewspaperDigest = {
  intro: string | null;
  sections: NewspaperDigestSection[];
};

export type NewspaperPersonalization = {
  greeting: string | null;
  intro: string | null;
  memberNote: string | null;
  emphasizedSectionIds: NewspaperEmailSectionId[];
};

const SECTION_DEFINITIONS: Array<{
  id: NewspaperEmailSectionId;
  title: string;
  aliases: string[];
}> = [
  { id: "keyDecisions", title: "Key Decisions Made", aliases: ["keyDecisionsMade", "decisions"] },
  { id: "actionItems", title: "Action Items Identified", aliases: ["actions", "nextActions"] },
  { id: "builtWork", title: "Built / Shipped Work", aliases: ["shippedWork", "buildArtifacts"] },
  { id: "conversationHighlights", title: "Conversation Highlights", aliases: ["highlights", "summary"] },
  { id: "teamPulse", title: "Team Pulse", aliases: ["pulse", "sentiment"] },
  { id: "emergingTensions", title: "Emerging Tensions", aliases: ["tensions", "risks"] },
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
      return sectionId === id || title === SECTION_DEFINITIONS.find((definition) => definition.id === id)?.title.toLowerCase();
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

function capEmailSections(sections: NewspaperDigestSection[]) {
  const layout = computeNewspaperLayout(sections.map((section, index) => ({
    id: section.id,
    priority: index + 1,
    itemCount: section.items.length,
    estimatedTextLength: section.items.reduce((sum, item) => sum + item.length, 0),
    surface: "email" as const,
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
  const sections = SECTION_DEFINITIONS.flatMap((definition) => {
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
    sections: capEmailSections(normalizedSections),
  };
}

export function normalizeNewspaperPersonalizationPayload(input: unknown): NewspaperPersonalization {
  const record = isRecord(input) ? input : {};
  const emphasizedSectionIds = Array.isArray(record.emphasizedSectionIds)
    ? record.emphasizedSectionIds.filter((id): id is NewspaperEmailSectionId => (
      typeof id === "string" && SECTION_DEFINITIONS.some((definition) => definition.id === id)
    ))
    : [];

  return {
    greeting: asText(record.greeting),
    intro: asText(record.intro),
    memberNote: asText(record.memberNote) ?? asText(record.note),
    emphasizedSectionIds,
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function renderHtmlText(value: string) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
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

export function renderNewspaperEmailHtml(params: {
  title: string;
  workspaceName: string;
  recipientName: string | null;
  workspaceUrl: string;
  digest: NormalizedNewspaperDigest;
  personalization?: NewspaperPersonalization;
}) {
  const recipient = params.recipientName?.trim() || "there";
  const greeting = params.personalization?.greeting ?? `Hello ${recipient},`;
  const intro = params.personalization?.intro ?? params.digest.intro;
  const emphasized = new Set(params.personalization?.emphasizedSectionIds ?? []);
  const sectionRows = params.digest.sections.map((section) => {
    const borderColor = emphasized.has(section.id) ? "#6750a4" : "#2d2a24";
    const items = section.items.map((item) => (
      `<li style="margin:0 0 8px;padding:0;font-size:15px;line-height:1.55;color:#2d2a24;">${renderHtmlText(item)}</li>`
    )).join("");
    return `
            <tr>
              <td style="padding:18px 0;border-top:2px solid ${borderColor};">
                <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:20px;line-height:1.2;margin:0 0 10px;color:#1f1d1a;">${escapeHtml(section.title)}</h2>
                <ul style="margin:0;padding:0 0 0 20px;">${items}</ul>
              </td>
            </tr>`;
  }).join("");
  const memberNote = params.personalization?.memberNote
    ? `<p style="font-size:15px;line-height:1.6;margin:18px 0 0;color:#5b5448;">${renderHtmlText(params.personalization.memberNote)}</p>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f4f1ea;color:#1f1d1a;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ea;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fffaf0;border:1px solid #2d2a24;">
            <tr>
              <td style="padding:24px 28px 12px;border-bottom:3px double #2d2a24;text-align:center;">
                <div style="font-size:12px;letter-spacing:1.6px;text-transform:uppercase;color:#5b5448;">The ${escapeHtml(params.workspaceName)} Edition</div>
                <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.05;margin:8px 0 6px;font-weight:700;color:#1f1d1a;">${escapeHtml(params.title)}</h1>
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#5b5448;">Your personal briefing</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px;">
                <p style="font-size:16px;line-height:1.6;margin:0 0 12px;color:#2d2a24;">${renderHtmlText(greeting)}</p>
                ${intro ? `<p style="font-size:16px;line-height:1.6;margin:0 0 18px;color:#2d2a24;">${renderHtmlText(intro)}</p>` : ""}
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${sectionRows}</table>
                ${memberNote}
                <div style="margin-top:24px;padding-top:16px;border-top:1px solid #d9d1bd;font-size:13px;line-height:1.5;color:#5b5448;">
                  <a href="${escapeAttribute(params.workspaceUrl)}" style="color:#6750a4;text-decoration:underline;">Open Corgtex</a> to review the source work and decisions behind this newspaper. If something looks off, the workspace is where your team can trace it back to evidence and decide what happens next.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
