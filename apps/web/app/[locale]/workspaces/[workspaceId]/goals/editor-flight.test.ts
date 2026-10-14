import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// Opt-in actual React Flight encoding of the page with synthetic reads and
// stand-in client module/action IDs. These are fixture bytes, not production
// transport sizes. Client components remain boundaries (no static-SSR shortcut).
describe.runIf(process.env.GOAL_EDITOR_FLIGHT_QA === "1")("Goals Flight construction", () => {
  const output = new URL("../../../../../../../.artifacts/pun-93/", import.meta.url);
  const webRoot = new URL("../../../../../", import.meta.url);
  const runner = new URL("flight-runner.mjs", output);
  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    const { build } = await import("esbuild");
    await build({
      stdin: { resolveDir: fileURLToPath(webRoot), loader: "tsx", contents: `
        import { performance } from "node:perf_hooks";
        import { renderToReadableStream } from "next/dist/compiled/react-server-dom-webpack/server.node.js";
        import GoalsPage from "./app/[locale]/workspaces/[workspaceId]/goals/page";
        const count = Number(process.argv[2]);
        globalThis.goals = Array.from({ length: count }, (_, index) => ({
          id: "goal-" + index, title: "Synthetic Goal " + index, cadence: "QUARTERLY", level: "COMPANY",
          status: "DRAFT", version: 3, progressPercent: 0, keyResults: [], childGoals: [],
          authorUserId: "synthetic-author", isPrivate: true,
        }));
        const manifest = new Proxy({}, { get: (_, id) => ({ id, chunks: [], name: "*" }) });
        const samples = [];
        for (let sample = 0; sample < 4; sample++) {
          const errors = [];
          const start = performance.now();
          const element = await GoalsPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }), searchParams: Promise.resolve({}) });
          const stream = renderToReadableStream(element, manifest, { onError: error => { errors.push(String(error)); } });
          const buffer = Buffer.from(await new Response(stream).arrayBuffer());
          if (errors.length) throw new Error(errors.join("; "));
          const result = { count, ms: performance.now() - start, flightBytes: buffer.length,
            options: (buffer.toString().match(/"option"/g) ?? []).length };
          if (sample > 0) samples.push(result);
        }
        samples.sort((a, b) => a.ms - b.ms);
        console.log(JSON.stringify(samples[1]));
      ` },
      bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", logLevel: "error",
      outfile: fileURLToPath(runner), alias: { "@": fileURLToPath(webRoot) },
      plugins: [{ name: "synthetic-rsc-boundaries", setup(build) {
        build.onResolve({ filter: /^(@corgtex\/domain|next-intl(?:\/server)?|next\/link|@\/lib\/auth|@\/lib\/workspace-feature-flags|@\/lib\/components\/MarkdownRenderer)$/ }, args => ({ path: args.path, namespace: "fixture" }));
        build.onResolve({ filter: /^\.\/actions$/ }, args => args.importer.includes("/goals/") ? { path: "actions", namespace: "fixture" } : undefined);
        build.onLoad({ filter: /\.tsx$/ }, async args => {
          const source = await readFile(args.path.endsWith("/goals/page.tsx") && process.env.GOAL_EDITOR_BASELINE_SOURCE ? process.env.GOAL_EDITOR_BASELINE_SOURCE : args.path, "utf8");
          if (/^["']use client["'];/.test(source)) {
            const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(match => match[1]);
            return { contents: `import {registerClientReference} from "next/dist/compiled/react-server-dom-webpack/server.node.js";\n` + names.map(name =>
              `export const ${name} = registerClientReference(() => {}, ${JSON.stringify(args.path)}, ${JSON.stringify(name)});`).join("\n"), loader: "js", resolveDir: dirname(args.path) };
          }
          return { contents: source, loader: "tsx", resolveDir: dirname(args.path) };
        });
        build.onLoad({ filter: /.*/, namespace: "fixture" }, args => {
          const modules: Record<string, string> = {
            "@corgtex/domain": `export const listGoals = async () => globalThis.goals;
              export const getGoalTree = async () => globalThis.goals;
              export const listCircles = async () => [{ id: "circle-1", name: "Synthetic circle" }];
              export const listHumanMembers = async () => [{ id: "member-1", user: { displayName: "Synthetic owner", email: "owner@example.test" } }];
              export const requireWorkspaceMembership = async () => ({ id: "member-1", role: "MEMBER" });
              export const getGoal = async () => null; export const getWorkspaceArchiveRecord = async () => null;
              export const getMyGoalSlice = async () => []; export const listRecognitions = async () => [];`,
            "@/lib/auth": `export const requirePageActor = async () => ({ kind: "user", user: { id: "synthetic-author" } });`,
            "@/lib/workspace-feature-flags": "export const requireWorkspaceFeature = async () => {};",
            "@/lib/components/MarkdownRenderer": "export const MarkdownRenderer = () => null;",
            "next/link": `import {registerClientReference} from "next/dist/compiled/react-server-dom-webpack/server.node.js"; export default registerClientReference(() => {}, "next/link", "default");`,
            "next-intl": "export const useTranslations = () => key => key;",
            "next-intl/server": "export const getTranslations = async () => key => key;",
            actions: `import {registerServerReference} from "next/dist/compiled/react-server-dom-webpack/server.node.js";\n` +
              ["addKeyResultFormAction", "updateKeyResultFormAction", "deleteKeyResultFormAction", "archiveGoalFormAction", "createGoalFormAction", "editGoalFormAction", "returnGoalToDraftFormAction", "updateGoalFormAction"].map(name =>
                `export const ${name} = registerServerReference(async () => {}, "synthetic-actions", "${name}");`).join("\n"),
          };
          return { contents: modules[args.path], resolveDir: fileURLToPath(webRoot) };
        });
      } }],
    });
  });

  for (const count of [100, 500, 1000]) {
    it(`encodes at most one initial choice set for ${count} editable Goals`, async () => {
      const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", fileURLToPath(runner), String(count)], {
        env: { ...process.env, NODE_ENV: "production" }, maxBuffer: 1024 * 1024, timeout: 180_000,
      });
      const measurement = JSON.parse(stdout.trim());
      await writeFile(new URL(`flight-${process.env.GOAL_EDITOR_BENCHMARK_LABEL ?? "after"}-${count}.json`, output), JSON.stringify(measurement, null, 2));
      expect(measurement.options).toBeLessThanOrEqual(count + 100);
    }, 180_000);
  }
});
