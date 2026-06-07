"use client";

import { useState } from "react";
import { X } from "lucide-react";
import {
  ControlPlaneSection,
  ControlPlaneStatusStrip,
  StatusBadge,
  controlPlaneButtonClass,
  controlPlaneInputClass,
} from "../../_components/control-plane-ui";

interface Membership {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: string;
}

interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: string;
  membershipsCount: number;
  lastActive: string;
  memberships: Membership[];
}

interface UsersClientProps {
  users: UserSummary[];
}

export function UsersClient({ users }: UsersClientProps) {
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null); // Active profile drawer

  // Search filter
  const filteredUsers = users.filter((u) =>
    u.name.toLowerCase().includes(query.toLowerCase()) ||
    u.email.toLowerCase().includes(query.toLowerCase())
  );

  const totalUsers = users.length;
  const adminCount = users.filter(u => u.role === "ADMIN").length;
  const activeCount = users.filter(u => u.lastActive !== "Never").length;

  return (
    <div className="space-y-5">
      <ControlPlaneStatusStrip
        items={[
          { label: "Users", value: totalUsers, detail: "registered" },
          { label: "Admins", value: adminCount, detail: "global" },
          { label: "Active", value: activeCount, detail: "profiles" },
          { label: "Sign-ins", value: "Not tracked", detail: "unavailable", status: "blocked" },
        ]}
      />

      <ControlPlaneSection
        title="Platform Users Directory"
        description="Search platform permissions and individual client workspace roles."
        actions={
          <div className="max-w-xs w-full">
            <input
              type="text"
              placeholder="Search by name or email..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={`${controlPlaneInputClass} w-full`}
            />
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                <th className="p-3">User</th>
                <th className="p-3">Global Role</th>
                <th className="p-3">Client Memberships</th>
                <th className="p-3">Last Active</th>
                <th className="p-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredUsers.map((u) => (
                <tr key={u.id} className="hover:bg-surface/40">
                  <td className="p-3 min-w-[200px]">
                    <span className="font-semibold text-white block">{u.name}</span>
                    <span className="text-[10px] text-muted block mt-0.5">{u.email}</span>
                  </td>
                  <td className="p-3">
                    <StatusBadge status={u.role === "ADMIN" ? "managed" : "unknown"}>{u.role}</StatusBadge>
                  </td>
                  <td className="p-3 text-text font-semibold">
                    {u.membershipsCount} {u.membershipsCount === 1 ? "workspace" : "workspaces"}
                  </td>
                  <td className="p-3 text-muted">
                    {u.lastActive}
                  </td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => setSelectedUser(u)}
                      className={controlPlaneButtonClass}
                    >
                      Inspect Profile
                    </button>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-muted">
                    No users found matching your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </ControlPlaneSection>

      {/* User profile side-drawer */}
      {selectedUser && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md border-l border-line bg-bg-alt text-text-strong shadow-2xl">
          <div className="flex flex-col w-full h-full relative p-5 space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-line">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 select-none items-center justify-center rounded-md border border-line bg-surface text-xs font-semibold text-white">
                  {selectedUser.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h2 className="text-xs font-bold text-white leading-none">{selectedUser.name}</h2>
                  <p className="text-[9px] text-muted mt-1">{selectedUser.email}</p>
                </div>
              </div>
              <button
                aria-label="Close user profile"
                onClick={() => setSelectedUser(null)}
                className="rounded-md border border-line bg-surface p-1 text-muted hover:bg-surface-strong hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Profile Overview cards */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface border border-line rounded-lg p-3">
                <span className="text-[8px] text-muted font-semibold uppercase">Global Role</span>
                <span className="text-xs font-bold text-white mt-1 block capitalize">{selectedUser.role.toLowerCase()}</span>
              </div>
              <div className="bg-surface border border-line rounded-lg p-3">
                <span className="text-[8px] text-muted font-semibold uppercase">Last Active</span>
                <span className="text-xs font-bold text-white mt-1 block">{selectedUser.lastActive}</span>
              </div>
            </div>

            {/* Client memberships list */}
            <div className="space-y-2 flex-1 overflow-y-auto scrollbar-thin">
              <span className="text-[9px] font-bold text-muted uppercase tracking-wider block">Workspace Memberships</span>
              
              <div className="space-y-2">
                {selectedUser.memberships.map((m) => (
                  <div key={m.workspaceId} className="p-3 bg-surface/60 border border-line rounded-lg flex items-center justify-between">
                    <div>
                      <strong className="text-xs text-white font-semibold block">{m.workspaceName}</strong>
                      <span className="text-[9px] text-muted block mt-0.5">slug: {m.workspaceSlug}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-bg-alt border border-line text-text capitalize">
                        {m.role.toLowerCase()}
                      </span>
                    </div>
                  </div>
                ))}
                {selectedUser.memberships.length === 0 && (
                  <div className="text-center py-6 text-[10px] text-muted bg-surface/30 border border-line/50 rounded-lg">
                    This user has no customer workspace associations.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
