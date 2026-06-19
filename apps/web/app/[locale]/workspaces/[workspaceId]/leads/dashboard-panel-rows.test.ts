import { describe, expect, it } from "vitest";

import { capDashboardPanelRows, CRM_DASHBOARD_PANEL_ROW_LIMIT } from "./dashboard-panel-rows";

describe("capDashboardPanelRows", () => {
  it("caps dashboard panels to the compact overview limit", () => {
    const rows = Array.from({ length: CRM_DASHBOARD_PANEL_ROW_LIMIT + 2 }, (_, index) => index);

    expect(capDashboardPanelRows(rows)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps shorter panels unchanged", () => {
    expect(capDashboardPanelRows(["account", "pipeline"])).toEqual(["account", "pipeline"]);
  });
});
