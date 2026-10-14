import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lineageContentFingerprint } from "./source-lineage";
import { sourceCommitCanonical } from "./source-commit-lock-plan";

const fields = ["workspaceId", "sourceId", "attemptId", "generation", "configurationFingerprint",
  "sourcePermissionEpoch", "permissionEpochsJson", "encryptedPayload", "payloadHash", "rowsProcessed",
  "nextCursor", "createdAt", "updatedAt"];
const previousFingerprint = (row: Record<string, unknown>) => createHash("sha256").update(JSON.stringify([
  "SqlNativeRunInput", ...fields.map(field => JSON.parse(sourceCommitCanonical(row[field] ?? null))),
])).digest("hex");
const surrogatePair = String.fromCharCode(0xd800, 0xdc00);

describe("bounded native original fingerprint compatibility", () => {
  it.each([
    "aes-256-gcm:" + "x".repeat(200_000),
    "x".repeat(65_535) + surrogatePair + "\"\\\n\ud800" + "z".repeat(65_532) + surrogatePair + "\udc00",
  ])("retains the previous exact JSON hash across string and surrogate boundaries", encryptedPayload => {
    const row = {workspaceId: "synthetic", sourceId: "source", attemptId: "attempt", generation: 42n,
      sourcePermissionEpoch: 0n, permissionEpochsJson: {"2": "numeric", "10": "keys", nested: [null, -0, 1.5]},
      encryptedPayload, rowsProcessed: 4_000, nextCursor: null, createdAt: new Date("2026-10-14T00:00:00Z")};
    expect(lineageContentFingerprint("SqlNativeRunInput", row)).toBe(previousFingerprint(row));
    expect(lineageContentFingerprint("SqlNativeRunInput", {...row, encryptedPayload: encryptedPayload + "changed"}))
      .not.toBe(previousFingerprint(row));
  });
});
