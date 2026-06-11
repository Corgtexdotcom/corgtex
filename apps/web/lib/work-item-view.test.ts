import { describe, expect, it } from "vitest";
import {
  buildWorkItemQuery,
  normalizeDateOnly,
  normalizeWorkItemScope,
  normalizeWorkItemView,
  resolveWorkItemScope,
} from "./work-item-view";

describe("work item view helpers", () => {
  it("normalizes view, scope, and date query values", () => {
    expect(normalizeWorkItemView("kanban")).toBe("kanban");
    expect(normalizeWorkItemView("table")).toBe("list");
    expect(normalizeWorkItemScope("circle")).toBe("circle");
    expect(normalizeWorkItemScope("member")).toBe("member");
    expect(normalizeWorkItemScope("invalid")).toBe("company");
    expect(normalizeDateOnly("2026-06-10")).toBe("2026-06-10");
    expect(normalizeDateOnly("2026-06-31")).toBeUndefined();
  });

  it("keeps filters in generated query links", () => {
    expect(buildWorkItemQuery({
      status: "OPEN",
      view: "kanban",
      scope: "member",
      memberId: "mem-1",
      dates: {
        openedFrom: "2026-06-01",
      },
    })).toBe("?status=OPEN&view=kanban&scope=member&memberId=mem-1&openedFrom=2026-06-01");
  });

  it("only applies circle or member ids for the selected scope", () => {
    expect(resolveWorkItemScope({
      scope: "circle",
      circleId: "circle-1",
      memberId: "mem-1",
    })).toEqual({
      scope: "circle",
      circleId: "circle-1",
      memberId: undefined,
    });

    expect(resolveWorkItemScope({
      scope: "member",
      circleId: "circle-1",
      memberId: "mem-1",
    })).toEqual({
      scope: "member",
      circleId: undefined,
      memberId: "mem-1",
    });
  });
});
