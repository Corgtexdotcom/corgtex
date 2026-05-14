import type { ReactNode } from "react";
import { ActionMenu } from "./ActionMenu";

interface ItemActionsProps {
  primary?: ReactNode;
  more?: ReactNode;
  moreLabel?: string;
  className?: string;
}

export function ItemActions({ primary, more, moreLabel, className = "" }: ItemActionsProps) {
  const hasPrimary = !!primary;
  const hasMore = !!more && !!moreLabel;
  if (!hasPrimary && !hasMore) return null;
  return (
    <div className={`item-actions ${className}`}>
      {hasPrimary && <div className="item-actions-primary">{primary}</div>}
      {hasMore && (
        <ActionMenu label={moreLabel!}>
          {more}
        </ActionMenu>
      )}
    </div>
  );
}
