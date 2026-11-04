import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { membership, usage, budget, counts } = vi.hoisted(() => ({membership: vi.fn(), usage: vi.fn(), budget: vi.fn(), counts: vi.fn()}));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../../../../../packages/domain/src/agent-authority-summary"),
  requireWorkspaceMembership: membership, getModelUsageSummary: usage, getModelUsageBudget: budget,
  listAgentIdentities: async () => [{agentKey: "maintenance", displayName: "Maintenance", maxSpendPerRunCents: 12345, maxRunsPerDay: 10}],
  getAgentRunOperationalCounts: counts,
  listAgentConfigs: async () => [], listAgentCredentials: async () => [], listAgentRuns: async () => [],
}));
vi.mock("@corgtex/shared", () => ({prisma: {agentRun: {groupBy: async () => []}}}));
vi.mock("./actions", () => ({updateAgentGovernancePolicyAction: vi.fn()}));
vi.mock("./AgentRegistryToggle", () => ({AgentRegistryToggle: () => null}));
vi.mock("../settings/agents/AgentBudgetManager", () => ({AgentBudgetManager: () => React.createElement("span", null, "Budget editor")}));
vi.mock("./AgentSpendLimits", () => ({AgentSpendLimits: () => React.createElement("span", null, "Spend limits")}));
vi.mock("next-intl/server", () => ({getTranslations: async () => { const {createTranslator}=await import("next-intl"); const messages=(await import("@/messages/en.json")).default; return createTranslator({locale:"en",messages,namespace:"agents"}); }, getFormatter: async () => ({dateTime: () => "date"})}));
import { AgentRegistryTab } from "./AgentRegistryTab";
import { SpendControlTab } from "./SpendControlTab";
const actor = {kind: "user", user: {id: "user"}} as any;
const props = {actor, workspaceId: "ws-1"};
beforeEach(() => {
  vi.stubGlobal("React", React); vi.resetAllMocks(); membership.mockResolvedValue({id: "member", role: "CONTRIBUTOR"});
  usage.mockResolvedValue({readWindow:{scope:"WINDOW",complete:true},totalCostUsd: 1, totalTokens: 30, totalCalls: 1, byAgent: [{agentKey: "maintenance", totalCostUsd: 1}], byModel: [], byDay: []});
  counts.mockResolvedValue({runCountsByAgent: [], pendingApprovalCountsByAgent: []});
  budget.mockResolvedValue({monthlyCostCapUsd: 6789, alertThresholdPct: 80, periodStartDay: 1});
});
describe("agent finance visibility", () => {
  it("keeps the registry visible without querying or rendering money for a non-admin", async () => {
    const html = renderToStaticMarkup(await AgentRegistryTab(props));
    expect(html).toContain("Maintenance"); expect(html).toContain("10 runs/day");
    expect(html).not.toMatch(/\$\d/); expect(html).not.toContain("12345"); expect(html).not.toContain("6789");
    expect(usage).not.toHaveBeenCalled(); expect(budget).not.toHaveBeenCalled();
    expect(counts).toHaveBeenCalledExactlyOnceWith(actor, "ws-1");
  });
  it("omits the financial panel without financial calls for a non-admin", async () => {
    expect(await SpendControlTab(props)).toBeNull();
    expect(usage).not.toHaveBeenCalled(); expect(budget).not.toHaveBeenCalled();
  });
  it("uses current admin membership for financial reads and rendering", async () => {
    membership.mockResolvedValue({id: "member", role: "ADMIN"});
    const html = renderToStaticMarkup(await AgentRegistryTab(props));
    expect(html).toContain("$123.45"); expect(html).toContain("$6789.00"); expect(html).toContain("$1.0000");
    expect(usage).toHaveBeenCalledExactlyOnceWith(actor, "ws-1", {periodDays: 30});
    expect(budget).toHaveBeenCalledExactlyOnceWith(actor, "ws-1");
  });
});


describe("bounded usage presentation",()=>{
  it("qualifies both tabs and keeps missing agent usage unknown in a partial window",async()=>{
    membership.mockResolvedValue({id:"member",role:"ADMIN"});
    usage.mockResolvedValue({readWindow:{scope:"WINDOW",complete:false},totalCostUsd:0,totalTokens:0,totalCalls:0,byAgent:[],byModel:[],byDay:[]});
    const registry=renderToStaticMarkup(await AgentRegistryTab(props));
    const spend=renderToStaticMarkup(await SpendControlTab(props));
    expect(registry).toContain("… (window)");expect(registry).not.toContain("$0.0000");
    for(const html of [registry,spend])expect(html).toContain("not the full period");
    expect(spend).toContain("the period total is unknown");expect(spend).not.toContain("$0.000000");
    expect(spend).toContain("Total Cost (30d) · window");
  });
  it("qualifies negative costs as window values rather than lower bounds",async()=>{
    membership.mockResolvedValue({id:"member",role:"ADMIN"});
    usage.mockResolvedValue({readWindow:{scope:"WINDOW",complete:false},totalCostUsd:-2,totalTokens:30,totalCalls:1,
      byAgent:[{agentKey:"maintenance",totalCostUsd:-2,callCount:1,totalInputTokens:10,totalOutputTokens:20}],
      byModel:[{provider:"synthetic",model:"model",totalCostUsd:-2,callCount:1,totalInputTokens:10,totalOutputTokens:20,totalLatencyMs:50}],byDay:[]});
    const html=renderToStaticMarkup(await SpendControlTab(props));
    expect(html).toContain("$-2.000000");expect(html).not.toContain("$-2.000000+");
    expect(html).toContain("averages and shares cover a limited window");
  });
});

it.runIf(process.env.USAGE_WINDOW_BROWSER_QA==="1")("renders both actual admin tabs with visible partial usage qualification",async()=>{
  const {chromium}=await import("playwright");const {readFile,mkdir}=await import("node:fs/promises");
  membership.mockResolvedValue({id:"member",role:"ADMIN"});
  const css=(await Promise.all(["globals.css","styles/tokens.css","styles/components.css","styles/animations.css","styles/pages.css"].map(path=>readFile(new URL(`../../../../../app/${path}`,import.meta.url),"utf8")))).join("\n");
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:1000}});await page.route("**/*",route=>route.abort());
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await mkdir(".artifacts/source-94062-usage-window",{recursive:true});
    for(const hidden of [false,true]){
      usage.mockResolvedValue({readWindow:{scope:"WINDOW",complete:false},totalCostUsd:hidden?0:2,totalTokens:hidden?0:30,totalCalls:hidden?0:1,
        byAgent:hidden?[]:[{agentKey:"maintenance",totalCostUsd:2,callCount:1,totalInputTokens:10,totalOutputTokens:20}],
        byModel:hidden?[]:[{provider:"synthetic",model:"model",totalCostUsd:2,callCount:1,totalInputTokens:10,totalOutputTokens:20,totalLatencyMs:50}],
        byDay:hidden?[]:[{date:"2026-10-17",totalCostUsd:2,callCount:1,totalInputTokens:10,totalOutputTokens:20}]});
      const html=renderToStaticMarkup(React.createElement("main",{style:{maxWidth:1100,margin:"24px auto",padding:20}},React.createElement("h1",null,"Synthetic admin usage"),await AgentRegistryTab(props),await SpendControlTab(props)));
      await page.setContent(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${html}</body></html>`);
      expect(await page.getByRole("status").count()).toBe(2);
      expect(await page.getByText("Total Cost (30d) · window",{exact:true}).isVisible()).toBe(true);
      if(hidden)expect(await page.getByText("No readable usage in this window; the period total is unknown.",{exact:true}).count()).toBe(3);
      for(const width of [1200,390]){
        await page.setViewportSize({width,height:1000});
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
        await page.screenshot({path:`.artifacts/source-94062-usage-window/${hidden?"hidden":"populated"}-${width}.png`,fullPage:true});
      }
    }
    expect(errors).toEqual([]);
  }finally{await browser.close();}
},60_000);
