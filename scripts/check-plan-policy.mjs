export const FORBIDDEN_UNLABELED_PATHS = [
  /^deploy\//,
  /^\.github\/workflows\//,
  /^prisma\/migrations\//,
  /^packages\/domain\/src\/auth.*\.ts$/,
  /^apps\/web\/lib\/auth\.ts$/,
];

export const RISK_CAPS = {
  low: { codeLoc: 4000, files: 100 },
  standard: { codeLoc: 2500, files: 60 },
  high: { codeLoc: 1800, files: 40 },
  critical: { codeLoc: 1200, files: 30 },
};

const PIPELINE_POLICY_PATHS = [
  /^AGENTS\.md$/,
  /^\.agents\/plan-template\.md$/,
  /^\.codex\/review\.md$/,
  /^\.codex\/ops\/.*\.md$/,
  /^\.github\/pull_request_template\.md$/,
  /^docs\/contributing\/agent-pipeline\.mdx$/,
  /^docs\/contributing\/pull-requests\.mdx$/,
  /^scripts\/check-plan(?:-policy(?:\.test)?)?\.mjs$/,
  /^scripts\/review-snapshot-integrity\.mjs$/,
];

export function sizePolicyForFiles(riskTier, files) {
  const requiresCriticalCap = files.some((file) =>
    [...FORBIDDEN_UNLABELED_PATHS, ...PIPELINE_POLICY_PATHS].some((pattern) => pattern.test(file)),
  );
  const effectiveRiskTier = requiresCriticalCap ? "critical" : riskTier;
  return { effectiveRiskTier, caps: RISK_CAPS[effectiveRiskTier] };
}
