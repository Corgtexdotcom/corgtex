export type DashboardAttentionCounts = {
  unreadNotificationsCount: number;
  proposalReviewRequestsCount?: number;
};

export type DashboardAttentionAction = {
  status: string;
  archivedAt?: Date | null;
  isPrivate?: boolean | null;
  assigneeMemberId?: string | null;
};

export type DashboardAttentionProposal = {
  id: string;
  status: string;
  archivedAt?: Date | null;
  isPrivate?: boolean | null;
  ownerMemberId?: string | null;
};

export type DashboardAttentionTension = {
  status: string;
  archivedAt?: Date | null;
  isPrivate?: boolean | null;
  assigneeMemberId?: string | null;
};

export type DashboardWorkAttentionCounts = {
  currentMemberId?: string | null;
  actions: DashboardAttentionAction[];
  proposals: DashboardAttentionProposal[];
  proposalAdviceRequestSubjectIds?: string[];
  tensions: DashboardAttentionTension[];
};

export type DashboardWorkAttentionMetrics = {
  currentMemberId?: string | null;
  actionPersonalCount?: number;
  actionTotalCount: number;
  proposalPersonalCount?: number;
  proposalTotalCount: number;
  tensionPersonalCount?: number;
  tensionTotalCount: number;
};

export type DashboardWorkAttentionResult = {
  actions: {
    personalCount: number | null;
    totalCount: number;
  };
  proposals: {
    personalCount: number | null;
    totalCount: number;
  };
  tensions: {
    personalCount: number | null;
    totalCount: number;
  };
};

export function getDashboardAttentionCounts({
  unreadNotificationsCount,
  proposalReviewRequestsCount = 0,
}: DashboardAttentionCounts) {
  return {
    totalAttentionItems: unreadNotificationsCount + proposalReviewRequestsCount,
  };
}

function isVisibleActiveItem(item: { archivedAt?: Date | null; isPrivate?: boolean | null }) {
  return item.archivedAt == null && !item.isPrivate;
}

function isOpenAction(action: DashboardAttentionAction) {
  return isVisibleActiveItem(action) && (action.status === "OPEN" || action.status === "IN_PROGRESS");
}

function isOpenProposal(proposal: DashboardAttentionProposal) {
  return isVisibleActiveItem(proposal) && proposal.status === "OPEN";
}

function isOpenTension(tension: DashboardAttentionTension) {
  return isVisibleActiveItem(tension) && tension.status === "OPEN";
}

export function getDashboardWorkAttentionCounts({
  currentMemberId,
  actions,
  proposals,
  proposalAdviceRequestSubjectIds = [],
  tensions,
}: DashboardWorkAttentionCounts): DashboardWorkAttentionResult {
  const openActions = actions.filter(isOpenAction);
  const openProposals = proposals.filter(isOpenProposal);
  const openTensions = tensions.filter(isOpenTension);
  const hasCurrentMember = Boolean(currentMemberId);
  const requestedProposalIds = new Set(proposalAdviceRequestSubjectIds);
  const openProposalIds = new Set(openProposals.map((proposal) => proposal.id));
  const personalProposalIds = new Set<string>();

  if (currentMemberId) {
    for (const proposal of openProposals) {
      if (proposal.ownerMemberId === currentMemberId) {
        personalProposalIds.add(proposal.id);
      }
    }

    for (const proposalId of requestedProposalIds) {
      if (openProposalIds.has(proposalId)) {
        personalProposalIds.add(proposalId);
      }
    }
  }

  return {
    actions: {
      personalCount: hasCurrentMember
        ? openActions.filter((action) => action.assigneeMemberId === currentMemberId).length
        : null,
      totalCount: openActions.length,
    },
    proposals: {
      personalCount: hasCurrentMember ? personalProposalIds.size : null,
      totalCount: openProposals.length,
    },
    tensions: {
      personalCount: hasCurrentMember
        ? openTensions.filter((tension) => tension.assigneeMemberId === currentMemberId).length
        : null,
      totalCount: openTensions.length,
    },
  };
}

export function getDashboardWorkAttentionCountsFromMetrics({
  currentMemberId,
  actionPersonalCount = 0,
  actionTotalCount,
  proposalPersonalCount = 0,
  proposalTotalCount,
  tensionPersonalCount = 0,
  tensionTotalCount,
}: DashboardWorkAttentionMetrics): DashboardWorkAttentionResult {
  const hasCurrentMember = Boolean(currentMemberId);

  return {
    actions: {
      personalCount: hasCurrentMember ? actionPersonalCount : null,
      totalCount: actionTotalCount,
    },
    proposals: {
      personalCount: hasCurrentMember ? proposalPersonalCount : null,
      totalCount: proposalTotalCount,
    },
    tensions: {
      personalCount: hasCurrentMember ? tensionPersonalCount : null,
      totalCount: tensionTotalCount,
    },
  };
}
