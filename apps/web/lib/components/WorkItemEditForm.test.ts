import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkItemEditFormView } from "./WorkItemEditForm";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const baseProps = {
  action: "/save",
  expectedVersion: 4,
  currentHref: "/workspaces/workspace-1/tensions/tension-1",
  submitLabel: "Save",
  pendingLabel: "Saving...",
  className: "stack",
};

describe("WorkItemEditForm", () => {
  it("keeps draft children mounted and exposes accessible compare and reload actions after conflict", () => {
    const html = renderToStaticMarkup(createElement(
      WorkItemEditFormView,
      { ...baseProps, state: { status: "conflict" } },
      createElement("textarea", { name: "bodyMd", defaultValue: "Unsaved local draft" }),
    ));

    expect(html).toContain("action=\"/save\"");
    expect(html).toContain("name=\"expectedVersion\" value=\"4\"");
    expect(html).toContain("Unsaved local draft");
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("editConflictTitle");
    expect(html).toContain("editConflictMessage");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("rel=\"noopener noreferrer\"");
    expect(html).toContain("editConflictOpenCurrent");
    expect(html).toContain("type=\"button\"");
    expect(html).toContain("editConflictReload");
  });

  it("announces success and prevents duplicate submission while pending", () => {
    const successHtml = renderToStaticMarkup(createElement(
      WorkItemEditFormView,
      { ...baseProps, state: { status: "success" } },
      createElement("input", { name: "title", defaultValue: "Draft title" }),
    ));
    const pendingHtml = renderToStaticMarkup(createElement(
      WorkItemEditFormView,
      { ...baseProps, state: { status: "idle" }, pending: true },
      createElement("input", { name: "title", defaultValue: "Draft title" }),
    ));

    expect(successHtml).toContain("role=\"status\"");
    expect(successHtml).toContain("editSaved");
    expect(pendingHtml).toContain("aria-busy=\"true\"");
    expect(pendingHtml).toContain("disabled=\"\"");
    expect(pendingHtml).toContain("Saving...");
  });
});
