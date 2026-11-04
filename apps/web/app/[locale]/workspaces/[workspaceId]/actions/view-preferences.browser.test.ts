import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Production preference boundary, synthetic content and Next navigation transport.
// ACTIONS_VIEW_BROWSER_QA=1 npm run test:unit -- view-preferences.browser.test.ts
// No credentials, customer data or database required.
describe.runIf(process.env.ACTIONS_VIEW_BROWSER_QA === "1")("Actions preference browser lifecycle", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  const list = "/en/workspaces/ws-1/actions";
  const board = "?view=kanban&status=ALL&scope=workspace&columns=OPEN%2CIN_PROGRESS";
  beforeAll(async () => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const bundle = await build({
      stdin: { resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "tsx", contents: `
        import React from "react";
        import {createRoot} from "react-dom/client";
        import {usePathname, useSearchParams} from "next/navigation";
        import {ActionsViewPreferences} from "./ActionsViewPreferences";
        import {readActionListReturnHref} from "./return-context";
        import {actionsViewStorageKey} from "./view-preferences";
        import {WorkItemKanbanBoard} from "@/lib/components/WorkItemKanbanBoard";
        function Fixture() {
          const pathname = usePathname(); const query = useSearchParams();
          const segments = pathname.split("/");
          const workspaceId = segments[segments.indexOf("workspaces") + 1];
          const path = "/workspaces/" + workspaceId + "/actions";
          const href = readActionListReturnHref(workspaceId, path + location.search) || path + "?status=OPEN";
          return <><nav><a href={"/en/workspaces/" + workspaceId + "/actions"}>Actions sidebar</a></nav>
            {pathname.endsWith("/actions") ? <ActionsViewPreferences userId={sessionStorage.getItem("user") || "u1"} workspaceId={workspaceId} href={href}>
              <h1>Actions</h1><p id="view">{query.get("view") || "list"}</p>
              <p id="columns">{query.get("columns") || "DRAFT,OPEN,IN_PROGRESS,COMPLETED"}</p>
              <a href={"?view=kanban&status=ALL&scope=workspace&columns=OPEN%2CIN_PROGRESS"}>Board, hide completed</a>
              <a href="?view=table&sort=due_asc&status=COMPLETED">Table, due soonest</a>
              <a href="?view=list&status=OPEN">Reset view</a>
              {query.get("view") === "kanban" && <WorkItemKanbanBoard
                columns={["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"].map(id=>({id,label:id,count:2,items:["Zulu", "Alpha"].map((title,index)=>({id:id+title,status:id,sort:{priority:2-index,date:null,alpha:title},node:<p>{title}</p>}))}))}
                storageKey={actionsViewStorageKey(sessionStorage.getItem("user") || "u1", workspaceId)+":board"}
                visibleColumnIds={query.get("columns")?.split(",")}
                hideColumnHrefs={{OPEN:"?view=kanban&columns=IN_PROGRESS", IN_PROGRESS:"?view=kanban&columns=OPEN"}}
                settingsLabel="Column settings" resetLabel="Reset columns" hideLabel="Hide column" moveUpLabel="Move left" moveDownLabel="Move right"
                hideShortLabel="Hide" moveUpShortLabel="Left" moveDownShortLabel="Right" sortLabel="Sort" sortPriorityLabel="Priority" sortDateLabel="Date" sortAlphaLabel="Alphabetical" dragUnavailableLabel="Unavailable" />}
              <a href={path + "/a1?returnTo=" + encodeURIComponent(href)}>Open action</a>
            </ActionsViewPreferences> : <><h1>Action detail</h1><a href={query.get("returnTo") || path}>Back to Actions</a></>}
          </>;
        }
        createRoot(document.getElementById("root")).render(<Fixture/>);
      ` },
      plugins: [{ name: "navigation", setup(api) {
        api.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "nav", namespace: "fixture" }));
        api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ resolveDir: fileURLToPath(new URL(".", import.meta.url)), contents: `
          import {useSyncExternalStore} from "react";
          const listeners = new Set();
          const changed = () => listeners.forEach(fn=>fn());
          addEventListener("popstate", changed);
          const subscribe = fn => {listeners.add(fn); return ()=>listeners.delete(fn);};
          const router = {replace(path) {if(window.holdNavigation) return; history.replaceState({}, "", path); changed();}};
          export const useRouter = () => router;
          export const usePathname = () => useSyncExternalStore(subscribe, ()=>location.pathname);
          export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, ()=>location.search));
        ` }));
      } }],
      alias: { "@": fileURLToPath(new URL("../../../../../", import.meta.url)) },
      bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    });
    const js = bundle.outputFiles[0].text;
    const webRoot = new URL("../../../../../", import.meta.url);
    const css = (await Promise.all(["app/styles/tokens.css", "app/globals.css", "app/styles/components.css"].map(path=>readFile(new URL(path,webRoot),"utf8")))).join("\n");
    server = createServer((req, res) => {
      res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html");
      res.end(req.url === "/fixture.js" ? js : '<!doctype html><title>Actions preference QA</title><style>' + css + 'body{font:18px system-ui;margin:40px}a{display:block;margin:16px}#columns{padding:24px;background:#eee}</style><div id="root"></div><script src="/fixture.js"></script>');
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing fixture port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server ? server.close(()=>resolve()) : resolve()); });
  const visit = (path: string) => page.goto(origin + path);
  const expectBoard = async () => {
    await page.locator("#view").filter({hasText: "kanban"}).waitFor({state:"visible"});
    expect(await page.locator("#columns").innerText()).toBe("OPEN,IN_PROGRESS");
    expect(await page.locator(".nr-kanban-column").count()).toBe(2);
    expect(await page.locator(".nr-kanban-heading-label").allTextContents()).toEqual(expect.arrayContaining(["OPEN2", "IN_PROGRESS2"]));
  };
  it("restores sidebar/detail/reload and honors browser history and explicit reset", async () => {
    await visit(list); await page.getByRole("link", {name:"Board, hide completed"}).click(); await expectBoard();
    await page.getByLabel("Column settings: OPEN", {exact:true}).click();
    await page.getByRole("button", {name:"Alphabetical", exact:true}).click();
    await page.getByRole("button", {name:"Move right", exact:true}).click();
    await page.getByRole("link", {name:"Open action", exact:true}).click();
    await page.getByRole("link", {name:"Back to Actions", exact:true}).click(); await expectBoard();
    await page.getByRole("link", {name:"Open action", exact:true}).click();
    await page.getByRole("link", {name:"Actions sidebar"}).click(); await expectBoard();
    await page.reload(); await expectBoard();
    expect(await page.locator(".nr-kanban-heading-label").allTextContents()).toEqual(["IN_PROGRESS2", "OPEN2"]);
    expect(await page.locator(".nr-kanban-column").nth(1).locator(".nr-kanban-draggable").allTextContents()).toEqual(["Alpha", "Zulu"]);
    await page.getByRole("link", {name:"Table, due soonest"}).click();
    await page.locator("#view").filter({hasText:"table"}).waitFor({state:"visible"});
    await page.goBack(); await expectBoard();
    await page.goForward(); await page.locator("#view").filter({hasText:"table"}).waitFor({state:"visible"});
    await page.getByRole("link", {name:"Actions sidebar"}).click();
    await page.locator("#view").filter({hasText:"table"}).waitFor({state:"visible"});
    expect(page.url()).toContain("sort=due_asc");
    await page.getByRole("link", {name:"Reset view"}).click();
    await page.getByRole("link", {name:"Actions sidebar"}).click();
    await page.locator("#view").filter({hasText:"list"}).waitFor({state:"visible"});
  });
  it("isolates users/workspaces and tolerates unavailable or corrupt storage", async () => {
    await visit(list + board); await expectBoard();
    await visit("/en/workspaces/ws-2/actions");
    await page.locator("#view").filter({hasText:"list"}).waitFor({state:"visible"});
    await page.evaluate(()=>sessionStorage.setItem("user", "u2"));
    await visit(list); await page.locator("#view").filter({hasText:"list"}).waitFor({state:"visible"});
    await visit(list + board); await expectBoard();
    expect(await page.locator(".nr-kanban-heading-label").allTextContents()).toEqual(["OPEN2", "IN_PROGRESS2"]);
    expect(await page.locator(".nr-kanban-column").first().locator(".nr-kanban-draggable").allTextContents()).toEqual(["Zulu", "Alpha"]);
    await page.evaluate(()=>sessionStorage.setItem("user", "u1"));
    await visit(list); await expectBoard();
    await page.evaluate(()=>{for (const key of Object.keys(localStorage)) localStorage.setItem(key, "invalid");});
    await visit(list); await page.locator("#view").filter({hasText:"list"}).waitFor({state:"visible"});
    await page.addInitScript(()=>Object.defineProperty(window, "localStorage", {get() {throw Error("disabled");}}));
    await visit(list + "?view=list&status=OPEN"); await page.locator("#view").filter({hasText:"list"}).waitFor({state:"visible"});
    expect(errors).toEqual([]);
  });
  it("does not overwrite a saved view during interrupted or repeated restoration", async () => {
    // Use a fresh page because the previous case intentionally disabled storage.
    await page.close(); page = await browser.newPage();
    await visit(list + board); await expectBoard();
    await page.addInitScript(()=>{(window as Window & {holdNavigation?:boolean}).holdNavigation = true;});
    await visit(list);
    await page.waitForTimeout(100);
    const stored = await page.evaluate(()=>Object.values(localStorage).find(value=>value.includes("kanban")));
    expect(stored).toContain("columns=OPEN%2CIN_PROGRESS");
    await page.close(); page = await browser.newPage();
    await visit(list + board); await expectBoard();
    for (let i=0; i<3; i++) { await visit(list); await expectBoard(); }
    await mkdir(".artifacts/pun-102", {recursive:true});
    await page.screenshot({path:`.artifacts/pun-102/restored-board-${Date.now()}.png`});
  });
});
