import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, prisma,
  type AppActor } from "@corgtex/shared";

type LockMetric = { startedMs: number; acquiredMs: number; roundTripMs: number };
type TransactionMetric = {
  durationMs: number; prismaOperations: number;
  phase: "preparation" | "publication";
  delegateOperations: Record<string, number>; rawSqlClasses: Record<string, number>;
  transactionStartDelayMs: number; transactionReturnedMs: number; transactionSucceeded: boolean;
  firstAdvisoryLock: LockMetric | null; firstPhysicalLock: LockMetric | null; firstEpochLock: LockMetric | null;
  firstDmlStartedMs: number | null; callbackReturnedMs: number;
  lockHeldLowerBoundMs: number | null;
  actualSqlStatementCount: null;
};

const remote = vi.hoisted(() => ({
  box: { text: "Synthetic selected Box bytes" } as unknown,
  mcp: { structuredContent: { results: [{ id: "synthetic-hit" }] } } as unknown,
  boxRead: vi.fn(), mcpRead: vi.fn(), inTransaction: 0,
  isTransaction: (): boolean => false,
  requestReadBarrier: null as null | { requestId: string; count: number; ready: Promise<void>; release: () => void },
  slackWorkspaceId: "",
  measureTransactions: false,
  transactions: [] as TransactionMetric[],
  slack: [{ type: "message", ts: "1700000000.000001", user: "U_PUBLIC", text: "Synthetic public Slack input" }],
  slackRead: vi.fn(),
}));
vi.mock("@slack/web-api", () => ({ WebClient: class {
  auth = { test: async () => ({ ok: true, team_id: remote.slackWorkspaceId, user_id: "U_BOT" }) };
  conversations = {
    info: async ({ channel }: { channel: string }) => ({ ok: true, channel: { id: channel, is_private: false,
      is_archived: false, is_member: true } }),
    history: remote.slackRead,
    replies: remote.slackRead,
  };
} }));
vi.mock("@corgtex/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const transactionScope = new AsyncLocalStorage<boolean>();
  remote.isTransaction = () => transactionScope.getStore() === true;
  const instrumented = new Proxy(actual.prisma, { get(target, key) {
    if (key === "executionRequest") return new Proxy(target.executionRequest, { get(delegate, operation) {
      const method = Reflect.get(delegate, operation, delegate);
      if (operation !== "findFirst") return typeof method === "function" ? method.bind(delegate) : method;
      return async (...args: any[]) => {
        const row = await method.apply(delegate, args);
        const barrier = remote.requestReadBarrier;
        if (barrier && args[0]?.where?.id === barrier.requestId && row?.status === "PENDING") {
          barrier.count++;
          if (barrier.count === 2) { remote.requestReadBarrier = null; barrier.release(); }
          await barrier.ready;
        }
        return row;
      };
    } });
    if (key !== "$transaction") return Reflect.get(target, key, target);
    return async (...args: any[]) => {
      const original = target.$transaction.bind(target) as (...args: any[]) => Promise<any>;
      if (typeof args[0] !== "function") return original(...args);
      const callback = args[0];
      const invoked = performance.now();
      let metric: TransactionMetric | undefined;
      let callbackStarted = 0;
      let succeeded = false;
      try { const result = await original(async (tx: any) => {
        const started = performance.now();
        callbackStarted = started;
        let prismaOperations = 0;
        const timed = remote.measureTransactions && args[1]?.timeout === 120_000;
        const rounded = (value: number) => Math.round(value * 100) / 100;
        if (timed) metric = { phase: remote.transactions.length === 0 ? "preparation" : "publication",
          durationMs: 0, prismaOperations: 0, delegateOperations: {}, rawSqlClasses: {},
          transactionStartDelayMs: rounded(started - invoked), transactionReturnedMs: 0, transactionSucceeded: false,
          firstAdvisoryLock: null, firstPhysicalLock: null, firstEpochLock: null, firstDmlStartedMs: null,
          callbackReturnedMs: 0, lockHeldLowerBoundMs: null, actualSqlStatementCount: null };
        // Inspect static SQL fragments only. Never retain SQL text, arguments, identifiers or values in metrics.
        const classifyRaw = (values: any[]): { label: string; lock?: "advisory" | "physical" | "epoch"; dml: boolean } => {
          const input = values[0];
          const fragments = Array.isArray(input) ? input : input?.strings;
          const sql = Array.isArray(fragments) ? fragments.join(" ? ") : typeof input === "string" ? input : "";
          const dml = /\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|"|[A-Za-z])/i.test(sql) && !/\bFOR\s+UPDATE\b/i.test(sql);
          if (/pg_advisory_xact_lock/i.test(sql)) return { label: /pg_advisory_xact_lock_shared/i.test(sql)
            ? "advisory_lock_shared" : "advisory_lock_update", lock: "advisory", dml: false };
          if (/"SourcePermissionEpoch"/.test(sql)) return { label: dml ? "epoch_write" : /\bFOR\s+SHARE\b/i.test(sql)
            ? "epoch_lock_share" : "epoch_read", ...(/\bFOR\s+SHARE\b/i.test(sql) ? { lock: "epoch" as const } : {}), dml };
          if (/\bFOR\s+(SHARE|UPDATE)\b/i.test(sql)) return { label: /\bFOR\s+UPDATE\b/i.test(sql)
            ? "physical_lock_update" : "physical_lock_share", lock: "physical", dml: false };
          if (/pg_backend_pid|txid_current/i.test(sql)) return { label: "transaction_identity", dml: false };
          return { label: dml ? "dml" : /\bSELECT\b/i.test(sql) ? "select" : "other", dml };
        };
        const count = (histogram: Record<string, number>, key: string) => { histogram[key] = (histogram[key] ?? 0) + 1; };
        const measured = new Proxy(tx, { get(connection, property) {
          const value = Reflect.get(connection, property, connection);
          if (typeof value === "function") return async (...values: any[]) => {
            const raw = ["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"].includes(String(property));
            const classification = raw && metric ? classifyRaw(values) : undefined;
            const operationStarted = performance.now();
            if (raw) prismaOperations++;
            if (metric && classification) {
              count(metric.rawSqlClasses, classification.label);
              if (classification.dml && metric.firstDmlStartedMs === null) metric.firstDmlStartedMs = rounded(operationStarted - started);
            }
            const result = await value.apply(connection, values);
            if (metric && classification?.lock && (classification.lock === "advisory" || Array.isArray(result) && result.length > 0)) {
              const field = classification.lock === "advisory" ? "firstAdvisoryLock"
                : classification.lock === "epoch" ? "firstEpochLock" : "firstPhysicalLock";
              if (metric[field] === null) metric[field] = { startedMs: rounded(operationStarted - started),
                acquiredMs: rounded(performance.now() - started), roundTripMs: rounded(performance.now() - operationStarted) };
            }
            return result;
          };
          if (!value || typeof value !== "object") return value;
          return new Proxy(value, { get(delegate, operation) {
            const method = Reflect.get(delegate, operation, delegate);
            return typeof method === "function" ? (...values: any[]) => {
              prismaOperations++;
              if (metric) {
                count(metric.delegateOperations, `${String(property)}.${String(operation)}`);
                if (/^(create|update|upsert|delete)/.test(String(operation)) && metric.firstDmlStartedMs === null)
                  metric.firstDmlStartedMs = rounded(performance.now() - started);
              }
              return method.apply(delegate, values);
            } : method;
          } });
        } });
        remote.inTransaction++;
        try { return await transactionScope.run(true, () => callback(measured)); } finally {
          remote.inTransaction--;
          if (metric) { metric.durationMs = rounded(performance.now() - started); metric.prismaOperations = prismaOperations;
            metric.callbackReturnedMs = metric.durationMs; }
        }
      }, ...args.slice(1)); succeeded = true; return result; } finally {
        if (metric) {
          metric.transactionReturnedMs = Math.round((performance.now() - callbackStarted) * 100) / 100;
          metric.transactionSucceeded = succeeded;
          const acquired = [metric.firstAdvisoryLock, metric.firstPhysicalLock, metric.firstEpochLock]
            .filter((entry): entry is LockMetric => entry !== null).map(entry => entry.acquiredMs);
          metric.lockHeldLowerBoundMs = acquired.length ? Math.round((metric.transactionReturnedMs - Math.min(...acquired)) * 100) / 100 : null;
          remote.transactions.push(metric);
        }
      }
    };
  } });
  return { ...actual, prisma: instrumented };
});
vi.mock("./external-mcp", async importOriginal => ({ ...await importOriginal<typeof import("./external-mcp")>(),
  readBoxExternalMcpNativeResponse: remote.boxRead,
  readExternalMcpNativeToolResult: remote.mcpRead,
}));

import { selectExternalContentSource } from "./external-content-sources";
import { captureExternalProviderFetchInput } from "./external-provider-authority";
import { captureExternalMcpResponseInput } from "./external-mcp-response-input";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight, lockArtifactReadAuthorityRows } from "./artifact-commit-preflight";
import { captureSlackNativeMessageFetch, withSlackNativeCommitReceipt } from "./communication-native-authority";
import { communicationCanonicalJson, communicationNativeHash } from "./communication-native-ingress";
import { artifactPermissionEpochIdentities, capturePermissionEpochs } from "./source-permission-epochs";
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage, withArtifactInputWriteFence,
  lineageContentFingerprint } from "./source-lineage";
import { createExecutionRequest, submitExecutionResult } from "./execution-plumbing";
import { createAction } from "./actions";
import { absorbSource } from "../../agents/src/brain-absorb";
import { defaultModelGateway } from "@corgtex/models";
import { AppError } from "./errors";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const assignedLocalFixture = database.hostname === "127.0.0.1" && database.port === "55468";
const assignedCiFixture = process.env.GITHUB_ACTIONS === "true"
  && database.hostname === "localhost" && database.port === "5432";
if (!["postgres:", "postgresql:"].includes(database.protocol) || (!assignedLocalFixture && !assignedCiFixture)
  || database.pathname !== "/corgtex_test" || database.searchParams.get("schema") !== "public") {
  throw new Error("Native caller tests require the assigned disposable local or GitHub Actions PostgreSQL fixture.");
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let current: Fixture | null = null;
async function fixture() {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `mixed-owner-${suffix}@synthetic.test`, displayName: "Synthetic Native Owner", passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `mixed-other-${suffix}@synthetic.test`, displayName: "Synthetic Other Member", passwordHash: "synthetic" } });
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic mixed external commit", slug: `mixed-native-${suffix}` } });
  await prisma.member.createMany({ data: [user.id, other.id].map(userId => ({ workspaceId: workspace.id, userId, role: "ADMIN", isActive: true })) });
  const actor = { kind: "user", user: { id: user.id, email: user.email, displayName: user.displayName, globalRole: "USER" } } as AppActor;
  const otherActor = { kind: "user", user: { id: other.id, email: other.email, displayName: other.displayName, globalRole: "USER" } } as AppActor;
  const connection = await prisma.externalMcpConnection.create({ data: { workspaceId: workspace.id, userId: user.id,
    providerKey: "box", displayName: "Synthetic selected Box", serverUrl: "https://mcp.box.com",
    providerAccountId: "synthetic-box-owner", accessTokenEnc: encryptSecret("synthetic-only-token"),
    scopes: ["root_readwrite"], status: "ACTIVE" } });
  const source = await selectExternalContentSource(actor, { workspaceId: workspace.id, providerKey: "box",
    sourceKind: "FILE", externalId: "synthetic-file", connectionId: connection.id, title: "Selected synthetic file" });
  const provider = await captureExternalProviderFetchInput(actor, { workspaceId: workspace.id,
    externalContentSourceId: source.id, connectionId: connection.id, sourceKind: "FILE", externalId: "synthetic-file",
    toolName: "get_file_content", arguments: { file_id: "synthetic-file" } });
  const mcp = await captureExternalMcpResponseInput(actor, { workspaceId: workspace.id,
    connectionId: connection.id, mode: "SEARCH", query: "synthetic", limit: 1 });
  const roots = await captureArtifactInputProof(actor, workspace.id, [
    { kind: "ExternalProviderFetchInput", id: provider.input.id },
    { kind: "ExternalMcpResponseInput", id: mcp.input.id, snapshot: mcp.input },
  ]);
  return { user, other, workspace, actor, otherActor, connection, source, provider, mcp, roots };
}

async function addSlack(f: Fixture, index = 0, priorInstallation?: Awaited<ReturnType<typeof prisma.communicationInstallation.create>>) {
  remote.slackWorkspaceId = `T_CALLER_${f.workspace.id}`;
  const installation = priorInstallation ?? await prisma.communicationInstallation.create({ data: { workspaceId: f.workspace.id,
    provider: "SLACK", externalWorkspaceId: remote.slackWorkspaceId, appId: "APP_SYNTHETIC", botUserId: "U_BOT",
    botTokenEnc: encryptSecret("synthetic-slack-token"), scopes: ["channels:read", "channels:history"], status: "ACTIVE" } });
  const channel = await prisma.communicationChannel.create({ data: { workspaceId: f.workspace.id,
    installationId: installation.id, provider: "SLACK", externalChannelId: `C_PUBLIC_${index}`,
    name: "Synthetic public channel", kind: "PUBLIC", isIngestEnabled: true } });
  const messageTs = remote.slack[index]!.ts;
  const receipt = await captureSlackNativeMessageFetch({ workspaceId: f.workspace.id, installationId: installation.id,
    channelId: channel.externalChannelId, messageTs });
  const saved = await prisma.$transaction(async tx => {
    const stamp = new Date(Math.trunc(Number(messageTs) * 1000));
    const message = await tx.communicationMessage.create({ data: { workspaceId: f.workspace.id,
      installationId: installation.id, provider: "SLACK", externalChannelId: channel.externalChannelId,
      externalMessageId: messageTs, externalUserId: String(receipt.projected.user),
      text: String(receipt.projected.text), raw: receipt.projected as any, messageTs: stamp, receivedAt: stamp,
      expiresRawAt: new Date(Date.now() + 600_000), permalink: null } });
    const epochs = await capturePermissionEpochs(tx, f.workspace.id,
      artifactPermissionEpochIdentities("CommunicationMessage", message));
    const input = await tx.communicationMessageNativeInput.create({ data: { workspaceId: f.workspace.id,
      installationId: installation.id, communicationMessageId: message.id, provider: "SLACK",
      externalWorkspaceId: installation.externalWorkspaceId, appId: installation.appId,
      providerPrincipalId: receipt.providerPrincipalId, externalChannelId: channel.externalChannelId,
      externalMessageId: messageTs, externalUserId: message.externalUserId, threadExternalId: null,
      mode: "AUTHENTICATED_FETCH", ingressInputId: null,
      requestJson: { ...receipt.request, messageContentFingerprint: lineageContentFingerprint("CommunicationMessage", message) } as any,
      encryptedPayloadJson: encryptSecret(communicationCanonicalJson(receipt.payload)),
      projectedContentJson: receipt.projected as any,
      projectionHash: communicationNativeHash(communicationCanonicalJson(receipt.projected)),
      installationGrantHash: receipt.installationGrantHash, channelGrantHash: receipt.channelGrantHash,
      permissionEpochsJson: epochs as any, epochProofVersion: 1,
      expiresRawAt: message.expiresRawAt!, fetchedAt: new Date(receipt.capturedAtMs) } });
    await withSlackNativeCommitReceipt(f.actor, f.workspace.id, input.id, tx, receipt, () => recordArtifactInputLineage({
      tx, actor: f.actor, workspaceId: f.workspace.id, artifact: { kind: "CommunicationMessage", id: message.id },
      content: message, origin: "DERIVED", inputs: [{ kind: "CommunicationMessageNativeInput", id: input.id }],
    }));
    return { message, input };
  });
  const roots = await captureArtifactInputProof(f.actor, f.workspace.id,
    [{ kind: "CommunicationMessage", id: saved.message.id }]);
  return { ...saved, installation, channel, roots };
}

afterEach(async () => {
  const f = current; current = null;
  if (f) {
    await prisma.workspace.delete({ where: { id: f.workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [f.user.id, f.other.id] } } });
  }
  vi.restoreAllMocks();
  remote.boxRead.mockClear(); remote.mcpRead.mockClear(); remote.slackRead.mockClear(); remote.inTransaction = 0;
  remote.measureTransactions = false; remote.transactions = [];
  remote.requestReadBarrier = null;
});
describe("actual native outer caller commit scopes", () => {
  async function submission(writebackTargetType: "COMMENT" | "BUILD_ARTIFACT" = "COMMENT") {
    const f = current = await fixture();
    const slack = await addSlack(f);
    const request = await createExecutionRequest(f.actor, { workspaceId: f.workspace.id, goal: "Synthetic explicit native result request",
      writebackTargetType });
    return { ...f, request, allRoots: [...f.roots, ...slack.roots] };
  }

  it("accepts actual mixed Box/MCP/Slack inputs with zero SDK calls inside every preparation/publication transaction", async () => {
    const f = await submission();
    remote.measureTransactions = true;
    const result = await submitExecutionResult(f.actor, { workspaceId: f.workspace.id, requestId: f.request.id,
      idempotencyKey: "native-mixed", output: { bodyMd: "Native copied result canary" }, lineageRoots: f.allRoots });
    remote.measureTransactions = false;
    console.info("Synthetic native caller metrics (Prisma operations, not SQL statement counts; lock-held time is a lower bound):", remote.transactions);
    expect(remote.transactions).toHaveLength(2);
    for (const metric of remote.transactions) {
      expect(Object.values(metric.delegateOperations).reduce((sum, count) => sum + count, 0)
        + Object.values(metric.rawSqlClasses).reduce((sum, count) => sum + count, 0)).toBe(metric.prismaOperations);
      expect(metric.transactionSucceeded).toBe(true);
      expect(metric.firstAdvisoryLock).not.toBeNull(); expect(metric.firstPhysicalLock).not.toBeNull(); expect(metric.firstEpochLock).not.toBeNull();
      expect(metric.firstDmlStartedMs).not.toBeNull();
      expect(metric.transactionReturnedMs).toBeGreaterThanOrEqual(metric.callbackReturnedMs);
      expect(metric.lockHeldLowerBoundMs).toBeGreaterThan(0);
      expect(metric.lockHeldLowerBoundMs).toBeLessThanOrEqual(metric.transactionReturnedMs);
    }
    if (process.env.PUN68_NATIVE_CALLER_METRICS_PATH)
      await writeFile(process.env.PUN68_NATIVE_CALLER_METRICS_PATH, JSON.stringify(remote.transactions, null, 2));
    expect(result).toMatchObject({ status: "ACCEPTED", output: { bodyMd: "Native copied result canary" } });
    const currentResult = await prisma.executionResult.findUniqueOrThrow({ where: { id: result.id } });
    const proof = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ExecutionResult", id: result.id }]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(true);
    expect(await isArtifactInputProofReadable(f.otherActor, f.workspace.id, proof)).toBe(false);
    expect(currentResult.submittedByUserId).toBe(f.user.id);
    expect(remote.boxRead).toHaveBeenCalled(); expect(remote.mcpRead).toHaveBeenCalled(); expect(remote.slackRead).toHaveBeenCalled();
    const replay = await submitExecutionResult(f.actor, { workspaceId: f.workspace.id, requestId: f.request.id,
      idempotencyKey: "native-mixed", output: { bodyMd: "Ignored retry body" } });
    expect(replay.output).toEqual(result.output);
    expect(await prisma.executionResult.count({ where: { executionRequestId: f.request.id } })).toBe(1);
  });

  it("rolls back result/request/audit effects when the final execution fence fails while retaining preparation history", async () => {
    const f = await submission();
    const beforeAudit = await prisma.auditLog.count({ where: { workspaceId: f.workspace.id } });
    let reachedFinalFence = false;
    await expect(withArtifactInputWriteFence(async tx => {
      if ((await tx.executionRequest.findUniqueOrThrow({ where: { id: f.request.id } })).status === "COMPLETED") {
        reachedFinalFence = true;
        throw new AppError(409, "SOURCE_CHANGED", "Synthetic final caller fence failed");
      }
    }, () => submitExecutionResult(f.actor, { workspaceId: f.workspace.id, requestId: f.request.id,
      idempotencyKey: "native-rollback", output: { bodyMd: "Never committed" }, lineageRoots: f.allRoots }))).rejects.toMatchObject({ code: "ARTIFACT_INPUT_WRITE_FENCE_LOST" });
    expect((await prisma.executionRequest.findUniqueOrThrow({ where: { id: f.request.id } })).status).toBe("PENDING");
    expect(await prisma.executionResult.count({ where: { executionRequestId: f.request.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBe(beforeAudit);
    expect(await prisma.artifactInputSnapshot.count({ where: { workspaceId: f.workspace.id } })).toBeGreaterThan(0);
    expect(reachedFinalFence).toBe(true);
  });

  it("keeps actual native Build writeback and copied PR source private under the complete result proof", async () => {
    const f = await submission("BUILD_ARTIFACT");
    const result = await submitExecutionResult(f.actor, { workspaceId: f.workspace.id, requestId: f.request.id,
      idempotencyKey: "native-build", output: { repositoryOwner: "synthetic", repositoryName: "native-caller",
        title: "Native private build canary", summaryMd: "Copied mixed inputs", visibility: "PRIVATE" }, lineageRoots: f.allRoots });
    const persisted = await prisma.executionResult.findUniqueOrThrow({ where: { id: result.id } });
    expect(persisted.writebackEntityType).toBe("BuildArtifact");
    const artifact = await prisma.buildArtifact.findUniqueOrThrow({ where: { id: persisted.writebackEntityId! } });
    expect(artifact).toMatchObject({ createdByUserId: f.user.id, visibility: "PRIVATE", title: "Native private build canary" });
    expect(artifact.brainSourceId).not.toBeNull();
    for (const input of [{ kind: "BuildArtifact" as const, id: artifact.id },
      { kind: "BrainSource" as const, id: artifact.brainSourceId! }]) {
      const proof = await captureArtifactInputProof(f.actor, f.workspace.id, [input]);
      expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(true);
      expect(await isArtifactInputProofReadable(f.otherActor, f.workspace.id, proof)).toBe(false);
    }
  });

  it("reconciles overlapping same-key submissions that both read PENDING to one committed proven result", async () => {
    const f = await submission();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const barrier = { requestId: f.request.id, count: 0, ready, release };
    remote.requestReadBarrier = barrier;
    const results = await Promise.all(["First candidate", "Second ignored candidate"].map(bodyMd =>
      submitExecutionResult(f.actor, { workspaceId: f.workspace.id, requestId: f.request.id,
        idempotencyKey: "overlapping-native", output: { bodyMd }, lineageRoots: f.allRoots })));
    expect(barrier.count).toBe(2);
    expect(results[1]).toEqual(results[0]);
    const rows = await prisma.executionResult.findMany({ where: { executionRequestId: f.request.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: results[0].id, status: "ACCEPTED", outputJson: results[0].output });
    expect((await prisma.executionRequest.findUniqueOrThrow({ where: { id: f.request.id } })).status).toBe("COMPLETED");
    expect(await prisma.auditLog.count({ where: { workspaceId: f.workspace.id, action: "execution_result.submitted" } })).toBe(1);
  });

  it("commits a native copied comment against an existing Action without rewriting its independent body or original receipt", async () => {
    const f = current = await fixture();
    const slack = await addSlack(f);
    const member = await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.user.id } } });
    const action = await createAction(f.actor, { workspaceId: f.workspace.id, title: "Independent existing target",
      bodyMd: "Original public Action body", isPrivate: false, assigneeMemberId: member.id });
    const before = await prisma.action.findUniqueOrThrow({ where: { id: action.id } });
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id,
      artifactType: "Action", artifactId: action.id }, orderBy: { revision: "desc" } });
    const request = await createExecutionRequest(f.actor, { workspaceId: f.workspace.id, goal: "Comment on the actual existing target",
      writebackTargetType: "ACTION", writebackTargetId: action.id });
    const result = await submitExecutionResult(f.actor, { workspaceId: f.workspace.id, requestId: request.id,
      idempotencyKey: "native-existing", output: { title: "Must not replace target", bodyMd: "Private native result comment" },
      lineageRoots: [...f.roots, ...slack.roots] });
    expect(result.writeback).toEqual({ entityType: "ExecutionResult", entityId: result.id });
    expect(await prisma.action.findUniqueOrThrow({ where: { id: action.id } })).toEqual(before);
    expect(await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id,
      artifactType: "Action", artifactId: action.id }, orderBy: { revision: "desc" } })).toEqual(manifest);
    expect(await captureArtifactInputProof(f.otherActor, f.workspace.id, [{ kind: "Action", id: action.id }])).not.toHaveLength(0);
    const resultProof = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ExecutionResult", id: result.id }]);
    expect(await isArtifactInputProofReadable(f.otherActor, f.workspace.id, resultProof)).toBe(false);
  });

  it("rejects revoked then restored native authority before replay or result writes without refreshing old vectors", async () => {
    const f = await submission();
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED" } });
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { status: "ACTIVE" } });
    const calls = [remote.boxRead.mock.calls.length, remote.mcpRead.mock.calls.length, remote.slackRead.mock.calls.length];
    await expect(submitExecutionResult(f.actor, { workspaceId: f.workspace.id, requestId: f.request.id,
      idempotencyKey: "native-restored", output: { bodyMd: "Must not reuse restored input" }, lineageRoots: f.allRoots }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect([remote.boxRead.mock.calls.length, remote.mcpRead.mock.calls.length, remote.slackRead.mock.calls.length]).toEqual(calls);
    expect(await prisma.executionResult.count({ where: { executionRequestId: f.request.id } })).toBe(0);
    expect((await prisma.executionRequest.findUniqueOrThrow({ where: { id: f.request.id } })).status).toBe("PENDING");
  });

  it("preserves the public absorption audience rule after safely freezing owner-native inputs", async () => {
    const f = current = await fixture();
    const slack = await addSlack(f);
    const roots = [...f.roots, ...slack.roots];
    const token = await prepareArtifactCommitPreflight(f.actor, f.workspace.id, roots);
    const source = await prisma.$transaction(async tx => {
      await lockArtifactReadAuthorityRows(f.actor, f.workspace.id, tx);
      return withArtifactCommitPreflight(f.actor, f.workspace.id, tx, roots, token, async () => {
        const row = await tx.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "RESEARCH", tier: 2,
          title: "Synthetic mixed owner-only source", content: "Native copied source canary" } });
        await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
          artifact: { kind: "BrainSource", id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
        return row;
      });
    });
    const extract = vi.spyOn(defaultModelGateway, "extract").mockImplementation(async () => { throw new Error("Private native data reached model"); });
    await expect(absorbSource({ workspaceId: f.workspace.id, sourceId: source.id, agentRunId: "native-denial", actor: f.actor }))
      .rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(extract).not.toHaveBeenCalled();
    expect(await prisma.brainArticle.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).absorbedAt).toBeNull();
    expect(await prisma.artifactInputSnapshot.count({ where: { workspaceId: f.workspace.id, sourceKind: "BrainSource", sourceId: source.id } })).toBeGreaterThan(0);
  });
});
remote.boxRead.mockImplementation(async () => {
  if (remote.isTransaction()) throw new Error("Box SDK called during a writer transaction.");
  return structuredClone(remote.box);
});
remote.mcpRead.mockImplementation(async () => {
  if (remote.isTransaction()) throw new Error("MCP SDK called during a writer transaction.");
  return structuredClone(remote.mcp);
});
remote.slackRead.mockImplementation(async (request: { oldest?: string; latest?: string }) => {
  if (remote.isTransaction()) throw new Error("Slack SDK called during a writer transaction.");
  return { ok: true, messages: structuredClone(remote.slack.filter(message => message.ts === request.oldest)), has_more: false };
});
