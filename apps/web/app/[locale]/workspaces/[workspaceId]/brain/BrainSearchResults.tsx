import React from "react";
import { BrainSearchSourceGroup } from "./BrainSearchSourceGroup";
import type { BrainSearchSourceGroup as SearchGroup } from "./view-model";

export type BrainSearchLabels = {
  results: string;
  noResults: string;
  noAvailableSources: string;
  someSourcesUnavailable: string;
  coverageNote: string;
  unavailableSource: string;
  sourceType: Record<SearchGroup["sourceType"], string>;
  passagesShown: (count: number) => string;
  morePassages: (count: number) => string;
};

export function BrainSearchResults({ groups, rawResultCount, hasUnavailableSources, workspaceId, labels }: {
  groups: SearchGroup[];
  rawResultCount: number;
  hasUnavailableSources: boolean;
  workspaceId: string;
  labels: BrainSearchLabels;
}) {
  return (
    <div className="brain-search-results">
      <h3>{labels.results}</h3>
      {groups.map((group) => (
        <BrainSearchSourceGroup
          key={group.key}
          group={group}
          workspaceId={workspaceId}
          sourceTypeLabel={labels.sourceType[group.sourceType]}
          passagesLabel={labels.passagesShown(group.passages.length)}
          morePassagesLabel={labels.morePassages(group.passages.length - 1)}
          unavailableLabel={labels.unavailableSource}
        />
      ))}
      {groups.length === 0 && (
        <p role="status" className="brain-search-empty">
          {rawResultCount === 0 ? labels.noResults : labels.noAvailableSources}
        </p>
      )}
      {groups.length > 0 && hasUnavailableSources && (
        <p className="brain-coverage-note">{labels.someSourcesUnavailable}</p>
      )}
      <p className="brain-coverage-note">{labels.coverageNote}</p>
    </div>
  );
}
