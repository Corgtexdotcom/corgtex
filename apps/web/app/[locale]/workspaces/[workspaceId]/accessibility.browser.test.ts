import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real tour components, production CSS, and Home's exact JSX with synthetic
// counts. No backend, customer data, or external traffic. Other samples exercise
// the reported CSS selectors; they are not whole-page accessibility coverage.
describe.runIf(process.env.PUN97_BROWSER_QA === "1")(
  "PUN-97 residual accessibility",
  () => {
    let browser: Browser;
    let server: Server;
    let origin: string;
    const errors: string[] = [];
    const prefix =
      process.env.PUN97_EXPECT_BASELINE === "1" ? "before" : "after";
    const output = `.artifacts/pun-97/${prefix}-${Date.now()}`;
    const reports: unknown[] = [];

    beforeAll(async () => {
      await mkdir(output, { recursive: true });
      const { build } = await import("esbuild");
      const { chromium } = await import("playwright");
      const webRoot = new URL("../../../../", import.meta.url);
      const source = await readFile(
        new URL("page.tsx", import.meta.url),
        "utf8",
      );
      const strip = source.match(
        /<section className="nr-home-attention-strip"[\s\S]*?<\/section>/,
      )?.[0];
      if (!strip)
        throw new Error(
          "Home attention strip moved; update the fixture boundary",
        );
      const bundle = await build({
        stdin: {
          resolveDir: fileURLToPath(webRoot),
          loader: "tsx",
          contents: `
        import React from "react";
        import {createRoot} from "react-dom/client";
        import {NextIntlClientProvider, useTranslations} from "next-intl";
        import en from "./messages/en.json";
        import es from "./messages/es.json";
        import {DemoTour} from "./app/[locale]/workspaces/[workspaceId]/DemoTour";
        import {WorkspaceOnboardingTour} from "./app/[locale]/workspaces/[workspaceId]/WorkspaceOnboardingTour";
        import {notificationUnreadCountLabel} from "./lib/notification-count";
        const Link = ({children, ...props}) => <a {...props}>{children}</a>;
        const query = new URLSearchParams(location.search);
        // Fixture options are not application navigation parameters.
        history.replaceState({}, "", location.pathname);
        function Samples() {
          const t = useTranslations("dashboard");
          const adviceComplete = true;
          const attentionTiles = ["Actions", "Tensions", "Proposals"].map(label => ({
            href: "/" + label.toLowerCase(), label, complete: true,
            counts: {personalCount: 0, totalCount: 6}
          })).concat([{href:"/total",label:"Total only",complete:false,counts:{personalCount:null,totalCount:200}}]);
          return <main className="ws-main-content"><h1>Synthetic accessibility samples</h1>
            ${strip}
            <div className="mobile-mode-switch"><button type="button" className="active">Workspace</button><button type="button">AI</button></div>
            <div className="brain-article-tags"><span className="tag neutral">Strategy</span></div>
            <div className="nr-work-item-card-badges"><span className="tag neutral nr-work-item-badge">Open</span></div>
            <div className="context-map-flow-node--selected"><div className="context-map-node-card" style={{background:"#f5f3ff"}}>
              <div className="context-map-node-meta"><span>Approved</span></div>
            </div></div>
            <aside className="context-map-inspector"><span className="tag neutral">Process</span></aside>
            <button id="page-action">Page action</button>
          </main>;
        }
        const locale = query.get("locale") || "en";
        createRoot(document.getElementById("root")).render(<NextIntlClientProvider locale={locale} timeZone="UTC" messages={locale === "es" ? es : en}>
          <Samples />
          {query.get("tour") === "demo" && <DemoTour workspaceId="synthetic" />}
          {query.get("tour") === "onboarding" && <WorkspaceOnboardingTour workspaceId="synthetic" tourKey="synthetic" tourVersion="1" initialCompletedAt={null} hasInitialKnowledge={true} aiWorkspaceState={{}} connectorUrl="" origin="" />}
        </NextIntlClientProvider>);
      `,
        },
        plugins: [
          {
            name: "synthetic-boundaries",
            setup(build) {
              build.onResolve({ filter: /^next\/navigation$/ }, () => ({
                path: "navigation",
                namespace: "fixture",
              }));
              build.onResolve(
                {
                  filter:
                    /^\.\/(SourceIntakePanel|OnboardingAiWorkspaceSetup)$/,
                },
                (args) => ({ path: args.path.slice(2), namespace: "fixture" }),
              );
              build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
                contents:
                  args.path === "navigation"
                    ? `const router={push:path=>history.pushState({},"",path),refresh:()=>{}}; const params=new URLSearchParams(location.search);
             export const useRouter=()=>router; export const usePathname=()=>location.pathname; export const useSearchParams=()=>params;`
                    : `export const ${args.path}=()=>null;`,
              }));
            },
          },
        ],
        alias: { "@": fileURLToPath(webRoot) },
        outfile: "fixture.js",
        bundle: true,
        write: false,
        jsx: "automatic",
        define: {
          "process.env.NODE_ENV": '"production"',
          "process.env.NEXT_PUBLIC_BOOK_DEMO_URL": '""',
        },
      });
      const rawCss =
        (
          await Promise.all(
            [
              "app/styles/tokens.css",
              "app/globals.css",
              "app/styles/components.css",
              "app/styles/pages.css",
              "app/[locale]/workspaces/[workspaceId]/maps/context-map.css",
            ].map((path) => readFile(new URL(path, webRoot), "utf8")),
          )
        )
          .join("\n")
          .replace(/@import[^;]+;/g, "") +
        bundle.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
      const { default: postcss } = await import("postcss");
      const { default: tailwindcss } = await import("tailwindcss");
      const css = (
        await postcss([
          tailwindcss({
            content: [{ raw: bundle.outputFiles[0].text, extension: "js" }],
          }),
        ]).process(rawCss, { from: undefined })
      ).css;
      const js = bundle.outputFiles.find((file) =>
        file.path.endsWith(".js"),
      )!.text;
      server = createServer((request, response) => {
        response.setHeader(
          "Content-Type",
          request.url === "/fixture.js"
            ? "text/javascript"
            : "text/html; charset=utf-8",
        );
        response.end(
          request.url === "/fixture.js"
            ? js
            : `<!doctype html><html lang="${request.url?.includes("locale=es") ? "es" : "en"}"><head><title>PUN-97 synthetic samples</title><style>${css}
        body{padding:24px}.ws-main-content{min-height:500px}.nr-home-attention-strip{display:flex;flex-wrap:wrap;gap:12px}.mobile-mode-switch{display:inline-grid;margin:16px 0}.context-map-node-card{max-width:240px;margin:16px 0}
      </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No fixture port");
      origin = "http://127.0.0.1:" + address.port;
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      });
    });

    afterAll(async () => {
      await browser?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await writeFile(
        `${output}/${prefix}-axe.json`,
        JSON.stringify(
          {
            errors,
            reports,
            coverage:
              "Synthetic samples and actual tours; not a whole-product audit",
          },
          null,
          2,
        ),
      );
      expect(errors).toEqual([]);
    });

    async function open(width: number, query = "") {
      const page = await browser.newPage({ viewport: { width, height: 940 } });
      await page.route("**/*", (route) =>
        route
          .request()
          .url()
          .startsWith(origin + "/")
          ? route.continue()
          : route.abort(),
      );
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin + "/workspaces/synthetic" + query);
      await page.locator(".nr-home-attention-tile").first().waitFor();
      await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
      return page;
    }

    async function audit(page: Page, name: string) {
      const report = await page.evaluate(async () => {
        const axe = (
          window as typeof window & { axe: typeof import("axe-core") }
        ).axe;
        return axe.run(document, {
          runOnly: {
            type: "rule",
            values: [
              "color-contrast",
              "aria-allowed-attr",
              "label-content-name-mismatch",
            ],
          },
        });
      });
      reports.push({
        name,
        version: report.testEngine.version,
        violations: report.violations,
        incomplete: report.incomplete,
      });
      await page.screenshot({
        path: `${output}/${prefix}-${name}.png`,
        fullPage: true,
      });
      return report.violations;
    }

    for (const width of [412, 1350])
      for (const locale of ["en", "es"])
        for (const dark of [false, true]) {
          it(`matches visible Home labels and neutral contrast at ${width}px in ${locale}, dark=${dark}`, async () => {
            const page = await open(width, `?locale=${locale}`);
            if (dark) {
              await page.evaluate(() =>
                document.documentElement.classList.add("dark"),
              );
              await page.waitForTimeout(250); // Let the existing theme color transitions finish.
            }
            const violations = await audit(
              page,
              `samples-${width}-${locale}-${dark ? "dark" : "light"}`,
            );
            expect(violations.map((v) => v.id).sort()).toEqual(
              prefix === "before"
                ? ["color-contrast", "label-content-name-mismatch"]
                : [],
            );
            if (prefix === "after") {
              await page.locator(".nr-home-attention-tile").first().focus();
              await page.keyboard.press("Enter");
              await page.waitForURL("**/actions");
              expect(new URL(page.url()).pathname).toBe("/actions");
            }
            await page.close();
          });
        }

    for (const tour of ["demo", "onboarding"]) {
      it(`keeps ${tour} dummy and section highlights valid without changing their roles`, async () => {
        const page = await open(412, `?tour=${tour}`);
        await page.locator(".driver-popover").waitFor();
        await page.waitForTimeout(450);
        const violations = await audit(page, tour + "-welcome");
        expect(violations.some((v) => v.id === "aria-allowed-attr")).toBe(
          prefix === "before",
        );
        if (prefix === "after") expect(violations).toEqual([]);
        expect(
          await page.locator("#driver-dummy-element").getAttribute("role"),
        ).toBeNull();
        await page.locator(".driver-popover-next-btn").press("Enter");
        await page.locator("main.driver-active-element").waitFor();
        await page.waitForTimeout(450);
        const section = await audit(page, tour + "-section");
        expect(section.some((v) => v.id === "aria-allowed-attr")).toBe(false);
        if (prefix === "after") expect(section).toEqual([]);
        expect(await page.locator("main").getAttribute("role")).toBeNull();
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(450);
        expect(
          await page
            .locator("#driver-dummy-element")
            .getAttribute("aria-expanded"),
        ).toBe(prefix === "before" ? "true" : null);
        if (tour === "demo") {
          await page.keyboard.press("Escape");
          expect(await page.locator(".driver-popover").count()).toBe(0);
          await page.locator("#page-action").focus();
          expect(
            await page
              .locator("#page-action")
              .evaluate((node) => node === document.activeElement),
          ).toBe(true);
        }
        await page.close();
      });
    }
  },
);
