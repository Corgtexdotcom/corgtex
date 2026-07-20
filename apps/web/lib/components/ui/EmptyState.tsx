import React, { type ReactNode } from "react";
import { WorkspaceEmptyState } from "@/lib/components/ControlPrimitives";

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className = "" }: EmptyStateProps) {
  return (
    <WorkspaceEmptyState
      title={title}
      description={description}
      action={action}
      media={icon ? <span aria-hidden="true">{icon}</span> : undefined}
      className={`nr-item ${className}`}
    />
  );
}
