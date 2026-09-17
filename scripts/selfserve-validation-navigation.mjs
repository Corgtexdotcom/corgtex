import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SELFSERVE_VALIDATION_TARGET as target } from "./lib/selfserve-validation-target.mjs";

export function navigationFailureKind(report) {
  if (report?.baseUrl !== target.origin || !Array.isArray(report.routeResults) || !Array.isArray(report.findings)) {
    return "infrastructure-unattributed";
  }
  const confirmed = report.findings.some((finding) => {
    if (!Number.isInteger(finding.status) || finding.status < 400 || finding.status > 599) return false;
    let url;
    try { url = new URL(finding.route); } catch { return false; }
    if (url.origin !== target.origin || !new RegExp(`^/(?:en/)?workspaces/${target.workspaceId}(?:/|$)`).test(url.pathname)) return false;
    return report.routeResults.some((row) => row.name === finding.name && row.status === finding.status
      && url.pathname.replace(/^\/en(?=\/)/, "") === row.route);
  });
  return confirmed ? "confirmed-route" : "infrastructure-unattributed";
}

export async function runSelfserveNavigation(run = execFileSync) {
  const directory = ".artifacts/selfserve-validation";
  const path = `${directory}/live.receipt.json`;
  const reportPath = `${directory}/navigation/qa-results.json`;
  const receipt = JSON.parse(await readFile(path, "utf8"));
  // A previous attempt's browser report must never attribute this invocation.
  await rm(reportPath, { force: true });
  try {
    run(process.execPath, ["scripts/client-readiness-smoke.mjs", target.origin, `${directory}/navigation`],
      { timeout: 10 * 60_000, stdio: "pipe", env: process.env });
    receipt.navigationPassed = true;
  } catch {
    const report = await readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
    receipt.navigationPassed = false;
    receipt.status = "failed";
    receipt.cleanup = "failed";
    receipt.failureKind = navigationFailureKind(report);
    process.exitCode = 1;
    console.error("Closed-target navigation failed; no raw browser logs emitted.");
  } finally {
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runSelfserveNavigation().catch(() => { console.error("Navigation harness unavailable."); process.exitCode = 1; });
}
