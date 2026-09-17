import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { SELFSERVE_VALIDATION_TARGET as target } from "./lib/selfserve-validation-target.mjs";

const directory = ".artifacts/selfserve-validation";
const path = `${directory}/live.receipt.json`;
const receipt = JSON.parse(await readFile(path, "utf8"));
try {
  execFileSync(process.execPath, ["scripts/client-readiness-smoke.mjs", target.origin, `${directory}/navigation`],
    { timeout: 10 * 60_000, stdio: "pipe", env: process.env });
  receipt.navigationPassed = true;
} catch {
  receipt.navigationPassed = false;
  receipt.status = "failed";
  receipt.cleanup = "failed";
  process.exitCode = 1;
  console.error("Closed-target navigation failed; no raw browser logs emitted.");
} finally {
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
}
