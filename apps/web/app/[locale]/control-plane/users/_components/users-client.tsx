"use client";

import { useState } from "react";
import {
  Users as UsersIcon,
  Search,
  ShieldCheck,
  UserCheck,
  Clock,
  ChevronRight,
  X,
  ExternalLink,
  Mail,
  User,
  Briefcase,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
    <div className="space-y-6">
      
      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "Platform Users", value: totalUsers, detail: "registered directory entries", icon: UsersIcon, tone: "text-slate-400" },
          { title: "Platform Admins", value: adminCount, detail: "unrestricted access control", icon: ShieldCheck, tone: "text-indigo-400" },
          { title: "Active Directory", value: activeCount, detail: "active user profiles", icon: UserCheck, tone: "text-emerald-400" },
          { title: "Monthly Sign-ins", value: totalUsers * 4, tone: "text-brand-400", detail: "estimated dashboard sessions", icon: Clock },
        ].map((metric, i) => {
          const Icon = metric.icon;
          return (
            <div key={i} className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-4 flex justify-between items-start shadow-sm">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 font-semibold uppercase">{metric.title}</span>
                <span className="text-xl font-bold text-white block">{metric.value}</span>
                <span className="text-[10px] text-slate-400 block">{metric.detail}</span>
              </div>
              <div className={cn("p-2 rounded-lg bg-[#141822] border border-[#202738]", metric.tone)}>
                <Icon className="w-4 h-4" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Main Users Table */}
      <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#1f2430]">
          <div>
            <h2 className="text-sm font-bold text-white">Platform Users Directory</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">Search and examine platform permissions and individual client workspace roles.</p>
          </div>

          <div className="relative max-w-xs w-full">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
            <input
              type="text"
              placeholder="Search by name or email..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="bg-[#141822] border border-[#202738] text-xs text-slate-300 placeholder-slate-600 rounded-lg pl-9 pr-4 py-2 w-full focus:border-[#2f3952] focus:outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#1f2430] text-slate-400 text-left font-medium">
                <th className="p-3">User</th>
                <th className="p-3">Global Role</th>
                <th className="p-3">Client Memberships</th>
                <th className="p-3">Last Active</th>
                <th className="p-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1f2430]/60">
              {filteredUsers.map((u) => (
                <tr key={u.id} className="hover:bg-[#141822]/40 transition-colors group">
                  <td className="p-3 min-w-[200px]">
                    <span className="font-semibold text-white block">{u.name}</span>
                    <span className="text-[10px] text-slate-500 block mt-0.5">{u.email}</span>
                  </td>
                  <td className="p-3">
                    <span className={cn(
                      "px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border",
                      u.role === "ADMIN" 
                        ? "text-indigo-400 border-indigo-500/25 bg-indigo-500/10" 
                        : "text-slate-400 border-slate-500/20 bg-slate-500/5"
                    )}>
                      {u.role}
                    </span>
                  </td>
                  <td className="p-3 text-slate-300 font-semibold">
                    {u.membershipsCount} {u.membershipsCount === 1 ? "workspace" : "workspaces"}
                  </td>
                  <td className="p-3 text-slate-400">
                    {u.lastActive}
                  </td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => setSelectedUser(u)}
                      className="inline-flex items-center gap-1 bg-[#141822] hover:bg-[#1d2333] border border-[#202738] text-slate-300 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-colors"
                    >
                      Inspect Profile
                      <ChevronRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-brand-400 transition-colors" />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-slate-500">
                    No users found matching your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* User profile side-drawer */}
      {selectedUser && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md bg-[#0b0d13]/95 backdrop-blur-md border-l border-[#1f2430] shadow-2xl text-slate-100 transform transition-transform animate-in slide-in-from-right duration-300">
          <div className="flex flex-col w-full h-full relative p-5 space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-[#1f2430]">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-brand-600 border border-brand-500 text-white font-bold text-xs select-none">
                  {selectedUser.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h2 className="text-xs font-bold text-white leading-none">{selectedUser.name}</h2>
                  <p className="text-[9px] text-slate-500 mt-1">{selectedUser.email}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedUser(null)}
                className="p-1 rounded hover:bg-[#1a1f2c] border border-transparent hover:border-[#2d3548] text-slate-400 hover:text-white transition-all duration-150"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Profile Overview cards */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-[#141822] border border-[#202738] rounded-xl p-3">
                <span className="text-[8px] text-slate-500 font-semibold uppercase flex items-center gap-1"><ShieldCheck className="w-2.5 h-2.5" /> Global Role</span>
                <span className="text-xs font-bold text-white mt-1 block capitalize">{selectedUser.role.toLowerCase()}</span>
              </div>
              <div className="bg-[#141822] border border-[#202738] rounded-xl p-3">
                <span className="text-[8px] text-slate-500 font-semibold uppercase flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Last Active</span>
                <span className="text-xs font-bold text-white mt-1 block">{selectedUser.lastActive}</span>
              </div>
            </div>

            {/* Client memberships list */}
            <div className="space-y-2 flex-1 overflow-y-auto scrollbar-thin">
              <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block">Workspace Memberships</span>
              
              <div className="space-y-2">
                {selectedUser.memberships.map((m) => (
                  <div key={m.workspaceId} className="p-3 bg-[#141822]/60 border border-[#202738] rounded-xl flex items-center justify-between">
                    <div>
                      <strong className="text-xs text-white font-semibold block">{m.workspaceName}</strong>
                      <span className="text-[9px] text-slate-500 block mt-0.5">slug: {m.workspaceSlug}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-[#0b0d12] border border-[#1f2430] text-slate-300 capitalize">
                        {m.role.toLowerCase()}
                      </span>
                    </div>
                  </div>
                ))}
                {selectedUser.memberships.length === 0 && (
                  <div className="text-center py-6 text-[10px] text-slate-500 bg-[#141822]/30 border border-[#202738]/50 rounded-lg">
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
