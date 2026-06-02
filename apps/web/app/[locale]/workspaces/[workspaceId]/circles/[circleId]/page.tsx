import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { listCircleTree, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";

import { requirePageActor } from "@/lib/auth";
import { ActionMenu } from "@/lib/components/ui/ActionMenu";
import {
  assignAgentToCircleAction,
  deleteCircleAction,
  deleteRoleAction,
  removeAgentFromCircleAction,
  unassignRoleAction,
  updateCircleAction,
  updateRoleAction,
} from "../../actions";
import { ConfirmSubmitButton } from "../ConfirmSubmitButton";
import {
  collectCircleMembers,
  countAccountabilities,
} from "../circleGraphHelpers";

export const dynamic = "force-dynamic";

type CircleTree = Awaited<ReturnType<typeof listCircleTree>>;
type CircleTreeNode = CircleTree[number];
type RoleAssignmentRecord = {
  id: string;
  member?: {
    id?: string | null;
    user?: {
      displayName?: string | null;
      email?: string | null;
    } | null;
  } | null;
};

function findCircle(nodes: CircleTree, circleId: string): CircleTreeNode | null {
  for (const node of nodes) {
    if (node.id === circleId) return node;
    const childMatch = findCircle(node.childCircles, circleId);
    if (childMatch) return childMatch;
  }
  return null;
}

function flattenCircles(nodes: CircleTree): CircleTree {
  return nodes.flatMap((node) => [node, ...flattenCircles(node.childCircles)]);
}

function memberName(assignment: RoleAssignmentRecord) {
  return assignment.member?.user?.displayName
    ?? assignment.member?.user?.email
    ?? "Unknown";
}

function hiddenWorkspace(workspaceId: string) {
  return <input type="hidden" name="workspaceId" value={workspaceId} />;
}

export default async function CircleDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; circleId: string }>;
}) {
  const { workspaceId, circleId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("circles");
  const tCommon = await getTranslations("common");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });

  const [treeData, currentWorkspace, agentAssignments, allAgents] = await Promise.all([
    listCircleTree(workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    prisma.circleAgentAssignment.findMany({
      where: { circleId, circle: { workspaceId, archivedAt: null } },
      include: { agentIdentity: true, role: { select: { id: true, name: true } } },
      orderBy: { assignedAt: "desc" },
    }),
    prisma.agentIdentity.findMany({
      where: { workspaceId, isActive: true, archivedAt: null },
      orderBy: { displayName: "asc" },
    }),
  ]);

  const circle = findCircle(treeData, circleId);
  if (!circle) notFound();

  const allCircles = flattenCircles(treeData);
  const descendantIds = new Set(flattenCircles(circle.childCircles).map((child) => child.id));
  const parentOptions = allCircles.filter((item) => item.id !== circle.id && !descendantIds.has(item.id));
  const isDemo = currentWorkspace?.slug === "jnj-demo";
  const canManageStructure = !isDemo && (membership?.role === "ADMIN" || membership?.role === "FACILITATOR");
  const canManageAgents = !isDemo && membership?.role === "ADMIN";
  const members = collectCircleMembers(circle);
  const accountabilityCount = countAccountabilities(circle);
  const assignedAgentIds = new Set(agentAssignments.map((assignment) => assignment.agentIdentityId));
  const availableAgents = allAgents.filter((agent) => !assignedAgentIds.has(agent.id));
  const roleIds = circle.roles.map((role) => role.id);
  const [roleVersions, holderHistory, onboardingSessions] = roleIds.length > 0
    ? await Promise.all([
      prisma.roleVersion.findMany({
        where: { workspaceId, roleId: { in: roleIds } },
        orderBy: [{ roleId: "asc" }, { version: "desc" }],
        take: 60,
      }),
      prisma.roleHolderHistory.findMany({
        where: { workspaceId, roleId: { in: roleIds } },
        include: {
          member: {
            include: {
              user: {
                select: { displayName: true, email: true },
              },
            },
          },
          agentIdentity: {
            select: { displayName: true, memberType: true },
          },
        },
        orderBy: { startedAt: "desc" },
        take: 80,
      }),
      prisma.roleOnboardingSession.findMany({
        where: { workspaceId, roleId: { in: roleIds } },
        select: {
          id: true,
          roleId: true,
          memberId: true,
          conversationId: true,
          status: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 80,
      }),
    ])
    : [[], [], []];
  const roleVersionsByRole = new Map<string, typeof roleVersions>();
  for (const version of roleVersions) {
    const versions = roleVersionsByRole.get(version.roleId) ?? [];
    versions.push(version);
    roleVersionsByRole.set(version.roleId, versions);
  }
  const holderHistoryByRole = new Map<string, typeof holderHistory>();
  for (const history of holderHistory) {
    const histories = holderHistoryByRole.get(history.roleId) ?? [];
    histories.push(history);
    holderHistoryByRole.set(history.roleId, histories);
  }
  const onboardingByRoleMember = new Map(onboardingSessions.map((session) => [`${session.roleId}:${session.memberId}`, session]));

  async function archiveCircleAndReturn(formData: FormData) {
    "use server";
    await deleteCircleAction(formData);
    redirect(`/workspaces/${workspaceId}/circles?view=list`);
  }

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <Link
          href={`/workspaces/${workspaceId}/circles?view=list`}
          style={{ color: "var(--muted)", display: "inline-block", fontSize: "0.85rem", marginBottom: 16, textDecoration: "none" }}
        >
          {t("backToCircles")}
        </Link>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>
              {t("circleTitle", { name: circle.name })}
            </h1>
            <div className="nr-masthead-meta" style={{ marginTop: 10 }}>
              {circle.parentCircle ? (
                <span>
                  {t("parentCircleMeta")}{" "}
                  <Link href={`/workspaces/${workspaceId}/circles/${circle.parentCircle.id}`}>
                    {circle.parentCircle.name}
                  </Link>
                </span>
              ) : (
                <span>{t("topLevelCircleMeta")}</span>
              )}
              <span>{circle.maturityStage}</span>
            </div>
          </div>
          {canManageStructure && (
            <ActionMenu label={tCommon("moreActions")}>
              <form action={archiveCircleAndReturn}>
                {hiddenWorkspace(workspaceId)}
                <input type="hidden" name="circleId" value={circle.id} />
                <ConfirmSubmitButton className="danger" message={t("confirmArchiveCircle")}>
                  {t("btnDeleteCircle")}
                </ConfirmSubmitButton>
              </form>
            </ActionMenu>
          )}
        </div>
      </header>

      <section className="ws-section" style={{ marginBottom: 32 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 24 }}>
          {[
            { value: circle.roles.length, label: t("rolesShort") },
            { value: members.length, label: t("membersShort") },
            { value: accountabilityCount, label: t("accountabilitiesShort") },
            { value: circle.childCircles.length, label: t("subcirclesShort") },
          ].map((item) => (
            <div key={item.label} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-alt)" }}>
              <strong style={{ display: "block", fontSize: "1.1rem", lineHeight: 1 }}>{item.value}</strong>
              <span className="nr-item-meta">{item.label}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          <div>
            <h2 className="nr-section-header" style={{ marginBottom: 8 }}>{t("labelPurpose")}</h2>
            <div className="nr-item">
              {circle.purposeMd ? <p className="nr-excerpt" style={{ margin: 0 }}>{circle.purposeMd}</p> : <p className="muted" style={{ margin: 0 }}>{t("noPurpose")}</p>}
            </div>
          </div>

          <div>
            <h2 className="nr-section-header" style={{ marginBottom: 8 }}>{t("labelDomain")}</h2>
            <div className="nr-item">
              {circle.domainMd ? <p className="nr-excerpt" style={{ margin: 0 }}>{circle.domainMd}</p> : <p className="muted" style={{ margin: 0 }}>{t("noDomain")}</p>}
            </div>
          </div>
        </div>

        {circle.childCircles.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <h2 className="nr-section-header" style={{ marginBottom: 8 }}>{t("childCirclesTitle")}</h2>
            <div style={{ display: "grid", gap: 8 }}>
              {circle.childCircles.map((child) => (
                <Link
                  key={child.id}
                  href={`/workspaces/${workspaceId}/circles/${child.id}`}
                  className="nr-item row"
                  style={{ color: "inherit", textDecoration: "none" }}
                >
                  <strong>{child.name}</strong>
                  <span className="nr-item-meta">{t("roleCount", { count: child.roles.length })}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {canManageStructure && (
          <details style={{ marginTop: 24 }}>
            <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>
              {t("btnEditCircle")}
            </summary>
            <form action={updateCircleAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
              {hiddenWorkspace(workspaceId)}
              <input type="hidden" name="circleId" value={circle.id} />
              <label>
                {t("formName")}
                <input name="name" defaultValue={circle.name} required />
              </label>
              <label>
                {t("formParentCircle")}
                <select name="parentCircleId" defaultValue={circle.parentCircleId ?? ""}>
                  <option value="">{t("formParentCircleNone")}</option>
                  {parentOptions.map((parent) => (
                    <option key={parent.id} value={parent.id}>{parent.name}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("formPurpose")}
                <textarea name="purposeMd" defaultValue={circle.purposeMd ?? ""} />
              </label>
              <label>
                {t("formDomain")}
                <textarea name="domainMd" defaultValue={circle.domainMd ?? ""} />
              </label>
              <button type="submit" className="secondary small">{tCommon("save")}</button>
            </form>
          </details>
        )}
      </section>

      <section className="ws-section" style={{ marginBottom: 32 }}>
        <h2 className="nr-section-header">{t("labelMembers", { count: members.length })}</h2>
        {members.length === 0 ? (
          <p className="muted">{t("noMembersAssigned")}</p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {members.map((member) => (
              <Link
                key={member.memberId}
                href={`/workspaces/${workspaceId}/members/${member.memberId}`}
                className="nr-item"
                style={{ color: "inherit", textDecoration: "none" }}
              >
                <strong>{member.displayName}</strong>
                <div className="nr-item-meta" style={{ marginTop: 4 }}>
                  {member.roleNames.join(", ")}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="ws-section" style={{ marginBottom: 32 }}>
        <h2 className="nr-section-header">{t("labelRoles", { count: circle.roles.length })}</h2>
        {circle.roles.length === 0 ? (
          <p className="muted">{t("noRolesInCircle")}</p>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {circle.roles.map((role) => {
              const assignments = role.assignments ?? [];
              const versions = roleVersionsByRole.get(role.id) ?? [];
              const holderEvents = holderHistoryByRole.get(role.id) ?? [];
              return (
                <article key={role.id} className="nr-item">
                  <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
                    <div style={{ minWidth: 0 }}>
                      <strong className="nr-item-title">{role.name}</strong>
                      <div className="nr-item-meta" style={{ marginTop: 4 }}>
                        {(role.accountabilities?.length ?? 0) > 0
                          ? t("accountabilityCount", { count: role.accountabilities.length })
                          : t("noAccountabilities")}
                      </div>
                    </div>
                    {canManageStructure && (
                      <ActionMenu label={tCommon("moreActions")}>
                        <form action={deleteRoleAction}>
                          {hiddenWorkspace(workspaceId)}
                          <input type="hidden" name="roleId" value={role.id} />
                          <ConfirmSubmitButton className="danger" message={t("confirmArchiveRole")}>
                            {t("btnDelete")}
                          </ConfirmSubmitButton>
                        </form>
                      </ActionMenu>
                    )}
                  </div>

                  {role.purposeMd && <div className="nr-excerpt" style={{ marginTop: 8 }}>{role.purposeMd}</div>}
                  {(role.accountabilities?.length ?? 0) > 0 && (
                    <ul style={{ margin: "10px 0 0", paddingLeft: 18 }}>
                      {role.accountabilities.map((accountability: string, index: number) => (
                        <li key={`${role.id}-accountability-${index}`} className="nr-item-meta" style={{ marginBottom: 4 }}>
                          {accountability}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                    <strong style={{ display: "block", marginBottom: 8, fontSize: "0.85rem" }}>{t("labelAssignedTo")}</strong>
                    {assignments.length === 0 ? (
                      <p className="muted" style={{ margin: 0 }}>{t("unassigned")}</p>
                    ) : (
                      <div style={{ display: "grid", gap: 8 }}>
                        {assignments.map((assignment: RoleAssignmentRecord) => {
                          const memberId = assignment.member?.id;
                          if (!memberId) return null;
                          return (
                            <div key={assignment.id} className="row" style={{ gap: 12 }}>
                              <Link href={`/workspaces/${workspaceId}/members/${memberId}`} style={{ color: "inherit", textDecoration: "none" }}>
                                {memberName(assignment)}
                              </Link>
                              {onboardingByRoleMember.has(`${role.id}:${memberId}`) && (
                                <Link
                                  href={`/workspaces/${workspaceId}/chat?session=${onboardingByRoleMember.get(`${role.id}:${memberId}`)?.conversationId}`}
                                  className="tag info"
                                  style={{ fontSize: "0.7rem", padding: "2px 6px", textDecoration: "none" }}
                                >
                                  onboarding {onboardingByRoleMember.get(`${role.id}:${memberId}`)?.status.toLowerCase()}
                                </Link>
                              )}
                              {canManageStructure && (
                                <form action={unassignRoleAction}>
                                  {hiddenWorkspace(workspaceId)}
                                  <input type="hidden" name="roleId" value={role.id} />
                                  <input type="hidden" name="memberId" value={memberId} />
                                  <button type="submit" className="secondary small">{t("btnUnassign")}</button>
                                </form>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {canManageStructure && (
                    <details style={{ marginTop: 16 }}>
                      <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>
                        {t("btnEditRole")}
                      </summary>
                      <form action={updateRoleAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
                        {hiddenWorkspace(workspaceId)}
                        <input type="hidden" name="roleId" value={role.id} />
                        <label>
                          {t("formName")}
                          <input name="name" defaultValue={role.name} required />
                        </label>
                        <label>
                          {t("formPurpose")}
                          <textarea name="purposeMd" defaultValue={role.purposeMd ?? ""} />
                        </label>
                        <label>
                          {t("formAccountabilities")}
                          <textarea name="accountabilities" defaultValue={(role.accountabilities ?? []).join("\n")} placeholder={t("formAccountabilitiesPlaceholder")} />
                        </label>
                        <button type="submit" className="secondary small">{tCommon("save")}</button>
                      </form>
                    </details>
                  )}

                  {(versions.length > 0 || holderEvents.length > 0) && (
                    <details style={{ marginTop: 16 }}>
                      <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>
                        Role history
                      </summary>
                      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                        {versions.length > 0 && (
                          <div>
                            <strong style={{ display: "block", fontSize: "0.8rem", marginBottom: 6 }}>Definition versions</strong>
                            <div style={{ display: "grid", gap: 6 }}>
                              {versions.slice(0, 5).map((version) => (
                                <div key={version.id} className="nr-item-meta">
                                  v{version.version} {version.changeType} - {version.createdAt.toISOString().slice(0, 10)}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {holderEvents.length > 0 && (
                          <div>
                            <strong style={{ display: "block", fontSize: "0.8rem", marginBottom: 6 }}>Holder history</strong>
                            <div style={{ display: "grid", gap: 6 }}>
                              {holderEvents.slice(0, 8).map((event) => {
                                const holderName = event.member?.user.displayName
                                  ?? event.member?.user.email
                                  ?? event.agentIdentity?.displayName
                                  ?? "Unknown holder";
                                return (
                                  <div key={event.id} className="nr-item-meta">
                                    {holderName} - {event.startedAt.toISOString().slice(0, 10)}
                                    {event.endedAt ? ` to ${event.endedAt.toISOString().slice(0, 10)}` : " to present"}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="ws-section">
        <h2 className="nr-section-header">{t("agentMembersTitle")}</h2>
        {agentAssignments.length === 0 ? (
          <p className="muted">{t("noAgentsAssigned")}</p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {agentAssignments.map((assignment) => (
              <div key={assignment.id} className="nr-item row" style={{ gap: 12 }}>
                <div>
                  <strong>{assignment.agentIdentity.displayName}</strong>
                  <div className="nr-item-meta" style={{ marginTop: 4 }}>
                    {assignment.role?.name ?? t("agentCircleLevelRole")} - {assignment.agentIdentity.memberType}
                  </div>
                </div>
                {canManageAgents && (
                  <form action={removeAgentFromCircleAction}>
                    {hiddenWorkspace(workspaceId)}
                    <input type="hidden" name="circleId" value={circle.id} />
                    <input type="hidden" name="agentIdentityId" value={assignment.agentIdentityId} />
                    <button type="submit" className="secondary small">{t("btnUnassign")}</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}

        {canManageAgents && (
          <details style={{ marginTop: 16 }}>
            <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>
              {t("btnAssignAgent")}
            </summary>
            <form action={assignAgentToCircleAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
              {hiddenWorkspace(workspaceId)}
              <input type="hidden" name="circleId" value={circle.id} />
              <label>
                {t("agentMembersTitle")}
                <select name="agentIdentityId" required defaultValue="">
                  <option value="">{t("selectAgentOption")}</option>
                  {availableAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.displayName}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("formRoleOptional")}
                <select name="roleId" defaultValue="">
                  <option value="">{t("agentCircleLevelRole")}</option>
                  {circle.roles.map((role) => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </select>
              </label>
              {availableAgents.length === 0 && <p className="form-message form-message-error">{t("noAgentsAvailable")}</p>}
              <button type="submit" className="secondary small" disabled={availableAgents.length === 0}>
                {t("btnAssignAgent")}
              </button>
            </form>
          </details>
        )}

        {canManageStructure && (
          <div className="nr-item-meta" style={{ marginTop: 16 }}>
            {t("addMemberWithPlusHint")}
          </div>
        )}
      </section>
    </>
  );
}
