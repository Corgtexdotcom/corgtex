#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises"; import path from "node:path"; import { pathToFileURL } from "node:url";
import { env, prisma } from "@corgtex/shared"; import { openAICompatibleModelGateway } from "@corgtex/models";
import { requireInternalValidationWorkspace } from "./lib/validation-workspace.mjs";
const TOOL_NAME = "respond_route_stream_contract"; const EXPECTED_ANSWER = "route-stream-contract-ok";
function assert(condition, message) { if (!condition) throw new Error(message); }
export function smokeConfig(source, argv = []) {
  const preflightOnly = argv.includes("--preflight-only");
  assert(preflightOnly || source.MODEL_ROUTE_STREAM_SMOKE_CONFIRM_ONE_PAID_REQUEST === "1", "Paid-request acknowledgement is required.");
  const workspaceId = source.MODEL_ROUTE_STREAM_SMOKE_WORKSPACE_ID?.trim(); assert(workspaceId, "Approved internal-validation workspace id is required.");
  const out = argv.find((value) => value.startsWith("--out="))?.slice(6); const artifactRoot = path.resolve(".artifacts/model-route-stream-contract");
  const resolvedOut = path.resolve(out ?? "");
  assert(resolvedOut.startsWith(`${artifactRoot}${path.sep}`), "Output must stay under the approved artifact directory.");
  return { workspaceId, out: resolvedOut, preflightOnly };
}
export function guardOneProviderRequest(fetchImpl, onRequest = () => {}) {
  let count = 0; const guarded = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input); if (url.includes("/chat/completions")) { onRequest(); count += 1; assert(count === 1, "Provider request limit exceeded."); }
    return fetchImpl(input, init); };
  return { guarded, count: () => count };
}
export async function runContractSmoke({
  source = process.env, argv = process.argv.slice(2),
  gateway = openAICompatibleModelGateway,
  findWorkspace = (id) => prisma.workspace.findUnique({ where: { id }, select: { id: true, slug: true, plan: true, modelUsageBudget: { select: { id: true } } } }),
  countResidue = (id) => Promise.all([prisma.workspace.count({ where: { id } }), prisma.modelUsage.count({ where: { workspaceId: id } }), prisma.aiUsageLedgerEntry.count({ where: { workspaceId: id } })]),
  fetchImpl = globalThis.fetch,
  writeEvidence = async (out, evidence) => { await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }); },
} = {}) {
  const config = smokeConfig(source, argv); let failurePhase = "provider_preflight"; let residueBefore;
  const localBoundary = async () => new Response("preflight-only", { status: 418 }); const guard = guardOneProviderRequest(config.preflightOnly ? localBoundary : fetchImpl, () => { failurePhase = "provider_stream"; });
  try {
  const model = source.MODEL_CHAT_CONVERSATION ?? env.MODEL_CHAT_CONVERSATION; const routes = source.MODEL_PROVIDER_ROUTES_JSON ? JSON.parse(source.MODEL_PROVIDER_ROUTES_JSON) : [];
  const route = routes.find((entry) => entry?.model === model);
  const provider = String(route?.provider ?? source.MODEL_PROVIDER ?? env.MODEL_PROVIDER).toLowerCase();
  assert(["openrouter", "openai", "azure-openai", "azure-foundry"].includes(provider), "Configured provider is not live-compatible.");
  const authMode = route?.authMode ?? source.AZURE_OPENAI_AUTH_MODE ?? env.AZURE_OPENAI_AUTH_MODE; const credential = route?.apiKeyEnv ? source[route.apiKeyEnv] : provider.startsWith("azure-") ? source.AZURE_OPENAI_API_KEY ?? source.MODEL_API_KEY : source.MODEL_API_KEY;
  assert(provider.startsWith("azure-") && authMode === "managed_identity" || Boolean(credential?.trim()), "Configured credential source is unavailable.");
  failurePhase = "workspace_validation";
  const workspace = await findWorkspace(config.workspaceId);
  assert(workspace, "Approved validation workspace was not found.");
  requireInternalValidationWorkspace(workspace, { env: {}, purpose: "model route stream contract smoke" });
  assert(workspace.plan === "ENTERPRISE_MANAGED" && !workspace.modelUsageBudget, "Validation workspace billing contract is unsafe.");
  if (config.preflightOnly) residueBefore = await countResidue(workspace.id);
  const originalFetch = globalThis.fetch; globalThis.fetch = guard.guarded;
  let next; const deltas = new Map(); let toolDeltaCount = 0;
  failurePhase = "gateway_preparation"; try {
    const stream = gateway.chatEventStream({ workspaceId: workspace.id, taskType: "AGENT", model,
      messages: [{ role: "user", content: `Call the required function with answer ${EXPECTED_ANSWER}.` }],
      tools: [{ type: "function", function: {
        name: TOOL_NAME, description: "Return the fixed synthetic route-stream contract answer.",
        parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      } }], tool_choice: "required",
    });
    next = await stream.next(); while (!next.done) {
      if (next.value.type === "tool_call_delta") {
        toolDeltaCount += 1; const current = deltas.get(next.value.index) ?? { name: "", arguments: "" };
        current.name += next.value.nameDelta ?? ""; current.arguments += next.value.argumentsDelta; deltas.set(next.value.index, current);
      }
      next = await stream.next();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const terminal = next?.value;
  const tool = terminal?.tool_calls?.[0];
  const streamed = deltas.get(0);
  failurePhase = "contract_validation";
  let args;
  try { args = JSON.parse(tool?.function.arguments ?? ""); } catch { throw new Error("Terminal wrapper arguments were not JSON."); }
  assert(guard.count() === 1, "Exactly one provider request was required.");
  assert(terminal?.tool_calls?.length === 1 && tool?.function.name === TOOL_NAME, "Required wrapper tool was not returned.");
  assert(streamed?.name === TOOL_NAME && streamed.arguments === tool.function.arguments, "Tool name/arguments were not fully streamed.");
  assert(toolDeltaCount > 0 && args?.answer === EXPECTED_ANSWER && terminal?.usage, "Wrapper or usage contract failed.");
  const evidence = { schemaVersion: "model-route-stream-contract/v1", status: "pass", providerRequestCount: 1, toolDeltaCount, streamedName: true, streamedArguments: true, terminalArgumentsValid: true, usagePresent: true };
  failurePhase = "evidence_write";
  await writeEvidence(config.out, evidence);
  return evidence;
  } catch {
    if (config.preflightOnly && failurePhase === "provider_stream" && guard.count() === 1) {
      const residueAfter = await countResidue(config.workspaceId);
      const residueDelta = residueAfter.map((count, index) => count - (residueBefore?.[index] ?? Number.NaN));
      if (residueDelta.length === 3 && residueDelta.every((count) => count === 0)) {
        const evidence = { schemaVersion: "model-route-stream-contract/v1", status: "pass", mode: "preflight-only", providerRequestCount: 0, localFetchBoundaryCount: 1, workspaceRowDelta: 0, usageRowDelta: 0, ledgerRowDelta: 0 };
        await writeEvidence(config.out, evidence); return evidence;
      }
    }
    if (failurePhase !== "evidence_write") await writeEvidence(config.out, {
      schemaVersion: "model-route-stream-contract/v1", status: "fail",
      errorCode: failurePhase === "provider_preflight" ? "PROVIDER_CONFIGURATION_UNSAFE" : failurePhase === "gateway_preparation" ? "GATEWAY_PREPARATION_FAILED" : "CONTRACT_SMOKE_FAILED",
      failurePhase, providerRequestCount: config.preflightOnly ? 0 : guard.count(), localFetchBoundaryCount: config.preflightOnly ? guard.count() : undefined,
    });
    throw new Error("Model route stream contract smoke failed.");
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runContractSmoke().then(() => console.log("Model route stream contract smoke: PASS (sanitized evidence written)."), () => {
    console.error("Model route stream contract smoke: FAIL (details suppressed)."); process.exitCode = 1;
  });
}
