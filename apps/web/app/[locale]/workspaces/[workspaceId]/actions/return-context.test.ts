import { describe, expect, it } from "vitest";
import { buildActionListQuery } from "./view-model";
import { appendActionReturnTo, buildActionListReturnHref, readActionListReturnHref } from "./return-context";

const workspaceId = "workspace-1";
const listPath = `/workspaces/${workspaceId}/actions`;

function returnToFrom(href: string) {
  return new URL(href, "https://app.local").searchParams.get("returnTo") ?? undefined;
}

describe("Action list return context", () => {
  it("round trips scope, assignee, statuses, view, due sort, and page through detail and edit", () => {
    const listHref = buildActionListReturnHref(workspaceId, buildActionListQuery({
      view: "table", status: ["OPEN", "IN_PROGRESS"], sort: "due_asc", page: 2,
      circleIds: ["circle-1"], assigneeMemberIds: ["member-1"],
    }, "workspace"));
    const detailHref = appendActionReturnTo(`${listPath}/action-1`, listHref);
    const detailReturnTo = readActionListReturnHref(workspaceId, returnToFrom(detailHref));
    const editHref = appendActionReturnTo(`${listPath}/action-1/edit`, detailReturnTo);
    const editReturnTo = readActionListReturnHref(workspaceId, returnToFrom(editHref));
    const cancelHref = appendActionReturnTo(`${listPath}/action-1`, editReturnTo);

    expect(editReturnTo).toBe(listHref);
    expect(readActionListReturnHref(workspaceId, returnToFrom(cancelHref))).toBe(listHref);
    const restored = new URL(listHref, "https://app.local");
    expect(restored.pathname).toBe(listPath);
    expect(Object.fromEntries(restored.searchParams)).toMatchObject({
      view: "table", sort: "due_asc", page: "2", scope: "workspace",
      circleId: "circle-1", assigneeMemberId: "member-1",
    });
    expect(restored.searchParams.getAll("status")).toEqual(["OPEN", "IN_PROGRESS"]);
  });

  it("keeps board view, grouping, and visible columns", () => {
    const listHref = buildActionListReturnHref(workspaceId, buildActionListQuery({
      view: "kanban", status: "ALL", columns: ["OPEN", "IN_PROGRESS"],
      assigneeMemberIds: ["member-1"],
    }, "assigned"));
    expect(readActionListReturnHref(workspaceId, listHref)).toBe(listHref);
    const dueBoardHref = buildActionListReturnHref(workspaceId, buildActionListQuery({ view: "kanban", group: "due" }, "workspace"));
    expect(readActionListReturnHref(workspaceId, dueBoardHref)).toBe(dueBoardHref);
  });

  it("uses the ordinary Actions list for direct links or malformed context", () => {
    expect(readActionListReturnHref(workspaceId, undefined)).toBeNull();
    expect(readActionListReturnHref(workspaceId, [listPath, listPath])).toBeNull();
    for (const value of [
      "https://evil.example/actions",
      `//evil.example${listPath}`,
      "/workspaces/workspace-2/actions?scope=workspace",
      `${listPath}/../settings?scope=workspace`,
      `${listPath}?returnTo=https://evil.example`,
      `${listPath}?scope=workspace&sort=bogus`,
      `${listPath}?scope=workspace&page=0`,
      `${listPath}?status=OPEN&status=BOGUS`,
      `${listPath}?view=table&view=kanban`,
      `${listPath}?assigneeMemberId=%2Fworkspaces%2Fworkspace-2`,
      `${listPath}#other`,
    ]) expect(readActionListReturnHref(workspaceId, value)).toBeNull();
    expect(appendActionReturnTo(`${listPath}/action-1`, null)).toBe(`${listPath}/action-1`);
  });

  it("rebuilds accepted values under the current workspace path", () => {
    const raw = `${listPath}?status=COMPLETED&sort=created_asc&assigneeMemberId=member-1&scope=workspace`;
    expect(readActionListReturnHref(workspaceId, raw)).toBe(
      `${listPath}?status=COMPLETED&assigneeMemberId=member-1&sort=created_asc&scope=workspace`,
    );
    expect(readActionListReturnHref("workspace-2", raw)).toBeNull();
  });
});
