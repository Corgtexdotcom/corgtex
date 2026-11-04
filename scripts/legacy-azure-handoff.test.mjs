import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it("exercises the standalone Azure utility and handoff privacy/protocol boundaries", () => {
  const tests = ["../deploy/legacy-handoff/worker.test.mjs", "../deploy/legacy-handoff/azure-utility.test.mjs"]
    .map(path => fileURLToPath(new URL(path, import.meta.url)));
  const result = execFileSync(process.execPath, ["--test", ...tests], { encoding: "utf8", timeout: 15000 });
  expect(result).toContain("# fail 0");
});
