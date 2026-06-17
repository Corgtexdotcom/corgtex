export type WorkflowJobMetricOutcome = "completed" | "failed";

const WORKFLOW_JOB_DURATION_BUCKETS_MS = [
  100,
  500,
  1_000,
  5_000,
  10_000,
  30_000,
  60_000,
  300_000,
] as const;

type WorkflowJobMetric = {
  type: string;
  outcome: WorkflowJobMetricOutcome;
  count: number;
  durationMsSum: number;
  buckets: number[];
};

export type WorkflowJobMetricSnapshot = {
  type: string;
  outcome: WorkflowJobMetricOutcome;
  count: number;
  durationMsSum: number;
  buckets: Array<{ leMs: number; count: number }>;
};

const workflowJobMetrics = new Map<string, WorkflowJobMetric>();

function metricKey(type: string, outcome: WorkflowJobMetricOutcome) {
  return `${outcome}\u0000${type}`;
}

function normalizeJobType(type: string) {
  const trimmed = type.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function normalizeDurationMs(durationMs: number) {
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
}

export function recordWorkflowJobProcessedMetric(params: {
  type: string;
  outcome: WorkflowJobMetricOutcome;
  durationMs: number;
}) {
  const type = normalizeJobType(params.type);
  const durationMs = normalizeDurationMs(params.durationMs);
  const key = metricKey(type, params.outcome);
  let metric = workflowJobMetrics.get(key);
  if (!metric) {
    metric = {
      type,
      outcome: params.outcome,
      count: 0,
      durationMsSum: 0,
      buckets: WORKFLOW_JOB_DURATION_BUCKETS_MS.map(() => 0),
    };
    workflowJobMetrics.set(key, metric);
  }

  metric.count += 1;
  metric.durationMsSum += durationMs;
  WORKFLOW_JOB_DURATION_BUCKETS_MS.forEach((bucket, index) => {
    if (durationMs <= bucket) {
      metric.buckets[index] += 1;
    }
  });
}

export function snapshotWorkflowJobMetrics(): WorkflowJobMetricSnapshot[] {
  return [...workflowJobMetrics.values()]
    .map((metric) => ({
      type: metric.type,
      outcome: metric.outcome,
      count: metric.count,
      durationMsSum: metric.durationMsSum,
      buckets: WORKFLOW_JOB_DURATION_BUCKETS_MS.map((leMs, index) => ({
        leMs,
        count: metric.buckets[index] ?? 0,
      })),
    }))
    .sort((left, right) => (
      left.type.localeCompare(right.type) || left.outcome.localeCompare(right.outcome)
    ));
}

function escapePrometheusLabel(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function formatPrometheusNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function renderWorkflowJobMetrics(workerId: string) {
  const worker = escapePrometheusLabel(workerId);
  const lines = [
    "# HELP worker_job_processed_total Total workflow jobs processed by type and outcome",
    "# TYPE worker_job_processed_total counter",
    "# HELP worker_job_duration_ms Workflow job processing duration in milliseconds by type and outcome",
    "# TYPE worker_job_duration_ms histogram",
  ];

  for (const metric of snapshotWorkflowJobMetrics()) {
    const labels = `worker="${worker}",type="${escapePrometheusLabel(metric.type)}",outcome="${metric.outcome}"`;
    lines.push(`worker_job_processed_total{${labels}} ${metric.count}`);
    for (const bucket of metric.buckets) {
      lines.push(`worker_job_duration_ms_bucket{${labels},le="${bucket.leMs}"} ${bucket.count}`);
    }
    lines.push(`worker_job_duration_ms_bucket{${labels},le="+Inf"} ${metric.count}`);
    lines.push(`worker_job_duration_ms_sum{${labels}} ${formatPrometheusNumber(metric.durationMsSum)}`);
    lines.push(`worker_job_duration_ms_count{${labels}} ${metric.count}`);
  }

  return lines;
}

export function resetWorkflowJobMetricsForTest() {
  workflowJobMetrics.clear();
}
