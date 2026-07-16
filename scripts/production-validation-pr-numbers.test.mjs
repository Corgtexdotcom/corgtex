import { describe, expect, it } from "vitest";

import {
  collectProductionValidationPrNumbers,
  parseMergeCommitPrNumbers,
  prNumbersFromGithubEvent,
} from "./production-validation-pr-numbers.mjs";

describe("production validation PR number resolution", () => {
  it("extracts PR numbers from merge commits and squash titles", () => {
    expect(parseMergeCommitPrNumbers("Merge pull request #706 from Corgtexdotcom/codex/test")).toEqual([706]);
    expect(parseMergeCommitPrNumbers("Run CRM production validation after deploy (#707)")).toEqual([707]);
  });

  it("does not treat unrelated issue references as production validation coverage", () => {
    expect(parseMergeCommitPrNumbers("Fix retry handling for issue #708")).toEqual([]);
    expect(parseMergeCommitPrNumbers("Run CRM production validation after deploy\n\nFixes (#708)")).toEqual([]);
  });

  it("reads pull request numbers from GitHub event payloads", () => {
    expect(prNumbersFromGithubEvent({
      pull_request: { number: 701 },
      head_commit: { message: "Merge pull request #702 from Corgtexdotcom/codex/other" },
      commits: [{ message: "Follow-up (#703)" }],
    })).toEqual([701, 702, 703]);
  });

  it("combines baseline, explicit, and event PR numbers without duplicates", () => {
    expect(collectProductionValidationPrNumbers({
      baseline: "696,705",
      explicit: "705,706",
      event: { head_commit: { message: "Merge pull request #706 from Corgtexdotcom/codex/test" } },
    })).toEqual([696, 705, 706]);
  });
});
