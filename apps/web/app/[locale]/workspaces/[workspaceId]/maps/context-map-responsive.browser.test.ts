import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real component and application CSS, synthetic graph, loopback requests only.
describe.runIf(process.env.MAP_BROWSER_QA === "1")("responsive Context Map", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  const errors: string[] = [];
  const mutations: string[] = [];
  const output = new URL("../../../../../../../.artifacts/pun-100/", import.meta.url);
  const prefix = process.env.MAP_QA_ARTIFACT_PREFIX ?? "after";
  const titles = ["Research intake", "Review evidence", "Validate requirements", "Plan delivery", "Assign owners", "Track dependencies", "Resolve blockers", "Approve the proposed delivery plan with all owners", "Publish findings", "Review outcomes"];

  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const webRoot = new URL("../../../../", import.meta.url);
    const component = fileURLToPath(new URL("./ContextMapClient.tsx", import.meta.url));
    const mapView = { id: "synthetic-map", name: "Synthetic process map", viewType: "process", createdByUserId: null, query: {} };
    const objects = titles.map((title, index) => ({
      id: `node-${index}`, title, objectType: "ProcessStep", summary: "Synthetic process evidence", properties: {}, confidence: 0.9,
      status: "approved", createdByType: "USER", createdByUserId: null, createdByAgentRunId: null,
      sourceEntityType: null, sourceEntityId: null, validFrom: null, validTo: null, lastVerifiedAt: null, evidenceRefs: [],
    }));
    const relationships = objects.slice(1).map((object, index) => ({
      ...objects[index], id: `edge-${index}`, sourceObjectId: objects[index].id, targetObjectId: object.id, relationshipType: "supports",
    }));
    const data = {
      mapView, mapViews: [mapView], objects, relationships,
      layoutItems: objects.map((object, index) => ({ objectId: object.id, x: (index % 4) * 340, y: Math.floor(index / 4) * 240 })),
      proposedDiffs: [], guidance: { evidenceBacked: true, defaultMapKey: null, description: "Synthetic map", missingEvidencePrompt: "", emptyTitle: "No facts", emptyDescription: "No matching cards." },
      permissions: { canSavePersonalView: true, canUpdateMasterView: true, canRequestMasterUpdate: true },
    };
    const bundle = await build({
      stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client"; import ${JSON.stringify(fileURLToPath(new URL("globals.css", webRoot)))}; import Map from ${JSON.stringify(component)}; createRoot(document.getElementById("root")).render(<main className="context-map-page"><Map workspaceId="synthetic" data={${JSON.stringify(data)}} readOnly={!location.search.includes("member=1")} /></main>);`, resolveDir: process.cwd(), loader: "tsx" },
      alias: { "@": fileURLToPath(new URL("../", webRoot)) },
      bundle: true, write: false, outdir: "fixture", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "fixture-styles", setup(buildApi) {
        buildApi.onLoad({ filter: /globals\.css$/ }, async args => ({
          contents: (await readFile(args.path, "utf8")).replace(/@tailwind[^;]+;/g, ""), loader: "css", resolveDir: fileURLToPath(webRoot),
        }));
      } }, { name: "stub-server-actions", setup(buildApi) {
        buildApi.onResolve({ filter: /^\.\/actions$/ }, args => args.importer === component ? { path: "actions", namespace: "fixture" } : undefined);
        buildApi.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `const action = async () => { await fetch(location.pathname, {method:"POST"}); return {mode:"updated", id:"personal", name:"Personal"}; }; export {action as applyContextGraphProposedDiffAction, action as createContextMapManualEditProposalAction, action as createPersonalContextMapViewAction, action as reviewContextGraphProposedDiffAction, action as saveContextMapLayoutAction, action as updateContextGraphProposedDiffAction};` }));
      } }],
    });
    const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
    const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text;
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET") mutations.push(request.method ?? "");
      if (url.pathname.endsWith("/context")) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ objects, relationships, evidenceRefs: [], rankedFacts: [], sourceRecords: [], likelyNextActions: [], contextGaps: [] }));
      } else if (url.pathname === "/fixture.js") {
        response.setHeader("Content-Type", "text/javascript"); response.end(js);
      } else {
        response.setHeader("Content-Type", "text/html");
        response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}:root{--font-inter:system-ui}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined), headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
  });

  async function open(width: number, height = 844, member = false) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 920 });
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(origin + `/en/workspaces/synthetic/maps${member ? "?member=1" : ""}`);
    await page.locator(".context-map-node-card").first().waitFor();
    // Existing scheduled initial fits finish at 740ms; also allow ResizeObserver delivery.
    await page.waitForTimeout(1000);
    return page;
  }

  async function evidence(page: Page, name: string) {
    const metrics = await page.evaluate(() => {
      const canvas = document.querySelector(".context-map-canvas")!.getBoundingClientRect();
      const inspector = document.querySelector(".context-map-inspector")!.getBoundingClientRect();
      const viewport = document.querySelector(".react-flow__viewport")!;
      const scale = new DOMMatrix(getComputedStyle(viewport).transform).a;
      const overlaps = (a: DOMRect, b: DOMRect) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
      return {
        scale,
        titlePx: parseFloat(getComputedStyle(document.querySelector(".context-map-node-card strong")!).fontSize) * scale,
        metadataPx: parseFloat(getComputedStyle(document.querySelector(".context-map-node-topline")!).fontSize) * scale,
        canvas: canvas.toJSON(), inspector: inspector.toJSON(),
        canvasOverlapsInspector: overlaps(canvas, inspector),
        coveredNodes: overlaps(canvas, inspector) ? [...document.querySelectorAll(".react-flow__node")].filter(node => overlaps(node.getBoundingClientRect(), canvas) && overlaps(node.getBoundingClientRect(), inspector)).length : 0,
        overflowsPage: document.documentElement.scrollWidth > innerWidth,
      };
    });
    await page.screenshot({ path: fileURLToPath(new URL(`${prefix}-${name}.png`, output)), fullPage: true });
    await writeFile(new URL(`${prefix}-${name}.json`, output), JSON.stringify(metrics, null, 2));
    return metrics;
  }

  for (const width of [320, 390, 768, 920]) {
    it(`starts readable and navigates every card without Inspector overlap at ${width}px`, async () => {
      const page = await open(width);
      try {
        const metrics = await evidence(page, `initial-${width}`);
        expect(metrics.overflowsPage).toBe(false);
        expect(metrics.canvasOverlapsInspector).toBe(false);
        expect(metrics.titlePx).toBeGreaterThanOrEqual(14);
        expect(metrics.metadataPx).toBeGreaterThanOrEqual(12);
        const selector = page.getByRole("combobox", { name: "Map card" });
        for (let index = 0; index < titles.length; index++) {
          await selector.selectOption(`node-${index}`);
          const card = page.locator(`.react-flow__node[data-id="node-${index}"]`);
          await expect.poll(async () => {
            const cardBox = await card.boundingBox();
            const canvasBox = await page.locator(".context-map-canvas").boundingBox();
            return cardBox && canvasBox ? cardBox.x >= canvasBox.x && cardBox.x + cardBox.width <= canvasBox.x + canvasBox.width && cardBox.y >= canvasBox.y && cardBox.y + cardBox.height <= canvasBox.y + canvasBox.height : false;
          }, { timeout: 3000, message: `Card ${index} at ${width}px must fit the canvas` }).toBe(true);
        }
        await page.getByRole("button", { name: "Show Inspector", exact: true }).click();
        expect(await page.locator(".context-map-selection-title").first().textContent()).toBe(titles[9]);
        expect((await evidence(page, `inspector-${width}`)).canvasOverlapsInspector).toBe(false);
        await page.getByRole("button", { name: "Hide Inspector", exact: true }).click();
        await page.getByRole("button", { name: "Overview", exact: true }).click();
        // Explicit overview must survive every delayed automatic fit (last one ends at 740ms).
        await page.waitForTimeout(800);
        await expect.poll(async () => (await page.locator(".react-flow__viewport").evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)) < 0.8).toBe(true);
        await page.getByRole("button", { name: "Focus", exact: true }).click();
        await expect.poll(async () => page.locator(".react-flow__viewport").evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBe(1);
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        await page.waitForTimeout(1000);
        expect((await evidence(page, `reset-${width}`)).titlePx).toBeGreaterThanOrEqual(14);
      } catch (error) { await evidence(page, `failure-${width}`); throw error; }
      finally { await page.context().close(); }
    });
  }

  it("keeps a usable canvas and collapsible Inspector in mobile fullscreen and landscape", async () => {
    const page = await open(390);
    try {
      await page.getByRole("button", { name: "Full screen", exact: true }).click();
      await page.getByRole("button", { name: "Show Inspector", exact: true }).click();
      await page.waitForTimeout(1000);
      const metrics = await evidence(page, "fullscreen-390");
      expect(metrics.canvasOverlapsInspector).toBe(false);
      expect(metrics.canvas.height).toBeGreaterThan(180);
      expect(metrics.inspector.bottom).toBeLessThanOrEqual(844);
      await page.getByRole("button", { name: "Hide Inspector", exact: true }).click();
      await page.setViewportSize({ width: 844, height: 390 });
      await page.getByRole("button", { name: "Show Inspector", exact: true }).click();
      const landscape = await evidence(page, "fullscreen-landscape");
      expect(landscape.canvasOverlapsInspector).toBe(false);
      expect(landscape.canvas.height).toBeGreaterThanOrEqual(160);
      await page.getByRole("button", { name: "Hide Inspector", exact: true }).click();
      await page.keyboard.press("Escape");
      expect(await page.locator(".context-map-shell--fullscreen").count()).toBe(0);
    } finally { await page.context().close(); }
  });

  it("preserves desktop docking, connection selection, filters, and compact resize", async () => {
    const page = await open(1440, 1000, true);
    try {
      const metrics = await evidence(page, "desktop-1440");
      expect(metrics.canvasOverlapsInspector).toBe(false);
      expect(await page.getByRole("button", { name: "Resize inspector" }).count()).toBe(1);
      await page.locator(".context-map-flow-edge-label").first().click();
      expect(await page.getByRole("heading", { name: "What this connection means" }).count()).toBe(1);
      await page.getByRole("button", { name: "Bottom", exact: true }).click();
      expect(await page.locator(".context-map-inspector--bottom").count()).toBe(1);
      await page.getByRole("button", { name: "Right", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(1000);
      expect((await evidence(page, "desktop-to-mobile")).canvasOverlapsInspector).toBe(false);
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      expect(await page.getByRole("checkbox", { name: "Load stale facts" }).count()).toBe(1);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForTimeout(1000);
      expect(await page.locator(".context-map-inspector--right").count()).toBe(1);
      expect(await page.getByRole("button", { name: "Resize inspector" }).count()).toBe(1);
    } finally { await page.context().close(); }
  });
});
