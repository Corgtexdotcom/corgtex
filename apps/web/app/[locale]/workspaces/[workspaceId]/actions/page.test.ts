import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const forms = source.match(/<form[\s\S]*?<\/form>/g) ?? [];

describe("Actions page observed-version forms", () => {
  it.each(["priority", "dueAt"])("carries each Action row version through every %s quick-edit form", (field) => {
    const contentForms = forms.filter((form) => (
      form.includes("action={updateActionAction}") && form.includes(`name="${field}"`)
    ));

    expect(contentForms).toHaveLength(2);
    for (const form of contentForms) {
      expect(form).toContain('name="expectedVersion" value={action.version}');
    }
  });

  it("keeps status and completion lifecycle submissions unversioned", () => {
    const statusForms = forms.filter((form) => form.includes("action={actionHandler}") && form.includes('name="status"'));

    expect(statusForms).not.toHaveLength(0);
    for (const form of statusForms) expect(form).not.toContain('name="expectedVersion"');
    expect(source).toContain('hiddenFields={{ workspaceId, actionId: action.id, status: "COMPLETED" }}');
    expect(source).not.toContain('hiddenFields={{ workspaceId, actionId: action.id, status: "COMPLETED", expectedVersion');
  });

  it("freezes the complete live Web work-item content caller inventory", () => {
    const appRoot = new URL("../../../../", import.meta.url);
    const callerNames = [
      "updateActionAction",
      "editActionAction",
      "updateGoalFormAction",
      "editGoalFormAction",
      "updateProposalAction",
      "editProposalAction",
      "updateTensionAction",
      "editTensionAction",
    ];
    const inventory = Object.fromEntries(callerNames.map((name) => [name, [] as string[]]));

    for (const relativePath of readdirSync(appRoot, { recursive: true }).map(String).filter((path) => path.endsWith(".tsx"))) {
      const candidate = readFileSync(new URL(relativePath, appRoot), "utf8");
      for (const name of callerNames) {
        if (candidate.includes(`action={${name}}`)) inventory[name].push(relativePath);
      }
    }
    for (const paths of Object.values(inventory)) paths.sort();

    expect(inventory).toEqual({
      updateActionAction: [
        "[locale]/workspaces/[workspaceId]/actions/[actionId]/page.tsx",
        "[locale]/workspaces/[workspaceId]/actions/page.tsx",
      ],
      editActionAction: ["[locale]/workspaces/[workspaceId]/actions/[actionId]/edit/page.tsx"],
      updateGoalFormAction: ["[locale]/workspaces/[workspaceId]/goals/page.tsx"],
      editGoalFormAction: ["[locale]/workspaces/[workspaceId]/goals/page.tsx"],
      updateProposalAction: [],
      editProposalAction: [
        "[locale]/workspaces/[workspaceId]/proposals/[proposalId]/page.tsx",
        "[locale]/workspaces/[workspaceId]/proposals/page.tsx",
      ],
      updateTensionAction: [
        "[locale]/workspaces/[workspaceId]/tensions/[tensionId]/page.tsx",
        "[locale]/workspaces/[workspaceId]/tensions/page.tsx",
      ],
      editTensionAction: [
        "[locale]/workspaces/[workspaceId]/tensions/[tensionId]/page.tsx",
        "[locale]/workspaces/[workspaceId]/tensions/page.tsx",
      ],
    });
  });
});
