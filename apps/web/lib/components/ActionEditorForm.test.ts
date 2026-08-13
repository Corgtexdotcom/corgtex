import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionEditorForm, type ActionEditorLabels } from "./ActionEditorForm";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/components/MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: ({ name, defaultValue }: { name: string; defaultValue?: string }) => (
      React.createElement("textarea", { name, defaultValue })
    ),
  };
});

vi.mock("@/lib/components/WorkItemMemberSelect", async () => {
  const React = await import("react");
  return {
    WorkItemMemberSelect: ({ name, defaultValue }: { name: string; defaultValue?: string | null }) => (
      React.createElement("select", { name, defaultValue: defaultValue ?? "" })
    ),
  };
});

vi.mock("@/lib/components/WorkItemPrioritySelect", async () => {
  const React = await import("react");
  return {
    WorkItemPrioritySelect: ({ defaultValue }: { defaultValue?: number | null }) => (
      React.createElement("select", { name: "priority", defaultValue: String(defaultValue ?? 1) })
    ),
  };
});

vi.mock("@/lib/components/WorkItemEditForm", async () => {
  const React = await import("react");
  return {
    WorkItemEditForm: ({
      expectedVersion,
      currentHref,
      className,
      children,
    }: {
      expectedVersion: number;
      currentHref: string;
      className?: string;
      children: ReactNode;
    }) => React.createElement(
      "form",
      { className, "data-current-href": currentHref, "data-shared-edit-form": "true" },
      React.createElement("input", { type: "hidden", name: "expectedVersion", value: expectedVersion }),
      children,
    ),
  };
});

const labels: ActionEditorLabels = {
  title: "Title",
  notes: "Notes",
  assignee: "Assignee",
  assigneeNone: "None",
  submit: "Save",
  cancel: "Cancel",
  dueDate: "Due date",
  priorityLabel: "Priority",
  priority: { 3: "Urgent", 2: "Important", 1: "Medium", 0: "Low" },
};

const commonProps = {
  workspaceId: "workspace-1",
  members: [{ id: "member-1", label: "Synthetic User" }],
  labels,
};

describe("ActionEditorForm", () => {
  it("routes edits through the shared versioned form while keeping draft field defaults", () => {
    const html = renderToStaticMarkup(createElement(ActionEditorForm, {
      ...commonProps,
      action: vi.fn(async () => ({ status: "success" as const })),
      actionId: "action-1",
      expectedVersion: 8,
      currentHref: "/workspaces/workspace-1/actions/action-1",
      title: "Preserved Action title",
      bodyMd: "Preserved local draft",
      priority: 3,
      assigneeMemberId: "member-1",
      cancelHref: "/workspaces/workspace-1/actions/action-1",
    }));

    expect(html).toContain("data-shared-edit-form=\"true\"");
    expect(html).toContain("name=\"expectedVersion\" value=\"8\"");
    expect(html).toContain("data-current-href=\"/workspaces/workspace-1/actions/action-1\"");
    expect(html).toContain("name=\"actionId\" value=\"action-1\"");
    expect(html).toContain("value=\"Preserved Action title\"");
    expect(html).toContain("Preserved local draft");
  });

  it("keeps Action creation on the ordinary non-versioned form", () => {
    const html = renderToStaticMarkup(createElement(ActionEditorForm, {
      ...commonProps,
      action: vi.fn(async () => undefined),
    }));

    expect(html).not.toContain("data-shared-edit-form");
    expect(html).not.toContain("name=\"expectedVersion\"");
    expect(html).toContain("name=\"workspaceId\" value=\"workspace-1\"");
  });
});
