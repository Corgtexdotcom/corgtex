import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import { MeetingPageGuidance } from "./MeetingPageGuidance";

describe("Meetings page guidance", () => {
  it.each([
    ["en", en.meetings],
    ["es", es.meetings],
  ] as const)("uses a compact, accessible %s disclosure with the original guidance", (_locale, labels) => {
    const html = renderToStaticMarkup(React.createElement(MeetingPageGuidance, {
      title: labels.meetingGuideTitle,
      workflow: labels.meetingGuideWorkflow,
      archive: labels.meetingGuideArchive,
      openBrain: labels.meetingGuideOpenBrain,
      workspaceId: "synthetic-workspace",
    }));

    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain(`<summary class="settings-disclosure-summary meeting-page-guidance-summary">${labels.meetingGuideTitle}</summary>`);
    expect(html).toContain(labels.meetingGuideWorkflow);
    expect(html).toContain(labels.meetingGuideArchive);
    expect(html).toContain(`href="/workspaces/synthetic-workspace/brain"`);
    expect(html).toContain(labels.meetingGuideOpenBrain);
    expect(html).not.toContain('class="panel"');
  });
});
