export const FORBIDDEN_UNLABELED_PATHS = [
  /^deploy\//,
  /^\.github\/workflows\//,
  /^prisma\/migrations\//,
  /^packages\/domain\/src\/auth.*\.ts$/,
  /^apps\/web\/lib\/auth\.ts$/,
];

export const RISK_CAPS = {
  low: { codeLoc: 1200, files: 50 },
  standard: { codeLoc: 800, files: 25 },
  high: { codeLoc: 700, files: 15 },
  critical: { codeLoc: 400, files: 15 },
};

const PIPELINE_POLICY_PATHS = [
  /^AGENTS\.md$/,
  /^\.agents\/plan-template\.md$/,
  /^\.codex\/review\.md$/,
  /^docs\/contributing\/agent-pipeline\.mdx$/,
  /^docs\/contributing\/pull-requests\.mdx$/,
  /^scripts\/check-plan(?:-policy(?:\.test)?)?\.mjs$/,
];

export function sizePolicyForFiles(riskTier, files) {
  const requiresCriticalCap = files.some((file) =>
    [...FORBIDDEN_UNLABELED_PATHS, ...PIPELINE_POLICY_PATHS].some((pattern) => pattern.test(file)),
  );
  const effectiveRiskTier = requiresCriticalCap ? "critical" : riskTier;
  return { effectiveRiskTier, caps: RISK_CAPS[effectiveRiskTier] };
}
