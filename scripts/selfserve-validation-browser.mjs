import { createRequire } from "node:module";

// The unchanged release helper exercises production cookies over synthetic TLS.
// Trust only this run's certificate key, never globally ignore certificate errors.
const pin = process.env.SELFSERVE_ISOLATED_TLS_SPKI;
if (process.env.SELFSERVE_ISOLATED_FIXTURE !== "true" || !/^[A-Za-z0-9+/]{43}=$/.test(pin || "")) {
  throw new Error("ISOLATED_TLS_PIN_REQUIRED");
}
const { chromium } = createRequire("/app/package.json")("playwright");
const launch = chromium.launch.bind(chromium);
chromium.launch = async (options = {}) => {
  const browser = await launch({ ...options, args: [...(options.args || []), `--ignore-certificate-errors-spki-list=${pin}`] });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (contextOptions = {}) => {
    const context = await newContext(contextOptions);
    await context.route("**/*", (route) => new URL(route.request().url()).origin === "https://fixture-web:3443"
      ? route.continue() : route.abort("blockedbyclient"));
    return context;
  };
  return browser;
};
