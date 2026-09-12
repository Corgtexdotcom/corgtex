import { describe, expect, it } from "vitest";
import { checkSiteCandidate } from "./site-candidate-smoke.mjs";

const config = { origin: "https://candidate.example", signupOrigin: "https://signup.example" };
function fixture(url) {
  const path = new URL(url).pathname;
  if (path === "/api/health") return Response.json({ status: "ok", app: "corgtex-site" });
  if (path === "/") return new Response('<a href="https://signup.example/signup">Signup</a>');
  if (path === "/es") return new Response('<a href="https://signup.example/es/signup">Signup</a>');
  if (path === "/sitemap.xml") return new Response("<loc>https://www.example/es/about</loc>");
  return new Response("Corgtex");
}

describe("Azure site candidate smoke", () => {
  it("checks only site GET routes without exercising demo or lead writers", async () => {
    const paths = [];
    const result = await checkSiteCandidate({ ...config, fetchImpl: async (url, init) => {
      expect(init.redirect).toBe("manual");
      expect(init.method).toBeUndefined();
      expect(url.origin).toBe(config.origin);
      paths.push(url.pathname);
      return fixture(url);
    } });
    expect(result.checked).toEqual(paths);
    expect(paths).not.toContain("/demo");
    expect(paths).not.toContain("/api/demo-leads");
  });
  it("rejects an image built with the wrong signup target", async () => {
    await expect(checkSiteCandidate({ ...config, fetchImpl: async (url) =>
      url.pathname === "/" ? new Response("https://old.example/signup") : fixture(url),
    })).rejects.toThrow("missing built signup URL");
  });
  it("rejects a redirect that would smoke the old host instead", async () => {
    await expect(checkSiteCandidate({ ...config, fetchImpl: async () =>
      new Response(null, { status: 302, headers: { location: "https://old.example" } }),
    })).rejects.toThrow("outside candidate");
  });
  it("allows same-origin canonical redirects", async () => {
    await expect(checkSiteCandidate({ ...config, fetchImpl: async (url) =>
      url.pathname === "/about" ? new Response(null, { status: 307, headers: { location: "/about/" } }) : fixture(url),
    })).resolves.toHaveProperty("checked");
  });
  it("rejects an app health endpoint masquerading as the site", async () => {
    await expect(checkSiteCandidate({ ...config, fetchImpl: async () => Response.json({ status: "ok", app: "web" }) }))
      .rejects.toThrow("Wrong site health");
  });
});
