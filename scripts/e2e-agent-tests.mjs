/**
 * End-to-End Agent Process Tests
 *
 * Tests all Corgtex agent processes against a live local dev server.
 * Uses AGENT_API_KEY for agent-scoped endpoints and session cookies for user-gated endpoints.
 *
 * Usage:
 *   npm run test:e2e:agents
 *   # or manually:
 *   node scripts/e2e-agent-tests.mjs [base-url] [--strict] [--without-storage]
 *
 * --strict requires every acceptance case to pass; any skip exits 1.
 * --without-storage explicitly declares a missing local fixture prerequisite and
 * skips all three upload cases before making an upload request. Developer mode
 * permits these skips; strict mode reports incomplete acceptance and exits 1.
 * Attempted requests, including HTTP 500, always fail on unexpected responses.
 * Run offline regression tests: node --test scripts/e2e-agent-tests.node-test.mjs
 */
import process from "node:process";
import { createReport } from "./lib/e2e-agent-report.mjs";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));
if ([...flags].some((flag) => !["--strict", "--without-storage"].includes(flag)) || positional.length > 1) {
  console.error("Usage: node scripts/e2e-agent-tests.mjs [base-url] [--strict] [--without-storage]");
  process.exit(1);
}
const BASE_URL = positional[0] || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const report = createReport({ strict: flags.has("--strict") });
const AGENT_API_KEY = process.env.AGENT_API_KEY || "";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const TEST_ID = randomUUID().slice(0, 8);

// How long to wait for worker-driven agent runs to complete (ms)
const WORKER_POLL_TIMEOUT_MS = 90_000;
const WORKER_POLL_INTERVAL_MS = 3_000;

// ---------------------------------------------------------------------------
// Test Harness
// ---------------------------------------------------------------------------
const createdResources = {
  brainSourceIds: [],
  brainArticleSlugs: [],
  meetingIds: [],
  documentIds: [],
  conversationIds: [],
  agentRunIds: [],
};

function fail(suite, id, test, message) {
  report.record(suite, id, "fail", `${test}: ${message}`);
}

function pass(suite, id, test) {
  report.record(suite, id, "pass", test);
}

function agentHeaders() {
  return {
    Authorization: `Bearer agent-${AGENT_API_KEY}`,
    "Content-Type": "application/json",
  };
}

function sessionHeaders(cookie) {
  return {
    Cookie: cookie,
    "Content-Type": "application/json",
  };
}

async function fetchJson(path, options = {}) {
  const url = new URL(path, BASE_URL);
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, json, text };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Suite 1: Auth & Bootstrap
// ---------------------------------------------------------------------------
async function suiteAuthBootstrap() {
  const suite = "Auth";
  console.log("\n━━━ Suite 1: Auth & Bootstrap ━━━");

  // Health check
  const { res: healthRes, json: health } = await fetchJson("/api/health");
  if (!healthRes.ok || (health?.status !== "ok" && health?.ok !== true)) {
    fail(suite, "health", "Health check", `Status: ${healthRes.status}, Body: ${JSON.stringify(health)}`);
    throw new Error("Health check failed — is the server running?");
  }
  pass(suite, "health", "Health check OK");

  // Session via agent bearer
  const { res: sessionRes, json: session } = await fetchJson("/api/session", {
    headers: agentHeaders(),
  });
  if (!sessionRes.ok || session?.actor?.kind !== "agent") {
    fail(suite, "agent-session", "Agent session", `Status: ${sessionRes.status}, Body: ${JSON.stringify(session)}`);
    throw new Error("Agent session failed — check AGENT_API_KEY");
  }
  pass(suite, "agent-session", `Agent session — kind: ${session.actor.kind}, label: ${session.actor.label}`);

  // Discover workspace
  const workspaces = session.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    fail(suite, "workspace", "Workspace discovery", "No workspaces found for agent");
    throw new Error("No workspaces");
  }
  const workspaceId = workspaces[0].id;
  pass(suite, "workspace", `Workspace discovered: ${workspaces[0].name} (${workspaceId})`);

  // Login as admin for user-gated endpoints
  const { res: loginRes, json: loginJson } = await fetchJson("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    redirect: "manual",
  });
  if (!loginRes.ok) {
    fail(suite, "admin-session", "Admin login", `Status: ${loginRes.status}, Body: ${JSON.stringify(loginJson)}`);
    throw new Error("Admin login failed — check ADMIN_EMAIL/ADMIN_PASSWORD");
  }
  const setCookie = loginRes.headers.get("set-cookie");
  const cookie = setCookie ? setCookie.split(";")[0] : null;
  if (!cookie) {
    fail(suite, "admin-session", "Session cookie", "No set-cookie header returned");
    throw new Error("No session cookie");
  }
  pass(suite, "admin-session", "Admin login OK");

  return { workspaceId, cookie };
}

// ---------------------------------------------------------------------------
// Suite 2: Brain Source Ingestion
// ---------------------------------------------------------------------------
async function suiteBrainSources(workspaceId) {
  const suite = "Brain Sources";
  console.log("\n━━━ Suite 2: Brain Source Ingestion ━━━");

  const testContent = `E2E Test Document — ${TEST_ID}

This is a test document for end-to-end validation of the Corgtex Brain ingestion pipeline.

Key provisions:
1. All workspace decisions must be documented within 48 hours.
2. Budget requests over $5,000 require proposal approval.
3. Meeting minutes should capture action items, owners, and deadlines.

This document tests the full flow: ingest → event → brain-absorb agent → article creation/update → knowledge sync.`;

  // Ingest source
  const { res: ingestRes, json: ingestJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/sources`,
    {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        sourceType: "DOC",
        tier: 2,
        content: testContent,
        title: `E2E Test Policy — ${TEST_ID}`,
        channel: "e2e-test",
      }),
    },
  );
  if (!ingestRes.ok || !ingestJson?.source?.id) {
    fail(suite, "ingest", "Ingest source", `Status: ${ingestRes.status}, Body: ${JSON.stringify(ingestJson)}`);
    return;
  }
  const sourceId = ingestJson.source.id;
  createdResources.brainSourceIds.push(sourceId);
  pass(suite, "ingest", `Ingested source: ${sourceId}`);

  // Verify source appears in unabsorbed list
  const { res: listRes, json: listJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/sources?absorbed=false`,
    { headers: agentHeaders() },
  );
  if (!listRes.ok) {
    fail(suite, "listing", "List unabsorbed sources", `Status: ${listRes.status}`);
    return;
  }
  const found = listJson?.items?.find((s) => s.id === sourceId);
  if (!found) {
    fail(suite, "listing", "Verify unabsorbed", "Source not found in unabsorbed list");
    return;
  }
  pass(suite, "listing", "Source appears in unabsorbed list");

  // Check brain status
  const { res: statusRes, json: statusJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/status`,
    { headers: agentHeaders() },
  );
  if (!statusRes.ok) {
    fail(suite, "status", "Brain status", `Status: ${statusRes.status}`);
    return;
  }
  if (typeof statusJson?.unabsorbedSources !== "number" || statusJson.unabsorbedSources < 1) {
    fail(suite, "status", "Brain status unabsorbed count", `Expected >= 1, got ${statusJson?.unabsorbedSources}`);
    return;
  }
  pass(suite, "status", `Brain status OK — ${statusJson.unabsorbedSources} unabsorbed, ${statusJson.totalArticles} articles`);
}

// ---------------------------------------------------------------------------
// Suite 3: File Upload & Document Ingestion
// ---------------------------------------------------------------------------
async function suiteFileUpload(workspaceId) {
  const suite = "File Upload";
  console.log("\n━━━ Suite 3: File Upload & Document Ingestion ━━━");

  if (flags.has("--without-storage")) {
    report.finishSuite(suite, "Missing fixture prerequisite: storage explicitly disabled via --without-storage");
    return;
  }

  const fileContent = `Meeting Minutes — E2E Test ${TEST_ID}
Date: 2026-04-10
Attendees: Alice, Bob, Charlie

Agenda:
1. Budget review for Q2
2. Platform roadmap update
3. New team member onboarding process

Decisions:
- Approved Q2 budget of $50,000 for platform development
- Roadmap: prioritize chat streaming and file ingestion features
- Charlie to draft onboarding proposal by next week

Action Items:
- Alice: Update finance records with Q2 budget approval
- Bob: Create proposal for streaming architecture changes
- Charlie: Draft onboarding documentation by 2026-04-17`;

  const blob = new Blob([fileContent], { type: "text/plain" });
  const formData = new FormData();
  formData.append("file", blob, `e2e-meeting-minutes-${TEST_ID}.txt`);
  formData.append("title", `E2E Meeting Minutes — ${TEST_ID}`);
  formData.append("source", "e2e-test");

  const { res: uploadRes, json: uploadJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/documents`,
    {
      method: "POST",
      headers: { Authorization: `Bearer agent-${AGENT_API_KEY}` },
      body: formData,
    },
  );
  if (!uploadRes.ok || !uploadJson?.id) {
    fail(suite, "upload", "Upload file", `Status: ${uploadRes.status}, Body: ${JSON.stringify(uploadJson)}`);
    return;
  }
  const documentId = uploadJson.id;
  createdResources.documentIds.push(documentId);
  pass(suite, "upload", `Document created: ${documentId}`);

  // Verify document in listing
  const { res: docsRes, json: docsJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/documents`,
    { headers: agentHeaders() },
  );
  if (!docsRes.ok) {
    fail(suite, "listing", "List documents", `Status: ${docsRes.status}`);
    return;
  }
  const docFound = docsJson?.documents?.find((d) => d.id === documentId);
  if (!docFound) {
    fail(suite, "listing", "Verify document", "Document not found in listing");
    return;
  }
  pass(suite, "listing", "Document appears in listing");

  // Verify FILE_UPLOAD brain source was auto-created
  const { res: srcRes, json: srcJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/sources?absorbed=false`,
    { headers: agentHeaders() },
  );
  if (!srcRes.ok) {
    fail(suite, "brain-source", "Check brain source", `Status: ${srcRes.status}`);
    return;
  }
  const fileSource = srcJson?.items?.find(
    (s) => s.sourceType === "FILE_UPLOAD" && s.title?.includes(TEST_ID),
  );
  if (!fileSource) {
    fail(suite, "brain-source", "FILE_UPLOAD source", "No FILE_UPLOAD source found for uploaded file");
    return;
  }
  createdResources.brainSourceIds.push(fileSource.id);
  pass(suite, "brain-source", `FILE_UPLOAD brain source auto-created: ${fileSource.id}`);
}

// ---------------------------------------------------------------------------
// Suite 4: Meeting Minutes Injection
// ---------------------------------------------------------------------------
async function suiteMeetingMinutes(workspaceId) {
  const suite = "Meeting Minutes";
  console.log("\n━━━ Suite 4: Meeting Minutes Injection ━━━");

  const transcript = `Chair: Good morning everyone. Let's start with the governance review.

Alice: I've identified two tensions from last week. First, our approval workflow is too slow for small purchases under $500. Second, we need clearer role definitions for the new circles.

Bob: I agree on the approval threshold. I propose we create an express lane for purchases under $500 requiring only one approval.

Charlie: Sounds reasonable. I'll draft that proposal.

Chair: Any objections? None noted. Charlie, please have the proposal ready by Friday.

Alice: Moving on to the roadmap — the streaming chat feature is critical for our Q2 goals. Bob, can you update us?

Bob: Yes, the streaming architecture is ready. We need to finalize the SSE implementation and update the frontend component. Estimated 2 weeks.

Chair: Great. Let's also address the onboarding issue Charlie raised.

Charlie: New members don't have a clear path to understand our governance model. I suggest we create an onboarding guide in the Brain wiki.

Chair: Excellent idea. Let's wrap up with action items.

Meeting concluded at 10:45 AM.`;

  const { res: meetRes, json: meetJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/meetings`,
    {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        title: `E2E Governance Review — ${TEST_ID}`,
        source: "e2e-test",
        recordedAt: new Date().toISOString(),
        transcript,
        summaryMd: null,
      }),
    },
  );
  if (!meetRes.ok || !meetJson?.id) {
    fail(suite, "create", "Create meeting", `Status: ${meetRes.status}, Body: ${JSON.stringify(meetJson)}`);
    return;
  }
  const meetingId = meetJson.id;
  createdResources.meetingIds.push(meetingId);
  pass(suite, "create", `Meeting created: ${meetingId}`);

  // Verify meeting in listing
  const { res: listRes, json: listJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/meetings`,
    { headers: agentHeaders() },
  );
  if (!listRes.ok) {
    fail(suite, "listing", "List meetings", `Status: ${listRes.status}`);
    return;
  }
  const meetFound = listJson?.meetings?.find((m) => m.id === meetingId);
  if (!meetFound) {
    fail(suite, "listing", "Verify meeting", "Meeting not found in listing");
    return;
  }
  pass(suite, "listing", "Meeting appears in listing");

  // Wait for worker to process meeting-summary agent
  console.log("  ⏳ Waiting for worker to process meeting-summary agent...");
  const summaryCompleted = await pollForAgentRun(workspaceId, "meeting-summary", meetingId);
  if (summaryCompleted?.status === "COMPLETED") {
    pass(suite, "summary-agent", `Meeting summary agent completed (run: ${summaryCompleted.id})`);
  } else {
    fail(suite, "summary-agent", "Meeting summary agent", `Expected COMPLETED, got ${summaryCompleted?.status ?? "timeout"}`);
  }

  // Check if meeting now has a summary
  const { json: updatedMeeting } = await fetchJson(
    `/api/workspaces/${workspaceId}/meetings`,
    { headers: agentHeaders() },
  );
  const withSummary = updatedMeeting?.meetings?.find((m) => m.id === meetingId);
  if (withSummary?.summaryMd) {
    pass(suite, "summary-persisted", `Meeting summary persisted (${withSummary.summaryMd.length} chars)`);
  } else {
    fail(suite, "summary-persisted", "Meeting summary persisted", "summaryMd is still null after agent run");
  }

  // Wait for action-extraction (depends on meeting-summary)
  console.log("  ⏳ Waiting for worker to process action-extraction agent...");
  const actionCompleted = await pollForAgentRun(workspaceId, "action-extraction", meetingId);
  if (actionCompleted) {
    const status = actionCompleted.status;
    if (status === "WAITING_APPROVAL" || status === "COMPLETED") {
      pass(suite, "action-agent", `Action extraction agent finished — status: ${status}`);
    } else {
      fail(suite, "action-agent", "Action extraction status", `Expected WAITING_APPROVAL or COMPLETED, got ${status}`);
    }
  } else {
    fail(suite, "action-agent", "Action extraction agent", "Agent run did not complete within timeout");
  }
}

async function pollForAgentRun(workspaceId, agentKey, relatedId) {
  const start = Date.now();
  while (Date.now() - start < WORKER_POLL_TIMEOUT_MS) {
    const { json } = await fetchJson(
      `/api/workspaces/${workspaceId}/agent-runs`,
      { headers: agentHeaders() },
    );
    const runs = json?.runs ?? [];
    const match = runs.find(
      (r) =>
        r.agentKey === agentKey &&
        (r.status === "COMPLETED" || r.status === "WAITING_APPROVAL" || r.status === "FAILED") &&
        // Check if the goal or payload relates to our test meeting
        (JSON.stringify(r.planJson)?.includes(relatedId) ||
          JSON.stringify(r.resultJson)?.includes(relatedId) ||
          JSON.stringify(r.contextJson)?.includes(relatedId)),
    );
    if (match) {
      if (!createdResources.agentRunIds.includes(match.id)) {
        createdResources.agentRunIds.push(match.id);
      }
      return match;
    }
    await sleep(WORKER_POLL_INTERVAL_MS);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Suite 5: Agent Run Triggering (Manual via session cookie)
// ---------------------------------------------------------------------------
async function suiteAgentTrigger(workspaceId, cookie) {
  const suite = "Agent Trigger";
  console.log("\n━━━ Suite 5: Agent Run Triggering ━━━");

  // These require ADMIN role, so we use session cookie
  const agents = [
    { agentKey: "inbox-triage", payload: {} },
    { agentKey: "brain-maintenance", payload: {} },
    { agentKey: "constitution-synthesis", payload: {} },
    {
      agentKey: "proposal-drafting",
      payload: { prompt: `E2E test: Draft a proposal for standardized meeting formats — ${TEST_ID}` },
    },
  ];

  for (const { agentKey, payload } of agents) {
    const { res, json } = await fetchJson(`/api/workspaces/${workspaceId}/agent-runs`, {
      method: "POST",
      headers: sessionHeaders(cookie),
      body: JSON.stringify({ agentKey, ...payload }),
    });
    if (!res.ok || !json?.job?.id) {
      fail(suite, agentKey, `Trigger ${agentKey}`, `Status: ${res.status}, Body: ${JSON.stringify(json)}`);
      continue;
    }
    pass(suite, agentKey, `Triggered ${agentKey} — job: ${json.job.id}`);
  }

  // Wait a bit and check agent runs listing
  console.log("  ⏳ Waiting 10s for triggered agents to start...");
  await sleep(10_000);

  const { res: runsRes, json: runsJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/agent-runs`,
    { headers: agentHeaders() },
  );
  if (!runsRes.ok) {
    fail(suite, "listing", "List agent runs", `Status: ${runsRes.status}`);
    return;
  }
  const runs = runsJson?.runs ?? [];
  pass(suite, "listing", `Agent runs listing OK — ${runs.length} total runs visible`);

  // Check for completed/running runs from our triggers
  const statuses = {};
  for (const run of runs) {
    statuses[run.status] = (statuses[run.status] || 0) + 1;
  }
  console.log(`  ℹ  Run statuses: ${JSON.stringify(statuses)}`);
}

// ---------------------------------------------------------------------------
// Suite 6: Conversation Agent
// ---------------------------------------------------------------------------
async function suiteConversation(workspaceId, cookie) {
  const suite = "Conversation";
  console.log("\n━━━ Suite 6: Conversation Agent ━━━");

  // Create a conversation session (requires user actor)
  const { res: createRes, json: createJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/conversations`,
    {
      method: "POST",
      headers: sessionHeaders(cookie),
      body: JSON.stringify({
        agentKey: "assistant",
        topic: `E2E Test — ${TEST_ID}`,
      }),
    },
  );
  if (!createRes.ok || !createJson?.session?.id) {
    fail(suite, "create", "Create conversation", `Status: ${createRes.status}, Body: ${JSON.stringify(createJson)}`);
    return;
  }
  const sessionId = createJson.session.id;
  createdResources.conversationIds.push(sessionId);
  pass(suite, "create", `Conversation created: ${sessionId}`);

  // Send a message and receive SSE stream
  const userMessage = `What are the key governance principles in this workspace? This is an E2E test message — ${TEST_ID}`;
  const streamUrl = new URL(`/api/workspaces/${workspaceId}/conversations/${sessionId}`, BASE_URL);
  const streamRes = await fetch(streamUrl, {
    method: "POST",
    headers: sessionHeaders(cookie),
    body: JSON.stringify({ message: userMessage }),
  });

  if (!streamRes.ok) {
    const errText = await streamRes.text();
    fail(suite, "stream", "Send message", `Status: ${streamRes.status}, Body: ${errText}`);
    return;
  }

  // Read the SSE stream
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = "";
  let gotDone = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            gotDone = true;
          } else {
            try {
              const parsed = JSON.parse(data);
              if (parsed.text) {
                fullResponse += parsed.text;
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
      }
    }
  } catch (err) {
    fail(suite, "stream", "Stream reading", err.message);
    return;
  }

  if (!gotDone) {
    fail(suite, "stream", "Stream completion", "Never received [DONE] signal");
    return;
  }
  if (fullResponse.length < 10) {
    fail(suite, "stream", "Stream content", `Response too short (${fullResponse.length} chars)`);
    return;
  }
  pass(suite, "stream", `Streamed response received (${fullResponse.length} chars)`);

  // Verify turn was persisted
  await sleep(1000); // wait for persistence
  const { res: convRes, json: convJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/conversations/${sessionId}`,
    { headers: sessionHeaders(cookie) },
  );
  if (!convRes.ok) {
    fail(suite, "persistence", "Get conversation", `Status: ${convRes.status}`);
    return;
  }
  const turns = convJson?.conversation?.turns ?? [];
  if (turns.length === 0) {
    fail(suite, "persistence", "Turn persistence", "No turns found in conversation");
    return;
  }
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn.userMessage?.includes(TEST_ID)) {
    fail(suite, "persistence", "Turn persistence", "Last turn does not contain our test message");
    return;
  }
  if (!lastTurn.assistantMessage || lastTurn.assistantMessage.length < 10) {
    fail(suite, "persistence", "Turn persistence", "Assistant message not persisted properly");
    return;
  }
  pass(suite, "persistence", `Turn persisted — user: ${lastTurn.userMessage.length} chars, assistant: ${lastTurn.assistantMessage.length} chars`);
}

// ---------------------------------------------------------------------------
// Suite 7: Brain Knowledge Search & Ask
// ---------------------------------------------------------------------------
async function suiteKnowledgeSearch(workspaceId) {
  const suite = "Knowledge";
  console.log("\n━━━ Suite 7: Brain Knowledge Search & Ask ━━━");

  // Search knowledge
  const { res: searchRes, json: searchJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/search?q=governance+budget+approval&limit=5`,
    { headers: agentHeaders() },
  );
  if (!searchRes.ok) {
    fail(suite, "search", "Search knowledge", `Status: ${searchRes.status}, Body: ${JSON.stringify(searchJson)}`);
    return;
  }
  const results = searchJson?.results ?? [];
  pass(suite, "search", `Search returned ${results.length} results`);
  if (results.length > 0) {
    console.log(`  ℹ  Top result: "${results[0].title}" (${results[0].sourceType}, score: ${results[0].score})`);
  }

  // Ask a question
  const { res: askRes, json: askJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/ask`,
    {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        question: "What are the workspace approval requirements for spending?",
        limit: 4,
      }),
    },
  );
  if (!askRes.ok) {
    fail(suite, "ask", "Ask question", `Status: ${askRes.status}, Body: ${JSON.stringify(askJson)}`);
    return;
  }
  if (!askJson?.answer || askJson.answer.length < 10) {
    fail(suite, "ask", "Ask answer", `Answer too short: "${askJson?.answer}"`);
    return;
  }
  const citationCount = askJson.citations?.length ?? 0;
  pass(suite, "ask", `Ask answered (${askJson.answer.length} chars, ${citationCount} citations)`);
}

// ---------------------------------------------------------------------------
// Suite 8: Brain Articles & Status
// ---------------------------------------------------------------------------
async function suiteBrainArticles(workspaceId) {
  const suite = "Brain Articles";
  console.log("\n━━━ Suite 8: Brain Articles & Status ━━━");

  const slug = `e2e-test-article-${TEST_ID}`;
  const title = `E2E Test Article — ${TEST_ID}`;
  const bodyMd = `# ${title}

This is an end-to-end test article for validating the Brain wiki system.

## Key Features Tested
- Article creation via API
- Article listing and retrieval
- Article deletion during cleanup

## Cross References
This article validates the full [[Brain]] lifecycle including [[Knowledge Sync]] pipeline integration.

---
*Generated by E2E test suite*`;

  // Create article
  const { res: createRes, json: createJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/articles`,
    {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        slug,
        title,
        type: "GLOSSARY",
        authority: "DRAFT",
        bodyMd,
      }),
    },
  );
  if (!createRes.ok || !createJson?.article?.id) {
    fail(suite, "create", "Create article", `Status: ${createRes.status}, Body: ${JSON.stringify(createJson)}`);
    return;
  }
  createdResources.brainArticleSlugs.push(slug);
  pass(suite, "create", `Article created: ${slug}`);

  // List articles
  const { res: listRes, json: listJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/articles`,
    { headers: agentHeaders() },
  );
  if (!listRes.ok) {
    fail(suite, "listing", "List articles", `Status: ${listRes.status}`);
    return;
  }
  const found = listJson?.items?.find((a) => a.slug === slug);
  if (!found) {
    fail(suite, "listing", "Verify article listing", "Article not found in listing");
    return;
  }
  pass(suite, "listing", `Article appears in listing (${listJson.total} total)`);

  // Get article detail
  const { res: getRes, json: getJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/articles/${slug}`,
    { headers: agentHeaders() },
  );
  if (!getRes.ok || !getJson?.article) {
    fail(suite, "detail", "Get article", `Status: ${getRes.status}`);
    return;
  }
  if (getJson.article.title !== title) {
    fail(suite, "detail", "Article detail", `Title mismatch: expected "${title}", got "${getJson.article.title}"`);
    return;
  }
  pass(suite, "detail", "Article detail matches");

  // Update article
  const { res: updateRes, json: updateJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/articles/${slug}`,
    {
      method: "PATCH",
      headers: agentHeaders(),
      body: JSON.stringify({
        bodyMd: bodyMd + "\n\n## Updated Section\nThis section was added by the E2E update test.",
        changeSummary: "E2E test update",
      }),
    },
  );
  if (!updateRes.ok) {
    fail(suite, "update", "Update article", `Status: ${updateRes.status}, Body: ${JSON.stringify(updateJson)}`);
    return;
  }
  pass(suite, "update", "Article updated successfully (version history created)");

  // Brain status
  const { res: statusRes, json: statusJson } = await fetchJson(
    `/api/workspaces/${workspaceId}/brain/status`,
    { headers: agentHeaders() },
  );
  if (!statusRes.ok) {
    fail(suite, "status", "Brain status", `Status: ${statusRes.status}`);
    return;
  }
  console.log(`  ℹ  Brain status: ${statusJson.totalArticles} articles, ${statusJson.unabsorbedSources} unabsorbed, ${statusJson.openDiscussionThreads} open threads`);
  pass(suite, "status", "Brain status metrics retrieved");
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function cleanup(workspaceId, cookie) {
  console.log("\n━━━ Cleanup ━━━");
  let deletionFailures = 0;

  // Delete brain articles
  for (const slug of createdResources.brainArticleSlugs) {
    try {
      const { res } = await fetchJson(`/api/workspaces/${workspaceId}/brain/articles/${slug}`, {
        method: "DELETE",
        headers: agentHeaders(),
      });
      if (res.ok) {
        console.log(`  Deleted article: ${slug}`);
      } else {
        deletionFailures++;
        console.log(`  WARNING:  Failed to delete article ${slug}: ${res.status}`);
      }
    } catch (err) {
      deletionFailures++;
      console.log(`  WARNING:  Error deleting article ${slug}: ${err.message}`);
    }
  }

  // Delete brain sources
  for (const sourceId of createdResources.brainSourceIds) {
    try {
      const { res } = await fetchJson(`/api/workspaces/${workspaceId}/brain/sources/${sourceId}`, {
        method: "DELETE",
        headers: agentHeaders(),
      });
      if (res.ok) {
        console.log(`  Deleted brain source: ${sourceId}`);
      } else {
        deletionFailures++;
        console.log(`  WARNING:  Failed to delete brain source ${sourceId}: ${res.status}`);
      }
    } catch (err) {
      deletionFailures++;
      console.log(`  WARNING:  Error deleting brain source ${sourceId}: ${err.message}`);
    }
  }

  // Delete documents
  for (const docId of createdResources.documentIds) {
    try {
      const { res } = await fetchJson(`/api/workspaces/${workspaceId}/documents/${docId}`, {
        method: "DELETE",
        headers: agentHeaders(),
      });
      if (res.ok) {
        console.log(`  Deleted document: ${docId}`);
      } else {
        deletionFailures++;
        console.log(`  WARNING:  Failed to delete document ${docId}: ${res.status}`);
      }
    } catch (err) {
      deletionFailures++;
      console.log(`  WARNING:  Error deleting document ${docId}: ${err.message}`);
    }
  }

  // Delete meetings
  for (const meetingId of createdResources.meetingIds) {
    try {
      const { res } = await fetchJson(`/api/workspaces/${workspaceId}/meetings/${meetingId}`, {
        method: "DELETE",
        headers: agentHeaders(),
      });
      if (res.ok) {
        console.log(`  Deleted meeting: ${meetingId}`);
      } else {
        deletionFailures++;
        console.log(`  WARNING:  Failed to delete meeting ${meetingId}: ${res.status}`);
      }
    } catch (err) {
      deletionFailures++;
      console.log(`  WARNING:  Error deleting meeting ${meetingId}: ${err.message}`);
    }
  }

  // Delete conversations (requires session cookie)
  for (const conversationId of createdResources.conversationIds) {
    try {
      // NOTE: conversations use session cookies since agent auth falls through to user checks
      // We pass the session cookie (if available) otherwise this might fail since only users can create/delete convos
      const headers = { ...agentHeaders() };
      if (cookie) {
        headers["Cookie"] = cookie;
      }
      
      const { res } = await fetchJson(`/api/workspaces/${workspaceId}/conversations/${conversationId}`, {
        method: "DELETE",
        headers, // E2E tests are run with admin session or agent token.
      });
      if (res.ok) {
        console.log(`  Deleted conversation: ${conversationId}`);
      } else {
        deletionFailures++;
        console.log(`  WARNING:  Failed to delete conversation ${conversationId}: ${res.status}`);
      }
    } catch (err) {
      deletionFailures++;
      console.log(`  WARNING:  Error deleting conversation ${conversationId}: ${err.message}`);
    }
  }

  // Agent runs (log them)
  if (createdResources.agentRunIds.length > 0) {
    console.log(`  ℹ  Agent runs observed: ${createdResources.agentRunIds.join(", ")}`);
  }

  if (deletionFailures > 0) {
    console.log(`  WARNING:  Cleanup finished with ${deletionFailures} resource deletion failure(s)`);
  } else {
    console.log("  ✅ Resource cleanup finished");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║   Corgtex E2E Agent Process Tests                      ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test ID:  ${TEST_ID}`);
  console.log("");

  let workspaceId;
  let cookie;
  try {
    const missing = ["AGENT_API_KEY", "ADMIN_EMAIL", "ADMIN_PASSWORD"].filter((key) => !process.env[key]);
    if (missing.length > 0) {
      report.error("Prerequisites", `Missing fixture prerequisites: ${missing.join(", ")}`);
      return;
    }
    try {
      ({ workspaceId, cookie } = await suiteAuthBootstrap());
    } catch (err) {
      report.abortSuite("Auth", `Bootstrap aborted: ${err.message}`);
      return;
    } finally {
      report.finishSuite("Auth");
    }

    for (const [suite, run] of [
      ["Brain Sources", () => suiteBrainSources(workspaceId)],
      ["File Upload", () => suiteFileUpload(workspaceId)],
      ["Meeting Minutes", () => suiteMeetingMinutes(workspaceId)],
      ["Agent Trigger", () => suiteAgentTrigger(workspaceId, cookie)],
      ["Conversation", () => suiteConversation(workspaceId, cookie)],
      ["Knowledge", () => suiteKnowledgeSearch(workspaceId)],
      ["Brain Articles", () => suiteBrainArticles(workspaceId)],
    ]) {
      try {
        await run();
      } catch (err) {
        report.abortSuite(suite, `Suite error: ${err.message}`);
      } finally {
        report.finishSuite(suite);
      }
    }
  } finally {
    if (workspaceId) {
      try {
        await cleanup(workspaceId, cookie);
      } catch (err) {
        report.error("Cleanup", err.message);
      }
    }
    process.exitCode = report.summary().exitCode;
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exitCode = 1;
});
