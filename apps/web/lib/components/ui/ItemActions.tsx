import React, { type ReactNode } from "react";
import { ActionMenu } from "./ActionMenu";

interface ItemActionsProps {
  /** Always rendered on the left of the row. Provide a sensible CTA (state-forward action or a "View" link). */
  primary?: ReactNode;
  /** Children rendered inside the kebab dropdown. If null/undefined the kebab is hidden. */
  more?: ReactNode;
  /** Accessible label for the kebab trigger. Required when `more` is provided. */
  moreLabel?: string;
  className?: string;
}

export function ItemActions({ primary, more, moreLabel, className = "" }: ItemActionsProps) {
  const hasPrimary = primary != null && primary !== false;
  const hasMore = more != null && more !== false && !!moreLabel;
  if (!hasPrimary && !hasMore) return null;
  return (
    <div className={`item-actions ${className}`}>
      <div className="item-actions-primary">{primary}</div>
      {hasMore && <ActionMenu label={moreLabel!}>{more}</ActionMenu>}
    </div>
  );
}
