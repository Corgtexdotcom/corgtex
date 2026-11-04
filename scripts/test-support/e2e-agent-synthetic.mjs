// Offline-only synthetic responses: never delegates to the real fetch.
const scenario = process.env.E2E_SYNTHETIC_SCENARIO || "pass";
let testId;
let article;
let message;
globalThis.setTimeout = (fn) => {
  queueMicrotask(fn);
  return 0;
};
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  if (parsed.origin !== "http://offline.invalid")
    throw new Error("Synthetic runner refuses any other target");
  const path = parsed.pathname;
  console.log(`SYNTHETIC_REQUEST ${options.method || "GET"} ${path}`);
  const method = options.method || "GET";
  const body = typeof options.body === "string" ? JSON.parse(options.body) : {};
  let data;
  let status = 200;
  let headers = {};
  if (path === "/api/health") {
    if (scenario === "bootstrap-network")
      throw new Error("synthetic bootstrap network failure");
    status = scenario === "bootstrap-500" ? 500 : 200;
    data = { ok: true };
  } else if (path === "/api/session")
    data = {
      actor: { kind: "agent", label: "synthetic" },
      workspaces: [{ id: "w", name: "synthetic" }],
    };
  else if (path === "/api/auth/login") {
    data = {};
    headers = { "set-cookie": "synthetic=only; Path=/" };
  } else if (method === "DELETE") data = {};
  else if (path.endsWith("/brain/sources") && method === "POST") {
    testId = body.title.split(" — ")[1];
    data = { source: { id: "s" } };
  } else if (path.endsWith("/brain/sources"))
    data = {
      items: [
        { id: "s" },
        { id: "fs", sourceType: "FILE_UPLOAD", title: testId },
      ],
    };
  else if (path.endsWith("/brain/status"))
    data = { unabsorbedSources: 1, totalArticles: 1 };
  else if (path.endsWith("/documents") && method === "POST") {
    if (scenario === "no-storage-request")
      throw new Error("Upload must not be attempted without storage");
    status =
      scenario === "500"
        ? 500
        : scenario === "503"
          ? 503
          : scenario === "401"
            ? 401
            : 200;
    data =
      scenario === "malformed"
        ? {}
        : status === 200
          ? { id: "d" }
          : { error: "synthetic server regression" };
    if (scenario === "network") throw new Error("synthetic network failure");
  } else if (path.endsWith("/documents"))
    data = { documents: scenario === "missing-document" ? [] : [{ id: "d" }] };
  else if (path.endsWith("/meetings") && method === "POST") data = { id: "m" };
  else if (path.endsWith("/meetings"))
    data = { meetings: [{ id: "m", summaryMd: "synthetic summary" }] };
  else if (path.endsWith("/agent-runs") && method === "POST")
    data = { job: { id: "j" } };
  else if (path.endsWith("/agent-runs"))
    data = {
      runs: ["meeting-summary", "action-extraction"].map((agentKey) => ({
        id: agentKey,
        agentKey,
        status:
          agentKey === "meeting-summary" && scenario === "failed-worker"
            ? "FAILED"
            : "COMPLETED",
        planJson: "m",
      })),
    };
  else if (path.endsWith("/conversations") && method === "POST")
    data = { session: { id: "c" } };
  else if (path.endsWith("/conversations/c") && method === "POST") {
    message = body.message;
    return new Response(
      'data: {"text":"synthetic answer long enough"}\n\ndata: [DONE]\n\n',
    );
  } else if (path.endsWith("/conversations/c"))
    data = {
      conversation: {
        turns: [
          {
            userMessage: message,
            assistantMessage: "synthetic answer long enough",
          },
        ],
      },
    };
  else if (path.endsWith("/brain/search")) data = { results: [] };
  else if (path.endsWith("/brain/ask"))
    data = { answer: "synthetic answer long enough", citations: [] };
  else if (path.endsWith("/brain/articles") && method === "POST") {
    article = body;
    data = { article: { id: "a" } };
  } else if (path.endsWith("/brain/articles"))
    data = { items: [article], total: 1 };
  else if (path.includes("/brain/articles/") && method === "PATCH") data = {};
  else if (path.includes("/brain/articles/")) data = { article };
  else throw new Error(`Unexpected synthetic request: ${method} ${path}`);
  return new Response(JSON.stringify(data), { status, headers });
};
