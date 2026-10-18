import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Opt-in real browser regression: actual client component, synthetic authorized graph.
it.runIf(process.env.MAP_BROWSER_QA === "1")("navigates, refreshes and reloads a read-only graph without action requests", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const output = new URL("../../../../../../../.artifacts/source-e42b-main-map-integration/browser/", import.meta.url);
  await mkdir(output, { recursive: true });
  const webRoot = new URL("../../../../", import.meta.url);
  const component = fileURLToPath(new URL("./ContextMapClient.tsx", import.meta.url));
  const baseObject = {
    objectType: "ProcessStep", summary: "Synthetic process evidence", properties: {}, confidence: 0.9,
    status: "approved", createdByType: "USER", createdByUserId: null, createdByAgentRunId: null,
    sourceEntityType: null, sourceEntityId: null, validFrom: null, validTo: null,
    lastVerifiedAt: null, evidenceRefs: [],
  };
  const mapView = { id: "map-1", name: "Synthetic process map", viewType: "process", createdByUserId: null, query: {} };
  const data = {
    mapView, mapViews: [mapView, { ...mapView, id: "map-2", name: "Second map" }],
    objects: [{ ...baseObject, id: "node-a", title: "Research intake" }, { ...baseObject, id: "node-b", title: "Review evidence" }],
    relationships: [], layoutItems: [], proposedDiffs: [],
    guidance: { evidenceBacked: true, defaultMapKey: null, description: "Synthetic map", missingEvidencePrompt: "", emptyTitle: "No facts", emptyDescription: "" },
    permissions: { canSavePersonalView: true, canUpdateMasterView: true, canRequestMasterUpdate: true },
  };
  const bundle = await build({
    stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client"; import ${JSON.stringify(fileURLToPath(new URL("globals.css", webRoot)))}; import Map from ${JSON.stringify(component)}; const params = new URLSearchParams(location.search); const data = ${JSON.stringify(data)}; if(params.has("partial")) data.readWindow={scope:"WINDOW",complete:false,objectsComplete:false,relationshipsComplete:true,evidenceComplete:true,proposedDiffsComplete:true,variantsComplete:true}; if(params.has("empty")) data.objects=[]; createRoot(document.getElementById("root")).render(<Map workspaceId="demo" data={data} readOnly={!params.has("member")} />);`, resolveDir: process.cwd(), loader: "tsx" },
    alias: { "@": fileURLToPath(new URL("../", webRoot)) },
    bundle: true, write: false, outdir: "fixture", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "fixture-styles", setup(buildApi) {
      buildApi.onLoad({ filter: /globals\.css$/ }, async args => ({
        contents: (await readFile(args.path, "utf8")).replace(/@tailwind[^;]+;/g, ""), loader: "css", resolveDir: fileURLToPath(webRoot),
      }));
    } }, { name: "stub-server-actions", setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\/actions$/ }, (args) => args.importer === component ? { path: "actions", namespace: "fixture" } : undefined);
      buildApi.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `const action = async () => { await fetch(location.pathname, {method:"POST"}); return {mode:"updated", id:"personal", name:"Personal"}; }; export {action as applyContextGraphProposedDiffAction, action as createContextMapManualEditProposalAction, action as createPersonalContextMapViewAction, action as reviewContextGraphProposedDiffAction, action as saveContextMapLayoutAction, action as updateContextGraphProposedDiffAction};` }));
    } }],
  });
  const js = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  const requests: Array<{ method: string; path: string }> = [];
  let failNext = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({ method: request.method ?? "", path: url.pathname + url.search });
    if (url.pathname.endsWith("/context")) {
      if (failNext) { failNext = false; response.writeHead(403).end(); return; }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ objects: data.objects, relationships: [], evidenceRefs: [], rankedFacts: [], sourceRecords: [], likelyNextActions: [], contextGaps: [] })); return;
    }
    if (request.method === "POST") { response.setHeader("Content-Type", "application/json"); response.end("{}"); return; }
    if (url.pathname === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(js); return; }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}:root{--font-inter:system-ui}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const origin = "http://127.0.0.1:" + address.port;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    for (let run = 0; run < 3; run++) {
      await Promise.all([
        page.waitForResponse((response) => response.url().includes("/context?")),
        page.goto(origin + "/en/workspaces/demo/maps"),
      ]);
      await Promise.all([
        page.waitForResponse((response) => response.url().includes("object=node-b")),
        page.locator('.react-flow__node[data-id="node-b"]').click(),
      ]);
      await Promise.all([
        page.waitForResponse((response) => response.url().includes("/context?")),
        page.getByRole("button", { name: "Context", exact: true }).click(),
      ]);
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      expect(await page.getByRole("button", { name: /Save copy|Update master|Add/ }).count()).toBe(0);
      await page.locator('.react-flow__node[data-id="node-a"]').click({ button: "right" });
      expect(await page.getByRole("button", { name: /Archive card|Add next card/ }).count()).toBe(0);
    }
    await page.screenshot({ path: fileURLToPath(new URL("demo-map.png", output)), fullPage: true });
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(errors).toEqual([]);
    await page.goto(origin + "/en/workspaces/demo/maps?partial=1");
    await expect.poll(() => page.getByRole("status").textContent()).toContain("Showing a limited window");
    expect(await page.locator('.react-flow__node').count()).toBe(2);
    await page.screenshot({ path: fileURLToPath(new URL("partial-populated.png", output)), fullPage: true });
    await page.goto(origin + "/en/workspaces/demo/maps?partial=1&empty=1");
    await expect.poll(() => page.getByRole("heading", { name: "No visible facts in this window" }).count()).toBe(1);
    expect(await page.getByText("This limited window does not establish that the map is empty.").count()).toBe(1);
    expect(await page.locator('.react-flow__node').count()).toBe(0);
    await page.screenshot({ path: fileURLToPath(new URL("partial-empty.png", output)), fullPage: true });
    expect(errors).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + "/en/workspaces/demo/maps?partial=1");
    await page.getByRole("combobox", { name: "Map card" }).selectOption("node-b");
    await page.getByRole("button", { name: "Show Inspector", exact: true }).click();
    expect(await page.locator(".context-map-selection-title").first().textContent()).toBe("Review evidence");
    expect(await page.getByRole("status").textContent()).toContain("Showing a limited window");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const boxes = await page.evaluate(() => {
      const canvas = document.querySelector(".context-map-canvas")!.getBoundingClientRect();
      const inspector = document.querySelector(".context-map-inspector")!.getBoundingClientRect();
      return { canvasBottom: canvas.bottom, inspectorTop: inspector.top };
    });
    expect(boxes.canvasBottom).toBeLessThanOrEqual(boxes.inspectorTop);
    await page.screenshot({ path: fileURLToPath(new URL("partial-mobile-populated.png", output)), fullPage: true });
    await page.getByRole("button", { name: "Hide Inspector", exact: true }).click();
    await page.goto(origin + "/en/workspaces/demo/maps?partial=1&empty=1");
    await page.getByRole("heading", { name: "No visible facts in this window" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: fileURLToPath(new URL("partial-mobile-empty.png", output)), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/context?")),
      page.goto(origin + "/en/workspaces/demo/maps"),
    ]);
    // Recoverable read failure stays in the inspector and can be retried.
    failNext = true;
    await Promise.all([
      page.waitForResponse((response) => response.status() === 403),
      page.getByRole("button", { name: "Context", exact: true }).click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/context?") && response.ok()),
      page.getByRole("button", { name: "Context", exact: true }).click(),
    ]);
    await page.goto(origin + "/en/workspaces/demo/maps?member=1");
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === "POST"),
      page.getByRole("button", { name: "Update master", exact: true }).click(),
    ]);
    expect(await page.getByRole("button", { name: "Save copy", exact: true }).count()).toBe(1);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60_000);
