import { describe, expect, it } from "vitest";
import { buildReplayPayload } from "./runtime";

describe("buildReplayPayload", () => {
  it("adds replay metadata to object payloads without dropping existing fields", () => {
    const payload = buildReplayPayload(
      {
        proposalId: "proposal-1",
        runtimeMeta: {
          existing: "keep-me",
        },
      },
      {
        replayOfEventId: "event-1",
      },
    ) as {
      proposalId: string;
      runtimeMeta: Record<string, string>;
    };

    expect(payload.proposalId).toBe("proposal-1");
    expect(payload.runtimeMeta.existing).toBe("keep-me");
    expect(payload.runtimeMeta.replayOfEventId).toBe("event-1");
    expect(typeof payload.runtimeMeta.replayRequestedAt).toBe("string");
  });

  it("wraps non-object payloads so replay metadata is still preserved", () => {
    const payload = buildReplayPayload("raw-payload", {
      replayOfJobId: "job-1",
    }) as {
      replayPayload: string;
      runtimeMeta: Record<string, string>;
    };

    expect(payload.replayPayload).toBe("raw-payload");
    expect(payload.runtimeMeta.replayOfJobId).toBe("job-1");
    expect(typeof payload.runtimeMeta.replayRequestedAt).toBe("string");
  });
});
