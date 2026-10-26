import {createServer} from "node:http";
import {readFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";

it.runIf(process.env.PROPOSAL_WINDOW_BROWSER_QA === "1")("shows incomplete relation samples without implying empty global relationships", async () => {
  const {build} = await import("esbuild");
  const {chromium} = await import("playwright");
  const web = fileURLToPath(new URL("../../../../../", import.meta.url));
  const component = fileURLToPath(new URL("./ProposalRelationNotice.tsx", import.meta.url));
  const messages = JSON.parse(await readFile(new URL("../../../../../messages/en.json", import.meta.url), "utf8"));
  const label = messages.proposals.relationWindowLimited;
  const bundle = await build({stdin: {resolveDir: web, loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {ProposalRelationNotice} from ${JSON.stringify(component)};
    const mode=new URL(location.href).searchParams.get("mode");
    createRoot(document.getElementById("root")).render(<main className="card stack" style={{margin:24,padding:24,maxWidth:900}}>
      <h1>Synthetic proposal</h1><h2>Related items</h2>
      {mode!=="hidden"&&<a href="#related">Visible related action</a>}
      <ProposalRelationNotice window={{complete:mode==="complete"}} label={${JSON.stringify(label)}}/>
    </main>);
  `}, bundle: true, write: false, jsx: "automatic", define: {"process.env.NODE_ENV": '"production"'}});
  const css = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/pages.css"].map(path =>
    readFile(new URL(`../../../../../app/${path}`, import.meta.url), "utf8")))).join("\n");
  const server = createServer((request,response) => {
    if (request.url === "/fixture.js") {response.writeHead(200,{"Content-Type":"text/javascript"}).end(bundle.outputFiles[0].text);return;}
    response.writeHead(200,{"Content-Type":"text/html;charset=utf-8"}).end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin=`http://127.0.0.1:${address.port}`;
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.route("**/*",route => new URL(route.request().url()).origin===origin ? route.continue() : route.abort());
    await mkdir(".artifacts/source-998-finance-proposals",{recursive:true});
    for (const width of [1100,390]) {
      await page.setViewportSize({width,height:800});
      for (const mode of ["partial","hidden","complete"]) {
        await page.goto(`${origin}/?mode=${mode}`);
        await page.getByRole("heading",{name:"Synthetic proposal"}).waitFor();
        expect(await page.getByRole("status").count()).toBe(mode==="complete"?0:1);
        if (mode!=="complete") expect(await page.getByText(label,{exact:true}).isVisible()).toBe(true);
        expect(await page.getByRole("link").count()).toBe(mode==="hidden"?0:1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
        await page.screenshot({path:`.artifacts/source-998-finance-proposals/proposal-${mode}-${width}.png`,fullPage:true});
      }
    }
  } finally {await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},60_000);
