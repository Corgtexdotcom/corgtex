"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ActionMenuProps {
  label: string;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}

export function ActionMenu({ label, children, align = "right", className = "" }: ActionMenuProps) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    const node = detailsRef.current;
    if (!node) return;

    function handleDocumentClick(event: MouseEvent) {
      if (!node || !node.open) return;
      const target = event.target as Node | null;
      if (target && node.contains(target)) return;
      node.open = false;
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape" && node && node.open) {
        node.open = false;
        const summary = node.querySelector<HTMLElement>("summary");
        summary?.focus();
      }
    }

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  return (
    <details ref={detailsRef} className={`action-menu ${className}`} data-align={align}>
      <summary
        className="action-menu-trigger nr-hide-marker"
        aria-label={label}
        title={label}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="3" cy="8" r="1.5" fill="currentColor" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" />
          <circle cx="13" cy="8" r="1.5" fill="currentColor" />
        </svg>
      </summary>
      <div className="action-menu-panel" role="menu">
        {children}
      </div>
    </details>
  );
}
