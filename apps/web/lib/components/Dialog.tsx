"use client";

import { useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const t = useTranslations("shared.dialog");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDialogElement>) => {
      if (e.target === dialogRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <dialog ref={dialogRef} className="dialog" onClick={handleClick} onClose={onClose}>
      <div className="dialog-content">
        <div className="dialog-header">
          <h2>{title}</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label={t("close")}>
            &times;
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </dialog>
  );
}
