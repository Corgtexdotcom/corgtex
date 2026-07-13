export type CommunicationSuggestionLike = {
  status: string;
  updatedAt?: Date | string;
  createdAt?: Date | string;
};

const STATUS_RANK: Record<string, number> = {
  FAILED: 0,
  SUGGESTED: 1,
  REQUESTED: 2,
  SENT: 3,
  DECLINED: 4,
};

export function isOpenCommunicationSuggestion(suggestion: CommunicationSuggestionLike) {
  return suggestion.status === "SUGGESTED" || suggestion.status === "REQUESTED" || suggestion.status === "FAILED";
}

function communicationSuggestionStatusRank(status: string) {
  return STATUS_RANK[status] ?? 99;
}

function suggestionTime(suggestion: CommunicationSuggestionLike) {
  const value = suggestion.updatedAt ?? suggestion.createdAt;
  return value ? new Date(value).getTime() : 0;
}

export function sortCommunicationSuggestions<T extends CommunicationSuggestionLike>(suggestions: T[]) {
  return [...suggestions].sort((a, b) => {
    const statusDelta = communicationSuggestionStatusRank(a.status) - communicationSuggestionStatusRank(b.status);
    if (statusDelta !== 0) return statusDelta;
    return suggestionTime(b) - suggestionTime(a);
  });
}

export function splitCommunicationSuggestions<T extends CommunicationSuggestionLike>(suggestions: T[]) {
  const sorted = sortCommunicationSuggestions(suggestions);
  return {
    open: sorted.filter(isOpenCommunicationSuggestion),
    suggested: sorted.filter((suggestion) => suggestion.status === "SUGGESTED"),
    requested: sorted.filter((suggestion) => suggestion.status === "REQUESTED"),
    sent: sorted.filter((suggestion) => suggestion.status === "SENT"),
    declined: sorted.filter((suggestion) => suggestion.status === "DECLINED"),
    failed: sorted.filter((suggestion) => suggestion.status === "FAILED"),
    all: sorted,
  };
}
