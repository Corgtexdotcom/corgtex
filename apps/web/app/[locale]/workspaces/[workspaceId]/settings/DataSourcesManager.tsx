"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileUploader } from "./FileUploader";
import { TextPasteUploader } from "./TextPasteUploader";
import { RecentUploads } from "./RecentUploads";
import { useTranslations } from "next-intl";

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

export function DataSourcesManager({ workspaceId, dataSources, documents }: { workspaceId: string; dataSources: DataSource[]; documents: any[] }) {
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
  const t = useTranslations("settings");

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

  async function handleArchive(sourceId: string) {
    if (confirm("Archive this data source? It will be hidden from active views but can be restored from Audit.")) {
      await fetch(`/api/workspaces/${workspaceId}/data-sources/${sourceId}`, { method: "DELETE" });
      router.refresh();
    }
  }

  return (
    <section className="stack" style={{ gap: 40 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
          <div>
            <h2 className="nr-section-header" style={{ marginBottom: 8, borderBottom: 'none' }}>{t("sectionKnowledgeSources")}</h2>
            <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 0 }}>
              {t("descKnowledgeSources")}
            </p>
          </div>
        </div>
        
        <FileUploader workspaceId={workspaceId} />
        <TextPasteUploader workspaceId={workspaceId} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 40, marginBottom: 16 }}>
          <h2 className="nr-section-header" style={{ margin: 0, border: 'none' }}>{t("sectionExternalDatabases")}</h2>
          <button className="small" onClick={() => setIsAdding(!isAdding)}>
            {isAdding ? t("btnCancel") : t("btnAddDatabase")}
          </button>
        </div>

        {isAdding && (
          <form className="nr-form-section stack" style={{ marginBottom: 32, padding: 24, border: "1px solid var(--line)" }} onSubmit={handleSave}>
            <h3>{t("titleAddPostgres")}</h3>
            {testingError && <div style={{ color: "var(--danger)", padding: "8px", background: "var(--danger-soft)" }}>{testingError}</div>}
            
            <label>
              {t("labelLabel")}
              <input required value={label} onChange={e => setLabel(e.target.value)} placeholder={t("placeholderLabel")} />
            </label>
            <label>
              {t("labelConnectionString")}
              <input required type="password" value={connectionString} onChange={e => setConnectionString(e.target.value)} placeholder={t("placeholderConnectionString")} />
            </label>
            <label>
              {t("labelPullCadence")}
              <input required type="number" min="5" value={pullCadenceMinutes} onChange={e => setPullCadenceMinutes(parseInt(e.target.value))} />
            </label>
            <label>
              {t("labelCursorColumn")}
              <input required value={cursorColumn} onChange={e => setCursorColumn(e.target.value)} placeholder={t("placeholderCursorColumn")} />
            </label>

            <div className="actions-inline">
              <button type="button" className="secondary small" disabled={isTesting || !connectionString} onClick={handleTestConnection}>
                {isTesting ? t("btnTesting") : t("btnTestConnection")}
              </button>
              <button type="submit" className="small" disabled={isTesting || selectedTables.length === 0}>{t("btnSaveDatabase")}</button>
            </div>

            {availableTables.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <strong>{t("labelSelectTables")}</strong>
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
            <p className="nr-item-meta">{t("noExternalSources")}</p>
          )}
          
          {dataSources.map(source => (
            <div className="nr-item" key={source.id} style={{ padding: "16px", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <strong className="nr-item-title" style={{ fontSize: "1.1rem" }}>{source.label}</strong>
                  <span className="tag" style={{ marginLeft: 8 }}>{source.driverType}</span>
                </div>
                <div className="actions-inline">
                  <button onClick={() => handleSync(source.id)} className="secondary small">{t("btnSyncNow")}</button>
                  <button onClick={() => handleArchive(source.id)} className="danger small">{t("btnDelete")}</button>
                </div>
              </div>
              <div className="nr-item-meta" style={{ fontSize: "0.85rem", marginTop: 8 }}>
                {t("metaCadence", { minutes: source.pullCadenceMinutes, status: source.isActive ? t("statusActive") : t("statusInactive") })}
              </div>
              <div className="nr-item-meta" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                {t("metaTables", { tables: source.selectedTables.join(", ") || t("valNone"), cursor: source.cursorColumn })}
              </div>
              <div className="nr-item-meta" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                {t("metaLastSync", { date: source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : t("valNever") })}
              </div>
              {source.lastSyncError && (
                <div style={{ color: "var(--danger)", fontSize: "0.85rem", marginTop: 4 }}>
                  {t("metaError", { error: source.lastSyncError })}
                </div>
              )}
            </div>
          ))}
        </div>
        
        <RecentUploads documents={documents} />
      </div>
    </section>
  );
}
