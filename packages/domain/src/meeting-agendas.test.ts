import { describe, expect, it } from "vitest";
import {
  MEETING_AGENDA_TEMPLATES,
  REGULAR_UPDATE_AGENDA_TEMPLATE_KEY,
  buildRegularUpdateAgenda,
  isRegularUpdateAgenda,
  normalizeMeetingAgendaForDisplay,
  selectedMeetingAgendaTemplate,
} from "./meeting-agendas";
import type { MeetingIntelligenceContext } from "./meeting-intelligence-context";

function context(overrides: Partial<MeetingIntelligenceContext> = {}): MeetingIntelligenceContext {
  return {
    contextualIntelligenceEnabled: true,
    meeting: {
      id: "meeting-2",
      workspaceId: "workspace-1",
      title: "Weekly update",
      source: "internal",
      status: "SCHEDULED",
      transcript: null,
      summaryMd: null,
      blocksJson: null,
      agendaJson: null,
      ingestionGuidanceMd: null,
      recordedAt: new Date("2026-06-23T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-06-23T18:00:00.000Z"),
      seriesId: "series-1",
      seriesTitle: "Weekly update",
      seriesRecurrenceRule: "FREQ=WEEKLY",
      participantIds: ["member-1", "member-2"],
      participantEmails: ["andy@example.com", "datise@example.com"],
    },
    attendees: [
      { memberId: "member-1", name: "Andy", email: "andy@example.com", circles: ["Sales"] },
      { memberId: "member-2", name: "Datise", email: "datise@example.com", circles: ["Operations"] },
    ],
    previousMeetings: [
      {
        id: "meeting-1",
        title: "Weekly update",
        recordedAt: "2026-06-16T17:00:00.000Z",
        summaryMd: "The team reviewed the buy stream and aligned on next outreach.",
        decisionsJson: {
          items: [{ title: "Use the Chicago shortlist first", bodyMd: "Start with Chicago targets before broadening." }],
        },
      },
    ],
    tensions: [
      {
        id: "tension-1",
        title: "Lead source quality is uneven",
        status: "OPEN",
        priority: 4,
        priorityLabel: "Urgent",
        upvotes: 2,
        upvoteCount: 2,
        circle: "Sales",
        owner: "Andy",
        ownerMemberId: "member-1",
        ownerMemberName: "Andy",
        responsibleMemberId: "member-1",
        responsibleMemberName: "Andy",
        bodyMd: "Some records need better evidence.",
      },
    ],
    actions: [
      {
        id: "action-1",
        title: "Refresh shortlist evidence",
        status: "OPEN",
        priority: 2,
        priorityLabel: "Important",
        dueAt: "2026-06-22T12:00:00.000Z",
        circle: "Operations",
        owner: "Datise",
        ownerMemberId: "member-2",
        ownerMemberName: "Datise",
        responsibleMemberId: "member-2",
        responsibleMemberName: "Datise",
        bodyMd: "Update the evidence sheet.",
      },
    ],
    proposals: [
      {
        id: "proposal-1",
        title: "Prioritize proprietary outreach",
        status: "OPEN",
        priority: 3,
        priorityLabel: "Urgent",
        summary: "Use proprietary source work first.",
        bodyMd: "Proposal body.",
        circle: "Sales",
        author: "Andy",
        owner: "Andy",
        ownerMemberId: "member-1",
        ownerMemberName: "Andy",
        responsibleMemberId: "member-1",
        responsibleMemberName: "Andy",
        tensions: [],
        actions: [],
      },
    ],
    followUps: [
      {
        id: "follow-up-1",
        meetingId: "meeting-1",
        title: "Review buyer criteria",
        bodyMd: "Carry this into the next weekly.",
        owner: "Datise",
      },
    ],
    resolvedTensions: [
      {
        id: "resolved-1",
        meetingId: "meeting-1",
        title: "Define evidence threshold",
        bodyMd: "The threshold was accepted.",
        targetEntityId: "tension-old",
      },
    ],
    createdFromPreviousMeeting: [
      { meetingId: "meeting-1", entityType: "Action", entityId: "action-1" },
      { meetingId: "meeting-1", entityType: "Proposal", entityId: "proposal-1" },
    ],
    deliberationEntries: [],
    knowledgeSearchQuery: "",
    knowledge: [],
    ...overrides,
  };
}

describe("meeting agendas", () => {
  it("selects deterministic regular update template for recurring meetings", () => {
    expect(MEETING_AGENDA_TEMPLATES[REGULAR_UPDATE_AGENDA_TEMPLATE_KEY].generationMode).toBe("deterministic");
    expect(selectedMeetingAgendaTemplate(context())).toEqual({
      key: REGULAR_UPDATE_AGENDA_TEMPLATE_KEY,
      generationMode: "deterministic",
    });
    expect(selectedMeetingAgendaTemplate(context({
      meeting: {
        ...context().meeting,
        seriesRecurrenceRule: null,
      },
    }))).toBeNull();
  });

  it("builds the simplified regular update agenda without duplicate created-item sections", () => {
    const agenda = buildRegularUpdateAgenda(context(), new Date("2026-06-22T12:00:00.000Z"));

    expect(agenda).toMatchObject({
      templateKey: REGULAR_UPDATE_AGENDA_TEMPLATE_KEY,
      version: 1,
      generationMode: "deterministic",
      title: "Weekly update",
    });
    expect(agenda.sections.map((section) => section.key)).toEqual([
      "check_in",
      "last_meeting_recap",
      "circle_updates",
      "work_queue",
      "checkout",
    ]);
    expect(agenda.participantOrder.map((attendee) => attendee.name)).toEqual(["Andy", "Datise"]);
    expect(agenda.sections.find((section) => section.key.includes("created"))).toBeUndefined();
    expect(agenda.sections[0].items?.map((item) => item.text)).toEqual(["Andy", "Datise"]);
    expect(agenda.sections[0].items).toEqual([
      { id: "attendee:member-1", text: "Andy" },
      { id: "attendee:member-2", text: "Datise" },
    ]);

    const recap = agenda.sections.find((section) => section.key === "last_meeting_recap");
    expect(recap?.description).toContain("buy stream");
    expect(recap?.groups?.flatMap((group) => group.items.map((item) => item.text))).toEqual([
      "Use the Chicago shortlist first",
      "Define evidence threshold",
    ]);

    const workQueueItems = agenda.sections
      .find((section) => section.key === "work_queue")
      ?.groups?.flatMap((group) => group.items) ?? [];
    expect(workQueueItems.find((item) => item.sourceId === "proposal-1")?.tags).toContainEqual(
      { key: "created_from_last_meeting", label: "Created last meeting" },
    );
    expect(workQueueItems.find((item) => item.sourceId === "action-1")?.tags).toEqual([
      { key: "created_from_last_meeting", label: "Created last meeting" },
      { key: "overdue", label: "Overdue" },
    ]);
    expect(workQueueItems.find((item) => item.sourceId === "follow-up-1")?.tags).toEqual([
      { key: "carried_forward", label: "Carried forward" },
    ]);
  });

  it("keeps legacy agenda payloads renderable", () => {
    const agenda = normalizeMeetingAgendaForDisplay({
      title: "Legacy agenda",
      sections: [{ title: "Action items", items: [{ text: "Review launch plan", owner: "Jan" }] }],
    }, "Fallback");

    expect(isRegularUpdateAgenda(agenda)).toBe(false);
    expect(agenda).toMatchObject({
      title: "Legacy agenda",
      sections: [{ title: "Action items", items: [{ text: "Review launch plan", owner: "Jan" }] }],
    });
  });
});
