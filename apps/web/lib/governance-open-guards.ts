type DraftVisibility = {
  status: string;
  isPrivate?: boolean | null;
};

export function canOpenPrivateDraft(item: DraftVisibility) {
  return item.status === "DRAFT" && item.isPrivate === true;
}
