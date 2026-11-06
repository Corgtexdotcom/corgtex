import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

vi.mock("next-intl", () => ({
  useLocale: () => "es",
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    `${key}${values?.name ? `: ${values.name}` : ""}`,
}));
const current = {
  id: "sample-a",
  name: "Sample A",
  slug: "sample-a",
  primaryName: "Sample A",
  secondaryLabel: "powered by Corgtex",
};
const other = {
  ...current,
  id: "sample-b",
  name: "Sample B",
  slug: "sample-b",
  primaryName: "Sample B",
};

describe("workspace identity", () => {
  it("shows a localized home link without a misleading picker for one membership", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSwitcher, {
        workspaceId: current.id,
        workspaces: [current],
      }),
    );
    expect(html).toContain('href="/es/workspaces/sample-a"');
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain("ChevronDown");
  });
  it("uses a named accessible desktop identity trigger", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSwitcher, {
        workspaceId: current.id,
        workspaces: [current, other],
      }),
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="trigger: Sample A"');
    expect(html).toContain("powered by Corgtex");
  });
  it("uses the shared dialog and current-workspace indicator on mobile", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSwitcher, {
        workspaceId: current.id,
        workspaces: [current, other],
        mobile: true,
      }),
    );
    expect(html).toContain("workspace-switcher-dialog");
    expect(html).toContain("aria-labelledby=");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("current");
  });
  it("does not substitute an unauthorized current workspace", () => {
    expect(
      renderToStaticMarkup(
        createElement(WorkspaceSwitcher, {
          workspaceId: "missing",
          workspaces: [current],
        }),
      ),
    ).toBe("");
  });
});
