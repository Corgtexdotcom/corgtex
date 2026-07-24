import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorkItemAttentionBadge,
  WorkItemCard,
  WorkItemFilterControls,
  WorkItemLifecycleBadge,
  WorkItemRelationshipTag,
  workItemLifecycleTone,
} from "./WorkItemControls";
import { ItemActions } from "./ui/ItemActions";

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

  it("hides the status chooser while preserving lifecycle status query values", () => {
    const html = renderToStaticMarkup(createElement(WorkItemFilterControls, {
      action: "/workspaces/workspace-1/actions",
      circles: [],
      members: [],
      statusOptions: [
        { id: "DRAFT", label: "Draft" },
        { id: "OPEN", label: "Open" },
      ],
      statusValues: ["OPEN"],
      showStatusFilter: false,
      summaryLabel: "Advanced filters",
      labels,
    }));

    expect(html).toContain("Advanced filters");
    expect(html).toContain("name=\"status\"");
    expect(html).toContain("value=\"OPEN\"");
    expect(html).not.toContain(">All statuses<");
  });
});

describe("WorkItem presentation primitives", () => {
  it("maps lifecycle statuses to the shared badge tone scale", () => {
    expect(workItemLifecycleTone("DRAFT")).toBe("info");
    expect(workItemLifecycleTone("OPEN")).toBe("neutral");
    expect(workItemLifecycleTone("IN_PROGRESS")).toBe("info");
    expect(workItemLifecycleTone("RESOLVED")).toBe("info");
    expect(workItemLifecycleTone("COMPLETED")).toBe("success");
    expect(workItemLifecycleTone("ARCHIVED")).toBe("muted");
  });

  it("renders lifecycle, attention, and relationship tags in shared card slots", () => {
    const html = renderToStaticMarkup(createElement(WorkItemCard, {
      href: "/workspaces/workspace-1/actions/action-1",
      title: "Review contract",
      ariaLabel: "Open Review contract",
      badges: [
        createElement(WorkItemLifecycleBadge, { key: "status", status: "OPEN", label: "Open" }),
        createElement(WorkItemAttentionBadge, { key: "request" }, "Input requested"),
      ],
      body: createElement(WorkItemRelationshipTag, { href: "/workspaces/workspace-1/proposals/proposal-1" }, "Proposal: Contract approval"),
      actions: createElement("div", { className: "item-actions" }, "Open"),
    }));

    expect(html).toContain("nr-work-item-card-header");
    expect(html).toContain("nr-work-item-badge-lifecycle");
    expect(html).toContain("nr-work-item-badge-attention");
    expect(html).toContain("nr-work-item-badge-relationship");
    expect(html).toContain("Review contract");
  });

  it("omits the badge rail when no lifecycle or attention badges are relevant", () => {
    const html = renderToStaticMarkup(createElement(WorkItemCard, {
      href: "/workspaces/workspace-1/actions/action-1",
      title: "Review contract",
      ariaLabel: "Open Review contract",
      badges: null,
      body: "No attention state",
    }));

    expect(html).not.toContain("nr-work-item-card-badges");
    expect(html).not.toContain("nr-work-item-badge-attention");
  });

  it("keeps the primary action in the fixed primary slot and exposes overflow separately", () => {
    const html = renderToStaticMarkup(createElement(ItemActions, {
      moreLabel: "More actions",
      primary: createElement("button", { className: "primary small" }, "Open"),
      more: createElement("form", null, createElement("button", { className: "danger" }, "Archive")),
    }));

    expect(html).toContain("item-actions-primary");
    expect(html).toContain("Open");
    expect(html).toContain("action-menu-trigger");
    expect(html).toContain("More actions");
    expect(html).not.toContain("Archive");
  });
});
