import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

// Merely checking an authorization scope or hashing sealed bytes must not load
// model configuration, extraction or the database-backed publisher.
vi.mock("@corgtex/models", () => { throw new Error("Unexpected model import in permission context"); });
vi.mock("@corgtex/knowledge", () => { throw new Error("Unexpected extractor import in permission context"); });
vi.mock("./native-transcript-publication", () => { throw new Error("Unexpected publisher import in permission context"); });
import { currentCompanyTranscriptPublicationScope, hasCompanyTranscriptPublicationScope,
  hasPendingCompanyTranscript, withCompanyTranscriptPublication } from "./native-transcript-publication-context";
import { nativeTranscriptCanonicalPayload, nativeTranscriptPayloadHash } from "./native-transcript-payload";

const actor: AppActor = { kind: "user", user: { id: "owner", email: "owner@example.test", displayName: null } };
const params = () => ({ actor, workspaceId: "ws", inputId: "native", fingerprint: "f".repeat(64), roots: [],
  callerEpochs: { version: 1 as const, policyVersion: "pun68-permissions-v3" as const, entries: [] } });

describe("private company publication process context", () => {
  it("loads without publication/model dependencies and retains exact actor, tenant and pending identity", async () => {
    expect(hasCompanyTranscriptPublicationScope(actor, "ws")).toBe(false);
    await withCompanyTranscriptPublication(params(), async () => {
      expect(hasPendingCompanyTranscript(actor, "ws", "native")).toBe(true);
      expect(hasPendingCompanyTranscript({ ...actor }, "ws", "native")).toBe(false);
      expect(hasPendingCompanyTranscript(actor, "foreign", "native")).toBe(false);
      expect(hasPendingCompanyTranscript(actor, "ws", "other")).toBe(false);
      currentCompanyTranscriptPublicationScope(actor, "ws")!.published = true;
      expect(hasPendingCompanyTranscript(actor, "ws", "native")).toBe(false);
    });
    expect(hasCompanyTranscriptPublicationScope(actor, "ws")).toBe(false);
  });

  it("revokes detached async continuations after both normal and exceptional completion", async () => {
    for (const fail of [false, true]) {
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      let detached!: Promise<boolean>;
      const run = withCompanyTranscriptPublication(params(), async () => {
        detached = barrier.then(() => hasPendingCompanyTranscript(actor, "ws", "native"));
        if (fail) throw new Error("synthetic callback failure");
      });
      if (fail) await expect(run).rejects.toThrow("synthetic callback failure"); else await run;
      release();
      expect(await detached).toBe(false);
    }
  });

  it("preserves the original canonical sealed bytes and hash", () => {
    const payload = { z: false, recordedAt: new Date("2026-10-14T12:00:00Z"), omitted: undefined, a: { b: [null, 1, "x"] } };
    expect(nativeTranscriptCanonicalPayload(payload)).toBe('{"a":{"b":[null,1,"x"]},"recordedAt":"2026-10-14T12:00:00.000Z","z":false}');
    expect(nativeTranscriptPayloadHash(payload)).toBe("7a15022454a142d6168b8d26b1ca3c551afc454fb7ee8ec41b6641970a7a5413");
  });
});
