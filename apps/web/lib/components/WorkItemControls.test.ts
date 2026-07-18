import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkItemFilterControls } from "./WorkItemControls";

const labels = {
  circle: "Circle",
  assignee: "Assigned to",
  person: "Person involved",
  allCircles: "All circles",
  allAssignees: "All assignees",
  allPeople: "All people involved",
  apply: "Apply filters",
  clear: "Clear",
};

describe("WorkItemFilterControls", () => {
  it("preserves exact assignee selections even when every assignee is selected", () => {
    const html = renderToStaticMarkup(createElement(WorkItemFilterControls, {
      action: "/workspaces/workspace-1/actions",
      circles: [],
      assigneeMembers: [{ id: "member-1", label: "E2E UI Testing Agent" }],
      assigneeMemberIds: ["member-1"],
      members: [],
      labels,
    }));

    expect(html).toContain("name=\"assigneeMemberId\"");
    expect(html).toContain("value=\"member-1\"");
    expect(html).toContain("E2E UI Testing Agent");
    expect(html).not.toContain(">All assignees<");
  });
});
