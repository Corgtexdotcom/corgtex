import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getVisibleAttendees, MeetingAttendeePicker } from "./MeetingAttendeePicker";

describe("MeetingAttendeePicker", () => {
  it("keeps selected attendee controls visible when filtering other members", () => {
    const members = [
      { id: "user-a", name: "Ari Member", email: "ari@workspace.test" },
      { id: "user-b", name: "Bea Member", email: "bea@workspace.test" },
    ];

    expect(getVisibleAttendees(members, ["user-a"], "Bea Member").map(({ id }) => id))
      .toEqual(["user-a", "user-b"]);
  });

  it("renders native form controls so values submit before client hydration", () => {
    const html = renderToStaticMarkup(createElement(MeetingAttendeePicker, {
      members: [{ id: "user-1", name: "Ari Member", email: "ari@workspace.test" }],
      labels: {
        members: "Workspace members",
        searchMembers: "Search members",
        externalEmails: "External email addresses",
        externalEmailsPlaceholder: "guest@example.test",
        externalEmailsHelp: "Separate addresses with commas, semicolons, or new lines.",
      },
    }));

    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="participantIds" value="user-1"');
    expect(html).toContain('name="participantEmails"');
    expect(html).not.toContain('type="hidden"');
  });
});
