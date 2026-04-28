const [, , siteUrlArg, appUrlArg] = process.argv;

const siteUrl = siteUrlArg || "http://localhost:3008";
const appUrl = appUrlArg || "http://localhost:3000";
const expectedDemoUrl = process.env.DEMO_APP_URL || "https://app.corgtex.com";

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function cookieHeader(setCookies) {
  return setCookies
    .map((header) => header.split(";")[0])
    .join("; ");
}

async function fetchText(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { response, text };
}

async function main() {
  const homepage = await fetchText(siteUrl);
  expect(homepage.response.ok, `Site homepage failed: ${homepage.response.status}`);
  expect(homepage.text.includes("Corgtex"), "Homepage is missing the Corgtex brand name");
  expect(
    homepage.text.includes(expectedDemoUrl) ||
      homepage.text.includes("Read the Demo Edition") ||
      homepage.text.includes("Try the Demo"),
    "Homepage is missing the demo CTA",
  );

  const platformPage = await fetchText(`${siteUrl.replace(/\/$/, "")}/platform`);
  expect(platformPage.response.ok, `/platform failed: ${platformPage.response.status}`);
  expect(platformPage.text.includes("Business Impact"), "/platform is missing the Business Impact phrase");

  const demoEntry = await fetch(`${appUrl.replace(/\/$/, "")}/demo`, {
    redirect: "manual",
    headers: {
      accept: "text/html",
    },
  });
  expect(demoEntry.status >= 300 && demoEntry.status < 400, `/demo did not redirect: ${demoEntry.status}`);

  const location = demoEntry.headers.get("location");
  expect(location && location.includes("/workspaces/"), `/demo redirected to an unexpected location: ${location}`);

  const setCookie = demoEntry.headers.getSetCookie?.() ?? [];
  expect(setCookie.length > 0, "/demo did not set a session cookie");

  const workspaceUrl = new URL(location, `${appUrl.replace(/\/$/, "")}/demo`).toString();
  const workspace = await fetchText(workspaceUrl, {
    headers: {
      cookie: cookieHeader(setCookie),
    },
  });

  expect(workspace.response.ok, `Demo workspace did not load: ${workspace.response.status}`);
  expect(
    workspace.text.includes("This demo is read-only") || workspace.text.includes("read-only demo environment"),
    "Demo workspace does not appear to be read-only",
  );

  console.log("Site smoke test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
