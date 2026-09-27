import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { runWorkItemEditAction, WorkItemEditFormView } from "./WorkItemEditForm";

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
  it("keeps draft children mounted and exposes a compare link without a destructive reload control", () => {
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
    expect(html).not.toContain("editConflictReload");
  });

  it("announces success and prevents duplicate submission while pending", () => {
    const successHtml = renderToStaticMarkup(createElement(
      WorkItemEditFormView,
      { ...baseProps, state: { status: "success", version: 5 } },
      createElement("input", { name: "title", defaultValue: "Draft title" }),
    ));
    const pendingHtml = renderToStaticMarkup(createElement(
      WorkItemEditFormView,
      { ...baseProps, state: { status: "idle" }, pending: true },
      createElement("input", { name: "title", defaultValue: "Draft title" }),
    ));

    expect(successHtml).toContain("role=\"status\"");
    expect(successHtml).toContain("editSaved");
    expect(successHtml).toContain('name="expectedVersion" value="5"');
    expect(successHtml).toContain("editViewSaved");
    expect(pendingHtml).toContain("aria-busy=\"true\"");
    expect(pendingHtml).toContain("disabled=\"\"");
    expect(pendingHtml).toContain("Saving...");
  });

  it("keeps the form and retry control available after a save failure", () => {
    const html = renderToStaticMarkup(createElement(
      WorkItemEditFormView,
      { ...baseProps, state: { status: "error" } },
      createElement("textarea", { name: "bodyMd", defaultValue: "Unsaved local draft" }),
    ));
    expect(html).toContain("Unsaved local draft");
    expect(html).toContain("editSaveFailed");
    expect(html).toContain('name="expectedVersion" value="4"');
  });

  it("keeps the last saved version when the next save request fails", async () => {
    const action = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await runWorkItemEditAction(action, { status: "success", version: 5 }, new FormData());

    expect(result).toEqual({ status: "error", version: 5 });
    const html = renderToStaticMarkup(createElement(
      WorkItemEditFormView,
      { ...baseProps, state: result },
      createElement("textarea", { name: "bodyMd", defaultValue: "Unsaved local draft" }),
    ));
    expect(html).toContain('name="expectedVersion" value="5"');
    expect(html).toContain("Unsaved local draft");
    expect(html).toContain("editSaveFailed");
  });
});
