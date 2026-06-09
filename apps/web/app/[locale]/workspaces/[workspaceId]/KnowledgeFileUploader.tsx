"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { MarkdownEditor } from "@/lib/components/MarkdownEditor";

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const IGNORED_FILE_NAMES = new Set([".ds_store"]);

type UploadStatus = "ready" | "uploading" | "done" | "error";

type UploadItem = {
  id: string;
  file: File;
  displayName: string;
  relativePath: string | null;
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

function fileRelativePath(file: File) {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim();
  return path || null;
}

function fileDisplayName(file: File) {
  return fileRelativePath(file) ?? file.name;
}

function isIgnoredFile(file: File) {
  const name = file.name.trim().toLowerCase();
  const path = fileRelativePath(file)?.toLowerCase() ?? "";
  return IGNORED_FILE_NAMES.has(name) || path.split("/").some((segment) => IGNORED_FILE_NAMES.has(segment));
}

export function KnowledgeFileUploader({
  workspaceId,
  defaultSource = "brain-upload",
  initiallyOpen = false,
  showTrigger = true,
  showFolderSelect = true,
  doneLabel,
  cancelHref,
  onUploaded,
  onDone,
}: {
  workspaceId: string;
  defaultSource?: string;
  initiallyOpen?: boolean;
  showTrigger?: boolean;
  showFolderSelect?: boolean;
  doneLabel?: string;
  cancelHref?: string;
  onUploaded?: (count: number) => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const t = useTranslations("brain");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [overallGuidance, setOverallGuidance] = useState("");
  const [items, setItems] = useState<UploadItem[]>([]);
  const overallGuidanceRef = useRef("");
  const itemsRef = useRef<UploadItem[]>([]);
  const isUploadingRef = useRef(false);

  function updateOverallGuidance(value: string) {
    overallGuidanceRef.current = value;
    setOverallGuidance(value);
  }

  function setUploadItems(updater: (current: UploadItem[]) => UploadItem[]) {
    const next = updater(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }

  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const selectedFiles = Array.from(files).filter((file) => !isIgnoredFile(file));
    if (selectedFiles.length === 0) return;
    setUploadItems((current) => [
      ...current,
      ...selectedFiles.map((file) => {
        const relativePath = fileRelativePath(file);
        const displayName = fileDisplayName(file);
        return {
          id: uploadId(),
          file,
          displayName,
          relativePath,
          title: "",
          guidance: "",
          status: "ready" as const,
        };
      }),
    ]);
    setIsOpen(true);
  }

  function updateItem(id: string, patch: Partial<UploadItem>) {
    setUploadItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeItem(id: string) {
    setUploadItems((current) => current.filter((item) => item.id !== id));
  }

  async function uploadItems() {
    if (isUploadingRef.current) return;

    const uploadableIds = itemsRef.current.filter((item) => item.status !== "done").map((item) => item.id);
    if (uploadableIds.length === 0) return;

    isUploadingRef.current = true;
    setIsUploading(true);
    let uploadedCount = 0;
    try {
      for (const itemId of uploadableIds) {
        const item = itemsRef.current.find((current) => current.id === itemId);
        if (!item || item.status === "done") {
          continue;
        }

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
        formData.set("title", item.title.trim() || item.displayName);
        if (item.relativePath) {
          formData.set("metadata", JSON.stringify({ relativePath: item.relativePath }));
        }
        const guidance = combineGuidance(overallGuidanceRef.current, item.guidance);
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
            uploadedCount += 1;
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
    } finally {
      isUploadingRef.current = false;
      setIsUploading(false);
      if (uploadedCount > 0) {
        onUploaded?.(uploadedCount);
      }
      router.refresh();
    }
  }

  const hasPendingUploads = items.some((item) => item.status !== "done");
  const doneCount = items.filter((item) => item.status === "done").length;
  const hasCompletedUploads = doneCount > 0 && !hasPendingUploads && !isUploading;

  return (
    <section className="stack mb-8">
      {showTrigger && (
        <div className="actions-inline">
          <button type="button" className="small" onClick={() => setIsOpen((open) => !open)}>
            {t("uploadFilesButton")}
          </button>
        </div>
      )}

      {isOpen && (
        <div
          className={`nr-form-section stack nr-upload-dropzone ${isDragging ? "nr-upload-dropzone-active" : ""}`}
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
          <div className="nr-upload-header">
            <div>
              <h3 className="nr-upload-title">{t("uploadFilesTitle")}</h3>
              <p className="nr-upload-desc">
                {t("uploadFilesDescription")}
              </p>
            </div>
            <div className="actions-inline">
              <button type="button" className="secondary small" onClick={() => fileInputRef.current?.click()}>
                {t("uploadFilesSelect")}
              </button>
              {showFolderSelect && (
                <button type="button" className="secondary small" onClick={() => folderInputRef.current?.click()}>
                  {t("uploadFilesSelectFolder")}
                </button>
              )}
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          {showFolderSelect && (
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="hidden"
              // @ts-expect-error directory attributes are non-standard but supported by Chromium.
              webkitdirectory=""
              directory=""
              onChange={(event) => {
                addFiles(event.target.files);
                event.currentTarget.value = "";
              }}
            />
          )}

          <div className="nr-upload-area">
            <button type="button" className="link-button secondary" onClick={() => fileInputRef.current?.click()}>
              {t("uploadFilesDrop")}
            </button>
          </div>

          <label>
            {t("uploadFilesOverallGuidance")}
            <MarkdownEditor
              name="overallGuidance"
              value={overallGuidance}
              onValueChange={updateOverallGuidance}
              rows={3}
              placeholder={t("uploadFilesOverallGuidancePlaceholder")}
            />
          </label>

          {items.length === 0 ? (
            <p className="nr-item-meta">{t("uploadFilesEmpty")}</p>
          ) : (
            <div className="stack nr-upload-list">
              <div className="nr-item-meta">
                {t("uploadFilesSelectedCount", { count: items.length, done: doneCount })}
              </div>
              {items.map((item, index) => (
                <div key={item.id} className="nr-item nr-upload-item">
                  <div className="nr-upload-item-header">
                    <div className="nr-upload-item-content">
                      <strong className="nr-item-title nr-truncate">
                        {item.displayName}
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
                  <div className="stack nr-upload-item-fields">
                    <label>
                      {t("uploadFilesFileTitle")}
                      <input
                        value={item.title}
                        disabled={item.status === "uploading"}
                        onChange={(event) => updateItem(item.id, { title: event.target.value })}
                        placeholder={item.displayName}
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
            {hasCompletedUploads && onDone && (
              <button type="button" className="secondary" onClick={onDone}>
                {doneLabel ?? t("uploadFilesDone")}
              </button>
            )}
            {cancelHref && <a className="link-button secondary" href={cancelHref}>{t("cancel")}</a>}
          </div>
        </div>
      )}
    </section>
  );
}
