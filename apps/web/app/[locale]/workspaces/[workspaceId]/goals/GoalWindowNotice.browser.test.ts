import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.runIf(process.env.GOAL_WINDOW_BROWSER_QA === "1")("qualifies empty and populated goal windows with reachable continuation and parent choices", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const component = fileURLToPath(new URL("./GoalWindowNotice.tsx", import.meta.url));
  const web = new URL("../../../../../", import.meta.url);
  const labels = JSON.parse(await readFile(new URL("messages/en.json", web), "utf8")).goals;
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(web), loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {GoalWindowNotice} from ${JSON.stringify(component)};
    const url = new URL(location.href); const continued = url.searchParams.has("goalCursor");
    const next = new URL(url); next.searchParams.set("goalCursor","synthetic-opaque");
    const first = new URL(url); first.searchParams.delete("goalCursor");
    const add = url.pathname.endsWith("/add");
    const my = url.searchParams.get("view")==="slice";
    const myContinued=url.searchParams.has("myCursor"), recContinued=url.searchParams.has("recognitionCursor");
    const sectionHref=key=>{const next=new URL(url);next.searchParams.set(key,"synthetic-section");return next.pathname+next.search;};
    createRoot(document.getElementById("root")).render(<section className="stack">
      <h1>{add?"Add goal":"Goals"}</h1>
      {my?<><h2>My active goals</h2><GoalWindowNotice complete={myContinued} nextHref={myContinued?null:sectionHref("myCursor")}
        labels={${JSON.stringify({limited:labels.myWindowLimited,next:labels.windowNext,start:labels.windowStart})}}/>
        <p>{myContinued?"Permitted owned goal":${JSON.stringify(labels.windowEmpty)}}</p>
        <h2>Recent recognitions</h2><GoalWindowNotice complete={recContinued} nextHref={recContinued?null:sectionHref("recognitionCursor")}
        labels={${JSON.stringify({limited:labels.recognitionWindowLimited,next:labels.recognitionWindowNext,start:labels.recognitionWindowStart})}}/>
        <p>{recContinued?"Permitted recognition":${JSON.stringify(labels.recognitionWindowEmpty)}}</p></>:<>
      <GoalWindowNotice complete={continued} nextHref={continued?null:next.pathname+next.search}
        startHref={continued?first.pathname+first.search:undefined}
        labels={${JSON.stringify({limited:labels.windowLimited,next:labels.windowNext,start:labels.windowStart})}}/>
      {add?<label>Parent goal<select><option>None</option>{continued&&<option>Permitted parent</option>}</select></label>
        :continued?<article className="nr-item"><h2>Permitted goal</h2><p>Parent outside this window</p></article>:<p>${labels.windowEmpty}</p>}</>}
    </section>);
  ` }, bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const rawCss=(await Promise.all(["globals.css","styles/tokens.css","styles/components.css","styles/pages.css"].map(path=>readFile(new URL(`app/${path}`,web),"utf8")))).join("\n");
  const {default:postcss}=await import("postcss");
  const {default:tailwind}=await import("tailwindcss");
  const {default:config}=await import("../../../../../tailwind.config");
  const css=(await postcss([tailwind({...config,content:[component]})]).process(rawCss.replace(/@import[^;]+;/g,""),{from:undefined})).css;
  const server=createServer((request,response)=>{
    if(request.url==="/fixture.js"){response.writeHead(200,{"Content-Type":"text/javascript"}).end(bundle.outputFiles[0].text);return;}
    response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}).end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--font-inter:system-ui;--font-playfair:Georgia}${css}</style></head><body><main style="max-width:900px;margin:24px auto;padding:20px"><div id="root"></div></main><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("Missing fixture port");
  const origin=`http://127.0.0.1:${address.port}`;
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1080,height:780}});
    await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await mkdir(".artifacts/source-4bd488-goals",{recursive:true});
    for(const [name,path] of [["goals","/workspaces/synthetic/goals?view=tree&cadence=WEEKLY"],["selector","/workspaces/synthetic/add?kind=goal&returnTo=%2Fworkspaces%2Fsynthetic%2Fgoals"]]){
      await page.goto(origin+path);
      await page.getByRole("status").waitFor();
      expect(await page.getByRole("status").textContent()).toContain("Other goals may be outside");
      if(name==="goals")expect(await page.getByText(labels.windowEmpty,{exact:true}).isVisible()).toBe(true);
      await page.screenshot({path:`.artifacts/source-4bd488-goals/${name}-partial.png`,fullPage:true});
      await page.getByRole("link",{name:labels.windowNext,exact:true}).click();
      await page.getByRole("link",{name:labels.windowStart,exact:true}).waitFor();
      expect(new URL(page.url()).searchParams.get("goalCursor")).toBe("synthetic-opaque");
      if(name==="goals"){
        expect(new URL(page.url()).searchParams.get("cadence")).toBe("WEEKLY");
        await page.getByText("Permitted goal",{exact:true}).waitFor();
      }else{
        expect(new URL(page.url()).searchParams.get("kind")).toBe("goal");
        expect(await page.locator("option").allTextContents()).toEqual(["None","Permitted parent"]);
      }
      await page.screenshot({path:`.artifacts/source-4bd488-goals/${name}-continued.png`,fullPage:true});
      await page.getByRole("link",{name:labels.windowStart,exact:true}).click();
      await page.getByRole("status").waitFor();
    }
    await page.goto(origin+"/workspaces/synthetic/goals?view=slice");
    await page.getByText(labels.myWindowLimited,{exact:true}).waitFor();
    expect(await page.getByText(labels.recognitionWindowLimited,{exact:true}).isVisible()).toBe(true);
    await page.screenshot({path:".artifacts/source-4bd488-goals/my-partial.png",fullPage:true});
    await page.getByRole("link",{name:labels.windowNext,exact:true}).click();
    await page.getByText("Permitted owned goal",{exact:true}).waitFor();
    await page.getByRole("link",{name:labels.recognitionWindowNext,exact:true}).click();
    await page.getByText("Permitted recognition",{exact:true}).waitFor();
    expect(new URL(page.url()).searchParams.get("myCursor")).toBe("synthetic-section");
    expect(new URL(page.url()).searchParams.get("recognitionCursor")).toBe("synthetic-section");
    await page.screenshot({path:".artifacts/source-4bd488-goals/my-continued.png",fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.goto(origin+"/workspaces/synthetic/goals");
    await page.getByRole("status").waitFor();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:".artifacts/source-4bd488-goals/goals-mobile.png",fullPage:true});
    expect(errors).toEqual([]);
  }finally{await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},60_000);
