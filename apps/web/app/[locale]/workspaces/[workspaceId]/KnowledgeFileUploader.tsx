"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { MarkdownEditor } from "@/lib/components/MarkdownEditor";

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

type UploadStatus = "ready" | "uploading" | "done" | "error";

type UploadItem = {
  id: string;
  file: File;
  title: string;
  guidance: string;
  status: UploadStatus;
  error?: string;
};

function uploadId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function combineGuidance(overallGuidance: string, fileGuidance: string) {
  const overall = overallGuidance.trim();
  const file = fileGuidance.trim();

  if (overall && file) {
    return `Overall guidance:\n${overall}\n\nFile guidance:\n${file}`;
  }

  if (overall) {
    return `Overall guidance:\n${overall}`;
  }

  if (file) {
    return `File guidance:\n${file}`;
  }

  return "";
}

function errorMessage(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  }
  return fallback;
}

export function KnowledgeFileUploader({
  workspaceId,
  defaultSource = "brain-upload",
  initiallyOpen = false,
  showTrigger = true,
  cancelHref,
}: {
  workspaceId: string;
  defaultSource?: string;
  initiallyOpen?: boolean;
  showTrigger?: boolean;
  cancelHref?: string;
}) {
  const router = useRouter();
  const t = useTranslations("brain");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [overallGuidance, setOverallGuidance] = useState("");
  const [items, setItems] = useState<UploadItem[]>([]);

  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setItems((current) => [
      ...current,
      ...Array.from(files).map((file) => ({
        id: uploadId(),
        file,
        title: "",
        guidance: "",
        status: "ready" as const,
      })),
    ]);
    setIsOpen(true);
  }

  function updateItem(id: string, patch: Partial<UploadItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  async function uploadItems() {
    const uploadable = items.filter((item) => item.status !== "done");
    if (uploadable.length === 0 || isUploading) return;

    setIsUploading(true);
    for (const item of uploadable) {
      if (item.file.size > MAX_FILE_SIZE_BYTES) {
        updateItem(item.id, {
          status: "error",
          error: t("uploadFilesFileTooLarge"),
        });
        continue;
      }

      updateItem(item.id, { status: "uploading", error: undefined });
      const formData = new FormData();
      formData.set("file", item.file);
      formData.set("source", defaultSource);
      formData.set("title", item.title.trim() || item.file.name);
      const guidance = combineGuidance(overallGuidance, item.guidance);
      if (guidance) {
        formData.set("ingestionGuidanceMd", guidance);
      }

      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/documents`, {
          method: "POST",
          body: formData,
        });

        if (response.ok) {
          updateItem(item.id, { status: "done", error: undefined });
          continue;
        }

        const data = await response.json().catch(() => null);
        updateItem(item.id, {
          status: "error",
          error: errorMessage(data, t("uploadFilesErrorGeneric")),
        });
      } catch {
        updateItem(item.id, {
          status: "error",
          error: t("uploadFilesErrorNetwork"),
        });
      }
    }

    setIsUploading(false);
    router.refresh();
  }

  const hasPendingUploads = items.some((item) => item.status !== "done");
  const doneCount = items.filter((item) => item.status === "done").length;

  return (
    <section className="stack" style={{ marginBottom: 32 }}>
      {showTrigger && (
        <div className="actions-inline">
          <button type="button" className="small" onClick={() => setIsOpen((open) => !open)}>
            {t("uploadFilesButton")}
          </button>
        </div>
      )}

      {isOpen && (
        <div
          className="nr-form-section stack"
          style={{
            padding: 24,
            border: isDragging ? "2px dashed var(--accent)" : "1px solid var(--line)",
            borderRadius: 8,
            background: isDragging ? "var(--accent-soft)" : "transparent",
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            addFiles(event.dataTransfer.files);
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div>
              <h3 style={{ margin: 0 }}>{t("uploadFilesTitle")}</h3>
              <p className="nr-item-meta" style={{ marginTop: 6, marginBottom: 0 }}>
                {t("uploadFilesDescription")}
              </p>
            </div>
            <button type="button" className="secondary small" onClick={() => fileInputRef.current?.click()}>
              {t("uploadFilesSelect")}
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(event) => {
              addFiles(event.target.files);
              event.currentTarget.value = "";
            }}
          />

          <div style={{ padding: 18, border: "1px dashed var(--line)", borderRadius: 6, textAlign: "center" }}>
            <button type="button" className="link-button secondary" onClick={() => fileInputRef.current?.click()}>
              {t("uploadFilesDrop")}
            </button>
          </div>

          <label>
            {t("uploadFilesOverallGuidance")}
            <MarkdownEditor
              name="overallGuidance"
              value={overallGuidance}
              onValueChange={setOverallGuidance}
              rows={3}
              placeholder={t("uploadFilesOverallGuidancePlaceholder")}
            />
          </label>

          {items.length === 0 ? (
            <p className="nr-item-meta">{t("uploadFilesEmpty")}</p>
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              <div className="nr-item-meta">
                {t("uploadFilesSelectedCount", { count: items.length, done: doneCount })}
              </div>
              {items.map((item, index) => (
                <div key={item.id} className="nr-item" style={{ padding: "14px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <div style={{ minWidth: 0 }}>
                      <strong className="nr-item-title" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.file.name}
                      </strong>
                      <span className="nr-item-meta">
                        {t(`uploadFilesStatus.${item.status}`)}
                        {item.error ? ` - ${item.error}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary small"
                      disabled={isUploading && item.status === "uploading"}
                      onClick={() => removeItem(item.id)}
                    >
                      {t("uploadFilesRemove")}
                    </button>
                  </div>
                  <div className="stack" style={{ gap: 10, marginTop: 12 }}>
                    <label>
                      {t("uploadFilesFileTitle")}
                      <input
                        value={item.title}
                        disabled={item.status === "uploading"}
                        onChange={(event) => updateItem(item.id, { title: event.target.value })}
                        placeholder={item.file.name}
                      />
                    </label>
                    <label>
                      {t("uploadFilesFileGuidance", { index: index + 1 })}
                      <MarkdownEditor
                        name={`fileGuidance-${item.id}`}
                        value={item.guidance}
                        disabled={item.status === "uploading"}
                        onValueChange={(value) => updateItem(item.id, { guidance: value })}
                        rows={3}
                        placeholder={t("uploadFilesFileGuidancePlaceholder")}
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="actions-inline">
            <button type="button" disabled={!hasPendingUploads || isUploading} onClick={uploadItems}>
              {isUploading ? t("uploadFilesSubmitting") : t("uploadFilesSubmit")}
            </button>
            {cancelHref && <a className="link-button secondary" href={cancelHref}>{t("cancel")}</a>}
          </div>
        </div>
      )}
    </section>
  );
}
