import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.runIf(process.env.COUNT_WINDOW_BROWSER_QA === "1")("qualifies partial Brain and Slack counts while keeping filters and installations visible", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const web = fileURLToPath(new URL("../../../../../", import.meta.url));
  const brain = fileURLToPath(new URL("./BrainTypeCountFilters.tsx", import.meta.url));
  const slack = fileURLToPath(new URL("../tools/ConnectorSetupPanels.tsx", import.meta.url));
  const messages = JSON.parse(await readFile(new URL("../../../../../messages/en.json", import.meta.url), "utf8"));
  const bundle = await build({ stdin: { resolveDir: web, loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {BrainTypeCountFilters} from ${JSON.stringify(brain)};
    import {SlackConnectorPanel} from ${JSON.stringify(slack)};
    const mode=new URL(location.href).searchParams.get("mode")||"hidden";
    const complete=mode==="exact", unavailable=mode==="unavailable", count=mode==="hidden"?0:12;
    const installation={id:"synthetic",externalTeamName:"Synthetic workspace",scopes:[],settings:{},_count:{channels:2,messages:complete?count:null},
      messageCount:{count:unavailable?null:count,complete,available:!unavailable}};
    createRoot(document.getElementById("root")).render(<main className="stack" style={{maxWidth:900,margin:"32px auto",padding:24,gap:24}}>
      <h1>Brain and Slack counts</h1><section className="card stack"><h2>Article types</h2>
      <BrainTypeCountFilters counts={count?[{type:"PROJECT",count}]:[]} complete={complete} types={["PROJECT","STRATEGY","POLICY"]}
        selectedType={null} href={type=>"?type="+(type||"all")} labels={{all:"All types",filter:"Filter by type",limited:${JSON.stringify(messages.brain.typeCountWindowLimited)}}}/></section>
      <SlackConnectorPanel workspaceId="synthetic" installation={installation} canManage={false}/>
    </main>);
  ` }, bundle:true,write:false,jsx:"automatic",define:{"process.env.NODE_ENV":'"production"'},plugins:[{
    name:"fixture-unrelated-controls",setup(builder){
      builder.onResolve({filter:/CorgtexConnectorManager|DataSourcesManager|AiWorkspaceManager|TimeZoneSelect|GoogleDrivePicker|^\.\.\/actions$/},args=>({path:args.path,namespace:"fixture"}));
      builder.onLoad({filter:/.*/,namespace:"fixture"},()=>({loader:"js",contents:`
        export const CorgtexConnectorManager=()=>null,DataSourcesManager=()=>null,AiWorkspaceManager=()=>null,TimeZoneSelect=()=>null,GoogleDrivePicker=()=>null;
        export const connectMeetingTranscriptSourceAction=()=>{},createWebhookEndpointAction=()=>{},deleteOAuthConnectionAction=()=>{},deleteWebhookEndpointAction=()=>{},disconnectCommunicationInstallationAction=()=>{},retryMeetingTranscriptImportBatchAction=()=>{},rotateWebhookSecretAction=()=>{},runMeetingTranscriptSourceBackfillAction=()=>{},runOAuthConnectionSyncAction=()=>{},updateMeetingRecorderConfigAction=()=>{},updateSlackAgendaSettingsAction=()=>{},updateWebhookEndpointAction=()=>{};
      `}));
    }
  }] });
  const css=(await Promise.all(["globals.css","styles/tokens.css","styles/components.css","styles/animations.css","styles/pages.css"].map(path=>readFile(new URL(`../../../../../app/${path}`,import.meta.url),"utf8")))).join("\n");
  const server=createServer((request,response)=>{
    if(request.url==="/fixture.js"){response.writeHead(200,{"Content-Type":"text/javascript"}).end(bundle.outputFiles[0].text);return;}
    response.writeHead(200,{"Content-Type":"text/html;charset=utf-8"}).end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("Missing fixture port");
  const origin=`http://127.0.0.1:${address.port}`;
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1100,height:900}});
    await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await mkdir(".artifacts/source-590875-count-windows",{recursive:true});
    for(const mode of ["hidden","partial","exact","unavailable"]){
      await page.goto(`${origin}/?mode=${mode}`);
      await page.getByText("Connected",{exact:true}).waitFor();
      const filters=page.getByRole("navigation",{name:"Filter by type"});
      expect(await filters.getByRole("link").count()).toBe(mode==="exact"?2:4);
      expect(await page.getByText(`${mode==="hidden"||mode==="unavailable"?"…":mode==="exact"?"12":"12+"} captured messages`,{exact:false}).isVisible()).toBe(true);
      if(mode!=="exact")expect(await page.getByText(messages.brain.typeCountWindowLimited,{exact:true}).isVisible()).toBe(true);
      if(mode==="unavailable")expect(await page.getByText("Captured message count is currently unavailable.",{exact:true}).isVisible()).toBe(true);
      if(mode==="hidden"||mode==="partial"){
        await page.screenshot({path:`.artifacts/source-590875-count-windows/${mode}-desktop.png`,fullPage:true});
        await page.setViewportSize({width:390,height:844});
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
        await page.screenshot({path:`.artifacts/source-590875-count-windows/${mode}-mobile.png`,fullPage:true});
        await page.setViewportSize({width:1100,height:900});
      }
    }
    expect(errors).toEqual([]);
  }finally{await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},60_000);
