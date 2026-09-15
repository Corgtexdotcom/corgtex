"use client";

import { useEffect, useState } from "react";
import { Copy, RefreshCw, Unplug } from "lucide-react";

type Connection = { id: string; clientName: string; resource: string | null; legacy: boolean;
  status: "connected" | "revoked" | "expired" | "paused"; createdAt: string };
export function McpConnections({ workspaceId, connectorUrl }: { workspaceId: string; connectorUrl: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void fetch(`/api/workspaces/${workspaceId}/mcp-connections`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("Connections are unavailable."); return response.json(); })
      .then(data => { if (!controller.signal.aborted) setConnections(data.grants); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, revision]);
  async function disconnect(id: string) {
    setPending(id); setError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/mcp-connections`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke", connectionId: id }),
      });
      if (!response.ok) throw new Error("Connection could not be disconnected.");
      setRevision(value => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setPending(null); }
  }
  return <section className="space-y-4" aria-label="Workspace MCP connections">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">Your workspace connections</h2>
      <button type="button" className="button secondary" aria-label="Refresh connections" title="Refresh connections" disabled={loading}
        onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} /></button>
    </div>
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 break-all text-sm">{connectorUrl}</code>
      <button type="button" className="button secondary shrink-0" aria-label="Copy workspace MCP URL" title="Copy workspace MCP URL"
        onClick={() => { void navigator.clipboard.writeText(connectorUrl).then(() => setCopied(true)).catch(() => setError("Clipboard unavailable.")); }}><Copy size={16} /></button>
    </div>
    {copied ? <p role="status" className="text-sm">URL copied.</p> : null}
    {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
    {loading ? <p role="status">Loading connections...</p> : <ul className="divide-y divide-[var(--line)]">
      {connections.map(connection => <li key={connection.id} className="flex items-start justify-between gap-3 py-3">
        <div className="min-w-0 space-y-1">
          <p className="break-words font-medium">{connection.clientName}</p>
          <code className="block break-all text-xs text-[var(--text-muted)]">{connection.id}</code>
          <p className="text-sm">{connection.status}{connection.legacy ? " - Legacy endpoint: reconnect with this workspace URL" : ""}</p>
        </div>
        {connection.status === "connected" || connection.status === "paused" ? <button type="button" className="button secondary shrink-0"
          aria-label={`Disconnect ${connection.clientName} ${connection.id}`} title="Disconnect this connection"
          disabled={pending !== null} onClick={() => void disconnect(connection.id)}><Unplug size={16} /></button> : null}
      </li>)}
      {connections.length === 0 ? <li className="py-3 text-sm text-[var(--text-muted)]">No connections yet.</li> : null}
    </ul>}
  </section>;
}
