import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as capture } from "./route";
import { POST as qualify } from "./qualify/route";
import { signupUrlForLocale } from "../../../lib/site";

const fetchMock = vi.fn();
function request(body: unknown = { email: "synthetic@example.invalid" }, headers = {}) {
  return new NextRequest("https://www.corgtex.com/api/demo-leads?backend=https://untrusted.invalid", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

describe("site demo backend continuity", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://selfserve.corgtex.com");
    vi.stubEnv("DEMO_BACKEND_URL", undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockReset().mockImplementation(async () => Response.json({ ok: true }));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each([{ stage: "capture", handler: capture }, { stage: "qualify", handler: qualify }])("does not impose a timeout or retry a pending $stage write", async ({ handler }) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    let settled = false;
    const pending = handler(request()).then(response => { settled = true; return response; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("signal");
    expect(timeout).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    finish(Response.json({ ok: true }));
    expect((await pending).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([{ stage: "capture", handler: capture }, { stage: "qualify", handler: qualify }])("logs only fixed diagnostic fields for $stage failures", async ({ stage, handler }) => {
    const secret = "synthetic-sensitive-sentinel";
    const input = () => request({ token: secret, email: secret }, { Cookie: secret, Authorization: secret, "x-real-ip": secret });
    vi.stubEnv("DEMO_BACKEND_URL", `https://user:${secret}@private.invalid`);
    await handler(input());
    vi.stubEnv("DEMO_BACKEND_URL", `https://${secret}.invalid`);
    fetchMock.mockRejectedValueOnce(new Error(secret))
      .mockResolvedValueOnce(Response.json({ error: secret }, { status: 503 }))
      .mockResolvedValueOnce(new Response(secret, { status: 307, headers: { Location: `https://${secret}.invalid` } }))
      .mockResolvedValueOnce(new Response(`<html>${secret}</html>`, { status: 400 }))
      .mockResolvedValueOnce(Response.json([secret]))
      .mockResolvedValueOnce(Response.json({ error: { code: "INVALID_INPUT", message: "Invalid qualification token.", debug: secret } }, { status: 400 }));
    for (let i = 0; i < 6; i++) await handler(input());
    await handler(new NextRequest("https://site.invalid/api/demo-leads", { method: "POST", body: secret }));
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["Demo proxy failure", { stage, failureClass: "invalid_configuration", status: 503 }],
      ["Demo proxy failure", { stage, failureClass: "transport", status: 502 }],
      ["Demo proxy failure", { stage, failureClass: "upstream_status", status: 503 }],
      ["Demo proxy failure", { stage, failureClass: "upstream_redirect", status: 307 }],
      ["Demo proxy failure", { stage, failureClass: "invalid_upstream_response", status: 400 }],
      ["Demo proxy failure", { stage, failureClass: "invalid_upstream_response", status: 200 }],
      ["Demo proxy failure", { stage, failureClass: "upstream_status", status: 400 }],
      ["Demo proxy failure", { stage, failureClass: "invalid_payload", status: 400 }],
    ]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(secret);
  });

  it("keeps both stages on Core while signup goes to selfserve", async () => {
    expect((await capture(request())).status).toBe(200);
    expect((await qualify(request({ token: "synthetic-token" }))).status).toBe(200);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://app.corgtex.com/api/demo-leads", "https://app.corgtex.com/api/demo-leads/qualify",
    ]);
    expect(signupUrlForLocale("en")).toBe("https://selfserve.corgtex.com/signup");
  });

  it("uses one configured origin for capture and qualification token continuity", async () => {
    vi.stubEnv("DEMO_BACKEND_URL", " https://core.example.invalid/ ");
    const tokens = new Set<string>();
    fetchMock.mockImplementation(async (url, init) => {
      expect(new URL(url).origin).toBe("https://core.example.invalid");
      const body = JSON.parse(init.body);
      if (url.endsWith("/qualify")) return tokens.has(body.token)
        ? Response.json({ ok: true, qualificationId: "synthetic-qualification" })
        : Response.json({ error: { code: "INVALID_TOKEN", message: "Invalid or expired token" } }, { status: 404 });
      tokens.add("issued-by-core");
      return Response.json({ ok: true }, { status: 201 });
    });
    expect((await capture(request())).status).toBe(201);
    expect(await (await qualify(request({ token: "issued-by-core" }))).json()).toEqual({ ok: true, qualificationId: "synthetic-qualification" });
    const invalid = await qualify(request({ token: "other-backend-token" }));
    expect(invalid.status).toBe(404);
    expect(await invalid.json()).toEqual({ error: { code: "INVALID_TOKEN", message: "Invalid or expired token" } });
  });

  it.each(["", "nonsense", "//core.invalid", "ftp://core.invalid", "http://core.invalid", "http://127.0.0.1:3291", "https://user:secret@core.invalid", "https://core.invalid/path", "https://core.invalid?token=secret", "https://core.invalid/#fragment"])("fails closed for invalid origin %s", async value => {
    vi.stubEnv("DEMO_BACKEND_URL", value);
    for (const handler of [capture, qualify]) expect((await handler(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports explicit local development without coupling to public APP URL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEMO_BACKEND_URL", "http://127.0.0.1:3291");
    await capture(request());
    await qualify(request());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["http://127.0.0.1:3291/api/demo-leads", "http://127.0.0.1:3291/api/demo-leads/qualify"]);
  });

  it("forwards only content and existing rate-limit IP headers, without redirects or credentials", async () => {
    await qualify(request({ token: "synthetic" }, { Cookie: "session=private", Authorization: "Bearer private", "x-api-key": "private", "x-forwarded-host": "untrusted.invalid", "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.1" }));
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { "Content-Type": "application/json", "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.1" }, redirect: "error", cache: "no-store" });
    expect(Object.keys(fetchMock.mock.calls[0][1].headers)).toHaveLength(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://app.corgtex.com/api/demo-leads/qualify");
  });

  it.each([400, 404, 409, 429])("preserves useful JSON error status %s and strips extra fields", async status => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: "INVALID_TOKEN", message: "Invalid or expired token", stack: "private" }, debug: "private" }, { status }));
    const response = await qualify(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: "INVALID_TOKEN", message: "Invalid or expired token" } });
  });

  it("preserves string validation errors", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Missing required fields" }, { status: 400 }));
    expect(await (await qualify(request())).json()).toEqual({ error: "Missing required fields" });
  });

  it.each([200, 400, 502])("does not expose upstream HTML at status %s", async status => {
    fetchMock.mockResolvedValue(new Response("<html>private upstream trace</html>", { status }));
    const response = await capture(request());
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("private");
  });

  it("hides internal JSON errors and transport exceptions", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "private SQL connection string" }, { status: 503 }))
      .mockRejectedValueOnce(new Error("private transport destination"));
    expect((await capture(request())).status).toBe(503);
    expect(await (await qualify(request())).json()).toEqual({ error: "Demo service is temporarily unavailable. Please try again." });
  });

  it("does not retry or fall back to another backend after a redirect", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 307, headers: { Location: "https://other.invalid" } }));
    const response = await qualify(request());
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects malformed JSON without contacting the backend", async () => {
    const response = await capture(new NextRequest("https://site.invalid/api/demo-leads", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
