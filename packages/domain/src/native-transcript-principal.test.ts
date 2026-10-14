import type { AppActor } from "@corgtex/shared";
import { describe, expect, it } from "vitest";
import { getAudioTranscriptWorkerPurpose, nativeTranscriptPrincipalUserId,
  registerAudioTranscriptWorker, revokeAudioTranscriptWorker } from "./native-transcript-principal";

describe("native transcript worker principal", () => {
  it("returns the actual human principal for a direct member upload", () => {
    const actor: AppActor = { kind: "user", user: { id: "user-1", email: "owner@example.test", displayName: "Owner" } };
    expect(nativeTranscriptPrincipalUserId(actor, "ws-1")).toBe("user-1");
  });

  it("uses object identity and an exact workspace purpose", () => {
    const actor: AppActor = Object.freeze({ kind: "agent", authProvider: "bootstrap", label: "audio-worker",
      workspaceIds: Object.freeze(["ws-1"]) as unknown as string[] });
    const forged = { ...actor } as AppActor;
    const purpose = { workspaceId: "ws-1", audioAssetId: "audio-1", workflowJobId: "job-1",
      ownerMemberId: "member-1", uploadedByUserId: "user-1", assetBindingHash: "a", jobLeaseHash: "b" };

    registerAudioTranscriptWorker(actor, purpose);
    expect(getAudioTranscriptWorkerPurpose(actor, "ws-1")).toEqual(purpose);
    expect(nativeTranscriptPrincipalUserId(actor, "ws-1")).toBe("user-1");
    expect(getAudioTranscriptWorkerPurpose(actor, "ws-2")).toBeNull();
    expect(getAudioTranscriptWorkerPurpose(forged, "ws-1")).toBeNull();
    expect(nativeTranscriptPrincipalUserId(forged, "ws-1")).toBeNull();
    revokeAudioTranscriptWorker(actor);
    expect(nativeTranscriptPrincipalUserId(actor, "ws-1")).toBeNull();
  });
});
