"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { updateMemberAction, deactivateMemberAction, createMemberAction } from "../actions";

// Use the type directly from what we fetch to avoid schema type friction in client components
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

export function MembersTable({
  workspaceId,
  members,
}: {
  workspaceId: string;
  members: EnrichedMember[];
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ACTIVE" | "ALL">("ACTIVE");
  const [circleFilter, setCircleFilter] = useState<string>("ALL");

  // Extract unique circles for the dropdown
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

  // Filter members based on criteria
  const filteredMembers = useMemo(() => {
    return members.filter((member) => {
      // 1. Status Filter
      if (statusFilter === "ACTIVE" && !member.isActive) return false;

      // 2. Search Filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const searchMatches = 
          (member.user.displayName && member.user.displayName.toLowerCase().includes(query)) ||
          member.user.email.toLowerCase().includes(query) ||
          member.roleAssignments.some(ra => 
            ra.role.name.toLowerCase().includes(query) || 
            ra.role.circle.name.toLowerCase().includes(query)
          );
        if (!searchMatches) return false;
      }

      // 3. Role Filter (System Role)
      if (roleFilter !== "ALL" && member.role !== roleFilter) return false;

      // 4. Circle Filter
      if (circleFilter !== "ALL") {
        const inCircle = member.roleAssignments.some(ra => ra.role.circle.id === circleFilter);
        if (!inCircle) return false;
      }

      return true;
    });
  }, [members, searchQuery, roleFilter, statusFilter, circleFilter]);

  // Derived stats
  const totalCount = members.length;
  const activeCount = members.filter(m => m.isActive).length;
  const adminCount = members.filter(m => m.role === "ADMIN" && (statusFilter === "ALL" || m.isActive)).length;
  const contributorCount = members.filter(m => m.role === "CONTRIBUTOR" && (statusFilter === "ALL" || m.isActive)).length;
  const facilitatorCount = members.filter(m => m.role === "FACILITATOR" && (statusFilter === "ALL" || m.isActive)).length;

  return (
    <div className="stack" style={{ gap: 24, marginTop: 16 }}>
      
      {/* Stats Bar */}
      <div className="nr-stat-bar" style={{ padding: "16px 20px" }}>
        <div className="nr-stat" style={{ display: "flex", flexDirection: "column" }}>
          <strong style={{ fontSize: "1.3rem" }}>{activeCount}</strong>
          <span className="nr-meta">Active Members {totalCount > activeCount && `(${totalCount - activeCount} inactive)`}</span>
        </div>
        <span className="nr-stat-sep" />
        <div className="nr-stat" style={{ display: "flex", flexDirection: "column" }}>
          <strong style={{ fontSize: "1rem", lineHeight: "1.2rem" }}>
            {adminCount} Admins · {contributorCount} Contributors {facilitatorCount > 0 && `· ${facilitatorCount} Facilitators`}
          </strong>
          <span className="nr-meta">Role Distribution</span>
        </div>
      </div>

      {/* Add Member Collapsible */}
      <details style={{ background: "var(--bg)", border: "1px dashed var(--line)", borderRadius: 8 }}>
        <summary className="nr-section-header" style={{ borderTop: "none", display: "block", padding: "16px", margin: 0, cursor: "pointer", color: "var(--accent)" }}>
          <span style={{ fontWeight: 600 }}>+ Add member</span>
        </summary>
        <div style={{ padding: "0 16px 16px" }}>
          <form action={createMemberAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <label>
                Name
                <input name="displayName" />
              </label>
              <label>
                Email
                <input name="email" type="email" required />
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <label>
                Password
                <input name="password" type="password" required minLength={8} />
              </label>
              <label>
                System Role
                <select name="role" defaultValue="CONTRIBUTOR">
                  <option value="CONTRIBUTOR">Contributor</option>
                  <option value="FACILITATOR">Facilitator</option>
                  <option value="FINANCE_STEWARD">Finance Steward</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </label>
            </div>
            <button type="submit" style={{ alignSelf: "flex-start" }}>Add member</button>
          </form>
        </div>
      </details>

      {/* Filters Bar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
        
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search name, email, role..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: "240px", fontSize: "0.85rem", padding: "8px 12px" }}
          />
          
          <select 
            value={circleFilter}
            onChange={(e) => setCircleFilter(e.target.value)}
            style={{ width: "200px", fontSize: "0.85rem", padding: "8px 12px" }}
          >
            <option value="ALL">All Circles</option>
            {allCircles.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.85rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
              <input 
                type="checkbox" 
                checked={statusFilter === "ALL"} 
                onChange={(e) => setStatusFilter(e.target.checked ? "ALL" : "ACTIVE")} 
                style={{ margin: 0 }}
              />
              Show deactivated
            </label>
          </div>
        </div>

        {/* Role Chips */}
        <div style={{ display: "flex", gap: 6 }}>
          {["ALL", "ADMIN", "CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD"].map((r) => (
            <button
              key={r}
              onClick={() => setRoleFilter(r)}
              className={roleFilter === r ? "button small" : "button secondary small"}
              style={{ padding: "4px 10px", fontSize: "0.75rem", borderRadius: 16 }}
            >
              {r === "ALL" ? "All Roles" : r.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      {/* The Table */}
      <div style={{ overflowX: "auto", border: "1px dashed var(--line)", borderRadius: 8, background: "var(--bg)" }}>
        <table className="nr-table" style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ borderBottom: "1px dashed var(--line)", background: "rgba(0,0,0,0.02)" }}>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>Name</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>Email</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>Org Roles</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>Circles</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>System Role</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>Joined</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>Status</th>
              <th style={{ padding: "12px 16px", fontWeight: 600 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredMembers.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                  {members.length === 0 ? "Unable to load members or workspace is empty." : "No members found matching your filters."}
                </td>
              </tr>
            ) : (
              filteredMembers.map((member) => {
                // Determine unique circles for this member
                const memberCircles = Array.from(new Set(member.roleAssignments.map(ra => ra.role.circle.name)));
                
                return (
                  <tr key={member.id} style={{ borderBottom: "1px dashed var(--line)", opacity: member.isActive ? 1 : 0.6 }}>
                    <td style={{ padding: "12px 16px", fontWeight: 500 }}>
                      <Link href={`/workspaces/${workspaceId}/members/${member.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                        {member.user.displayName || "Unknown"}
                      </Link>
                    </td>
                    <td style={{ padding: "12px 16px", color: "var(--muted)" }}>
                      {member.user.email}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      {member.roleAssignments.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {member.roleAssignments.slice(0, 3).map(ra => (
                            <span key={`${member.id}-${ra.role.name}`} className="tag info" style={{ fontSize: "0.7rem", padding: "2px 6px" }}>
                              {ra.role.name}
                            </span>
                          ))}
                          {member.roleAssignments.length > 3 && (
                            <span className="tag" style={{ fontSize: "0.7rem", padding: "2px 6px" }}>+{member.roleAssignments.length - 3}</span>
                          )}
                        </div>
                      ) : (
                        <span className="muted" style={{ fontSize: "0.75rem" }}>None</span>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px", color: "var(--muted)", fontSize: "0.8rem" }}>
                      {memberCircles.join(", ") || "—"}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <form action={updateMemberAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="memberId" value={member.id} />
                        <select 
                          name="role" 
                          defaultValue={member.role}
                          onChange={(e) => e.target.form?.requestSubmit()}
                          disabled={!member.isActive}
                          style={{ padding: "4px 8px", fontSize: "0.75rem", background: "transparent", border: "none" }}
                        >
                          <option value="CONTRIBUTOR">Contributor</option>
                          <option value="FACILITATOR">Facilitator</option>
                          <option value="FINANCE_STEWARD">Finance Steward</option>
                          <option value="ADMIN">Admin</option>
                        </select>
                      </form>
                    </td>
                    <td style={{ padding: "12px 16px", color: "var(--muted)", fontSize: "0.8rem" }}>
                      {new Date(member.joinedAt).toLocaleDateString()}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      {member.isActive ? (
                        <span style={{ color: "var(--success, #155724)", fontSize: "0.75rem", fontWeight: 600 }}>Active</span>
                      ) : (
                        <span style={{ color: "var(--muted)", fontSize: "0.75rem", fontWeight: 600 }}>Deactivated</span>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      {member.isActive ? (
                        <form action={deactivateMemberAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="memberId" value={member.id} />
                          <button type="submit" className="danger small" style={{ padding: "4px 8px", fontSize: "0.7rem" }}>Deactivate</button>
                        </form>
                      ) : (
                        <form action={updateMemberAction}>
                           <input type="hidden" name="workspaceId" value={workspaceId} />
                           <input type="hidden" name="memberId" value={member.id} />
                           <input type="hidden" name="isActive" value="true" />
                           <button type="submit" className="secondary small" style={{ padding: "4px 8px", fontSize: "0.7rem" }} disabled title="Reactivation requires API / DB update currently">Reactivate</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
