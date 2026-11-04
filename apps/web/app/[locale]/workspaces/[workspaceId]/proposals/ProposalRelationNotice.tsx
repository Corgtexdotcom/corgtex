export function ProposalRelationNotice({window, label}: {
  window?: {complete: boolean};
  label: string;
}) {
  return window?.complete === false ? <span role="status" className="nr-item-meta">{label}</span> : null;
}
