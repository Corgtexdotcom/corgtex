"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import type { SupportConnectorPreparation } from "@corgtex/domain";

const labels = { configurationPrepared: "Configuration prepared", consentRequested: "Client consent requested", handoffReady: "Handoff ready" };
export function SetupChecklist({ workspaceId, initialVersion, initialChecklist, initialConnectors, initialSetupRevision }: {
  workspaceId: string; initialVersion: number; initialChecklist: Record<string, boolean>;
  initialConnectors: SupportConnectorPreparation[]; initialSetupRevision: number;
}) {
  const [checklist, setChecklist] = useState(initialChecklist);
  const [version, setVersion] = useState(initialVersion);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [connectors, setConnectors] = useState(initialConnectors);
  const [setupRevision, setSetupRevision] = useState(initialSetupRevision);
  function setProvider(provider: "google" | "microsoft" | "slack", enabled: boolean) {
    setConnectors((current) => enabled ? [...current.filter((item) => item.provider !== provider),
      provider === "slack" ? { provider, intent: "selected_channels", calendarImport: false } : { provider, intent: "calendar", calendarImport: false }]
      : current.filter((item) => item.provider !== provider));
  }
  async function save() {
    setPending(true);
    setStatus("");
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/support-setup`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: version, checklist, connectors, expectedSetupRevision: setupRevision }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? "Access changed. Refresh this page." : "Unable to save setup handoff.");
      const body = await response.json();
      setVersion(body.version);
      setSetupRevision(body.setupRevision);
      setStatus("Saved.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Unable to save."); }
    finally { setPending(false); }
  }
  return <div className="space-y-4">
    <fieldset disabled={pending} className="space-y-4">
      <legend className="mb-3 text-lg font-semibold">Connector Preparation</legend>
      <p className="text-sm text-[var(--text-muted)]">Draft only. Owner review and provider consent required.</p>
      {(["google", "microsoft", "slack"] as const).map((provider) => {
        const prepared = connectors.find((item) => item.provider === provider);
        return <div key={provider} className="space-y-3 border-b border-[var(--line-subtle)] py-3">
          <label style={{ flexDirection: "row" }} className="flex items-center gap-3 text-sm">
            <input style={{ width: 18, height: 18, padding: 0, flexShrink: 0 }} type="checkbox" checked={Boolean(prepared)} onChange={(event) => setProvider(provider, event.target.checked)} />
            {{ google: "Google", microsoft: "Microsoft", slack: "Slack" }[provider]}
          </label>
          {prepared?.provider === "google" && <label className="text-sm">Purpose
            <select aria-label="Purpose" value={prepared.intent} onChange={(event) => setConnectors((current) => current.map((item) => item.provider === "google" ? { ...item, intent: event.target.value as "calendar" | "documents", calendarImport: false } : item))}>
              <option value="calendar">Calendar</option><option value="documents">Selected Drive documents</option>
            </select>
          </label>}
          {prepared?.intent === "calendar" && <label className="text-sm">Import after owner consent
            <select aria-label={`${provider} calendar import after owner consent`} value={String(prepared.calendarImport)} onChange={(event) => setConnectors((current) => current.map((item) => item.provider === provider && item.intent === "calendar" ? { ...item, calendarImport: event.target.value === "true" } : item))}>
              <option value="false">Off</option><option value="true">Calendar events with meeting links</option>
            </select>
          </label>}
          {prepared?.intent === "selected_channels" && <p className="text-sm text-[var(--text-muted)]">Selected channels only. Broad archive import off.</p>}
          {prepared?.intent === "documents" && <p className="text-sm text-[var(--text-muted)]">Document selection remains with the owner.</p>}
        </div>;
      })}
    </fieldset>
    <h3 className="pt-4 font-semibold">Handoff</h3>
    {Object.entries(labels).map(([key, label]) => <label key={key} className="flex items-center gap-3 text-sm" style={{ flexDirection: "row" }}>
      <input style={{ width: 18, height: 18, padding: 0, flexShrink: 0 }} type="checkbox" checked={checklist[key] ?? false} disabled={pending} onChange={(event) => setChecklist({ ...checklist, [key]: event.target.checked })} />
      {label}
    </label>)}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={save} disabled={pending} className="inline-flex items-center gap-2 rounded-md border border-[var(--line-subtle)] px-3 py-2 text-sm disabled:opacity-50"><Save size={16} aria-hidden />Save</button>
      <span role="status" className="text-sm">{status}</span>
    </div>
  </div>;
}
