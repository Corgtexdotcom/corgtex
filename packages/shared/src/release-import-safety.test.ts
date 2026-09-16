import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
describe("release metadata runtime import boundaries", () => {
  it.each(["packages/shared/src/release-metadata.ts", "packages/shared/src/telemetry.ts", "apps/web/instrumentation.ts"])("bundles %s for browser/Edge without Node builtins", async entry => {
    const result = await build({
      absWorkingDir: root, entryPoints: [entry], bundle: true, platform: "browser", format: "esm", write: false,
      external: ["@sentry/nextjs"], define: { "process.env.NEXT_RUNTIME": '"edge"' }, metafile: true,
    });
    expect(Object.keys(result.metafile!.inputs).some(path => path.includes("release-build-node") || path.includes("telemetry-node"))).toBe(false);
    expect(result.outputFiles[0].text).not.toContain("node:fs");
  });
});
