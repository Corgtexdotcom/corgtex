import { beforeEach, describe, expect, it } from "vitest";
import {
  recordWorkflowJobProcessedMetric,
  renderWorkflowJobMetrics,
  resetWorkflowJobMetricsForTest,
  snapshotWorkflowJobMetrics,
} from "./job-metrics";

describe("workflow job metrics", () => {
  beforeEach(() => {
    resetWorkflowJobMetricsForTest();
  });

  it("aggregates counts, sums, and duration buckets by job type and outcome", () => {
    recordWorkflowJobProcessedMetric({
      type: "webhook.deliver",
      outcome: "completed",
      durationMs: 75,
    });
    recordWorkflowJobProcessedMetric({
      type: "webhook.deliver",
      outcome: "completed",
      durationMs: 700,
    });
    recordWorkflowJobProcessedMetric({
      type: "webhook.deliver",
      outcome: "failed",
      durationMs: 1_200,
    });

    expect(snapshotWorkflowJobMetrics()).toEqual([
      expect.objectContaining({
        type: "webhook.deliver",
        outcome: "completed",
        count: 2,
        durationMsSum: 775,
        buckets: expect.arrayContaining([
          { leMs: 100, count: 1 },
          { leMs: 500, count: 1 },
          { leMs: 1_000, count: 2 },
        ]),
      }),
      expect.objectContaining({
        type: "webhook.deliver",
        outcome: "failed",
        count: 1,
        durationMsSum: 1_200,
        buckets: expect.arrayContaining([
          { leMs: 1_000, count: 0 },
          { leMs: 5_000, count: 1 },
        ]),
      }),
    ]);
  });

  it("renders Prometheus counter and histogram lines with escaped labels", () => {
    recordWorkflowJobProcessedMetric({
      type: "custom \"quoted\" job",
      outcome: "completed",
      durationMs: 1_234.5,
    });

    const output = renderWorkflowJobMetrics("worker-1").join("\n");

    expect(output).toContain("# TYPE worker_job_processed_total counter");
    expect(output).toContain("# TYPE worker_job_duration_ms histogram");
    expect(output).toContain("worker_job_processed_total{worker=\"worker-1\",type=\"custom \\\"quoted\\\" job\",outcome=\"completed\"} 1");
    expect(output).toContain("worker_job_duration_ms_bucket{worker=\"worker-1\",type=\"custom \\\"quoted\\\" job\",outcome=\"completed\",le=\"1000\"} 0");
    expect(output).toContain("worker_job_duration_ms_bucket{worker=\"worker-1\",type=\"custom \\\"quoted\\\" job\",outcome=\"completed\",le=\"5000\"} 1");
    expect(output).toContain("worker_job_duration_ms_bucket{worker=\"worker-1\",type=\"custom \\\"quoted\\\" job\",outcome=\"completed\",le=\"+Inf\"} 1");
    expect(output).toContain("worker_job_duration_ms_sum{worker=\"worker-1\",type=\"custom \\\"quoted\\\" job\",outcome=\"completed\"} 1234.500");
    expect(output).toContain("worker_job_duration_ms_count{worker=\"worker-1\",type=\"custom \\\"quoted\\\" job\",outcome=\"completed\"} 1");
  });
});
