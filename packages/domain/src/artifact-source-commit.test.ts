import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const f = vi.hoisted(() => ({ prisma: {}, source: Object.freeze({}), native: Object.freeze({}),
  owner: Object.freeze({}), events: [] as string[], activeSource: false, activeNative: false,
  rejectOwner: false, rejectAfter: false }));
vi.mock("@corgtex/shared", () => ({ prisma: f.prisma }));
vi.mock("./artifact-commit-preflight", () => ({
  prepareArtifactCommitPreflight: vi.fn(async () => { f.events.push("native-preparation"); return f.native; }),
  withArtifactCommitPreflight: vi.fn(async (_actor, _ws, _tx, _roots, _token, work) => {
    expect(f.activeSource).toBe(true);
    f.events.push("native-validation"); f.activeNative = true;
    try { return await work(); } finally { f.activeNative = false; }
  }),
}));
vi.mock("./source-commit-lock-plan", () => ({
  prepareSourceCommitAmbientFences: vi.fn(async () => { f.events.push("ambient-fences"); }),
  prepareSourceCommitLockPlan: vi.fn(async () => { f.events.push("source-preparation"); return f.source; }),
  prepareSourceCommitOwnerAttestation: vi.fn(async (_actor, _ws, tx, _plan, binding, check) => {
    f.events.push("owner");
    expect(f.activeNative).toBe(false);
    await check(tx, binding);
    if (f.rejectOwner) throw new Error("STALE_OWNER");
    return f.owner;
  }),
  withSourceCommitLockPlan: vi.fn(async (_actor, _ws, _tx, _roots, _targets, _binding, _plan, _owner, work) => {
    f.events.push("source-locks"); f.activeSource = true;
    try {
      const result = await work(); f.events.push("source-final-check");
      expect(f.activeNative).toBe(false);
      if (f.rejectAfter) throw new Error("SOURCE_CHANGED");
      return result;
    } finally { f.activeSource = false; }
  }),
}));

import { prepareArtifactSourceCommit, withArtifactSourceCommit } from "./artifact-source-commit";
import { prepareArtifactCommitPreflight } from "./artifact-commit-preflight";
import { prepareSourceCommitLockPlan } from "./source-commit-lock-plan";
import { assertOutsideArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import type { ArtifactStructuralAuthority } from "./artifact-structural-authority";

const actor = { kind: "user", user: { id: "synthetic-owner" } } as AppActor;
const tx = {} as any;
const roots = [{ kind: "Action" as const, id: "synthetic-source", fingerprint: "a".repeat(64) }];
const options = { writeTargets: [{ kind: "BrainArticle" as const, id: "preallocated-output",
  projectedAuthority: { isPrivate: true, ownerMemberId: "synthetic-member" } }],
ownerBinding: { kind: "HUMAN_REQUEST" as const, id: "synthetic-request", generation: 1 } };

describe("source and native commit composition", () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.events = []; f.activeSource = false; f.activeNative = false;
    f.rejectOwner = false; f.rejectAfter = false;
  });

  it("holds the source plan through native validation and the writer, with owner checks outside native authority", async () => {
    const token = await prepareArtifactSourceCommit(actor, "workspace", roots, options);
    const owner = vi.fn(async (connection, binding) => {
      expect(connection).toBe(tx); expect(binding).toEqual(options.ownerBinding);
      expect(f.activeNative).toBe(false);
    });
    const result = await withArtifactSourceCommit(actor, "workspace", tx, roots, options, token, owner, async () => {
      expect(f.activeSource).toBe(true); expect(f.activeNative).toBe(true);
      f.events.push("write"); return "committed";
    });
    expect(result).toBe("committed");
    expect(f.events).toEqual(["native-preparation", "ambient-fences", "source-preparation", "owner", "source-locks",
      "native-validation", "write", "source-final-check"]);
    expect(f.activeSource).toBe(false); expect(f.activeNative).toBe(false);
  });

  it("seals complete roots, output governors and owner control before a preparation await", async () => {
    const submittedRoots = structuredClone(roots), submittedOptions = structuredClone(options);
    vi.mocked(prepareArtifactCommitPreflight).mockImplementationOnce(async () => {
      submittedRoots[0].id = "changed-source";
      submittedOptions.writeTargets[0].projectedAuthority.ownerMemberId = "changed-owner";
      submittedOptions.ownerBinding.generation = 9;
      return f.native as any;
    });
    const token = await prepareArtifactSourceCommit(actor, "workspace", submittedRoots, submittedOptions);
    expect(prepareSourceCommitLockPlan).toHaveBeenCalledWith(actor, "workspace", roots,
      { writeTargets: options.writeTargets, ownerBinding: options.ownerBinding });
    const work = vi.fn(async () => "stored");
    await expect(withArtifactSourceCommit(actor, "workspace", tx, submittedRoots,
      submittedOptions, token, async () => {}, work)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(work).not.toHaveBeenCalled();
  });

  it("retains structural capability identity and rejects an equal-looking substituted receipt", async () => {
    const receipt = Object.freeze({}) as ArtifactStructuralAuthority;
    const submitted = { ...options, structuralAuthorities: [receipt] };
    const token = await prepareArtifactSourceCommit(actor, "workspace", roots, submitted);
    expect(prepareSourceCommitLockPlan).toHaveBeenCalledWith(actor, "workspace", roots,
      { writeTargets: options.writeTargets, ownerBinding: options.ownerBinding, structuralAuthorities: [receipt] });
    expect(vi.mocked(prepareSourceCommitLockPlan).mock.calls[0][3].structuralAuthorities![0]).toBe(receipt);
    const work = vi.fn(async () => "stored"), owner = vi.fn(async () => {});
    await expect(withArtifactSourceCommit(actor, "workspace", tx, roots,
      { ...submitted, structuralAuthorities: [Object.freeze({}) as ArtifactStructuralAuthority] },
      token, owner, work)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(owner).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
    await expect(withArtifactSourceCommit(actor, "workspace", tx, roots, submitted,
      token, owner, work)).resolves.toBe("stored");
  });

  it.each(["owner", "final", "writer"])("burns the composite capability after %s failure and clears both scopes", async failure => {
    const token = await prepareArtifactSourceCommit(actor, "workspace", roots, options);
    f.rejectOwner = failure === "owner"; f.rejectAfter = failure === "final";
    const work = vi.fn(async () => { if (failure === "writer") throw new Error("ROLLBACK"); return "stored"; });
    await expect(withArtifactSourceCommit(actor, "workspace", tx, roots, options, token, async () => {}, work)).rejects.toThrow();
    const calls = work.mock.calls.length;
    await expect(withArtifactSourceCommit(actor, "workspace", tx, roots, options, token, async () => {}, work))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(work).toHaveBeenCalledTimes(calls);
    expect(f.activeSource).toBe(false); expect(f.activeNative).toBe(false);
  });

  it("blocks provider replay in owner callbacks and direct writer work while preserving single-use retry safety", async () => {
    for (const phase of ["owner", "writer"] as const) {
      const token = await prepareArtifactSourceCommit(actor, "workspace", roots, options);
      const provider = vi.fn(() => assertOutsideArtifactNativeCommitPhase());
      const work = vi.fn(async () => { if (phase === "writer") provider(); return "stored"; });
      await expect(withArtifactSourceCommit(actor, "workspace", tx, roots, options, token,
        async () => { if (phase === "owner") provider(); }, work)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(work).toHaveBeenCalledTimes(phase === "owner" ? 0 : 1);
      await expect(withArtifactSourceCommit(actor, "workspace", tx, roots, options, token,
        async () => {}, work)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(f.activeSource).toBe(false); expect(f.activeNative).toBe(false);
    }
    expect(() => assertOutsideArtifactNativeCommitPhase()).not.toThrow();
  });

  it("rejects a different actor, tenant, target, generation or primary client before owner or native execution", async () => {
    const token = await prepareArtifactSourceCommit(actor, "workspace", roots, options);
    const work = vi.fn(async () => "stored"), owner = vi.fn(async () => {});
    const variants = [
      { actor: structuredClone(actor), ws: "workspace", tx, opts: options },
      { actor, ws: "other-workspace", tx, opts: options },
      { actor, ws: "workspace", tx: f.prisma as any, opts: options },
      { actor, ws: "workspace", tx, opts: { ...options, writeTargets: [] } },
      { actor, ws: "workspace", tx, opts: { ...options, ownerBinding: { ...options.ownerBinding, generation: 2 } } },
    ];
    for (const variant of variants) await expect(withArtifactSourceCommit(variant.actor, variant.ws,
      variant.tx, roots, variant.opts, token, owner, work)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(owner).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  });
});
