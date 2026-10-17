"use client";

import React, { useEffect, useState, type ReactNode } from "react";

export function ConfirmSubmitButton({
  children,
  confirmMessage,
  className,
  menuItem,
}: {
  children: ReactNode;
  confirmMessage: string;
  className?: string;
  menuItem?: boolean;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  return (
    <button
      type="submit"
      disabled={!ready}
      className={className}
      role={menuItem ? "menuitem" : undefined}
      tabIndex={menuItem ? -1 : undefined}
      onClick={(event) => {
        if (!window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </button>
  );
}
