"use client";

import { useState } from "react";
import { UserPlus, UserX } from "lucide-react";
type Role = "SETUP" | "FULL";
type Grant = { id: string; email: string; role: Role; isActive: boolean; version: number };

export function SupportAccessManager({ workspaceId, initialGrants }: { workspaceId: string; initialGrants: Grant[] }) {
  const [grants, setGrants] = useState(initialGrants);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("SETUP");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  async function change(email: string, role: Role, isActive: boolean, expectedVersion: number) {
    setPending(true); setStatus("");
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/support-access`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, isActive, expectedVersion }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? "Access changed or an existing membership needs review. Refresh before trying again." : "Unable to change access. Verify the account and workspace ownership.");
      const refreshed = await fetch(`/api/workspaces/${workspaceId}/support-access`, { cache: "no-store" });
      if (!refreshed.ok) throw new Error("Access updated. Refresh to see the latest grants.");
      const rows = await refreshed.json();
      setGrants(rows.map((grant: Grant & { user: { email: string } }) => ({ ...grant, email: grant.user.email })));
      setStatus("Access updated."); setEmail(""); setRole("SETUP"); setConfirmed(false);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Unable to change access."); }
    finally { setPending(false); }
  }
  return <div className="space-y-6">
    <form className="flex max-w-xl flex-col gap-4" onSubmit={(event) => {
      event.preventDefault();
      const existing = grants.find((grant) => grant.email.toLowerCase() === email.trim().toLowerCase());
      void change(email, role, true, existing?.version ?? 0);
    }}>
      <label className="flex flex-col gap-2 text-sm">Named account email
        <input className="rounded-md border border-[var(--line-subtle)] bg-[var(--surface)] px-3 py-2" type="email" required value={email} disabled={pending} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label className="flex flex-col gap-2 text-sm">Workspace role
        <select className="rounded-md border border-[var(--line-subtle)] bg-[var(--surface)] px-3 py-2" value={role} disabled={pending} onChange={(event) => { setRole(event.target.value as Role); setConfirmed(false); }}>
          <option value="SETUP">Setup Admin - No Content Access</option>
          <option value="FULL">Full Admin</option>
        </select>
      </label>
      {role === "FULL" && <label className="flex items-start gap-3 text-sm" style={{ flexDirection: "row" }}><input style={{ width: 18, height: 18, padding: 0, flexShrink: 0 }} type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I approve this account to access and administer this workspace&apos;s content.</label>}
      <button disabled={pending || (role === "FULL" && !confirmed)} className="inline-flex w-fit items-center gap-2 rounded-md border border-[var(--line-subtle)] px-3 py-2 text-sm disabled:opacity-50"><UserPlus size={16} aria-hidden />Grant access</button>
    </form>
    <p role="status" className="text-sm">{status}</p>
    <ul aria-label="Support grants" className="divide-y divide-[var(--line-subtle)] border-t border-[var(--line-subtle)]">
      {grants.map((grant) => <li className="flex flex-wrap items-center justify-between gap-3 py-4" key={grant.id}>
        <div className="min-w-0"><p className="break-all text-sm font-medium">{grant.email}</p><p className="text-sm text-[var(--text-muted)]">{grant.isActive ? grant.role === "FULL" ? "Full Admin" : "Setup Admin" : "Revoked"}</p></div>
        {grant.isActive && <div className="flex flex-wrap gap-3">
          {grant.role === "FULL" && <button type="button" disabled={pending} className="text-sm underline" onClick={() => void change(grant.email, "SETUP", true, grant.version)}>Change to Setup Admin</button>}
          <button type="button" disabled={pending} className="inline-flex items-center gap-2 text-sm" onClick={() => void change(grant.email, grant.role, false, grant.version)}><UserX size={16} aria-hidden />Revoke</button>
        </div>}
      </li>)}
    </ul>
  </div>;
}
