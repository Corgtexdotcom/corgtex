import { describe, expect, it } from "vitest";
import {
  ACTION_STATUS_META,
  actionStatusFormValues,
  actionMatchesStatusFilter,
  buildActionListQuery,
  groupActionsByStatus,
  hasEligibleActionAssignee,
  normalizeActionPage,
  normalizeActionSort,
  normalizeActionStatusFilter,
  normalizeActionStatusFilters,
  resolveActionAssigneeScope,
  resolveActionStatusSearch,
} from "./view-model";

describe("actions view model", () => {
  it("keeps old Date links on newest-created while accepting explicit date directions", () => {
    expect(normalizeActionSort(undefined)).toBe("priority");
    expect(normalizeActionSort("date")).toBe("date");
    expect(normalizeActionSort("created_asc")).toBe("created_asc");
    expect(normalizeActionSort("due_asc")).toBe("due_asc");
    expect(normalizeActionSort("due_desc")).toBe("due_desc");
    expect(normalizeActionSort("unknown")).toBe("priority");
    expect(normalizeActionSort(["due_asc", "date"])).toBe("due_asc");
  });
  it("normalizes invalid Action page references to the first page", () => {
    expect(normalizeActionPage(undefined)).toBe(1);
    expect(normalizeActionPage("0")).toBe(1);
    expect(normalizeActionPage("-1")).toBe(1);
    expect(normalizeActionPage("2.5")).toBe(1);
    expect(normalizeActionPage("99999999999999999999")).toBe(1);
    expect(normalizeActionPage("999999999")).toBe(1);
    expect(normalizeActionPage(["2", "3"])).toBe(2);
  });

  it("preserves the Actions table, status, owner, and circle filters across due sorting", () => {
    const due = new URLSearchParams(buildActionListQuery({
      view: "table",
      status: ["OPEN", "IN_PROGRESS"],
      circleIds: ["circle-1"],
      assigneeMemberIds: ["member-1"],
      sort: "due_asc",
      page: 2,
    }, "assigned").slice(1));
    expect(due.get("view")).toBe("table");
    expect(due.getAll("status")).toEqual(["OPEN", "IN_PROGRESS"]);
    expect(due.getAll("circleId")).toEqual(["circle-1"]);
    expect(due.getAll("assigneeMemberId")).toEqual(["member-1"]);
    expect(due.get("scope")).toBe("assigned");
    expect(due.get("sort")).toBe("due_asc");
    expect(due.get("page")).toBe("2");

    expect(buildActionListQuery({ sort: "date" })).toBe("?sort=date");
    expect(buildActionListQuery({ sort: "priority" })).toBe("?");
  });
  it("starts on the current member's Actions while keeping explicit workspace and owner filters", () => {
    expect(resolveActionAssigneeScope([], "member-daniel", undefined)).toMatchObject({
      assigneeMemberIds: ["member-daniel"], includeOwnDrafts: true, actionScope: "mine", assignedToMeActive: false,
    });
    expect(resolveActionAssigneeScope([], "member-daniel", "assigned")).toMatchObject({
      assigneeMemberIds: ["member-daniel"], includeOwnDrafts: false, actionScope: "assigned", assignedToMeActive: true,
    });
    expect(resolveActionAssigneeScope([], "member-daniel", "workspace")).toMatchObject({
      assigneeMemberIds: [], assignedToMeActive: false, actionScope: "workspace",
    });
    expect(resolveActionAssigneeScope(["member-andy"], "member-daniel", undefined)).toMatchObject({
      assigneeMemberIds: ["member-andy"], includeOwnDrafts: false, assignedToMeActive: false,
    });
    expect(resolveActionAssigneeScope(["member-andy"], "member-daniel", "workspace")).toMatchObject({
      actionScope: "filtered", baseScope: "workspace", assigneeMemberIds: ["member-andy"],
    });
    expect(resolveActionAssigneeScope(["member-andy"], "member-daniel", "assigned")).toMatchObject({
      actionScope: "filtered", baseScope: "assigned", assigneeMemberIds: ["member-andy"],
    });
  });
  it("allows draft opening only for an active human assignee", () => {
    const activeHumans = new Set(["member-daniel"]);
    expect(hasEligibleActionAssignee("member-daniel", activeHumans)).toBe(true);
    expect(hasEligibleActionAssignee("inactive-member", activeHumans)).toBe(false);
    expect(hasEligibleActionAssignee("system-member", activeHumans)).toBe(false);
    expect(hasEligibleActionAssignee(null, activeHumans)).toBe(false);
  });
  it("keeps the explicit All lifecycle status in the advanced filter form", () => {
    const all = resolveActionStatusSearch("ALL");
    expect(actionStatusFormValues(all.statusQuery, all.statusFilters)).toEqual(["ALL"]);
    const open = resolveActionStatusSearch("OPEN");
    expect(actionStatusFormValues(open.statusQuery, open.statusFilters)).toEqual(["OPEN"]);
  });
  it("normalizes status filters and falls back to open", () => {
    expect(normalizeActionStatusFilter("DRAFT")).toBe("DRAFT");
    expect(normalizeActionStatusFilter("IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(normalizeActionStatusFilter(["COMPLETED", "DRAFT"])).toBe("COMPLETED");
    expect(normalizeActionStatusFilter("INVALID")).toBe("OPEN");
    expect(normalizeActionStatusFilter(undefined)).toBe("OPEN");
  });

  it("defaults list and table status filters to open", () => {
    expect(normalizeActionStatusFilters(undefined)).toEqual(["OPEN"]);
    expect(normalizeActionStatusFilters("INVALID")).toEqual(["OPEN"]);
    expect(resolveActionStatusSearch(undefined)).toEqual({
      statusFilter: "OPEN",
      statusFilters: ["OPEN"],
      statusQuery: ["OPEN"],
    });
  });

  it("preserves explicit all status selection", () => {
    expect(resolveActionStatusSearch("ALL")).toEqual({
      statusFilter: "ALL",
      statusFilters: [],
      statusQuery: "ALL",
    });
    expect(resolveActionStatusSearch(["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"])).toEqual({
      statusFilter: "ALL",
      statusFilters: [],
      statusQuery: "ALL",
    });
  });

  it("allows kanban callers to keep a no-status all-columns state", () => {
    expect(resolveActionStatusSearch(undefined, null)).toEqual({
      statusFilter: "OPEN",
      statusFilters: [],
      statusQuery: undefined,
    });
  });

  it("keeps private drafts visible in the draft tab", () => {
    expect(actionMatchesStatusFilter({ status: "DRAFT", isPrivate: true }, "DRAFT")).toBe(true);
    expect(actionMatchesStatusFilter({ status: "DRAFT", isPrivate: false }, "DRAFT")).toBe(true);
  });

  it("excludes private non-drafts from public status tabs", () => {
    expect(actionMatchesStatusFilter({ status: "OPEN", isPrivate: true }, "OPEN")).toBe(false);
    expect(actionMatchesStatusFilter({ status: "IN_PROGRESS", isPrivate: true }, "IN_PROGRESS")).toBe(false);
    expect(actionMatchesStatusFilter({ status: "COMPLETED", isPrivate: true }, "COMPLETED")).toBe(false);
  });

  it("groups action counts by normalized tab behavior", () => {
    const grouped = groupActionsByStatus([
      { id: "draft-private", status: "DRAFT", isPrivate: true },
      { id: "open-public", status: "OPEN", isPrivate: false },
      { id: "open-private", status: "OPEN", isPrivate: true },
      { id: "done-public", status: "COMPLETED", isPrivate: false },
    ]);

    expect(grouped.DRAFT.map((action) => action.id)).toEqual(["draft-private"]);
    expect(grouped.OPEN.map((action) => action.id)).toEqual(["open-public"]);
    expect(grouped.COMPLETED.map((action) => action.id)).toEqual(["done-public"]);
    expect(grouped.ALL).toHaveLength(4);
  });

  it("defines explicit rendering metadata for the draft status", () => {
    expect(ACTION_STATUS_META.DRAFT).toEqual({
      labelKey: "statusDraft",
      tagClass: "info",
    });
  });
});
