"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, RefreshCw, Unplug } from "lucide-react";

type State = {
  label: string; resource: string;
  connections: { id: string; clientName: string; createdAt: string; refreshExpiresAt: string | null; requiresReauthorization: boolean }[];
};

export function WorkspaceMcpConnections({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/oauth-connections`;
  const reload = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load connections.");
      setData(await response.json());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [endpoint]);
  useEffect(() => { void reload(); }, [reload]);
  async function revoke(connectionId: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId }) });
      if (!response.ok) throw new Error("Unable to revoke connection.");
      await reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); }
    catch { setError("Clipboard unavailable. The connection details remain selectable."); }
  }
  return <section className="stack" aria-label="Workspace MCP connections" style={{ gap: 12, minWidth: 0 }}>
    <div className="row" style={{ justifyContent: "space-between" }}>
      <h3>Your MCP connections</h3>
      <button className="button secondary" type="button" title="Refresh connections" aria-label="Refresh connections" disabled={busy} onClick={() => void reload()}><RefreshCw size={16} /></button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!data && <p role="status">{busy ? "Loading connections..." : "Connections unavailable."}</p>}
    {data && <>
      <div style={{ overflowWrap: "anywhere" }}><strong>{data.label}</strong>{" "}
        <button className="button secondary small" title="Copy connection name" aria-label="Copy connection name" onClick={() => void copy(data.label)}><Copy size={16} /></button>
      </div>
      <div style={{ overflowWrap: "anywhere" }}><code>{data.resource}</code>{" "}
        <button className="button secondary small" title="Copy workspace MCP URL" aria-label="Copy workspace MCP URL" onClick={() => void copy(data.resource)}><Copy size={16} /></button>
      </div>
      <p className="nr-item-meta">Each connection is bound to this workspace. Multiple connectors in one AI conversation can combine their results; separate conversations keep their context separate.</p>
      {data.connections.length === 0 && <p>No connections yet.</p>}
      <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
        {data.connections.map((connection) => <li key={connection.id} className="row" style={{ flexWrap: "wrap", justifyContent: "space-between", borderTop: "1px solid var(--line)", paddingBlock: 12, gap: 12 }}>
          <div style={{ minWidth: 0, overflowWrap: "anywhere", flex: 1 }}>
            <strong>{connection.clientName}</strong><div className="nr-item-meta">{connection.id}</div>
            <div className="nr-item-meta">{connection.requiresReauthorization ? "Legacy connection: reconnect with this workspace URL" : connection.refreshExpiresAt && new Date(connection.refreshExpiresAt) <= new Date() ? "Expired: reconnect" : "Workspace-bound"}</div>
          </div>
          <button className="button secondary" type="button" disabled={busy} onClick={() => void revoke(connection.id)}><Unplug size={16} /> Revoke</button>
        </li>)}
      </ul>
    </>}
  </section>;
}
