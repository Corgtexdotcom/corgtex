"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Save, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import type { getSupportConfiguration, SupportConfigurationCommand } from "@corgtex/domain";

type Configuration = Awaited<ReturnType<typeof getSupportConfiguration>>;
const field = "w-full min-w-0 rounded border border-[var(--line-subtle)] bg-transparent px-3 py-2 text-sm";
const roles = ["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"] as const;

function Editor({ title, children, onSave, disabled = false, add = false }: { title: string; children: ReactNode; onSave: (data: FormData) => Promise<string>; disabled?: boolean; add?: boolean }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setMessage("");
    try { setMessage(await onSave(data)); } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save."); } finally { setBusy(false); }
  }
  return <form aria-label={title} onSubmit={submit} className="space-y-3">
    <fieldset disabled={disabled || busy} className="min-w-0 space-y-3">
      {children}
      <button type="submit" title={add ? "Add member" : "Save changes"} aria-label={add ? "Add member" : `Save ${title}`} className="inline-flex items-center gap-2 rounded border border-[var(--line-subtle)] px-3 py-2 text-sm disabled:opacity-50">
        {add ? <UserPlus size={16} /> : <Save size={16} />} {busy ? "Saving..." : add ? "Add member" : "Save"}
      </button>
    </fieldset>
    <p role="status" className="break-words text-sm">{message}</p>
  </form>;
}
function Label({ children, text }: { children: ReactNode; text: string }) { return <label className="block min-w-0 space-y-1 text-sm"><span>{text}</span>{children}</label>; }
function Toggle({ name, text, checked, disabled }: { name: string; text: string; checked: boolean; disabled?: boolean }) { return <label className="flex items-center gap-2 text-sm" style={{ flexDirection: "row" }}><input style={{ width: 18, height: 18, padding: 0, flexShrink: 0 }} type="checkbox" name={name} defaultChecked={checked} disabled={disabled} />{text}</label>; }
const value = (data: FormData, key: string) => String(data.get(key) ?? "");

export function ConfigurationManager({ initial }: { initial: Configuration }) {
  const [config, setConfig] = useState(initial);
  const router = useRouter();
  async function save(command: SupportConfigurationCommand) {
    const url = `/api/workspaces/${encodeURIComponent(config.workspace.id)}/support-configuration`;
    const response = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: config.version, command }) });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : "Unable to save configuration.");
    const refreshed = await fetch(url, { cache: "no-store" });
    if (!refreshed.ok) throw new Error("Saved. Refresh to verify current configuration.");
    setConfig(await refreshed.json());
    if (command.kind === "workspace") router.refresh();
    if (body.invitation === "unavailable") throw new Error("Membership saved. Invitation delivery is unavailable; the recipient can use account recovery.");
    return body.approvalRequired ? "Requested owner approval. Access is unchanged." : "Saved";
  }
  return <div className="space-y-8">
    <section className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
      <h2 className="text-lg font-semibold">Workspace configuration</h2>
      <Editor title="workspace" onSave={data => save({ kind: "workspace", name: value(data, "name"), ...(data.has("replaceDescription") ? { description: value(data, "description") } : {}) })}>
        <Label text="Workspace name"><input className={field} name="name" required maxLength={160} defaultValue={config.workspace.name} /></Label>
        <Toggle name="replaceDescription" text="Replace workspace description" checked={false} />
        <Label text="New description (existing text withheld)"><textarea className={field} name="description" maxLength={4000} rows={2} /></Label>
      </Editor>
      <Editor title="invitation policy" onSave={data => save({ kind: "invitePolicy", policy: value(data, "policy") as "ADMINS_ONLY" | "MEMBERS_CAN_INVITE" | "MEMBERS_CAN_REQUEST" })}>
        <Label text="Invitations"><select className={field} name="policy" defaultValue={config.invitePolicy}><option value="ADMINS_ONLY">Admins only</option><option value="MEMBERS_CAN_INVITE">Members can invite</option><option value="MEMBERS_CAN_REQUEST">Members can request</option></select></Label>
      </Editor>
    </section>
    <section className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
      <h2 className="text-lg font-semibold">Members and administrators</h2>
      <ul className="space-y-2 text-sm" aria-label="Access requests">{config.accessRequests.map(request => <li key={request.id}>Access request {request.id.slice(0, 8)}: {request.status === "PENDING" && request.grantVersion !== config.version ? "EXPIRED" : request.status}</li>)}</ul>
      <ul className="divide-y divide-[var(--line-subtle)]">{config.members.map(member => <li key={`${member.id}-${member.role}-${member.isActive}`} className="space-y-3 py-4">
        <p className="break-all text-sm font-medium">{member.email}</p>
        {member.protected ? <p className="text-sm text-[var(--text-muted)]">Owner/support policy protected</p> : null}
        <Editor title={`member ${member.email}`} disabled={member.protected} onSave={data => save({ kind: "member", memberId: member.id, role: value(data, "role") as typeof roles[number], isActive: data.has("isActive") })}>
          <Label text="Role"><select className={field} name="role" defaultValue={member.role}>{roles.map(role => <option key={role} value={role}>{role.replaceAll("_", " ")}</option>)}</select></Label>
          <Toggle name="isActive" text="Active membership" checked={member.isActive} />
        </Editor>
      </li>)}</ul>
      <Editor title="add member" add onSave={data => save({ kind: "addMember", email: value(data, "email"), role: value(data, "role") as typeof roles[number] })}>
        <Label text="Member email"><input className={field} type="email" name="email" required /></Label>
        <Label text="Role"><select className={field} name="role" defaultValue="CONTRIBUTOR">{roles.map(role => <option key={role} value={role}>{role.replaceAll("_", " ")}</option>)}</select></Label>
      </Editor>
    </section>
    <section className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
      <h2 className="text-lg font-semibold">AI budget</h2>
      <Editor title="budget" onSave={data => save({ kind: "budget", monthlyCostCapUsd: Number(value(data, "monthlyCostCapUsd")), alertThresholdPct: Number(value(data, "alertThresholdPct")), periodStartDay: Number(value(data, "periodStartDay")) })}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Label text="Monthly limit USD (-1 unlimited)"><input className={field} type="number" name="monthlyCostCapUsd" min={-1} max={1000000} step="0.01" required defaultValue={config.budget.monthlyCostCapUsd} /></Label>
          <Label text="Alert threshold %"><input className={field} type="number" name="alertThresholdPct" min={1} max={100} required defaultValue={config.budget.alertThresholdPct} /></Label>
          <Label text="Period start day"><input className={field} type="number" name="periodStartDay" min={1} max={31} required defaultValue={config.budget.periodStartDay} /></Label>
        </div>
      </Editor>
    </section>
    <section className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
      <h2 className="text-lg font-semibold">Integration configuration</h2>
      {config.connections.length === 0 && <p className="text-sm">No OAuth connection. Provider consent remains with the connection owner.</p>}
      {config.connections.map((connection, index) => <div key={`${connection.id}-${connection.status}-${connection.calendar}-${connection.documents}-${connection.email}`} className="space-y-3 border-b border-[var(--line-subtle)] py-4">
        <h3 className="text-sm font-semibold">{connection.provider} {index + 1} · {connection.status}</h3>
        <Editor title={`connection ${index + 1}`} disabled={!["ACTIVE", "PAUSED"].includes(connection.status)} onSave={data => save({ kind: "oauth", connectionId: connection.id, status: value(data, "status") as "ACTIVE" | "PAUSED", calendar: data.has("calendar"), documents: data.has("documents"), email: data.has("email") })}>
          <Label text="Connection status"><select className={field} name="status" defaultValue={connection.status}><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option></select></Label>
          <Toggle name="calendar" text="Calendar sync" checked={connection.calendar} disabled={!connection.calendar && !connection.canEnableCalendar} />
          <Toggle name="documents" text="Owner-selected documents sync" checked={connection.documents} disabled={!connection.documents && !connection.canEnableDocuments} />
          <Toggle name="email" text="Owner-filtered email sync" checked={connection.email} disabled={!connection.email && !connection.canEnableEmail} />
        </Editor>
      </div>)}
      {config.installations.map((installation, index) => <div key={installation.id} className="space-y-3 py-4">
        <h3 className="text-sm font-semibold">{installation.provider} {index + 1} · {installation.status}</h3>
        <Editor title={`communication ${index + 1}`} onSave={data => save({ kind: "communication", installationId: installation.id, rawRetentionDays: Number(value(data, "rawRetentionDays")) })}>
          <Label text="Raw message retention days"><input className={field} name="rawRetentionDays" type="number" min={1} max={365} required defaultValue={installation.rawRetentionDays} /></Label>
        </Editor>
      </div>)}
    </section>
    {config.recorder && <section className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
      <h2 className="text-lg font-semibold">Recording configuration</h2>
      <p className="text-sm">Recording {config.recorder.enabled ? "enabled" : "disabled"}; automatic recording {config.recorder.autoRecordEnabled ? "enabled" : "disabled"}. Consent unchanged.</p>
      <Editor title="recorder" onSave={data => save({ kind: "recorder", defaultProvider: value(data, "defaultProvider") as "RECALL_AI" | "MEETING_BAAS", fallbackProvider: (value(data, "fallbackProvider") || null) as "RECALL_AI" | "MEETING_BAAS" | null, monthlyMinuteCap: Number(value(data, "monthlyMinuteCap")), ...(value(data, "botName") ? { botName: value(data, "botName") } : {}), ...(data.has("replaceEntry") ? { entryMessage: value(data, "entryMessage") } : {}) })}>
        <Label text="Default provider"><select className={field} name="defaultProvider" defaultValue={config.recorder.defaultProvider}><option value="RECALL_AI">Recall AI</option><option value="MEETING_BAAS">Meeting BaaS</option></select></Label>
        <Label text="Fallback provider"><select className={field} name="fallbackProvider" defaultValue={config.recorder.fallbackProvider ?? ""}><option value="">None</option><option value="RECALL_AI">Recall AI</option><option value="MEETING_BAAS">Meeting BaaS</option></select></Label>
        <Label text="Monthly minute limit"><input className={field} name="monthlyMinuteCap" type="number" min={0} max={1000000} required defaultValue={config.recorder.monthlyMinuteCap} /></Label>
        <Label text="New bot name (optional)"><input className={field} name="botName" maxLength={100} /></Label>
        <Toggle name="replaceEntry" text="Replace entry message" checked={false} />
        <Label text="New entry message (existing text withheld)"><textarea className={field} name="entryMessage" maxLength={1000} /></Label>
      </Editor>
    </section>}
    <section className="space-y-2 border-t border-[var(--line-subtle)] pt-6 text-sm text-[var(--text-muted)]">
      <h2 className="font-semibold">Owner-controlled boundaries</h2>
      <p>Support access and opt-out, account credentials and SSO trust, provider consent, source selection, recording activation and outbound destinations remain owner-controlled. Messages, documents, profiles, usage records and secrets are withheld.</p>
      <p>New members receive an account setup email. Existing account credentials are unchanged.</p>
    </section>
  </div>;
}
