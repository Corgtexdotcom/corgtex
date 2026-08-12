import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Goals page source", () => {
  it("does not render the permanent Brain direction workbench by default", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("CompanyDirectionFromBrain");
    expect(source).not.toContain("listCompanyDirectionFromBrain");
  });

  it("uses the shared versioned edit form only for Goal content edits", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const editForm = source.match(/<WorkItemEditForm[\s\S]*?<\/WorkItemEditForm>/)?.[0] ?? "";

    expect(editForm).toContain("action={editGoalFormAction}");
    expect(editForm).toContain("expectedVersion={goal.version}");
    expect(editForm).toContain("currentHref=");
    expect(editForm).toContain('name="title"');
    expect(editForm).toContain('name="descriptionMd"');

    expect(source).toContain('<form action={updateGoalFormAction} className="actions-inline">');
    expect(source).toContain('name="progressPercent"');
    expect(source).toContain("<form action={returnGoalToDraftFormAction}>");
    expect(source).toContain("<form action={addKeyResultFormAction}");
  });
});
