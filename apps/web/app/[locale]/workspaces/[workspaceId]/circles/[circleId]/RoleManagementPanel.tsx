import Link from "next/link";
import { ActionMenu } from "@/lib/components/ui/ActionMenu";
import {
  assignRoleAction,
  deleteRoleAction,
  reassignRoleAction,
  unassignRoleAction,
  updateRoleAction,
} from "../../actions";
import { ConfirmSubmitButton } from "../ConfirmSubmitButton";

type RoleManagementMember = {
  id: string;
  name: string;
  email?: string | null;
};

type RoleManagementAssignment = {
  id: string;
  member?: {
    id?: string | null;
    user?: {
      id?: string | null;
      displayName?: string | null;
      email?: string | null;
    } | null;
  } | null;
};

type RoleManagementRole = {
  id: string;
  name: string;
  purposeMd?: string | null;
  accountabilities?: string[];
  assignments?: RoleManagementAssignment[];
};

type RoleVersionRecord = {
  id: string;
  roleId: string;
  version: number;
  changeType: string;
  createdAt: Date;
};

type RoleHolderHistoryRecord = {
  id: string;
  roleId: string;
  startedAt: Date;
  endedAt: Date | null;
  member?: {
    user: {
      displayName: string | null;
      email: string | null;
    };
  } | null;
  agentIdentity?: {
    displayName: string;
    memberType: string;
  } | null;
};

type RoleOnboardingRecord = {
  roleId: string;
  memberId: string;
  conversationId: string | null;
  status: string;
};

export type RoleManagementLabels = {
  accountabilityCount: (count: number) => string;
  btnAddHolder: string;
  btnDelete: string;
  btnEditRole: string;
  btnReassign: string;
  btnUnassign: string;
  confirmArchiveRole: string;
  dateRangeTo: string;
  definitionVersions: string;
  formAccountabilities: string;
  formAccountabilitiesPlaceholder: string;
  formMember: string;
  formName: string;
  formPurpose: string;
  holderHistory: string;
  labelAssignedTo: string;
  noAccountabilities: string;
  noAvailableMembers: string;
  onboardingStatus: (status: string) => string;
  present: string;
  reassignTo: string;
  roleHistory: string;
  save: string;
  selectMember: string;
  unassigned: string;
  unknownHolder: string;
};

function hiddenWorkspace(workspaceId: string) {
  return <input type="hidden" name="workspaceId" value={workspaceId} />;
}

function memberName(assignment: RoleManagementAssignment, unknownHolder: string) {
  return assignment.member?.user?.displayName
    ?? assignment.member?.user?.email
    ?? unknownHolder;
}

function memberOptionLabel(member: RoleManagementMember) {
  return member.email ? `${member.name} (${member.email})` : member.name;
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function RoleManagementPanel({
  workspaceId,
  roles,
  members,
  canManageStructure,
  currentUserId,
  roleVersionsByRole,
  holderHistoryByRole,
  onboardingByRoleMember,
  labels,
  moreActionsLabel,
}: {
  workspaceId: string;
  roles: RoleManagementRole[];
  members: RoleManagementMember[];
  canManageStructure: boolean;
  currentUserId: string | null;
  roleVersionsByRole: Map<string, RoleVersionRecord[]>;
  holderHistoryByRole: Map<string, RoleHolderHistoryRecord[]>;
  onboardingByRoleMember: Map<string, RoleOnboardingRecord>;
  labels: RoleManagementLabels;
  moreActionsLabel: string;
}) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {roles.map((role) => {
        const assignments = role.assignments ?? [];
        const assignedMemberIds = new Set(assignments.map((assignment) => assignment.member?.id).filter(Boolean));
        const addableMembers = members.filter((member) => !assignedMemberIds.has(member.id));
        const versions = roleVersionsByRole.get(role.id) ?? [];
        const holderEvents = holderHistoryByRole.get(role.id) ?? [];

        return (
          <article key={role.id} className="nr-item">
            <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
              <div style={{ minWidth: 0 }}>
                <strong className="nr-item-title">{role.name}</strong>
                <div className="nr-item-meta" style={{ marginTop: 4 }}>
                  {(role.accountabilities?.length ?? 0) > 0
                    ? labels.accountabilityCount(role.accountabilities?.length ?? 0)
                    : labels.noAccountabilities}
                </div>
              </div>
              {canManageStructure && (
                <ActionMenu label={moreActionsLabel}>
                  <form action={deleteRoleAction}>
                    {hiddenWorkspace(workspaceId)}
                    <input type="hidden" name="roleId" value={role.id} />
                    <ConfirmSubmitButton className="danger" message={labels.confirmArchiveRole}>
                      {labels.btnDelete}
                    </ConfirmSubmitButton>
                  </form>
                </ActionMenu>
              )}
            </div>

            {role.purposeMd && <div className="nr-excerpt" style={{ marginTop: 8 }}>{role.purposeMd}</div>}
            {(role.accountabilities?.length ?? 0) > 0 && (
              <ul style={{ margin: "10px 0 0", paddingLeft: 18 }}>
                {role.accountabilities?.map((accountability, index) => (
                  <li key={`${role.id}-accountability-${index}`} className="nr-item-meta" style={{ marginBottom: 4 }}>
                    {accountability}
                  </li>
                ))}
              </ul>
            )}

            <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              <strong style={{ display: "block", marginBottom: 8, fontSize: "0.85rem" }}>{labels.labelAssignedTo}</strong>
              {assignments.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>{labels.unassigned}</p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {assignments.map((assignment) => {
                    const memberId = assignment.member?.id;
                    const onboarding = memberId ? onboardingByRoleMember.get(`${role.id}:${memberId}`) : null;
                    const canOpenOnboarding = Boolean(
                      onboarding && assignment.member?.user?.id === currentUserId,
                    );
                    const replacementMembers = memberId
                      ? members.filter((member) => member.id !== memberId && !assignedMemberIds.has(member.id))
                      : [];
                    if (!memberId) return null;
                    return (
                      <div key={assignment.id} style={{ display: "grid", gap: 8, padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                        <div className="row" style={{ gap: 12 }}>
                          <Link href={`/workspaces/${workspaceId}/members/${memberId}`} style={{ color: "inherit", textDecoration: "none", fontWeight: 700 }}>
                            {memberName(assignment, labels.unknownHolder)}
                          </Link>
                          {onboarding && canOpenOnboarding && (
                            <Link
                              href={`/workspaces/${workspaceId}/chat?session=${onboarding.conversationId}`}
                              className="tag info"
                              style={{ fontSize: "0.7rem", padding: "2px 6px", textDecoration: "none" }}
                            >
                              {labels.onboardingStatus(onboarding.status.toLowerCase())}
                            </Link>
                          )}
                          {onboarding && !canOpenOnboarding && (
                            <span className="tag info" style={{ fontSize: "0.7rem", padding: "2px 6px" }}>
                              {labels.onboardingStatus(onboarding.status.toLowerCase())}
                            </span>
                          )}
                          {canManageStructure && (
                            <form action={unassignRoleAction}>
                              {hiddenWorkspace(workspaceId)}
                              <input type="hidden" name="roleId" value={role.id} />
                              <input type="hidden" name="memberId" value={memberId} />
                              <button type="submit" className="secondary small">{labels.btnUnassign}</button>
                            </form>
                          )}
                        </div>
                        {canManageStructure && (
                          <form action={reassignRoleAction} className="row" style={{ gap: 8 }}>
                            {hiddenWorkspace(workspaceId)}
                            <input type="hidden" name="roleId" value={role.id} />
                            <input type="hidden" name="fromMemberId" value={memberId} />
                            <label style={{ flex: "1 1 220px", minWidth: 180 }}>
                              {labels.reassignTo}
                              <select name="toMemberId" required defaultValue="" disabled={replacementMembers.length === 0}>
                                <option value="">{labels.selectMember}</option>
                                {replacementMembers.map((member) => (
                                  <option key={member.id} value={member.id}>{memberOptionLabel(member)}</option>
                                ))}
                              </select>
                            </label>
                            <button type="submit" className="secondary small" disabled={replacementMembers.length === 0}>
                              {labels.btnReassign}
                            </button>
                          </form>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {canManageStructure && (
                <form action={assignRoleAction} className="row" style={{ gap: 8, marginTop: 12 }}>
                  {hiddenWorkspace(workspaceId)}
                  <input type="hidden" name="roleId" value={role.id} />
                  <label style={{ flex: "1 1 260px", minWidth: 200 }}>
                    {labels.formMember}
                    <select name="memberId" required defaultValue="" disabled={addableMembers.length === 0}>
                      <option value="">{labels.selectMember}</option>
                      {addableMembers.map((member) => (
                        <option key={member.id} value={member.id}>{memberOptionLabel(member)}</option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="secondary small" disabled={addableMembers.length === 0}>
                    {labels.btnAddHolder}
                  </button>
                  {addableMembers.length === 0 && <span className="nr-item-meta">{labels.noAvailableMembers}</span>}
                </form>
              )}
            </div>

            {canManageStructure && (
              <details style={{ marginTop: 16 }}>
                <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>
                  {labels.btnEditRole}
                </summary>
                <form action={updateRoleAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
                  {hiddenWorkspace(workspaceId)}
                  <input type="hidden" name="roleId" value={role.id} />
                  <label>
                    {labels.formName}
                    <input name="name" defaultValue={role.name} required />
                  </label>
                  <label>
                    {labels.formPurpose}
                    <textarea name="purposeMd" defaultValue={role.purposeMd ?? ""} />
                  </label>
                  <label>
                    {labels.formAccountabilities}
                    <textarea name="accountabilities" defaultValue={(role.accountabilities ?? []).join("\n")} placeholder={labels.formAccountabilitiesPlaceholder} />
                  </label>
                  <button type="submit" className="secondary small">{labels.save}</button>
                </form>
              </details>
            )}

            {(versions.length > 0 || holderEvents.length > 0) && (
              <details style={{ marginTop: 16 }}>
                <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>
                  {labels.roleHistory}
                </summary>
                <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                  {versions.length > 0 && (
                    <div>
                      <strong style={{ display: "block", fontSize: "0.8rem", marginBottom: 6 }}>{labels.definitionVersions}</strong>
                      <div style={{ display: "grid", gap: 6 }}>
                        {versions.slice(0, 5).map((version) => (
                          <div key={version.id} className="nr-item-meta">
                            v{version.version} {version.changeType} - {formatDate(version.createdAt)}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {holderEvents.length > 0 && (
                    <div>
                      <strong style={{ display: "block", fontSize: "0.8rem", marginBottom: 6 }}>{labels.holderHistory}</strong>
                      <div style={{ display: "grid", gap: 6 }}>
                        {holderEvents.slice(0, 8).map((event) => {
                          const holderName = event.member?.user.displayName
                            ?? event.member?.user.email
                            ?? event.agentIdentity?.displayName
                            ?? labels.unknownHolder;
                          return (
                            <div key={event.id} className="nr-item-meta">
                              {holderName} - {formatDate(event.startedAt)}
                              {" "}
                              {labels.dateRangeTo}
                              {" "}
                              {event.endedAt ? formatDate(event.endedAt) : labels.present}
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
  );
}
