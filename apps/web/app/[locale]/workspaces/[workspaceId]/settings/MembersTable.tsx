"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  approveMemberInviteRequestAction,
  bulkInviteAction,
  createMemberAction,
  inviteMemberAction,
  rejectMemberInviteRequestAction,
  requestMemberInviteAction,
  resendMemberAccessLinkAction,
  updateMemberAction,
  updateMemberInvitePolicyAction,
} from "../actions";
import { useTranslations } from "next-intl";
import { Dialog } from "@/lib/components/Dialog";

type InvitePolicy = "ADMINS_ONLY" | "MEMBERS_CAN_INVITE" | "MEMBERS_CAN_REQUEST";

type EnrichedMember = {
  id: string;
  role: string;
  isActive: boolean;
  joinedAt: Date;
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  roleAssignments: {
    role: {
      name: string;
      circle: {
        id: string;
        name: string;
      };
    };
  }[];
};

type InviteRequest = {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: Date;
  requesterMember: {
    user: {
      email: string;
      displayName: string | null;
    };
  };
};

const MEMBER_ROLES = ["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"] as const;

function roleLabelKey(role: string) {
  return `role${role.split("_").map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join("")}`;
}

export function MembersTable({
  workspaceId,
  members,
  isAdmin,
  invitePolicy,
  inviteRequests,
}: {
  workspaceId: string;
  members: EnrichedMember[];
  isAdmin?: boolean;
  invitePolicy: InvitePolicy;
  inviteRequests: InviteRequest[];
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ACTIVE" | "ALL">("ACTIVE");
  const [circleFilter, setCircleFilter] = useState<string>("ALL");
  const [editingMember, setEditingMember] = useState<EnrichedMember | null>(null);
  const t = useTranslations("settings");

  const allCircles = useMemo(() => {
    const circles = new Map<string, { id: string; name: string }>();
    for (const member of members) {
      for (const assignment of member.roleAssignments) {
        if (!circles.has(assignment.role.circle.id)) {
          circles.set(assignment.role.circle.id, assignment.role.circle);
        }
      }
    }
    return Array.from(circles.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [members]);

  const filteredMembers = useMemo(() => {
    return members.filter((member) => {
      if (statusFilter === "ACTIVE" && !member.isActive) return false;

      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const searchMatches =
          (member.user.displayName && member.user.displayName.toLowerCase().includes(query)) ||
          member.user.email.toLowerCase().includes(query) ||
          member.role.toLowerCase().includes(query) ||
          member.roleAssignments.some((assignment) =>
            assignment.role.name.toLowerCase().includes(query) ||
            assignment.role.circle.name.toLowerCase().includes(query)
          );
        if (!searchMatches) return false;
      }

      if (roleFilter !== "ALL" && member.role !== roleFilter) return false;

      if (circleFilter !== "ALL") {
        const inCircle = member.roleAssignments.some((assignment) => assignment.role.circle.id === circleFilter);
        if (!inCircle) return false;
      }

      return true;
    });
  }, [members, searchQuery, roleFilter, statusFilter, circleFilter]);

  const totalCount = members.length;
  const activeCount = members.filter((member) => member.isActive).length;
  const adminCount = members.filter((member) => member.role === "ADMIN" && (statusFilter === "ALL" || member.isActive)).length;
  const contributorCount = members.filter((member) => member.role === "CONTRIBUTOR" && (statusFilter === "ALL" || member.isActive)).length;
  const facilitatorCount = members.filter((member) => member.role === "FACILITATOR" && (statusFilter === "ALL" || member.isActive)).length;
  const canInviteDirectly = Boolean(isAdmin) || invitePolicy === "MEMBERS_CAN_INVITE";
  const canRequestInvite = !isAdmin && invitePolicy === "MEMBERS_CAN_REQUEST";

  return (
    <div className="stack" style={{ gap: 24, marginTop: 16 }}>
      <div className="nr-stat-bar" style={{ padding: "16px 20px" }}>
        <div className="nr-stat" style={{ display: "flex", flexDirection: "column" }}>
          <strong style={{ fontSize: "1.3rem" }}>{activeCount}</strong>
          <span className="nr-meta">{t("statActiveMembers", { inactiveInfo: totalCount > activeCount ? t("inactiveInfo", { count: totalCount - activeCount }) : "" })}</span>
        </div>
        <span className="nr-stat-sep" />
        <div className="nr-stat" style={{ display: "flex", flexDirection: "column" }}>
          <strong style={{ fontSize: "1rem", lineHeight: "1.2rem" }}>
            {t("statRoleDistribution", { admin: adminCount, contributor: contributorCount, facilitatorInfo: facilitatorCount > 0 ? t("facilitatorInfo", { count: facilitatorCount }) : "" })}
          </strong>
          <span className="nr-meta">{t("labelRoleDistribution")}</span>
        </div>
      </div>

      {isAdmin && (
        <section className="stack" style={{ gap: 12, border: "1px dashed var(--line)", borderRadius: 8, padding: 16 }}>
          <div>
            <strong>{t("invitePolicyTitle")}</strong>
            <p className="nr-item-meta" style={{ marginTop: 4 }}>{t("invitePolicyDescription")}</p>
          </div>
          <form action={updateMemberInvitePolicyAction} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end" }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <label style={{ minWidth: 260 }}>
              {t("invitePolicyLabel")}
              <select name="policy" defaultValue={invitePolicy}>
                <option value="ADMINS_ONLY">{t("invitePolicyAdminsOnly")}</option>
                <option value="MEMBERS_CAN_INVITE">{t("invitePolicyMembersCanInvite")}</option>
                <option value="MEMBERS_CAN_REQUEST">{t("invitePolicyMembersCanRequest")}</option>
              </select>
            </label>
            <button type="submit" className="secondary">{t("btnSavePolicy")}</button>
          </form>
        </section>
      )}

      {isAdmin && inviteRequests.length > 0 && (
        <section className="stack" style={{ gap: 12, border: "1px dashed var(--line)", borderRadius: 8, padding: 16 }}>
          <strong>{t("pendingInviteRequestsTitle")}</strong>
          <div className="stack" style={{ gap: 8 }}>
            {inviteRequests.map((request) => (
              <div key={request.id} className="nr-item row" style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
                <div>
                  <strong>{request.displayName || request.email}</strong>
                  <div className="nr-item-meta">
                    {request.email} · {t("requestedBy", { name: request.requesterMember.user.displayName || request.requesterMember.user.email })}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <form action={approveMemberInviteRequestAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="requestId" value={request.id} />
                    <button type="submit" className="small">{t("btnApprove")}</button>
                  </form>
                  <form action={rejectMemberInviteRequestAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="requestId" value={request.id} />
                    <button type="submit" className="secondary small">{t("btnReject")}</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {(canInviteDirectly || canRequestInvite) && (
        <details style={{ background: "var(--bg)", border: "1px dashed var(--line)", borderRadius: 8 }}>
          <summary className="nr-section-header" style={{ borderTop: "none", display: "block", padding: 16, margin: 0, cursor: "pointer", color: "var(--accent)" }}>
            <span style={{ fontWeight: 600 }}>
              {canRequestInvite ? t("btnRequestInvite") : t("btnInviteMember")}
            </span>
          </summary>
          <div style={{ padding: "0 16px 16px" }}>
            <form action={canRequestInvite ? requestMemberInviteAction : isAdmin ? createMemberAction : inviteMemberAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                <label>
                  {t("labelName")}
                  <input name="displayName" />
                </label>
                <label>
                  {t("labelEmail")}
                  <input name="email" type="email" required />
                </label>
              </div>
              {isAdmin && (
                <label>
                  {t("labelSystemRole")}
                  <select name="role" defaultValue="CONTRIBUTOR">
                    {MEMBER_ROLES.map((role) => (
                      <option key={role} value={role}>{t(roleLabelKey(role) as any)}</option>
                    ))}
                  </select>
                </label>
              )}
              <button type="submit" style={{ alignSelf: "flex-start" }}>{canRequestInvite ? t("btnSubmitInviteRequest") : t("btnSendInvite")}</button>
            </form>
          </div>
        </details>
      )}

      {isAdmin && (
        <details style={{ background: "var(--bg)", border: "1px dashed var(--line)", borderRadius: 8 }}>
          <summary className="nr-section-header" style={{ borderTop: "none", display: "block", padding: 16, margin: 0, cursor: "pointer", color: "var(--accent)" }}>
            <span style={{ fontWeight: 600 }}>{t("btnBulkInvite")}</span>
          </summary>
          <div style={{ padding: "0 16px 16px" }}>
            <form action={bulkInviteAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                {t("labelPasteCsv")}
                <textarea
                  name="csvData"
                  rows={4}
                  placeholder={t("placeholderCsv")}
                  style={{ fontFamily: "monospace", width: "100%", padding: 8 }}
                  required
                />
              </label>
              <button type="submit" style={{ alignSelf: "flex-start" }}>{t("btnSendBulkInvites")}</button>
            </form>
          </div>
        </details>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
          <input
            type="text"
            placeholder={t("placeholderSearchMembers")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            style={{ width: 240, fontSize: "0.85rem", padding: "8px 12px" }}
          />
          <select
            value={circleFilter}
            onChange={(event) => setCircleFilter(event.target.value)}
            style={{ width: 200, fontSize: "0.85rem", padding: "8px 12px" }}
          >
            <option value="ALL">{t("optionAllCircles")}</option>
            {allCircles.map((circle) => (
              <option key={circle.id} value={circle.id}>{circle.name}</option>
            ))}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={statusFilter === "ALL"}
              onChange={(event) => setStatusFilter(event.target.checked ? "ALL" : "ACTIVE")}
              style={{ margin: 0 }}
            />
            {t("labelShowDeactivated")}
          </label>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {["ALL", ...MEMBER_ROLES].map((role) => (
            <button
              key={role}
              onClick={() => setRoleFilter(role)}
              className={roleFilter === role ? "button small" : "button secondary small"}
              style={{ padding: "4px 10px", fontSize: "0.75rem", borderRadius: 16 }}
            >
              {role === "ALL" ? t("optionAllRoles") : t(roleLabelKey(role) as any)}
            </button>
          ))}
        </div>
      </div>

      <div style={{ overflowX: "auto", border: "1px dashed var(--line)", borderRadius: 8, background: "var(--bg)" }}>
        <table className="nr-table" style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ borderBottom: "1px dashed var(--line)", background: "rgba(0,0,0,0.02)" }}>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>{t("colName")}</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>{t("colEmail")}</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>{t("colOrgRoles")}</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>{t("colCircles")}</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>{t("labelSystemRole")}</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>{t("colStatus")}</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>{t("colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {filteredMembers.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>
                  {members.length === 0 ? t("msgEmptyMembers") : t("msgNoMatchingMembers")}
                </td>
              </tr>
            ) : (
              filteredMembers.map((member) => {
                const memberCircles = Array.from(new Set(member.roleAssignments.map((assignment) => assignment.role.circle.name)));
                return (
                  <tr key={member.id} style={{ borderBottom: "1px dashed var(--line)", opacity: member.isActive ? 1 : 0.6 }}>
                    <td style={{ padding: "12px 16px", fontWeight: 500 }}>
                      <Link href={`/workspaces/${workspaceId}/members/${member.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                        {member.user.displayName || t("unknownUser")}
                      </Link>
                    </td>
                    <td style={{ padding: "12px 16px", color: "var(--muted)" }}>{member.user.email}</td>
                    <td style={{ padding: "12px 16px" }}>
                      {member.roleAssignments.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {member.roleAssignments.slice(0, 3).map((assignment) => (
                            <span key={`${member.id}-${assignment.role.name}`} className="tag info" style={{ fontSize: "0.7rem", padding: "2px 6px" }}>
                              {assignment.role.name}
                            </span>
                          ))}
                          {member.roleAssignments.length > 3 && (
                            <span className="tag" style={{ fontSize: "0.7rem", padding: "2px 6px" }}>+{member.roleAssignments.length - 3}</span>
                          )}
                        </div>
                      ) : (
                        <span className="muted" style={{ fontSize: "0.75rem" }}>{t("valNone")}</span>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px", color: "var(--muted)", fontSize: "0.8rem" }}>{memberCircles.join(", ") || t("valNone")}</td>
                    <td style={{ padding: "12px 16px" }}>{t(roleLabelKey(member.role) as any)}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <span style={{ color: member.isActive ? "var(--success, #155724)" : "var(--muted)", fontSize: "0.75rem", fontWeight: 600 }}>
                        {member.isActive ? t("statusActive") : t("statusDeactivated")}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", minWidth: 260 }}>
                      {isAdmin ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <button
                            type="button"
                            className="secondary small"
                            onClick={() => setEditingMember(member)}
                            style={{ alignSelf: "flex-start" }}
                          >
                            {t("btnEditMember")}
                          </button>
                          <form action={resendMemberAccessLinkAction}>
                            <input type="hidden" name="workspaceId" value={workspaceId} />
                            <input type="hidden" name="memberId" value={member.id} />
                            <button type="submit" className="secondary small" style={{ padding: "4px 8px", fontSize: "0.7rem" }}>{t("btnResendAccessLink")}</button>
                          </form>
                        </div>
                      ) : (
                        <span className="muted" style={{ fontSize: "0.75rem" }}>{t("noMemberActions")}</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {editingMember && (
        <Dialog open={true} onClose={() => setEditingMember(null)} title={t("btnEditMember")}>
          <form
            action={(formData) => {
              updateMemberAction(formData);
              setEditingMember(null);
            }}
            className="stack nr-form-section"
          >
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="memberId" value={editingMember.id} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>
                {t("labelName")}
                <input name="displayName" defaultValue={editingMember.user.displayName ?? ""} />
              </label>
              <label>
                {t("labelEmail")}
                <input name="email" type="email" defaultValue={editingMember.user.email} required />
              </label>
            </div>
            <label>
              {t("labelSystemRole")}
              <select name="role" defaultValue={editingMember.role}>
                {MEMBER_ROLES.map((role) => (
                  <option key={role} value={role}>{t(roleLabelKey(role) as any)}</option>
                ))}
              </select>
            </label>
            <label>
              {t("colStatus")}
              <select name="isActive" defaultValue={editingMember.isActive ? "true" : "false"}>
                <option value="true">{t("statusActive")}</option>
                <option value="false">{t("statusDeactivated")}</option>
              </select>
            </label>
            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button type="submit" className="small">{t("btnSaveMember")}</button>
              <button type="button" className="secondary small" onClick={() => setEditingMember(null)}>{t("btnCancel")}</button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
