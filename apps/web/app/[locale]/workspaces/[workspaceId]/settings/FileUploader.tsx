"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

const MAX_SIZE = 25 * 1024 * 1024; // 25MB

export function FileUploader({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{name: string; status: 'uploading' | 'done' | 'error', error?: string}[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const t = useTranslations("settings");

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    setIsUploading(true);
    const newStatuses = Array.from(files).map(f => ({ name: f.name, status: 'uploading' as const }));
    setUploadStatus(prev => [...newStatuses, ...prev].slice(0, 50));
    
    for (const file of Array.from(files)) {
      if (file.size > MAX_SIZE) {
        updateStatus(file.name, 'error', "File too large (>25MB)");
        continue;
      }
      
      const formData = new FormData();
      formData.append("file", file);
      formData.append("source", "settings-upload");
      
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/documents`, {
          method: "POST",
          body: formData,
        });
        
        if (res.ok) {
          updateStatus(file.name, 'done');
        } else {
          const data = await res.json().catch(() => ({}));
          updateStatus(file.name, 'error', data.error?.message || "Failed to upload");
        }
      } catch (err) {
        updateStatus(file.name, 'error', "Network error");
      }
    }
    
    setIsUploading(false);
    router.refresh();
  };
  
  const updateStatus = (name: string, status: 'done' | 'error', error?: string) => {
    setUploadStatus(prev => prev.map(s => s.name === name ? { ...s, status, error } : s));
  };
  
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div className="nr-form-section stack" style={{ marginBottom: 32, padding: 24, border: "2px dashed var(--line)", borderRadius: 8, background: isDragging ? "var(--accent-soft)" : "transparent" }}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
    >
      <h3>{t("titleUploadFiles")}</h3>
      <p className="nr-item-meta">{t("descUploadFiles")}</p>
      
      <div className="actions-inline" style={{ marginTop: 16 }}>
        <button type="button" className="small" onClick={() => fileInputRef.current?.click()}>
          {t("btnSelectFiles")}
        </button>
        <button type="button" className="secondary small" onClick={() => folderInputRef.current?.click()}>
          {t("btnSelectFolder")}
        </button>
      </div>
      
      <input type="file" multiple ref={fileInputRef} style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />
      {/* @ts-expect-error directory attributes are non-standard but supported by most browsers */}
      <input type="file" multiple ref={folderInputRef} style={{ display: 'none' }} webkitdirectory="" directory="" onChange={(e) => handleFiles(e.target.files)} />
      
      {uploadStatus.length > 0 && (
         <div className="stack" style={{ marginTop: 16, gap: 8, maxHeight: 200, overflowY: 'auto' }}>
            {uploadStatus.map((s, i) => (
               <div key={i} className="row" style={{ fontSize: '0.85rem' }}>
                  <span style={{flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{s.name}</span>
                  {s.status === 'uploading' && <span style={{color: 'var(--accent)'}}>{t("statusUploading")}</span>}
                  {s.status === 'done' && <span style={{color: '#198754'}}>{t("statusDone")}</span>}
                  {s.status === 'error' && <span style={{color: '#dc3545'}}>{t("uploadError", { error: s.error || t("valUnknown") })}</span>}
               </div>
            ))}
         </div>
      )}
    </div>
  );
}
