import { describe, expect, it } from "vitest";
import {
  workspaceHomeHref,
  workspaceOptions,
} from "./workspace-switcher-model";

const workspaces = [
  {
    id: "workspace-a",
    name: "Example company",
    slug: "example-east",
    primaryName: "Example company",
    secondaryLabel: "powered by Corgtex",
  },
  {
    id: "workspace-b",
    name: "Example company",
    slug: "example-west",
    primaryName: "Example company",
    secondaryLabel: "powered by Corgtex",
  },
  {
    id: "workspace-c",
    name: "Other company",
    slug: "other",
    primaryName: "Other company",
    secondaryLabel: "powered by Corgtex",
  },
];

describe("workspace switcher destinations", () => {
  it("opens the localized workspace home without an entity path or filters", () => {
    expect(workspaceHomeHref("es", "workspace-b")).toBe(
      "/es/workspaces/workspace-b",
    );
    expect(workspaceHomeHref("en", "id/with?query")).toBe(
      "/en/workspaces/id%2Fwith%3Fquery",
    );
  });
  it("disambiguates duplicate names before filtering and searches names and slugs", () => {
    expect(workspaceOptions(workspaces, " EAST ")).toEqual([
      { ...workspaces[0], disambiguator: "example-east" },
    ]);
    expect(workspaceOptions(workspaces, "other")[0].disambiguator).toBeNull();
    expect(workspaceOptions(workspaces, "missing")).toEqual([]);
  });
  it("never manufactures memberships and preserves the server list order", () => {
    expect(workspaceOptions([], "")).toEqual([]);
    expect(
      workspaceOptions(workspaces, "").map((workspace) => workspace.id),
    ).toEqual(workspaces.map((workspace) => workspace.id));
  });
});
