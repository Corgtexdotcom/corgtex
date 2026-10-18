import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { assertDemoWorkspaceDisconnected } from "./demo-credentials.mjs";

const scopes = new WeakMap();
const FLAG_KEYS = ["AI_WORKSPACES", "CONTEXT_MAPS", "FINANCE", "RELATIONSHIPS"];
const INITIAL_MODELS = new Set(["Workspace", "Member", "Circle", "Role", "WorkspaceFeatureFlag", "SourcePermissionEpoch", "Event"]);
const require = (condition, message) => { if (!condition) throw new Error(`Demo initialization refused: ${message}`); };
const transactionId = async tx => {
  const rows = await tx.$queryRawUnsafe("SELECT txid_current()::text AS id");
  require(rows.length === 1 && /^[0-9]+$/.test(rows[0].id), "native transaction identity unavailable");
  return rows[0].id;
};

/** Only the actual fresh create, in its still-open transaction, obtains a scope. */
export async function createFreshDemoSeedWorkspace(tx, data) {
  require(data.slug === "jnj-demo" && !await tx.workspace.count({ where: { slug: data.slug } }), "workspace already exists");
  const txId = await transactionId(tx);
  const workspace = await tx.workspace.create({ data });
  const token = Object.freeze({});
  scopes.set(token, { tx, txId, workspaceId: workspace.id });
  return { workspace, token };
}

/** Settle an empty workspace's own initialization notice before it becomes
 * visible to workers. Epochs remain authoritative and are never removed/reset. */
export async function settleFreshDemoInitialization(tx, token, fixture) {
  const scope = scopes.get(token);
  require(scope?.tx === tx && scope.txId === await transactionId(tx), "scope is not this fresh transaction");
  scopes.delete(token);
  const workspaceId = scope.workspaceId;
  require(fixture.userIds.length > 0 && new Set(fixture.userIds).size === fixture.userIds.length
    && fixture.emails.length === fixture.userIds.length && fixture.emails.every(email =>
      email === "demo@jnj-demo.corgtex.app" || /^[a-z]+@jnj\.demo\.corgtex\.app$/.test(email)),
    "fixture identity set is incomplete");
  const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } });
  require(workspace?.slug === "jnj-demo", "workspace identity changed");
  // Every workspace-scoped table outside initial governance must be empty.
  for (const model of Prisma.dmmf.datamodel.models) {
    if (INITIAL_MODELS.has(model.name) || !model.fields.some(field => field.name === "workspaceId" && field.kind !== "object")) continue;
    const delegate = tx[model.name[0].toLowerCase() + model.name.slice(1)];
    require(await delegate.count({ where: { workspaceId } }) === 0, `semantic or authority data already exists (${model.name})`);
  }
  const users = await tx.user.findMany({ where: { id: { in: fixture.userIds } }, select: { id: true, email: true, globalRole: true } });
  require(users.length === fixture.userIds.length && users.every(user => user.globalRole === "USER" && fixture.emails.includes(user.email)),
    "fixture users do not match");
  const members = await tx.member.findMany({ where: { workspaceId }, select: { id: true, userId: true, isActive: true, role: true } });
  require(members.length === users.length && members.every(member => member.isActive && fixture.userIds.includes(member.userId)), "fixture members do not match");
  const publicMembers = members.filter(member => users.find(user => user.id === member.userId)?.email === "demo@jnj-demo.corgtex.app");
  require(publicMembers.length === 1 && publicMembers[0].role === "CONTRIBUTOR", "public identity is not a contributor");
  const circles = await tx.circle.findMany({ where: { workspaceId }, select: { id: true } });
  require(circles.length === fixture.circleIds.length && circles.every(circle => fixture.circleIds.includes(circle.id)), "fixture circles do not match");
  const roles = await tx.role.findMany({ where: { circleId: { in: fixture.circleIds } }, select: { id: true, circleId: true } });
  require(roles.length === fixture.roleIds.length && roles.every(role => fixture.roleIds.includes(role.id)), "fixture roles do not match");
  const assignments = await tx.roleAssignment.findMany({ where: { roleId: { in: fixture.roleIds } }, select: { id: true, roleId: true, memberId: true } });
  require(assignments.length === fixture.assignments.length && assignments.every(row =>
    members.some(member => member.id === row.memberId) && roles.some(role => role.id === row.roleId)
      && fixture.assignments.some(expected => expected.roleId === row.roleId && expected.memberId === row.memberId)), "fixture assignments do not match");
  for (const [model, where] of [["roleVersion", { roleId: { in: fixture.roleIds } }], ["roleHolderHistory", { roleId: { in: fixture.roleIds } }]]) {
    require(await tx[model].count({ where }) === 0, "role history already exists");
  }
  const flags = await tx.workspaceFeatureFlag.findMany({ where: { workspaceId }, select: { id: true, flag: true, enabled: true, config: true } });
  require(flags.length === FLAG_KEYS.length && flags.every(flag => FLAG_KEYS.includes(flag.flag) && flag.enabled)
    && isDeepStrictEqual(flags.find(flag => flag.flag === "FINANCE")?.config, { financeCapabilities: { reports: true, reportImports: true } }),
  "fixture flags do not match");
  const eventId = createHash("md5").update(`pun68-permission:${workspaceId}:${scope.txId}`).digest("hex");
  const events = await tx.event.findMany({ where: { workspaceId } });
  require(events.length === 1, "unexpected initialization notifications");
  const event = events[0];
  require(event.id === eventId && event.type === "source-permission.changed" && event.aggregateType === "SourcePermissionEpoch"
    && event.aggregateId === workspaceId && event.status === "PENDING" && event.attempts === 0
    && !event.lockedAt && !event.lockedBy && !event.dispatchedAt && !event.error && !event.mcpOrigin
    && !event.supportOriginUserId && event.supportGrantVersion == null && await tx.workflowJob.count({ where: { eventId } }) === 0,
  "notification is not this unclaimed native initialization");
  const payload = event.payload;
  const legacy = payload && Object.keys(payload).sort().join(",") === "governors,version" && payload.version === 1
    && Array.isArray(payload.governors) && payload.governors.length > 0 && payload.governors.length <= 1000;
  const workspaceNotice = payload && Object.keys(payload).sort().join(",") === "scope,version"
    && payload.version === 2 && payload.scope === "WORKSPACE";
  require(legacy || workspaceNotice, "native notification payload is invalid");
  // V2 deliberately carries no row inventory. The still-open native scope and
  // exact fixture checks above remain mandatory; verify every actual fixture
  // assignment and flag's epoch rather than inferring authority from the notice.
  const governors = legacy ? payload.governors : [
    ...assignments.map(row => ({kind: "RoleAssignment", id: row.id})),
    ...flags.map(row => ({kind: "WorkspaceFeatureFlag", id: row.id})),
  ];
  for (const governor of governors) {
    require(governor && Object.keys(governor).sort().join(",") === "id,kind" && typeof governor.id === "string"
      && (governor.kind === "RoleAssignment" ? assignments.some(row => row.id === governor.id)
        : governor.kind === "WorkspaceFeatureFlag" && flags.some(row => row.id === governor.id)), "governor is not a fixture initialization row");
    const epoch = await tx.sourcePermissionEpoch.findUnique({ where: { workspaceId_sourceKind_sourceId: { workspaceId,
      sourceKind: governor.kind, sourceId: governor.id } }, select: { epoch: true } });
    require(epoch && epoch.epoch > 0n, "native epoch was not applied");
  }
  const removed = await tx.event.deleteMany({ where: { id: eventId, workspaceId, status: "PENDING", attempts: 0,
    lockedAt: null, lockedBy: null, dispatchedAt: null, mcpOrigin: { equals: Prisma.DbNull }, supportOriginUserId: null, supportGrantVersion: null } });
  require(removed.count === 1, "initialization notice changed");
  // Any extra asynchronous or external authority fails the original guard and
  // rolls back the entire seed, including the exact notice disposal above.
  await assertDemoWorkspaceDisconnected(tx, workspaceId, fixture.userIds);
}
