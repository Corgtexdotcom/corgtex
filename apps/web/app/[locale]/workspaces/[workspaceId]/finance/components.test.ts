import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PracticeFinanceNav } from "./components";

describe("PracticeFinanceNav", () => {
  it("renders the unified Finance sections and optional Slicing Pie route", () => {
    const markup = renderToStaticMarkup(createElement(PracticeFinanceNav, {
      workspaceId: "workspace-1",
      active: "overview",
      slicingPieEnabled: true,
    }));

    expect(markup).toContain("Finance sections");
    expect(markup).toContain("/workspaces/workspace-1/finance");
    expect(markup).toContain("/workspaces/workspace-1/finance/projects");
    expect(markup).toContain("/workspaces/workspace-1/finance/clients");
    expect(markup).toContain("/workspaces/workspace-1/finance/consultants");
    expect(markup).toContain("/workspaces/workspace-1/finance/time");
    expect(markup).toContain("/workspaces/workspace-1/finance/expenses");
    expect(markup).toContain("/workspaces/workspace-1/finance/reports");
    expect(markup).toContain("/workspaces/workspace-1/finance/slicing-pie");
  });

  it("hides project Finance sections and Slicing Pie when their capabilities are disabled", () => {
    const markup = renderToStaticMarkup(createElement(PracticeFinanceNav, {
      workspaceId: "workspace-1",
      active: "overview",
      financeProjectsEnabled: false,
      slicingPieEnabled: false,
    }));

    expect(markup).toContain("/workspaces/workspace-1/finance");
    expect(markup).not.toContain("/workspaces/workspace-1/finance/projects");
    expect(markup).not.toContain("/workspaces/workspace-1/finance/slicing-pie");
  });
});
