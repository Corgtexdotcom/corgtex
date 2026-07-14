"use client";

import type { ReactNode } from "react";

export function ConfirmSubmitButton({
  children,
  confirmMessage,
  className,
}: {
  children: ReactNode;
  confirmMessage: string;
  className?: string;
}) {
  return (
    <button
      type="submit"
      className={className}
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
