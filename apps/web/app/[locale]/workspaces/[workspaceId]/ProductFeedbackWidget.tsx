"use client";

import html2canvas from "html2canvas";
import { Camera, ImagePlus, MessageSquareText, Trash2 } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/lib/components/Dialog";
import { useToast } from "@/lib/components/Toast";
import { shouldHideMobileBottomNavForWorkspacePath } from "./mobile-nav-model";

const MAX_SCREENSHOTS = 5;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

type ScreenshotDraft = {
  file: File;
  id: string;
  previewUrl: string;
};

function viewportContext() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

function fileId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
}

export function ProductFeedbackWidget({
  locale,
  workspaceId,
}: {
  locale: string;
  workspaceId: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("productFeedback");
  const { addToast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triedAutoCaptureRef = useRef(false);
  const screenshotsRef = useRef<ScreenshotDraft[]>([]);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [screenshots, setScreenshots] = useState<ScreenshotDraft[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hideForFocusedActionRoute = shouldHideMobileBottomNavForWorkspacePath(pathname, workspaceId, searchParams?.get("kind"));

  const clearScreenshots = useCallback(() => {
    setScreenshots((current) => {
      current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return [];
    });
  }, []);

  useEffect(() => {
    screenshotsRef.current = screenshots;
  }, [screenshots]);

  useEffect(() => () => {
    screenshotsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  }, []);

  const addScreenshots = useCallback((files: File[]) => {
    setError(null);
    const accepted: ScreenshotDraft[] = [];
    for (const file of files) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        setError(t("invalidFile"));
        continue;
      }
      if (file.size > MAX_SCREENSHOT_BYTES) {
        setError(t("fileTooLarge"));
        continue;
      }
      accepted.push({
        file,
        id: fileId(file),
        previewUrl: URL.createObjectURL(file),
      });
    }

    if (accepted.length === 0) return;
    setScreenshots((current) => {
      const slots = Math.max(0, MAX_SCREENSHOTS - current.length);
      if (accepted.length > slots) {
        setError(t("tooManyFiles"));
      }
      const next = [...current, ...accepted.slice(0, slots)];
      accepted.slice(slots).forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return next;
    });
  }, [t]);

  const captureScreenshot = useCallback(async () => {
    if (screenshots.length >= MAX_SCREENSHOTS || typeof window === "undefined") return;
    setError(null);
    setIsCapturing(true);
    try {
      const canvas = await html2canvas(document.body, {
        backgroundColor: null,
        height: window.innerHeight,
        ignoreElements: (element) => Boolean(element.closest("[data-product-feedback-ignore]")),
        logging: false,
        scale: Math.min(window.devicePixelRatio || 1, 1.5),
        scrollX: -window.scrollX,
        scrollY: -window.scrollY,
        useCORS: true,
        width: window.innerWidth,
        x: window.scrollX,
        y: window.scrollY,
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png", 0.92));
      if (!blob) {
        setError(t("captureFailed"));
        return;
      }
      const file = new File([blob], `corgtex-feedback-${Date.now()}.png`, { type: "image/png" });
      addScreenshots([file]);
    } catch {
      setError(t("captureFailed"));
    } finally {
      setIsCapturing(false);
    }
  }, [addScreenshots, screenshots.length, t]);

  useEffect(() => {
    if (!open) {
      triedAutoCaptureRef.current = false;
      return;
    }
    if (triedAutoCaptureRef.current) return;
    triedAutoCaptureRef.current = true;
    window.requestAnimationFrame(() => {
      void captureScreenshot();
    });
  }, [captureScreenshot, open]);

  function removeScreenshot(id: string) {
    setScreenshots((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  async function submitFeedback(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setError(t("messageRequired"));
      return;
    }

    setIsSubmitting(true);
    try {
      const formData = new FormData();
      formData.set("message", trimmedMessage);
      formData.set("path", pathname || window.location.pathname);
      formData.set("url", window.location.href);
      formData.set("title", document.title);
      formData.set("locale", locale);
      formData.set("viewport_json", JSON.stringify(viewportContext()));
      screenshots.forEach((item) => formData.append("screenshots", item.file, item.file.name));

      const response = await fetch(`/api/workspaces/${workspaceId}/product-feedback`, {
        method: "POST",
        body: formData,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error?.message || t("submitFailed"));
      }

      addToast(t("submitted"), "success");
      setMessage("");
      clearScreenshots();
      setOpen(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("submitFailed"));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (hideForFocusedActionRoute) {
    return null;
  }

  return (
    <div className="product-feedback-widget" data-product-feedback-ignore>
      <button
        type="button"
        className="product-feedback-trigger"
        onClick={() => setOpen(true)}
        aria-label={t("open")}
        title={t("open")}
      >
        <MessageSquareText aria-hidden="true" size={20} strokeWidth={1.9} />
        <span>{t("trigger")}</span>
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title={t("title")}>
        <form className="product-feedback-form" onSubmit={submitFeedback}>
          <label className="product-feedback-field">
            <span>{t("messageLabel")}</span>
            <textarea
              required
              maxLength={4000}
              rows={5}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t("messagePlaceholder")}
              disabled={isSubmitting}
            />
          </label>

          <div className="product-feedback-attachments">
            <div className="product-feedback-attachment-actions">
              <button type="button" className="secondary small" onClick={captureScreenshot} disabled={isCapturing || isSubmitting || screenshots.length >= MAX_SCREENSHOTS}>
                <Camera aria-hidden="true" size={16} />
                {isCapturing ? t("capturing") : t("capture")}
              </button>
              <button type="button" className="secondary small" onClick={() => inputRef.current?.click()} disabled={isSubmitting || screenshots.length >= MAX_SCREENSHOTS}>
                <ImagePlus aria-hidden="true" size={16} />
                {t("attach")}
              </button>
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(event) => {
                  addScreenshots(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </div>

            {screenshots.length > 0 && (
              <div className="product-feedback-previews" aria-label={t("screenshots")}>
                {screenshots.map((item, index) => (
                  <div key={item.id} className="product-feedback-preview">
                    <span
                      className="product-feedback-preview-image"
                      role="img"
                      aria-label={t("screenshotAlt", { number: index + 1 })}
                      style={{ backgroundImage: `url(${item.previewUrl})` }}
                    />
                    <button type="button" onClick={() => removeScreenshot(item.id)} aria-label={t("removeScreenshot", { number: index + 1 })} disabled={isSubmitting}>
                      <Trash2 aria-hidden="true" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <p className="product-feedback-error" role="alert">{error}</p>}

          <div className="product-feedback-actions">
            <button type="button" className="secondary" onClick={() => setOpen(false)} disabled={isSubmitting}>{t("cancel")}</button>
            <button type="submit" className="primary" disabled={isSubmitting}>{isSubmitting ? t("submitting") : t("submit")}</button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
