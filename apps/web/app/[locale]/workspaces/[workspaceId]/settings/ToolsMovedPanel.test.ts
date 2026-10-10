import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolsMovedPanel } from "./ToolsMovedPanel";

describe("Settings Tools shortcuts", () => {
  it.each(["en", "es"])("keeps %s and the current workspace in the Data sources destination", (locale) => {
    const html = renderToStaticMarkup(React.createElement(ToolsMovedPanel, {
      locale,
      workspaceId: "synthetic-workspace",
      toolsAvailable: true,
      dataSourcesAvailable: true,
    }));
    expect(html).toContain(`href="/${locale}/workspaces/synthetic-workspace/tools?surface=apps&amp;type=DATA_SOURCE"`);
    expect(html).toContain("Data sources</a>");
  });

  it("does not offer a broken shortcut when Tools or data sources are disabled", () => {
    const props = { locale: "en", workspaceId: "synthetic-workspace", toolsAvailable: true, dataSourcesAvailable: false };
    const noData = renderToStaticMarkup(React.createElement(ToolsMovedPanel, props));
    expect(noData).toContain("Data sources are not enabled in this workspace.");
    expect(noData).not.toContain("type=DATA_SOURCE");

    const noTools = renderToStaticMarkup(React.createElement(ToolsMovedPanel, { ...props, toolsAvailable: false }));
    expect(noTools).toContain("Tools directory is not enabled in this workspace.");
    expect(noTools).not.toContain("<a ");
  });
});
