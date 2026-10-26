import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real Next middleware, page auth and HTTP fallback; synthetic session/membership
// services and minimal pages. No database, credentials or external requests.
// WORKSPACE_ACCESS_BROWSER_QA=1 npx vitest run --project unit auth.workspace-access.browser.test.ts
describe.runIf(process.env.WORKSPACE_ACCESS_BROWSER_QA === "1")("workspace page HTTP access", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = path.join(root, ".artifacts", `workspace-access-${process.pid}-${Date.now()}`);
  let server: ChildProcess;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let origin: string;
  let serverLog = "";

  beforeAll(async () => {
    const portServer = createServer();
    await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
    const address = portServer.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const port = address.port;
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    const authImport = JSON.stringify(path.join(root, "apps/web/lib/auth.ts"));
    const errorsImport = JSON.stringify(path.join(root, "packages/domain/src/errors.ts"));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "workspace-access-synthetic-proof", private: true, type: "module" }),
      "next.config.mjs": `export default { outputFileTracingRoot: ${JSON.stringify(root)}, experimental: { externalDir: true }, webpack(config) {
        config.resolve.alias = { ...config.resolve.alias,
          "@corgtex/domain$": ${JSON.stringify(path.join(fixture, "domain.ts"))},
          "@corgtex/shared$": ${JSON.stringify(path.join(fixture, "shared.ts"))},
          "@": ${JSON.stringify(path.join(root, "apps/web"))} }; return config; } };`,
      "shared.ts": `export const env = { CONTROL_PLANE_MODE: false };
        export const beginAuthorizationContext = () => {};
        export const setSupportAuthorizationActor = () => {};
        export const sessionCookieName = () => "synthetic_session";
        export const isDatabaseUnavailableError = () => false;`,
      "domain.ts": `import { cookies } from "next/headers";
        import { AppError } from ${errorsImport};
        export { AppError } from ${errorsImport};
        export const clearSession = async () => {};
        export const isGlobalOperator = () => false;
        export const getWorkspaceSupportGrant = async () => null;
        export const requireAgentOperation = () => { throw new Error("No agents in fixture"); };
        export const resolveAgentActorFromBearer = async () => null;
        export const resolveControlPlaneAgentFromBearer = async () => null;
        export const resolveSessionActor = async (token) => token === "expired" ? null :
          ({ kind: "user", user: { id: "viewer", email: "viewer@example.test" } });
        export async function requireWorkspaceMembership({ workspaceId }) {
          if (workspaceId === "backend-down") throw new Error("synthetic backend unavailable");
          const cookieStore = await cookies();
          if (workspaceId !== "accessible" || cookieStore.get("synthetic_membership")?.value === "revoked") {
            throw new AppError(403, "NOT_A_MEMBER", "Private workspace denial details");
          }
          return { id: "member", role: "CONTRIBUTOR", isActive: true };
        }`,
      "middleware.ts": `export { default } from ${JSON.stringify(path.join(root, "apps/web/middleware.ts"))};
        export const config = { matcher: ["/", "/(es|en)/:path*", "/((?!api|mcp|public|_next|_vercel|.*\\\\..*).*)"] };`,
      "app/[locale]/layout.tsx": `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
      "app/[locale]/page.tsx": `import Link from "next/link";
        export default async function Page({ params }) { const { locale } = await params; return <main><h1>Synthetic access fixture</h1>
          {["accessible", "inaccessible", "nonexistent"].map(id => <p key={id}><Link prefetch={false}
            href={"/"+locale+"/workspaces/"+id+"/brain"}>{id}</Link></p>)}</main>; }`,
      "app/[locale]/login/page.tsx": `export default function Page() { return <h1>Synthetic login</h1>; }`,
      "app/[locale]/workspaces/[workspaceId]/layout.tsx": `import { requirePageActor } from ${authImport};
        export async function generateMetadata() { await requirePageActor(); return { title: "Authorized synthetic metadata" }; }
        export default async function Layout({ children }) { await requirePageActor(); return <main>{children}</main>; }`,
      "app/[locale]/workspaces/[workspaceId]/brain/page.tsx": `import { requirePageActor } from ${authImport};
        export default async function Page() { await requirePageActor(); return <h1>Authorized synthetic content</h1>; }`,
    };
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(fixture, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "dir");
    server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", fixture, "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: fixture, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", chunk => { serverLog += String(chunk); });
    server.stderr?.on("data", chunk => { serverLog += String(chunk); });
    await vi.waitFor(() => expect(serverLog).toContain("Ready"), { timeout: 60_000 });
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  }, 90_000);

  beforeEach(async () => {
    context = await browser.newContext();
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    await context.addCookies([{ name: "synthetic_session", value: "active", url: origin }]);
    page = await context.newPage();
  });
  afterEach(async () => { await context?.close(); });
  afterAll(async () => {
    await browser?.close();
    server?.kill("SIGTERM");
    await writeFile(path.join(fixture, "server.log"), serverLog);
  });

  for (const locale of ["en", "es"]) {
    it(`${locale}: direct and nonexistent URLs share the generic 404 without tenant content`, async () => {
      for (const id of ["inaccessible", "nonexistent"]) {
        const response = await page.goto(`${origin}/${locale}/workspaces/${id}/brain`);
        expect(response?.status()).toBe(404);
        expect(await page.locator("body").innerText()).toContain("This page could not be found");
        const html = await page.content();
        expect(html).not.toContain("Private workspace denial details");
        expect(html).not.toContain("Authorized synthetic content");
        expect(html).not.toContain("Authorized synthetic metadata");
        const head = await context.request.head(`${origin}/${locale}/workspaces/${id}/brain`, {
          headers: { "x-corgtex-pathname": `/${locale}/workspaces/accessible/brain` },
        });
        expect(head.status()).toBe(404);
      }
      if (process.env.WORKSPACE_ACCESS_SCREENSHOT) await page.screenshot({ path: path.join(fixture, `${locale}-404.png`) });
    });

    it(`${locale}: Next Link navigation shows the 404 and preserves the requested URL`, async () => {
      await page.goto(`${origin}/${locale}`);
      const response = page.waitForResponse(response => response.url().includes("/workspaces/inaccessible/brain"));
      await page.getByRole("link", { name: "inaccessible", exact: true }).click();
      const flight = await response;
      expect(flight.request().headers().rsc).toBe("1");
      // Next streams Flight navigation with HTTP 200 and carries the fallback
      // digest in the payload; document requests above must return HTTP 404.
      expect(flight.status()).toBe(200);
      expect(await flight.text()).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
      await expect.poll(() => page.locator("body").innerText()).toContain("This page could not be found");
      expect(page.url()).toBe(`${origin}/${locale}/workspaces/inaccessible/brain`);
    });
  }

  it("allows a current membership, then rejects a stale open URL after revocation", async () => {
    const response = await page.goto(`${origin}/en/workspaces/accessible/brain`);
    expect(response?.status()).toBe(200);
    expect(await page.getByRole("heading", { name: "Authorized synthetic content" }).count()).toBe(1);
    await context.addCookies([{ name: "synthetic_membership", value: "revoked", url: origin }]);
    expect((await page.reload())?.status()).toBe(404);
    expect(await page.locator("body").innerText()).not.toContain("Authorized synthetic content");
  });

  it("redirects missing and expired sessions to login", async () => {
    for (const expired of [false, true]) {
      await context.clearCookies();
      if (expired) await context.addCookies([{ name: "synthetic_session", value: "expired", url: origin }]);
      const response = await context.request.get(`${origin}/en/workspaces/inaccessible/brain`, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(response.headers().location).toBe("/login");
    }
  });

  it("preserves backend failures as HTTP 500", async () => {
    const response = await context.request.get(`${origin}/en/workspaces/backend-down/brain`);
    expect(response.status()).toBe(500);
  });
});
