"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import type { listSupportAccessRequests } from "@corgtex/domain";

type Request = Awaited<ReturnType<typeof listSupportAccessRequests>>[number];
export function SupportAccessRequests({ workspaceId, initial }: { workspaceId: string; initial: Request[] }) {
  const [requests, setRequests] = useState(initial), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  async function decide(requestId: string, approve: boolean) {
    setBusy(true); setMessage("");
    try {
      const url = `/api/workspaces/${workspaceId}/support-access/requests`;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, approve }) });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : "Unable to decide access request.");
      const refreshed = await fetch(url, { cache: "no-store" });
      if (!refreshed.ok) throw new Error("Decision saved. Refresh to see current requests.");
      setRequests(await refreshed.json());
      setMessage(body.invitation === "unavailable" ? "Approved. Invitation delivery unavailable; the recipient can use account recovery." : approve ? "Access approved by owner." : "Request rejected.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to decide access request."); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
    <h2 className="text-lg font-semibold">Support access requests</h2>
    <p className="text-sm">Approval grants independent workspace access or invitation authority. Revoking the requesting Setup grant does not revoke an owner-approved membership.</p>
    <p role="status" className="text-sm">{message}</p>
    <ul className="divide-y divide-[var(--line-subtle)]">{requests.map(request => <li key={request.id} aria-label={`access request ${request.id}`} className="space-y-3 py-4">
      <p className="break-all text-sm font-medium">{request.command.kind === "addMember" ? `Add ${request.command.email} as ${request.command.role}` : request.command.kind === "member" ? `${request.targetEmail ?? request.command.memberId}: ${request.command.role}, ${request.command.isActive ? "active" : "inactive"}` : request.command.kind === "invitePolicy" ? `Invitation policy: ${request.command.policy.replaceAll("_", " ")}` : "Unavailable request"}</p>
      <p className="break-words text-sm" style={{ overflowWrap: "anywhere" }}>Requested by {request.requesterEmail}</p>
      <p className="text-sm">{request.status}</p>
      {request.status === "PENDING" && <div className="flex flex-wrap gap-4">
        <button disabled={busy} onClick={() => void decide(request.id, true)} className="inline-flex items-center gap-2 text-sm"><Check size={16} />Approve access</button>
        <button disabled={busy} onClick={() => void decide(request.id, false)} className="inline-flex items-center gap-2 text-sm"><X size={16} />Reject</button>
      </div>}
    </li>)}</ul>
  </section>;
}
