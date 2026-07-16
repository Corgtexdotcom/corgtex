import {
  NEWSPAPER_SECTION_DEFINITIONS,
  capNewspaperDigestSections,
  normalizeNewspaperDigestPayload,
  normalizeWorkspaceBriefingPayload,
  renderNewspaperDigestMarkdown,
  type NormalizedNewspaperDigest,
  type NewspaperDigestSection,
  type NewspaperEmailSectionId,
} from "@corgtex/domain";

export {
  normalizeNewspaperDigestPayload,
  renderNewspaperDigestMarkdown,
};
export type { NormalizedNewspaperDigest };

export type NewspaperPersonalization = {
  greeting: string | null;
  intro: string | null;
  memberNote: string | null;
  emphasizedSectionIds: NewspaperEmailSectionId[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function withNewspaperAdviceRequests(
  digest: NormalizedNewspaperDigest,
  items: string[],
): NormalizedNewspaperDigest {
  const normalizedItems = items
    .map((item) => item.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1000))
    .filter(Boolean);

  if (normalizedItems.length === 0) return digest;

  const existingAdviceSection = digest.sections.find((section) => section.id === "adviceRequests");
  const sectionsWithoutAdvice = digest.sections.filter((section) => section.id !== "adviceRequests");
  const adviceSection: NewspaperDigestSection = {
    id: "adviceRequests",
    title: "Requests Awaiting Your Input",
    items: [...(existingAdviceSection?.items ?? []), ...normalizedItems],
  };

  return {
    ...digest,
    sections: capNewspaperDigestSections([adviceSection, ...sectionsWithoutAdvice]),
  };
}

export function normalizeNewspaperPersonalizationPayload(input: unknown): NewspaperPersonalization {
  const record = isRecord(input) ? input : {};
  const emphasizedSectionIds = Array.isArray(record.emphasizedSectionIds)
    ? record.emphasizedSectionIds.filter((id): id is NewspaperEmailSectionId => (
      typeof id === "string" && NEWSPAPER_SECTION_DEFINITIONS.some((definition) => definition.id === id)
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

function renderNarrativeMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\r?\n/g, "<br>");
}

function renderNarrativeParagraphs(values: Array<string | null | undefined>) {
  return values
    .flatMap((value) => value?.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean) ?? [])
    .map((paragraph, index) => (
      `<p style="font-size:${index === 0 ? "17px" : "15px"};line-height:1.65;margin:0 0 16px;color:#2d2a24;">${renderNarrativeMarkdown(paragraph)}</p>`
    ))
    .join("");
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

export function renderNewspaperEditionEmailHtml(params: {
  edition: {
    title: string;
    digestJson: unknown;
  };
  workspaceName: string;
  recipientName: string | null;
  workspaceUrl: string;
  digest?: NormalizedNewspaperDigest;
  personalization?: NewspaperPersonalization;
}) {
  return renderNewspaperEmailHtml({
    title: params.edition.title,
    workspaceName: params.workspaceName,
    recipientName: params.recipientName,
    workspaceUrl: params.workspaceUrl,
    digest: params.digest ?? normalizeNewspaperDigestPayload(params.edition.digestJson),
    personalization: params.personalization,
  });
}

export function renderWorkspaceBriefingEmailHtml(params: {
  briefing: {
    title: string;
    briefingJson: unknown;
  };
  workspaceName: string;
  recipientName: string | null;
  workspaceUrl: string;
  digest?: NormalizedNewspaperDigest;
  personalization?: NewspaperPersonalization;
}) {
  const recipient = params.recipientName?.trim() || "there";
  const greeting = params.personalization?.greeting ?? `Hello ${recipient},`;
  const briefing = normalizeWorkspaceBriefingPayload(params.briefing.briefingJson);
  const intro = params.personalization?.intro ?? briefing.introMd;
  const articleHtml = renderNarrativeParagraphs([
    intro,
    briefing.leadMd,
    briefing.bodyMd,
    briefing.attentionMd,
    briefing.continuingContextMd,
    briefing.closingMd,
  ]);
  const memberNote = params.personalization?.memberNote
    ? `<p style="font-size:15px;line-height:1.6;margin:18px 0 0;color:#5b5448;">${renderNarrativeMarkdown(params.personalization.memberNote)}</p>`
    : "";
  const sourceLinks = briefing.sourceRefs.slice(0, 8).flatMap((ref) => {
    if (!ref.href) return [];
    return [`<a href="${escapeAttribute(ref.href)}" style="color:#6750a4;text-decoration:underline;">${escapeHtml(ref.label)}</a>`];
  });
  const sourceTrail = sourceLinks.length > 0
    ? `<p style="font-size:13px;line-height:1.5;margin:14px 0 0;color:#5b5448;">Source trail: ${sourceLinks.join(" · ")}</p>`
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
                <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.05;margin:8px 0 6px;font-weight:700;color:#1f1d1a;">${escapeHtml(params.briefing.title)}</h1>
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#5b5448;">Your workspace briefing</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px;">
                <p style="font-size:16px;line-height:1.6;margin:0 0 12px;color:#2d2a24;">${renderHtmlText(greeting)}</p>
                ${articleHtml}
                ${memberNote}
                <div style="margin-top:24px;padding-top:16px;border-top:1px solid #d9d1bd;font-size:13px;line-height:1.5;color:#5b5448;">
                  <a href="${escapeAttribute(params.workspaceUrl)}" style="color:#6750a4;text-decoration:underline;">Open Corgtex</a> to review the source work and decisions behind this newspaper.
                  ${sourceTrail}
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
