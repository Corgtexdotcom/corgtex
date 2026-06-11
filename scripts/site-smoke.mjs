const [, , siteUrlArg, appUrlArg] = process.argv;

const siteUrl = siteUrlArg || "http://localhost:3008";
const appUrl = appUrlArg || "http://localhost:3000";
const normalizedSiteUrl = siteUrl.replace(/\/$/, "");
const normalizedAppUrl = appUrl.replace(/\/$/, "");

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

async function expectRouteOk(path, expectedText) {
  const result = await fetchText(`${normalizedSiteUrl}${path}`);
  expect(result.response.ok, `${path} failed: ${result.response.status}`);
  expect(result.text.includes(expectedText), `${path} is missing expected text: ${expectedText}`);
  return result;
}

async function expectDemoRedirect(path, expectedWorkspaceSegment) {
  let currentUrl = new URL(path, normalizedAppUrl);

  for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        accept: "text/html",
      },
    });

    expect(response.status >= 300 && response.status < 400, `${path} did not redirect: ${response.status}`);

    const location = response.headers.get("location");
    expect(location, `${path} redirect ${redirectCount + 1} did not include a Location header`);

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.pathname.includes(expectedWorkspaceSegment)) {
      const setCookie = response.headers.getSetCookie?.() ?? [];
      expect(setCookie.length > 0, `${path} did not set a session cookie before workspace redirect`);
      return { location: nextUrl.toString(), setCookie };
    }

    currentUrl = nextUrl;
  }

  throw new Error(`${path} did not reach ${expectedWorkspaceSegment} within 5 redirects`);
}

async function main() {
  await expectRouteOk("/", "Corgtex");
  await expectRouteOk("/es", "Dirige tu fuerza laboral");
  await expectRouteOk("/about", "Jan Brezina");
  await expectRouteOk("/es/about", "Jan Brezina");
  await expectRouteOk("/blog", "Organizational Intelligence");
  await expectRouteOk("/es/blog", "Inteligencia organizacional");

  const englishAlias = await fetch(`${normalizedSiteUrl}/en/about`, {
    redirect: "manual",
  });
  expect(
    englishAlias.status >= 300 && englishAlias.status < 400,
    `/en/about did not redirect back to the canonical English path: ${englishAlias.status}`,
  );
  expect(
    englishAlias.headers.get("location")?.endsWith("/about"),
    `/en/about redirected to an unexpected location: ${englishAlias.headers.get("location")}`,
  );

  const sitemap = await fetchText(`${normalizedSiteUrl}/sitemap.xml`);
  expect(sitemap.response.ok, `Sitemap failed: ${sitemap.response.status}`);
  expect(sitemap.text.includes("/es/about"), "Sitemap is missing Spanish routes");
  expect(sitemap.text.includes('hreflang="es"'), "Sitemap is missing Spanish hreflang alternates");
  expect(sitemap.text.includes('hreflang="x-default"'), "Sitemap is missing x-default hreflang alternates");

  const llms = await fetchText(`${normalizedSiteUrl}/llms.txt`);
  expect(llms.response.ok, `/llms.txt failed: ${llms.response.status}`);
  expect(llms.text.includes("Interactive demo"), "/llms.txt is missing English content");

  const spanishLlms = await fetchText(`${normalizedSiteUrl}/es/llms.txt`);
  expect(spanishLlms.response.ok, `/es/llms.txt failed: ${spanishLlms.response.status}`);
  expect(spanishLlms.text.includes("Demo interactiva"), "/es/llms.txt is missing Spanish content");

  const englishDemo = await expectDemoRedirect("/demo", "/workspaces/");
  expect(
    !new URL(englishDemo.location, `${normalizedAppUrl}/demo`).pathname.includes("/es/workspaces/"),
    "/demo redirected into the Spanish workspace path",
  );

  const spanishDemo = await expectDemoRedirect("/es/demo", "/es/workspaces/");

  const workspaceUrl = new URL(englishDemo.location, `${normalizedAppUrl}/demo`).toString();
  const workspace = await fetchText(workspaceUrl, {
    headers: {
      cookie: cookieHeader(englishDemo.setCookie),
    },
  });

  expect(workspace.response.ok, `Demo workspace did not load: ${workspace.response.status}`);
  expect(
    workspace.text.includes("This demo is read-only") || workspace.text.includes("read-only demo environment"),
    "Demo workspace does not appear to be read-only",
  );

  const spanishWorkspaceUrl = new URL(spanishDemo.location, `${normalizedAppUrl}/es/demo`).toString();
  const spanishWorkspace = await fetchText(spanishWorkspaceUrl, {
    headers: {
      cookie: cookieHeader(spanishDemo.setCookie),
    },
  });

  expect(spanishWorkspace.response.ok, `Spanish demo workspace did not load: ${spanishWorkspace.response.status}`);
  expect(
    spanishWorkspace.text.includes("Esta demostración es de solo lectura") ||
      spanishWorkspace.text.includes("entorno de demostración de solo lectura"),
    "Spanish demo workspace does not appear to be localized",
  );

  console.log("Site smoke test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
