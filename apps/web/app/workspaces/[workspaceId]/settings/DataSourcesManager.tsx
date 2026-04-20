"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type DataSource = {
  id: string;
  label: string;
  driverType: string;
  isActive: boolean;
  selectedTables: string[];
  cursorColumn: string;
  pullCadenceMinutes: number;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
};

export function DataSourcesManager({ workspaceId, dataSources }: { workspaceId: string; dataSources: DataSource[] }) {
  const router = useRouter();
  const [isAdding, setIsAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [connectionString, setConnectionString] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [testingError, setTestingError] = useState("");
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [cursorColumn, setCursorColumn] = useState("updated_at");
  const [pullCadenceMinutes, setPullCadenceMinutes] = useState(60);

  async function handleTestConnection(e: React.FormEvent) {
    e.preventDefault();
    setIsTesting(true);
    setTestingError("");
    setAvailableTables([]);

    const res = await fetch(`/api/workspaces/${workspaceId}/data-sources/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driverType: "postgres",
        connectionString,
      }),
    });

    const data = await res.json();
    if (res.ok) {
      setAvailableTables(data.tables ?? []);
      setSelectedTables(data.tables?.slice(0, 1) ?? []);
    } else {
      setTestingError(data.error?.message || "Failed to test connection");
    }

    setIsTesting(false);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch(`/api/workspaces/${workspaceId}/data-sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label,
        driverType: "postgres",
        connectionString,
        selectedTables,
        cursorColumn,
        pullCadenceMinutes,
      })
    });
    
    if (res.ok) {
      setIsAdding(false);
      router.refresh();
      setLabel("");
      setConnectionString("");
      setAvailableTables([]);
      setSelectedTables([]);
      setCursorColumn("updated_at");
    } else {
      const data = await res.json();
      setTestingError(data.error?.message || "Failed to save");
    }
  }

  function toggleTable(table: string) {
    setSelectedTables((current) => (
      current.includes(table)
        ? current.filter((value) => value !== table)
        : [...current, table]
    ));
  }

  async function handleSync(sourceId: string) {
    await fetch(`/api/workspaces/${workspaceId}/data-sources/${sourceId}/sync`, { method: "POST" });
    alert("Sync triggered!");
  }

  async function handleDelete(sourceId: string) {
    if (confirm("Delete this data source and all its knowledge chunks?")) {
      await fetch(`/api/workspaces/${workspaceId}/data-sources/${sourceId}`, { method: "DELETE" });
      router.refresh();
    }
  }

  return (
    <section className="stack" style={{ gap: 40 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2 className="nr-section-header">External Data Sources</h2>
            <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
              Connect read-only databases to sync data into the Knowledge Brain.
            </p>
          </div>
          <button className="small" onClick={() => setIsAdding(!isAdding)}>
            {isAdding ? "Cancel" : "+ Add Database"}
          </button>
        </div>

        {isAdding && (
          <form className="nr-form-section stack" style={{ marginBottom: 32, padding: 24, border: "1px solid var(--line)" }} onSubmit={handleSave}>
            <h3>Add PostgreSQL Database</h3>
            {testingError && <div style={{ color: "#842029", padding: "8px", background: "#f8d7da" }}>{testingError}</div>}
            
            <label>
              Label
              <input required value={label} onChange={e => setLabel(e.target.value)} placeholder="Production DB" />
            </label>
            <label>
              Connection String
              <input required type="password" value={connectionString} onChange={e => setConnectionString(e.target.value)} placeholder="postgres://user:pass@host:5432/db" />
            </label>
            <label>
              Pull Cadence (minutes)
              <input required type="number" min="5" value={pullCadenceMinutes} onChange={e => setPullCadenceMinutes(parseInt(e.target.value))} />
            </label>
            <label>
              Cursor Column
              <input required value={cursorColumn} onChange={e => setCursorColumn(e.target.value)} placeholder="updated_at" />
            </label>

            <div className="actions-inline">
              <button type="button" className="secondary small" disabled={isTesting || !connectionString} onClick={handleTestConnection}>
                {isTesting ? "Testing..." : "Test Connection"}
              </button>
              <button type="submit" className="small" disabled={isTesting || selectedTables.length === 0}>Save Database</button>
            </div>

            {availableTables.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <strong>Select tables to sync</strong>
                {availableTables.map((table) => (
                  <label key={table} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={selectedTables.includes(table)}
                      onChange={() => toggleTable(table)}
                    />
                    {table}
                  </label>
                ))}
              </div>
            )}
          </form>
        )}

        <div>
          {dataSources.length === 0 && !isAdding && (
            <p className="nr-item-meta">No external data sources configured.</p>
          )}
          
          {dataSources.map(source => (
            <div className="nr-item" key={source.id} style={{ padding: "16px", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <strong className="nr-item-title" style={{ fontSize: "1.1rem" }}>{source.label}</strong>
                  <span className="tag" style={{ marginLeft: 8 }}>{source.driverType}</span>
                </div>
                <div className="actions-inline">
                  <button onClick={() => handleSync(source.id)} className="secondary small">Sync Now</button>
                  <button onClick={() => handleDelete(source.id)} className="danger small">Delete</button>
                </div>
              </div>
              <div className="nr-item-meta" style={{ fontSize: "0.85rem", marginTop: 8 }}>
                Cadence: {source.pullCadenceMinutes}m | Status: {source.isActive ? "Active" : "Inactive"}
              </div>
              <div className="nr-item-meta" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                Tables: {source.selectedTables.join(", ") || "None"} | Cursor: {source.cursorColumn}
              </div>
              <div className="nr-item-meta" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                Last Sync: {source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : "Never"}
              </div>
              {source.lastSyncError && (
                <div style={{ color: "#842029", fontSize: "0.85rem", marginTop: 4 }}>
                  Error: {source.lastSyncError}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
