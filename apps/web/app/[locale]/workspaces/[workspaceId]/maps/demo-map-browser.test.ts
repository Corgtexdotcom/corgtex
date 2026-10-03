import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Opt-in real browser regression: actual client component, synthetic authorized graph.
it.runIf(process.env.MAP_BROWSER_QA === "1")("navigates, refreshes and reloads a read-only graph without action requests", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const output = new URL("../../../../../../../.artifacts/pun-55/", import.meta.url);
  await mkdir(output, { recursive: true });
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
    stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client"; import Map from ${JSON.stringify(component)}; createRoot(document.getElementById("root")).render(<Map workspaceId="demo" data={${JSON.stringify(data)}} readOnly={!new URLSearchParams(location.search).has("member")} />);`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, outdir: "fixture", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "stub-server-actions", setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\/actions$/ }, (args) => args.importer === component ? { path: "actions", namespace: "fixture" } : undefined);
      buildApi.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `const action = async () => { await fetch(location.pathname, {method:"POST"}); return {mode:"updated", id:"personal", name:"Personal"}; }; export {action as applyContextGraphProposedDiffAction, action as createContextMapManualEditProposalAction, action as createPersonalContextMapViewAction, action as reviewContextGraphProposedDiffAction, action as saveContextMapLayoutAction, action as updateContextGraphProposedDiffAction};` }));
    } }],
  });
  const js = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  const globalStyles = await readFile(new URL("../../../../globals.css", import.meta.url), "utf8");
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
    response.end(`<html><head><style>${globalStyles.replace(/@import[^;]+;/g, "")}${css}body{margin:0}.context-map-canvas{height:650px}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const origin = "http://127.0.0.1:" + address.port;
  const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    for (let run = 0; run < 3; run++) {
      await page.goto(origin + "/en/workspaces/demo/maps");
      await page.waitForResponse((response) => response.url().includes("/context?"));
      await page.locator('.react-flow__node[data-id="node-b"]').click();
      await page.waitForResponse((response) => response.url().includes("object=node-b"));
      await page.getByRole("button", { name: "Context", exact: true }).click();
      await page.waitForResponse((response) => response.url().includes("/context?"));
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      expect(await page.getByRole("button", { name: /Save copy|Update master|Add/ }).count()).toBe(0);
      await page.locator('.react-flow__node[data-id="node-a"]').click({ button: "right" });
      expect(await page.getByRole("button", { name: /Archive card|Add next card/ }).count()).toBe(0);
    }
    await page.screenshot({ path: fileURLToPath(new URL("demo-map.png", output)), fullPage: true });
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(errors).toEqual([]);
    // Recoverable read failure stays in the inspector and can be retried.
    failNext = true;
    await page.getByRole("button", { name: "Context", exact: true }).click();
    await page.waitForResponse((response) => response.status() === 403);
    await page.getByRole("button", { name: "Context", exact: true }).click();
    await page.waitForResponse((response) => response.url().includes("/context?") && response.ok());
    await page.goto(origin + "/en/workspaces/demo/maps?member=1");
    await page.getByRole("button", { name: "Update master", exact: true }).click();
    await page.waitForResponse((response) => response.request().method() === "POST");
    expect(await page.getByRole("button", { name: "Save copy", exact: true }).count()).toBe(1);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60_000);
