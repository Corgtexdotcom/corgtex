import { describe, expect, it } from "vitest";
import { aggregateModelUsageByRunId, sortAgentFleetRows } from "./view-model";

describe("control-plane agent view model", () => {
  it("aggregates multiple model usage rows for the same agent run", () => {
    const usageByRunId = aggregateModelUsageByRunId([
      {
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: "0.0100",
        billableCostUsd: null,
        agentRun: { id: "run-1" },
      },
      {
        inputTokens: 15,
        outputTokens: 7,
        estimatedCostUsd: "0.0200",
        billableCostUsd: "0.0300",
        agentRun: { id: "run-1" },
      },
      {
        inputTokens: 4,
        outputTokens: 3,
        estimatedCostUsd: "0.0040",
        billableCostUsd: "0.0050",
        agentRun: { id: "run-2" },
      },
      {
        inputTokens: 100,
        outputTokens: 100,
        estimatedCostUsd: "1",
        billableCostUsd: "1",
        agentRun: null,
      },
    ]);

    expect(usageByRunId.get("run-1")).toEqual({
      inputTokens: 25,
      outputTokens: 12,
      estimatedCostUsd: 0.03,
      billableCostUsd: 0.03,
    });
    expect(usageByRunId.get("run-2")).toEqual({
      inputTokens: 4,
      outputTokens: 3,
      estimatedCostUsd: 0.004,
      billableCostUsd: 0.005,
    });
    expect(usageByRunId.has("run-3")).toBe(false);
  });

  it("sorts the full loaded agent fleet by customer label without dropping rows", () => {
    const rows = sortAgentFleetRows([
      { id: "3", label: "Zephyr" },
      { id: "1", label: "Beta Works" },
      { id: "2", label: "Alpha Operations" },
    ]);

    expect(rows.map((row) => row.label)).toEqual(["Alpha Operations", "Beta Works", "Zephyr"]);
    expect(rows).toHaveLength(3);
  });
});
