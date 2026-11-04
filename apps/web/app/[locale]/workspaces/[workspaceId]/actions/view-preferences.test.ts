import { describe, expect, it } from "vitest";
import { actionsViewStorageKey, restoredActionsView } from "./view-preferences";

const path = "/workspaces/ws-1/actions";
const board = `${path}?view=kanban&status=ALL&scope=workspace&columns=OPEN%2CIN_PROGRESS`;

describe("Actions view preferences", () => {
  it("restores board layout, hidden columns and filters only on bare visits", () => {
    const restored = restoredActionsView("ws-1", "", board);
    expect(restored).toContain("view=kanban");
    expect(restored).toContain("columns=OPEN%2CIN_PROGRESS");
    expect(restored).toContain("scope=workspace");
    expect(restored).toContain("status=ALL");
    expect(restoredActionsView("ws-1", "versionConflict=1", board)).toBe(restored);
    for (const search of ["view=list", "sort=due_asc", "status=COMPLETED", "scope=workspace", "circleId=c1", "assigneeMemberId=m1", "page=2", "group=due", "columns=OPEN"]) {
      expect(restoredActionsView("ws-1", search, board)).toBeNull();
    }
  });

  it("restores table sort and repeated filters without leaking other workspace paths", () => {
    const table = `${path}?view=table&sort=due_asc&circleId=c1&circleId=c2&assigneeMemberId=m1`;
    expect(restoredActionsView("ws-1", "", table)).toContain("sort=due_asc");
    expect(restoredActionsView("ws-1", "", table)).toContain("circleId=c1&circleId=c2");
    for (const stored of [null, path, `${path}?view=list`, "bad json", "https://evil.test/", board.replace("ws-1", "ws-2"), `${path}?view=kanban&columns=EVIL`, `${path}?redirect=evil`]) {
      expect(restoredActionsView("ws-1", "", stored)).toBeNull();
    }
  });

  it("isolates user/workspace identities, including delimiter-containing IDs", () => {
    const keys = [["u1", "ws1"], ["u2", "ws1"], ["u1", "ws2"], ["u:ws", "1"], ["u", "ws:1"]]
      .map(([user, workspace]) => actionsViewStorageKey(user, workspace));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
