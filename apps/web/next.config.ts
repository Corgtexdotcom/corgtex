import type { NextConfig } from "next";
import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";
import { withSentryConfig } from "@sentry/nextjs";
import withBundleAnalyzer from "@next/bundle-analyzer";

const analyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

function releaseGitSha() {
  return [
    process.env.CORGTEX_RELEASE_GIT_SHA,
    process.env.RAILWAY_GIT_COMMIT_SHA,
    process.env.GITHUB_SHA,
  ]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
}

const buildReleaseSha = releaseGitSha();

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  ...(buildReleaseSha ? {
    deploymentId: buildReleaseSha,
    generateBuildId: () => buildReleaseSha,
  } : {}),
  transpilePackages: [
    "@corgtex/shared",
    "@corgtex/domain",
    "@corgtex/workflows",
    "@corgtex/models",
    "@corgtex/knowledge",
    "@corgtex/agents",
  ],
  serverExternalPackages: ["pdf-parse", "mammoth"],
};

export default withSentryConfig(analyzer(withNextIntl(nextConfig)), {
  // For all available options, see:
  // https://github.com/getsentry/sentry-webpack-plugin#options
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
  webpack: {
    automaticVercelMonitors: true,
    reactComponentAnnotation: {
      enabled: true,
    },
  },
});
