export type ProposalDeliberationEntryType = "REACTION" | "OBJECTION";

export type ProposalDeliberationComposerState = {
  visible: boolean;
  entryTypes: ProposalDeliberationEntryType[];
  mode: "open" | "post-decision" | null;
};

export function resolveProposalDeliberationComposer(params: {
  isArchived: boolean;
  status: string;
}): ProposalDeliberationComposerState {
  if (params.isArchived) {
    return { visible: false, entryTypes: [], mode: null };
  }

  if (params.status === "OPEN") {
    return {
      visible: true,
      entryTypes: ["REACTION", "OBJECTION"],
      mode: "open",
    };
  }

  if (params.status === "RESOLVED") {
    return {
      visible: true,
      entryTypes: ["REACTION"],
      mode: "post-decision",
    };
  }

  return { visible: false, entryTypes: [], mode: null };
}
