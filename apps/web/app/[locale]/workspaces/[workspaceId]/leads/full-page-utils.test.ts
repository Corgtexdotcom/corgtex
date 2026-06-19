import { describe, expect, it } from "vitest";

import { crmPageCount, crmPageHref, crmPageOffset, crmViewHref, normalizeCrmPage, normalizeCrmViewMode, optionValue } from "./full-page-utils";

describe("CRM full page helpers", () => {
  it("normalizes invalid page values to the first page", () => {
    expect(normalizeCrmPage(undefined)).toBe(1);
    expect(normalizeCrmPage("0")).toBe(1);
    expect(normalizeCrmPage("-3")).toBe(1);
    expect(normalizeCrmPage("abc")).toBe(1);
    expect(normalizeCrmPage("4")).toBe(4);
  });

  it("calculates offset and page count with a minimum page count", () => {
    expect(crmPageOffset(3, 25)).toBe(50);
    expect(crmPageCount(0, 25)).toBe(1);
    expect(crmPageCount(51, 25)).toBe(3);
  });

  it("preserves filters while replacing pagination", () => {
    expect(crmPageHref("/workspaces/ws/leads/accounts", { q: "acme", page: "2" }, { page: 3 }))
      .toBe("/workspaces/ws/leads/accounts?q=acme&page=3");
    expect(crmPageHref("/workspaces/ws/leads/accounts", { q: "acme", page: "2" }, { q: "", page: 1 }))
      .toBe("/workspaces/ws/leads/accounts?page=1");
  });

  it("keeps only allowed filter options", () => {
    expect(optionValue("LEAD", ["LEAD", "QUALIFIED"])).toBe("LEAD");
    expect(optionValue("BAD", ["LEAD", "QUALIFIED"])).toBeUndefined();
  });

  it("normalizes page view modes to supported defaults", () => {
    expect(normalizeCrmViewMode("kanban", ["kanban", "table", "list"], "kanban")).toBe("kanban");
    expect(normalizeCrmViewMode("grid", ["kanban", "table", "list"], "kanban")).toBe("kanban");
    expect(normalizeCrmViewMode("kanban", ["table", "list"], "table")).toBe("table");
  });

  it("preserves filters and pagination when switching CRM views", () => {
    expect(crmViewHref("/workspaces/ws/leads/pipeline", { stage: "LEAD", page: "2" }, "table", "kanban"))
      .toBe("/workspaces/ws/leads/pipeline?stage=LEAD&page=2&view=table");
    expect(crmViewHref("/workspaces/ws/leads/pipeline", { stage: "LEAD", page: "2", view: "table" }, "kanban", "kanban"))
      .toBe("/workspaces/ws/leads/pipeline?stage=LEAD&page=2");
  });
});
