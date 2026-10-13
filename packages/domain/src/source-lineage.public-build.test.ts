import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";

const fixture = vi.hoisted(() => {
  const rows = new Map<string, Map<string, any>>();
  const delegates = new Map<string, any>();
  let serial = 0;
  const table = (name: string) => {
    if (!rows.has(name)) rows.set(name, new Map());
    return rows.get(name)!;
  };
  const insert = (name: string, value: any) => {
    const row = { id: `${name}-${++serial}`, workspaceId: "ws-build", createdAt: new Date("2026-10-13T12:00:00Z"),
      updatedAt: new Date("2026-10-13T12:00:00Z"), ...value };
    table(name).set(row.id, row);
    return row;
  };
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([field, value]: [string, any]) => {
    if (field === "artifact") return matches(table("buildArtifact").get(row.artifactId), value);
    if (field === "flow") return matches(table("approvalFlow").get(row.flowId), value);
    if (value && typeof value === "object" && !(value instanceof Date) && "in" in value) return value.in.includes(row[field]);
    return row[field] === value;
  });
  const base = { $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn(async () => 1), $transaction: vi.fn() };
  const db: any = new Proxy(base, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    const name = String(property);
    if (!delegates.has(name)) {
      const find = ({ where, orderBy }: any) => {
        const found = [...table(name).values()].filter(row => matches(row, where));
        return orderBy?.revision === "desc" ? found.sort((left, right) => right.revision - left.revision) : found;
      };
      delegates.set(name, {
        findFirst: vi.fn(async (args: any) => structuredClone(find(args)[0] ?? null)),
        findMany: vi.fn(async (args: any) => structuredClone(find(args))),
        create: vi.fn(async ({ data }: any) => structuredClone(insert(name, data))),
      });
    }
    return delegates.get(name);
  } });
  return { rows, db, base, insert };
});

vi.mock("@corgtex/shared", async original => ({ ...await original<typeof import("@corgtex/shared")>(), prisma: fixture.db }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }: any) => {
  if (workspaceId !== "ws-build" || actor.kind !== "user") throw new Error("Synthetic workspace unavailable");
  return { id: "member-owner", userId: actor.user.id, role: "ADMIN", isActive: true };
}) }));
vi.mock("./finance", () => ({ getFinanceAccessPolicy: async () => ({ canRead: false }) }));

import { captureArtifactInputProof, captureArtifactInputSnapshotProof, isArtifactInputProofPubliclyShareable,
  isArtifactInputProofReadable, recordArtifactInputLineage, type LineageKind } from "./source-lineage";

const actor: AppActor = { kind: "user", user: { id: "owner", email: "owner@example.test", displayName: "Owner" } };
const workspaceId = "ws-build";
let epoch: ReturnType<typeof installSourcePermissionEpochFixture>;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.rows.clear();
  epoch = installSourcePermissionEpochFixture(fixture.db);
  fixture.base.$transaction.mockImplementation(async work => work(fixture.db));
});

async function authoredArtifact(visibility = "PUBLIC_REVIEW", classification = "OPEN_CORE") {
  const row = fixture.insert("buildArtifact", { id: "build-1", createdByUserId: "owner", brainSourceId: null,
    title: "Synthetic public review", summaryMd: "Synthetic body", visibility, classification,
    publicEnabledAt: visibility === "PUBLIC_REVIEW" ? new Date("2026-10-13T12:00:00Z") : null,
    publicRevokedAt: null, publicTokenHash: "synthetic-token", noPrivateDataConfirmedAt: new Date("2026-10-13T12:00:00Z") });
  await receipt("BuildArtifact", row);
  return row;
}

async function receipt(kind: LineageKind, row: any) {
  await recordArtifactInputLineage({ tx: fixture.db, actor, workspaceId,
    artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
}

async function proof(kind: "BuildArtifact" | "BuildArtifactAsset", id: string) {
  return captureArtifactInputProof(actor, workspaceId, [{ kind, id }], fixture.db);
}

describe("BuildArtifact public source proof", () => {
  it("withholds a readable decision whose permission parent is private, including its immutable snapshot", async () => {
    const action = fixture.insert("action", { id: "action-private", title: "Private decision subject",
      descriptionMd: "Private parent text", status: "DRAFT", isPrivate: true, authorUserId: actor.user.id, archivedAt: null });
    await receipt("Action", action);
    const flow = fixture.insert("approvalFlow", { id: "flow-private", subjectType: "ACTION", subjectId: action.id });
    await receipt("ApprovalFlow", flow);
    const decision = fixture.insert("approvalDecision", { id: "decision-private", flowId: flow.id,
      memberId: "member-owner", choice: "APPROVE", rationale: "Independently authored answer" });
    await receipt("ApprovalDecision", decision);
    const direct = await captureArtifactInputProof(actor, workspaceId, [{ kind: "ApprovalDecision", id: decision.id }], fixture.db);
    const snapshot = await captureArtifactInputSnapshotProof(actor, workspaceId,
      { kind: "ApprovalDecision", id: decision.id }, fixture.db);
    for (const roots of [direct, snapshot]) {
      expect(await isArtifactInputProofReadable(actor, workspaceId, roots, fixture.db)).toBe(true);
      expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, roots, fixture.db)).toBe(false);
    }
  });

  it("allows an original public review, then denies a currently revoked review even with a fresh readable receipt", async () => {
    const artifact = await authoredArtifact();
    const original = await proof("BuildArtifact", artifact.id);
    expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, original, fixture.db)).toBe(true);

    artifact.publicRevokedAt = new Date("2026-10-13T13:00:00Z");
    await receipt("BuildArtifact", artifact);
    const revoked = await proof("BuildArtifact", artifact.id);
    expect(await isArtifactInputProofReadable(actor, workspaceId, revoked, fixture.db)).toBe(true);
    expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, revoked, fixture.db)).toBe(false);
  });

  it("checks an asset's current BuildArtifact parent before public sharing", async () => {
    const artifact = await authoredArtifact();
    const asset = fixture.insert("buildArtifactAsset", { id: "asset-1", artifactId: artifact.id,
      kind: "IMAGE", label: "Public preview", storageKey: "synthetic/preview.png", sha256: "a".repeat(64) });
    await receipt("BuildArtifactAsset", asset);
    const assetRoots = await proof("BuildArtifactAsset", asset.id);
    expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, assetRoots, fixture.db)).toBe(true);
    artifact.publicRevokedAt = new Date("2026-10-13T13:00:00Z");
    await receipt("BuildArtifact", artifact);
    expect(await isArtifactInputProofReadable(actor, workspaceId, assetRoots, fixture.db)).toBe(true);
    expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, assetRoots, fixture.db)).toBe(false);
  });

  it("checks both saved and live public envelopes of an immutable snapshot, then rejects restored stale epochs", async () => {
    const artifact = await authoredArtifact();
    const roots = await captureArtifactInputSnapshotProof(actor, workspaceId,
      { kind: "BuildArtifact", id: artifact.id }, fixture.db);
    expect(roots[0].kind).toBe("ArtifactInputSnapshot");
    expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, roots, fixture.db)).toBe(true);

    artifact.publicRevokedAt = new Date("2026-10-13T13:00:00Z");
    await receipt("BuildArtifact", artifact);
    expect(await isArtifactInputProofReadable(actor, workspaceId, roots, fixture.db)).toBe(true);
    expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, roots, fixture.db)).toBe(false);

    epoch.bump(workspaceId, "BuildArtifact", artifact.id);
    artifact.publicRevokedAt = null;
    await receipt("BuildArtifact", artifact);
    epoch.bump(workspaceId, "BuildArtifact", artifact.id);
    expect(await isArtifactInputProofReadable(actor, workspaceId, roots, fixture.db)).toBe(false);
    expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, roots, fixture.db)).toBe(false);
  });

  it.each([["PRIVATE", "OPEN_CORE"], ["PUBLIC_REVIEW", "INTERNAL"]] as const)(
    "keeps %s / %s reviews private even with valid source receipts", async (visibility, classification) => {
      const artifact = await authoredArtifact(visibility, classification);
      const roots = await proof("BuildArtifact", artifact.id);
      expect(await isArtifactInputProofReadable(actor, workspaceId, roots, fixture.db)).toBe(true);
      expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, roots, fixture.db)).toBe(false);
    });

  it.each(["visibility", "classification", "revocation"] as const)(
    "does not launder a saved %s restriction by later making the live artifact public", async restriction => {
      const artifact = await authoredArtifact();
      if (restriction === "visibility") artifact.visibility = "PRIVATE";
      if (restriction === "classification") artifact.classification = "INTERNAL";
      if (restriction === "revocation") artifact.publicRevokedAt = new Date("2026-10-13T12:30:00Z");
      await receipt("BuildArtifact", artifact);
      const historical = await captureArtifactInputSnapshotProof(actor, workspaceId,
        { kind: "BuildArtifact", id: artifact.id }, fixture.db);
      artifact.visibility = "PUBLIC_REVIEW";
      artifact.classification = "OPEN_CORE";
      artifact.publicRevokedAt = null;
      await receipt("BuildArtifact", artifact);
      expect(await isArtifactInputProofReadable(actor, workspaceId, historical, fixture.db)).toBe(true);
      expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, historical, fixture.db)).toBe(false);
    });
});
