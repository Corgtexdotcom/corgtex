import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PracticeProjectAddPanel } from "./PracticeProjectAddPanel";

function renderPanel(canManagePracticeProjects: boolean) {
  return renderToStaticMarkup(createElement(PracticeProjectAddPanel, {
    action: "/submit",
    canManagePracticeProjects,
    returnTo: "/workspaces/ws-1/finance",
    workspaceId: "ws-1",
  }));
}

describe("PracticeProjectAddPanel", () => {
  it("renders the Practice Ledger project form for finance writers", () => {
    const markup = renderPanel(true);

    expect(markup).toContain("<form");
    expect(markup).toContain("Create project");
    expect(markup).toContain("name=\"workspaceId\"");
    expect(markup).toContain("name=\"code\"");
    expect(markup).toContain("name=\"poValue\"");
    expect(markup).not.toContain("Only workspace admins or finance stewards");
  });

  it("renders the admin/finance-steward notice instead of a form for non-writers", () => {
    const markup = renderPanel(false);

    expect(markup).toContain("Only workspace admins or finance stewards can add Practice Ledger projects.");
    expect(markup).toContain("href=\"/workspaces/ws-1/finance\"");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("Create project");
  });
});
