#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export function buildHostingImageReceipt({ repository, gitSha, runId, runAttempt, siteDigest, monitorDigest }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid repository");
  if (!/^[a-f0-9]{40}$/.test(gitSha ?? "")) throw new Error("Invalid source commit");
  if (!/^[1-9][0-9]*$/.test(runId ?? "") || !/^[1-9][0-9]*$/.test(runAttempt ?? "")) {
    throw new Error("Invalid workflow run identity");
  }
  const image = (name, digest) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) throw new Error(`Invalid published ${name} digest`);
    return { digest, reference: `ghcr.io/${repository.toLowerCase()}/${name}@${digest}` };
  };
  return {
    schemaVersion: 1,
    sourceCommit: gitSha,
    workflowRun: { id: runId, attempt: runAttempt, url: `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}` },
    images: { site: image("site", siteDigest), monitor: image("ops-monitor", monitorDigest) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = buildHostingImageReceipt({
      repository: process.env.GITHUB_REPOSITORY,
      gitSha: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      siteDigest: process.env.SITE_IMAGE_DIGEST,
      monitorDigest: process.env.MONITOR_IMAGE_DIGEST,
    });
    console.log(process.argv.includes("--summary")
      ? `## Published Hosting Images\n\nSource commit: ${receipt.sourceCommit}\n\nRun: ${receipt.workflowRun.url}\n\nImport and deploy only these digest references:\n\n- ${receipt.images.site.reference}\n- ${receipt.images.monitor.reference}`
      : JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
