import { describe, expect, it } from "vitest";
import {
  agendaItemHref,
  hasMeetingAgendaTab,
  meetingTabHref,
  normalizeMeetingTab,
} from "./meetingAgendaView";

describe("meetingAgendaView", () => {
  it("opens the agenda tab for scheduled recurring meetings before an agenda payload exists", () => {
    const allowAgenda = hasMeetingAgendaTab({
      agendaExists: false,
      status: "SCHEDULED",
      recurrenceRule: "FREQ=WEEKLY",
    });

    expect(allowAgenda).toBe(true);
    expect(normalizeMeetingTab(undefined, allowAgenda ? "agenda" : "summary", allowAgenda)).toBe("agenda");
  });

  it("keeps completed meetings on the existing summary flow when no agenda exists", () => {
    const allowAgenda = hasMeetingAgendaTab({
      agendaExists: false,
      status: "COMPLETED",
      recurrenceRule: "FREQ=WEEKLY",
    });

    expect(allowAgenda).toBe(false);
    expect(normalizeMeetingTab("agenda", allowAgenda ? "agenda" : "summary", allowAgenda)).toBe("summary");
    expect(meetingTabHref("/workspaces/ws-1/meetings/meeting-1", "summary")).toBe("/workspaces/ws-1/meetings/meeting-1");
  });

  it("links agenda source items without exposing edit routes", () => {
    expect(agendaItemHref("ws-1", { id: "item-1", text: "Tension", sourceType: "Tension", sourceId: "tension-1" }))
      .toBe("/workspaces/ws-1/tensions/tension-1");
    expect(agendaItemHref("ws-1", { id: "item-2", text: "Proposal", sourceType: "Proposal", sourceId: "proposal-1" }))
      .toBe("/workspaces/ws-1/proposals/proposal-1");
    expect(agendaItemHref("ws-1", { id: "item-3", text: "Action", sourceType: "Action", sourceId: "action-1" }))
      .toBe("/workspaces/ws-1/actions");
    expect(agendaItemHref("ws-1", { id: "item-4", text: "Check-in" })).toBeNull();
  });
});
