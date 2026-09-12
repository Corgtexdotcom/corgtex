#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export async function checkSiteCandidate({ origin, signupOrigin, fetchImpl = fetch }) {
  const candidate = new URL(origin);
  const signup = new URL(signupOrigin);
  const paths = ["/api/health", "/", "/es", "/about", "/es/about", "/sitemap.xml", "/llms.txt"];
  const checked = [];
  for (const path of paths) {
    // Follow only canonical trailing-slash redirects for this requested route.
    const requested = new URL(path, candidate);
    const withTrailingSlash = requested.pathname === "/" ? "/" : `${requested.pathname}/`;
    let url = requested;
    let response;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location) throw new Error(`${path}: redirect is missing Location`);
      url = new URL(location, url);
      if (url.origin !== candidate.origin) throw new Error(`${path}: redirected outside candidate origin`);
      if ((url.pathname !== requested.pathname && url.pathname !== withTrailingSlash)
        || url.search !== requested.search || url.hash !== requested.hash) {
        throw new Error(`${path}: redirect changed requested route`);
      }
    }
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const text = await response.text();
    if (path === "/api/health") {
      const health = JSON.parse(text);
      if (health.status !== "ok" || health.app !== "corgtex-site") throw new Error("Wrong site health response");
    } else if (path === "/" || path === "/es") {
      const expected = `${signup.origin}${path === "/es" ? "/es" : ""}/signup`;
      if (!text.includes(expected)) throw new Error(`${path}: missing built signup URL ${expected}`);
    } else if (path === "/sitemap.xml" && !text.includes("/es/about")) {
      throw new Error("Sitemap is missing localized routes");
    } else if (!text.trim()) {
      throw new Error(`${path}: empty response`);
    }
    checked.push(path);
  }
  return { origin: candidate.origin, checked };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [origin, signupOrigin] = process.argv.slice(2);
  if (!origin || !signupOrigin) {
    console.error("Usage: node scripts/migration/site-candidate-smoke.mjs SITE_ORIGIN SIGNUP_ORIGIN");
    process.exitCode = 1;
  } else {
    checkSiteCandidate({ origin, signupOrigin }).then(
      (result) => console.log(JSON.stringify(result, null, 2)),
      (error) => { console.error(error.message); process.exitCode = 1; },
    );
  }
}
