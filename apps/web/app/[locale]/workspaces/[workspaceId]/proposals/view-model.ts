export const PROPOSAL_STATUS_FILTERS = ["DRAFT", "OPEN", "RESOLVED", "ARCHIVED", "ALL"] as const;
export const PROPOSAL_COLUMN_STATUSES = ["DRAFT", "OPEN", "RESOLVED", "ARCHIVED"] as const;

export type ProposalStatusFilter = (typeof PROPOSAL_STATUS_FILTERS)[number];
export type ProposalColumnStatus = (typeof PROPOSAL_COLUMN_STATUSES)[number];
export type ProposalStatusQuery = ProposalStatusFilter | readonly ProposalColumnStatus[] | undefined;
export type ProposalStatusSearch = {
  statusFilters: ProposalColumnStatus[];
  statusQuery: ProposalStatusQuery;
};

function proposalStatusValues(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<ProposalStatusFilter>();
  for (const entry of values) {
    if (PROPOSAL_STATUS_FILTERS.includes(entry as ProposalStatusFilter)) {
      seen.add(entry as ProposalStatusFilter);
    }
  }
  return seen;
}

export function resolveProposalStatusSearch(
  value: string | string[] | undefined,
  defaultValue: ProposalColumnStatus | null = "OPEN",
): ProposalStatusSearch {
  const seen = proposalStatusValues(value);
  const selected = PROPOSAL_COLUMN_STATUSES.filter((status) => seen.has(status));
  const isAllStatuses = seen.has("ALL") || selected.length === PROPOSAL_COLUMN_STATUSES.length;
  if (isAllStatuses) {
    return {
      statusFilters: [],
      statusQuery: "ALL" as const,
    };
  }
  if (selected.length > 0) {
    return {
      statusFilters: selected,
      statusQuery: selected,
    };
  }
  if (defaultValue !== null) {
    return {
      statusFilters: [defaultValue],
      statusQuery: [defaultValue],
    };
  }
  return {
    statusFilters: [],
    statusQuery: undefined,
  };
}
