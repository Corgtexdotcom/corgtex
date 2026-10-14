import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";

export type ChatRequest = {
  id: number;
  url: string;
  method: string;
  body: string | null;
  aborted: boolean;
  canceled: boolean;
};

export type ChatFixture = {
  requests: ChatRequest[];
  refreshes: number;
  configure: (patch: { workspaceId?: string; activeSessionId?: string | null; rail?: boolean; mobileMode?: boolean; questions?: boolean }) => void;
  reply: (id: number, value: unknown, status?: number) => void;
  stream: (id: number) => void;
  chunk: (id: number, text: string) => void;
  bytes: (id: number, bytes: number[]) => void;
  finish: (id: number) => void;
  fail: (id: number) => void;
  unmount: () => void;
  settle: () => Promise<void>;
};

declare global {
  interface Window {
    __chatFixture: ChatFixture;
  }
}

export function conversation(id: string) {
  return {
    id, topic: `Synthetic ${id}`, agentKey: "assistant", status: "ACTIVE",
    updatedAt: "2026-01-01T00:00:00.000Z", roleOnboarding: null,
    turns: [{ id: `turn-${id}`, sequenceNumber: 1, userMessage: `Question ${id}`, assistantMessage: `Answer ${id}`, createdAt: "2026-01-01T00:00:00.000Z" }],
  };
}

// Bundle the real chat/rail, React, Intl and Markdown renderer. Only Next navigation
// and the unrelated launch panel are replaced. No auth, database or agent runtime.
export async function startChatBrowserFixture() {
  const webRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
  const messages = JSON.parse(await readFile(`${webRoot}/messages/en.json`, "utf8"));
  const component = fileURLToPath(new URL("./ChatInterface.tsx", import.meta.url));
  const rail = fileURLToPath(new URL("../WorkspaceChatRail.tsx", import.meta.url));
  const result = await build({
    stdin: { resolveDir: webRoot, loader: "tsx", contents: `
      import React, {useState} from "react";
      import {createRoot} from "react-dom/client";
      import {NextIntlClientProvider} from "next-intl";
      import {ChatInterface} from ${JSON.stringify(component)};
      import {WorkspaceChatRail} from ${JSON.stringify(rail)};
      const fixture = window.__chatFixture = {requests: [], refreshes: 0};
      const pending = new Map();
      const streams = new Map();
      window.fetch = (url, options = {}) => {
        if (!String(url).startsWith('/api/workspaces/')) throw new Error('Unexpected fixture fetch: ' + url);
        const request = {id: fixture.requests.length, url: String(url), method: options.method || 'GET',
          body: options.body instanceof FormData ? Array.from(options.body.entries()).map(([key, value]) => key + ':' + (value.name || value)).join('\\n') : options.body || null,
          aborted: options.signal?.aborted || false, canceled: false};
        fixture.requests.push(request);
        options.signal?.addEventListener('abort', () => {request.aborted = true;}, {once: true});
        // Deliberately allow responses after abort: the UI must also reject stale
        // completions even if a transport or an already queued callback ignores it.
        return new Promise(resolve => pending.set(request.id, resolve));
      };
      fixture.reply = (id, value, status = 200) => {
        const resolve = pending.get(id); pending.delete(id);
        resolve(new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}}));
      };
      fixture.stream = id => {
        const stream = new ReadableStream({start(controller) {streams.set(id, controller);},
          cancel() {fixture.requests[id].canceled = true; streams.delete(id);}});
        const resolve = pending.get(id); pending.delete(id);
        resolve(new Response(stream, {headers: {'Content-Type': 'text/event-stream'}}));
      };
      fixture.chunk = (id, text) => streams.get(id)?.enqueue(new TextEncoder().encode(text));
      fixture.bytes = (id, bytes) => streams.get(id)?.enqueue(new Uint8Array(bytes));
      fixture.finish = id => {streams.get(id)?.close(); streams.delete(id);};
      fixture.fail = id => {streams.get(id)?.error(new Error('Synthetic stream interrupted')); streams.delete(id);};
      fixture.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const root = createRoot(document.getElementById('root'));
      fixture.unmount = () => root.unmount();
      function Fixture() {
        const [props, setProps] = useState({workspaceId: 'alpha', activeSessionId: null, rail: false, mobileMode: false, questions: false});
        fixture.configure = patch => setProps(previous => ({...previous, ...patch}));
        fixture.pathname = '/en/workspaces/' + props.workspaceId;
        const conversations = React.useMemo(() => (props.workspaceId === 'alpha' ? ['a', 'b'] : ['c']).map(id => ({
          id, topic: 'Synthetic ' + id, agentKey: 'assistant', status: 'ACTIVE', updatedAt: '2026-01-01T00:00:00.000Z', lastMessage: 'Preview ' + id,
        })), [props.workspaceId]);
        const questions = React.useMemo(() => props.questions ? [{id: 'question', questionText: 'Synthetic company question',
          confidence: null, priority: 1, relatedConversationId: null, createdAt: '2026-01-01T00:00:00.000Z'}] : [], [props.questions]);
        return <NextIntlClientProvider locale="en" timeZone="UTC" messages={${JSON.stringify({ chat: messages.chat, demo: messages.demo })}}>
          <div className="ws-layout">
          {props.rail ? <WorkspaceChatRail workspaceId={props.workspaceId} conversations={conversations} companyQuestions={questions} aiWorkspaceState={{}} />
            : <ChatInterface {...props} compact={props.mobileMode} conversations={conversations} companyQuestions={questions} />}
          </div>
        </NextIntlClientProvider>;
      }
      root.render(<Fixture />);
    ` },
    bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "chat-browser-fixture", setup(api) {
      api.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
      api.onResolve({ filter: /AiWorkspaceLaunchPanel$/ }, () => ({ path: "launch", namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: path === "navigation"
        ? `const router = {refresh() {window.__chatFixture.refreshes++;}};
           export const useRouter = () => router;
           export const usePathname = () => window.__chatFixture.pathname;`
        : `export const AiWorkspaceLaunchPanel = () => null;` }));
    } }],
  });
  const css = await readFile(`${webRoot}/app/styles/pages.css`, "utf8");
  const server = createServer((request, response) => {
    if (request.url === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(result.outputFiles[0].text);
    } else if (request.url?.startsWith("/api/")) {
      response.writeHead(500);
      response.end("Unmocked API request");
    } else {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="en"><head><title>Synthetic personal chat</title><style>${css}
        :root{--accent:#345;--muted:#567;--line:#ccc;--surface:#fff;--text:#123}
        body{margin:16px;font-family:Arial}.chat-layout{height:720px}.ws-agent-chat-shell[hidden]{display:none}
        </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? (existsSync("/usr/lib/chromium/chromium") ? "/usr/lib/chromium/chromium" : undefined) });
  return {
    origin,
    async newPage() {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      page.setDefaultTimeout(5_000);
      await page.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
      await page.goto(origin);
      await page.locator("textarea").waitFor();
      return page;
    },
    async close() {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function configure(page: Page, patch: Parameters<ChatFixture["configure"]>[0]) {
  await page.evaluate(async (value) => {
    const fixture = window.__chatFixture;
    fixture.configure(value);
    await fixture.settle();
  }, patch);
}

export async function requests(page: Page) {
  return page.evaluate(() => window.__chatFixture.requests);
}

export async function reply(page: Page, id: number, value: unknown, status = 200) {
  await page.evaluate(async (args) => {
    const fixture = window.__chatFixture;
    fixture.reply(args.id, args.value, args.status);
    await fixture.settle();
  }, { id, value, status });
}

export async function streamAction(page: Page, id: number, action: "stream" | "chunk" | "finish" | "fail", text = "") {
  await page.evaluate(async (args) => {
    const fixture = window.__chatFixture;
    if (args.action === "chunk") fixture.chunk(args.id, args.text);
    else fixture[args.action](args.id);
    await fixture.settle();
  }, { id, action, text });
}

export async function refreshes(page: Page) {
  return page.evaluate(() => window.__chatFixture.refreshes);
}
