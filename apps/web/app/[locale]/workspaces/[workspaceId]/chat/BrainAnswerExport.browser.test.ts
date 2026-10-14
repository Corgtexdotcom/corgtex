import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Actual component/translations/browser, with a synthetic HTTP commit/replay
// boundary. Server consent/current-authority behavior has separate real PG proof.
it.runIf(process.env.BRAIN_EXPORT_BROWSER_QA === "1")("replays failed export responses with exact choice keys for all metadata modes", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const component = fileURLToPath(new URL("./BrainAnswerExport.tsx", import.meta.url));
  const messages = JSON.parse(await readFile(new URL("../../../../../messages/en.json", import.meta.url), "utf8"));
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL("../../../../../", import.meta.url)), loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {NextIntlClientProvider} from "next-intl";
    import {BrainAnswerExport} from ${JSON.stringify(component)};
    const output={id:"answer-"+new URLSearchParams(location.search).get("case"),sequenceNumber:2,userMessage:"Synthetic second question",assistantMessage:"Synthetic saved answer"};
    const turns=[{id:"turn-1",sequenceNumber:1,userMessage:"Synthetic private question",assistantMessage:"Synthetic first answer"},output];
    createRoot(document.getElementById("root")).render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={${JSON.stringify({chat:{brainExport:messages.chat.brainExport}})}}><BrainAnswerExport workspaceId="synthetic-ws" conversationId="synthetic-session" output={output} turns={turns}/></NextIntlClientProvider>);
  ` }, bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const script = bundle.outputFiles[0].text;
  type Submission = { requestId: string; transcriptMode: string; selectedTurns: Array<{id: string; hash: string}>; [key: string]: unknown };
  const requests: Submission[] = [];
  const commits = new Map<string, string>();
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const submission = JSON.parse(raw) as Submission;
      requests.push(submission);
      const { requestId, ...choice } = submission;
      const signature = JSON.stringify(choice);
      if (!commits.has(requestId)) {
        commits.set(requestId, signature); // Commit succeeds, proxy returns an ambiguous failure.
        response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Response unavailable after commit" })); return;
      }
      response.setHeader("Content-Type", "application/json");
      if (commits.get(requestId) !== signature) { response.writeHead(409).end(JSON.stringify({message:"Changed choice"})); return; }
      response.writeHead(201).end(JSON.stringify({sourceId: `source-${requestId}`})); return;
    }
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); return; }
    response.setHeader("Content-Type", "text/html");
    response.end('<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing browser fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const open = async (name: string) => { await page.goto(`${origin}/?case=${name}`); await page.getByText(messages.chat.brainExport.open, {exact:true}).click(); };
    const submit = () => page.getByRole("button", {name:messages.chat.brainExport.confirm, exact:true}).click();
    for (const mode of ["NONE", "PARTIAL", "FULL"]) {
      await open(mode);
      await page.getByLabel(messages.chat.brainExport.transcript, {exact:true}).selectOption(mode);
      if (mode === "PARTIAL") await page.getByRole("checkbox").first().check();
      const start = requests.length, before = commits.size;
      await submit(); await page.getByRole("alert").waitFor();
      expect(commits.size).toBe(before + 1);
      await submit(); await page.getByRole("status").waitFor();
      expect(requests.slice(start)).toHaveLength(2);
      expect(requests[start + 1]).toEqual(requests[start]);
      expect(commits.size).toBe(before + 1);
      expect(requests[start].transcriptMode).toBe(mode);
      expect(requests[start].selectedTurns).toHaveLength(mode === "NONE" ? 0 : mode === "PARTIAL" ? 1 : 2);
    }
    await open("changed-choice"); const start = requests.length, before = commits.size;
    await submit(); await page.getByRole("alert").waitFor();
    await page.getByLabel(messages.chat.brainExport.transcript, {exact:true}).selectOption("FULL");
    await submit(); await page.getByRole("alert").waitFor();
    expect(requests[start + 1].requestId).not.toBe(requests[start].requestId);
    await page.getByLabel(messages.chat.brainExport.transcript, {exact:true}).selectOption("NONE");
    await submit(); await page.getByRole("status").waitFor();
    expect(requests[start + 2]).toEqual(requests[start]);
    expect(commits.size).toBe(before + 2);
    expect(errors).toEqual([]);
    await mkdir(".artifacts", {recursive:true});
    await page.screenshot({path:".artifacts/brain-export-retry-browser.png", fullPage:true});
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);
