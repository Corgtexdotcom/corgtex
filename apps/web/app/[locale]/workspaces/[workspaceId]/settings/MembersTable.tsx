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
import { CheckboxFilter, FilterField, FilterToolbar, TableActionGroup } from "@/lib/components/ControlPrimitives";
import { DataTable, type DataTableColumn, type DataTableRow } from "@/lib/components/DataTable";
import { Dialog } from "@/lib/components/Dialog";
import { MultiSelectFilter } from "@/lib/components/MultiSelectFilter";
import { useToast } from "@/lib/components/Toast";

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
  const [roleFilters, setRoleFilters] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<"ACTIVE" | "ALL">("ACTIVE");
  const [circleFilters, setCircleFilters] = useState<string[]>([]);
  const [editingMember, setEditingMember] = useState<EnrichedMember | null>(null);
  const t = useTranslations("settings");
  const tWork = useTranslations("workItems");
  const { addToast } = useToast();

  const handleActionWithToast = async (actionFn: (formData: FormData) => Promise<any>, formData: FormData, successMsg: string) => {
    try {
      const result = await actionFn(formData);
      if (result && result.success === false) {
        addToast(result.error || "Action failed", "error");
        return;
      }
      if (result?.emailStatus && !result.emailStatus.sent) {
        addToast(`${successMsg}. However, the email failed to send: ${result.emailStatus.error}`, "info");
      } else {
        addToast(successMsg, "success");
      }
    } catch (e: any) {
      addToast(e.message || "An error occurred", "error");
    }
  };

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

      if (roleFilters.length > 0 && !roleFilters.includes(member.role)) return false;

      if (circleFilters.length > 0) {
        const inCircle = member.roleAssignments.some((assignment) => circleFilters.includes(assignment.role.circle.id));
        if (!inCircle) return false;
      }

      return true;
    });
  }, [members, searchQuery, roleFilters, statusFilter, circleFilters]);

  const totalCount = members.length;
  const activeCount = members.filter((member) => member.isActive).length;
  const adminCount = members.filter((member) => member.role === "ADMIN" && (statusFilter === "ALL" || member.isActive)).length;
  const contributorCount = members.filter((member) => member.role === "CONTRIBUTOR" && (statusFilter === "ALL" || member.isActive)).length;
  const facilitatorCount = members.filter((member) => member.role === "FACILITATOR" && (statusFilter === "ALL" || member.isActive)).length;
  const canInviteDirectly = Boolean(isAdmin) || invitePolicy === "MEMBERS_CAN_INVITE";
  const canRequestInvite = !isAdmin && invitePolicy === "MEMBERS_CAN_REQUEST";
  const memberColumns: DataTableColumn[] = [
    { id: "name", label: t("colName") },
    { id: "email", label: t("colEmail"), cellClassName: "muted" },
    { id: "orgRoles", label: t("colOrgRoles") },
    { id: "circles", label: t("colCircles"), cellClassName: "muted" },
    { id: "systemRole", label: t("labelSystemRole") },
    { id: "status", label: t("colStatus") },
    { id: "actions", label: t("colActions"), cellClassName: "nr-table-action-cell" },
  ];
  const memberRows: DataTableRow[] = filteredMembers.map((member) => {
    const memberCircles = Array.from(new Set(member.roleAssignments.map((assignment) => assignment.role.circle.name)));

    return {
      id: member.id,
      className: member.isActive ? undefined : "nr-table-row-muted",
      cells: {
        name: (
          <Link href={`/workspaces/${workspaceId}/members/${member.id}`} className="nr-table-link">
            {member.user.displayName || t("unknownUser")}
          </Link>
        ),
        email: member.user.email,
        orgRoles: member.roleAssignments.length > 0 ? (
          <div className="actions-inline">
            {member.roleAssignments.slice(0, 3).map((assignment) => (
              <span key={`${member.id}-${assignment.role.name}`} className="tag info tag-compact">
                {assignment.role.name}
              </span>
            ))}
            {member.roleAssignments.length > 3 && (
              <span className="tag tag-compact">+{member.roleAssignments.length - 3}</span>
            )}
          </div>
        ) : (
          <span className="muted">{t("valNone")}</span>
        ),
        circles: memberCircles.join(", ") || t("valNone"),
        systemRole: t(roleLabelKey(member.role) as any),
        status: (
          <span className={`tag tag-compact ${member.isActive ? "success" : "neutral"}`}>
            {member.isActive ? t("statusActive") : t("statusDeactivated")}
          </span>
        ),
        actions: isAdmin ? (
          <TableActionGroup direction="stack">
            <button
              type="button"
              className="secondary small"
              onClick={() => setEditingMember(member)}
            >
              {t("btnEditMember")}
            </button>
            <button type="button" className="secondary small" onClick={async () => {
              const fd = new FormData();
              fd.append("workspaceId", workspaceId);
              fd.append("memberId", member.id);
              await handleActionWithToast(resendMemberAccessLinkAction, fd, "Access link sent successfully");
            }}>{t("btnResendAccessLink")}</button>
          </TableActionGroup>
        ) : (
          <span className="muted">{t("noMemberActions")}</span>
        ),
      },
    };
  });

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
                <TableActionGroup>
                  <button type="button" className="small" onClick={async () => {
                    const fd = new FormData();
                    fd.append("workspaceId", workspaceId);
                    fd.append("requestId", request.id);
                    await handleActionWithToast(approveMemberInviteRequestAction, fd, "Invite request approved");
                  }}>{t("btnApprove")}</button>
                  <button type="button" className="secondary small" onClick={async () => {
                    const fd = new FormData();
                    fd.append("workspaceId", workspaceId);
                    fd.append("requestId", request.id);
                    await handleActionWithToast(rejectMemberInviteRequestAction, fd, "Invite request rejected");
                  }}>{t("btnReject")}</button>
                </TableActionGroup>
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
            <form onSubmit={async (e) => { e.preventDefault(); await handleActionWithToast(canRequestInvite ? requestMemberInviteAction : isAdmin ? createMemberAction : inviteMemberAction, new FormData(e.currentTarget), canRequestInvite ? "Invite requested successfully" : "Member invited successfully"); }} className="stack nr-form-section" style={{ marginTop: 8 }}>
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
              <TableActionGroup>
                <button type="submit">{canRequestInvite ? t("btnSubmitInviteRequest") : t("btnSendInvite")}</button>
              </TableActionGroup>
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
            <form onSubmit={async (e) => { e.preventDefault(); await handleActionWithToast(bulkInviteAction, new FormData(e.currentTarget), "Bulk invites sent successfully"); }} className="stack nr-form-section" style={{ marginTop: 8 }}>
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
              <TableActionGroup>
                <button type="submit">{t("btnSendBulkInvites")}</button>
              </TableActionGroup>
            </form>
          </div>
        </details>
      )}

      <FilterToolbar className="nr-members-filter-toolbar">
        <FilterField label={t("labelSearchMembers")} className="nr-members-search-field">
          <input
            type="text"
            placeholder={t("placeholderSearchMembers")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </FilterField>
        <MultiSelectFilter
          name="circle"
          label={t("colCircles")}
          options={allCircles.map((circle) => ({ value: circle.id, label: circle.name }))}
          selectedValues={circleFilters}
          allLabel={t("optionAllCircles")}
          selectAllLabel={tWork("selectAll")}
          unselectAllLabel={tWork("unselectAll")}
          selectedCountLabel={tWork("selectedCount", { count: "{count}" })}
          onSelectionChange={setCircleFilters}
        />
        <MultiSelectFilter
          name="role"
          label={t("labelSystemRole")}
          options={MEMBER_ROLES.map((role) => ({ value: role, label: t(roleLabelKey(role) as any) }))}
          selectedValues={roleFilters}
          allLabel={t("optionAllRoles")}
          selectAllLabel={tWork("selectAll")}
          unselectAllLabel={tWork("unselectAll")}
          selectedCountLabel={tWork("selectedCount", { count: "{count}" })}
          onSelectionChange={setRoleFilters}
        />
        <CheckboxFilter
          checked={statusFilter === "ALL"}
          onChange={(event) => setStatusFilter(event.target.checked ? "ALL" : "ACTIVE")}
        >
          {t("labelShowDeactivated")}
        </CheckboxFilter>
      </FilterToolbar>

      <DataTable
        columns={memberColumns}
        rows={memberRows}
        empty={members.length === 0 ? t("msgEmptyMembers") : t("msgNoMatchingMembers")}
      />

      {editingMember && (
        <Dialog open={true} onClose={() => setEditingMember(null)} title={t("btnEditMember")}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await handleActionWithToast(updateMemberAction, new FormData(e.currentTarget), "Member updated successfully");
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
