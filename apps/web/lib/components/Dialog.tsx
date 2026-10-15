"use client";

import React, { useEffect, useId, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";

export function Dialog({
  open,
  onClose,
  title,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const t = useTranslations("shared.dialog");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      // Close before removal so native modal state and the opener are restored.
      if (dialog?.open) dialog.close();
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDialogElement>) => {
      const dialog = dialogRef.current;
      if (!dialog || e.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) {
        onClose();
      }
    },
    [onClose],
  );

  const handleCancel = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    },
    [onClose],
  );

  return (
    <dialog
      ref={dialogRef}
      className={`dialog ${className}`}
      aria-labelledby={titleId}
      onClick={handleClick}
      onCancel={handleCancel}
    >
      <div className="dialog-content">
        <div className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label={t("close")}>
            &times;
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </dialog>
  );
}
