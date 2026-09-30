import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("preserves exact OAuth queries through actual middleware and ordinary routes", () => {
  // tsx supplies the same supported module resolution as the application for
  // next-intl's extensionless Next import, without replacing middleware behavior.
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx"], {
    cwd: repo,
    env: { ...process.env, TSX_TSCONFIG_PATH: `${repo}/apps/web/tsconfig.json` },
    encoding: "utf8",
    input: String.raw`
      const assert = require("node:assert/strict");
      const { NextRequest } = require("next/server");
      const config = require("./apps/web/next.config.ts").default;
      assert.equal(config.skipMiddlewareUrlNormalize, true);
      process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = "true";
      const middleware = require("./apps/web/middleware.ts").default;
      const query = "redirect_uri=http%3A%2F%2F127.0.0.1%3A56288%2Fcallback%2Fcodex"
        + "&state=opaque-127.0.0.1%2Bvalue%252Fkeep&scope=workspace%3Aread+actions%3Awrite";
      const request = new NextRequest("https://selfserve.corgtex.test/oauth/authorize?" + query);
      assert.ok(request.nextUrl.search.includes("localhost"));
      const redirect = middleware(request);
      assert.equal(redirect.status, 307);
      assert.equal(redirect.headers.get("location"), "https://selfserve.corgtex.test/en/oauth/authorize?" + query);
      for (const locale of ["en", "es"]) {
        const localized = new NextRequest("https://selfserve.corgtex.test/" + locale + "/oauth/authorize?" + query);
        const response = middleware(localized);
        assert.equal(localized.nextUrl.search, "?" + query);
        assert.equal(response.headers.get("x-middleware-request-x-next-intl-locale"), locale);
        assert.equal(response.headers.get("location"), null);
      }
      const page = middleware(new NextRequest("https://selfserve.corgtex.test/login?next=%2Fworkspaces"));
      assert.equal(page.headers.get("location"), "https://selfserve.corgtex.test/en/login?next=%2Fworkspaces");
      const api = middleware(new NextRequest("https://selfserve.corgtex.test/api/oauth/authorize?" + query));
      assert.equal(api.headers.get("x-middleware-next"), "1");
      assert.equal(api.headers.get("location"), null);
    `,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
