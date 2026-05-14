"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ActionMenuProps {
  label: string;
  children: ReactNode;
  className?: string;
}

const PANEL_MARGIN = 8;
const VIEWPORT_PADDING = 12;

export function ActionMenu({ label, children, className = "" }: ActionMenuProps) {
  const triggerId = useId();
  const panelId = `${triggerId}-panel`;
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const recompute = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const panelWidth = panelRect.width || 220;
    const panelHeight = panelRect.height || 0;
    const minWidth = Math.max(triggerRect.width, 220);

    // Prefer right-aligned (panel right edge aligned with trigger right edge).
    // Flip to left-aligned if it would clip the left edge of the viewport.
    let left = triggerRect.right - panelWidth;
    if (left < VIEWPORT_PADDING) {
      left = triggerRect.left;
    }
    // Clamp inside viewport so neither side gets clipped at zoom or narrow widths.
    if (left + panelWidth > vw - VIEWPORT_PADDING) {
      left = Math.max(VIEWPORT_PADDING, vw - VIEWPORT_PADDING - panelWidth);
    }
    if (left < VIEWPORT_PADDING) left = VIEWPORT_PADDING;

    // Prefer below the trigger. Flip above if not enough room below.
    let top = triggerRect.bottom + PANEL_MARGIN;
    if (panelHeight && top + panelHeight > vh - VIEWPORT_PADDING) {
      const flipped = triggerRect.top - PANEL_MARGIN - panelHeight;
      if (flipped >= VIEWPORT_PADDING) {
        top = flipped;
      } else {
        top = Math.max(VIEWPORT_PADDING, vh - VIEWPORT_PADDING - panelHeight);
      }
    }

    setPos({ top, left, minWidth });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    setPos({ top: -9999, left: -9999, minWidth: 220 });
    const raf = requestAnimationFrame(recompute);
    return () => cancelAnimationFrame(raf);
  }, [open, recompute]);

  useEffect(() => {
    if (!open) return;
    function handleScrollOrResize() {
      recompute();
    }
    function handleDocumentPointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    document.addEventListener("mousedown", handleDocumentPointerDown);
    document.addEventListener("touchstart", handleDocumentPointerDown, { passive: true });
    document.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
      document.removeEventListener("mousedown", handleDocumentPointerDown);
      document.removeEventListener("touchstart", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, recompute, close]);

  // Close on submit-button or link click so the menu doesn't linger after navigation/server action.
  const handlePanelClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button[type=submit], a[href]")) {
      requestAnimationFrame(close);
    }
  };

  return (
    <div className={`action-menu ${className}`}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="action-menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="3" cy="8" r="1.5" fill="currentColor" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" />
          <circle cx="13" cy="8" r="1.5" fill="currentColor" />
        </svg>
      </button>
      {mounted && open && createPortal(
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-labelledby={triggerId}
          className="action-menu-panel"
          style={{
            position: "fixed",
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            minWidth: pos?.minWidth ?? 220,
            visibility: pos && pos.top >= 0 ? "visible" : "hidden",
          }}
          onClick={handlePanelClick}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}
