// Every required acceptance case must end in an explicit terminal status.
export const ACCEPTANCE_CASES = {
  Auth: ["health", "agent-session", "workspace", "admin-session"],
  "Brain Sources": ["ingest", "listing", "status"],
  "File Upload": ["upload", "listing", "brain-source"],
  "Meeting Minutes": [
    "create",
    "listing",
    "summary-agent",
    "summary-persisted",
    "action-agent",
  ],
  "Agent Trigger": [
    "inbox-triage",
    "brain-maintenance",
    "constitution-synthesis",
    "proposal-drafting",
    "listing",
  ],
  Conversation: ["create", "stream", "persistence"],
  Knowledge: ["search", "ask"],
  "Brain Articles": ["create", "listing", "detail", "update", "status"],
};

export function createReport({ strict = false, log = console.log } = {}) {
  const cases = new Map(
    Object.entries(ACCEPTANCE_CASES).flatMap(([suite, ids]) =>
      ids.map((id) => [
        `${suite}/${id}`,
        { suite, id, status: null, reason: null },
      ]),
    ),
  );
  const errors = [];
  function record(suite, id, status, reason) {
    const entry = cases.get(`${suite}/${id}`);
    if (
      !entry ||
      entry.status !== null ||
      !["pass", "fail", "skip"].includes(status)
    ) {
      throw new Error(
        `Invalid or duplicate case result: ${suite}/${id} (${status})`,
      );
    }
    Object.assign(entry, { status, reason });
    log(`  ${status.toUpperCase()} [${suite}/${id}] ${reason}`);
  }
  return {
    record,
    error(suite, reason) {
      errors.push({ suite, reason });
      log(`  FAIL [${suite}] ${reason}`);
    },
    abortSuite(suite, reason) {
      const entries = [...cases.values()].filter(
        (entry) => entry.suite === suite,
      );
      // Assertion failures may throw to abort bootstrap; retain that original case.
      if (entries.some((entry) => entry.status === "fail")) {
        log(`  ABORT [${suite}] ${reason}`);
      } else {
        const pending = entries.find((entry) => entry.status === null);
        if (pending) record(suite, pending.id, "fail", reason);
        else this.error(suite, reason);
      }
    },
    finishSuite(
      suite,
      reason = "Blocked by an earlier failed prerequisite in this suite",
    ) {
      for (const entry of cases.values()) {
        if (entry.suite === suite && entry.status === null)
          record(suite, entry.id, "skip", reason);
      }
    },
    summary() {
      for (const entry of cases.values()) {
        if (entry.status === null)
          record(
            entry.suite,
            entry.id,
            "skip",
            "Not run: bootstrap or runner aborted",
          );
      }
      const results = [...cases.values()].map((entry) => ({ ...entry }));
      const passed = results.filter((entry) => entry.status === "pass").length;
      const failed =
        results.filter((entry) => entry.status === "fail").length +
        errors.length;
      const skipped = results.filter((entry) => entry.status === "skip").length;
      const exitCode = failed > 0 || (strict && skipped > 0) ? 1 : 0;
      log(
        `Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${strict ? "strict acceptance" : "developer"} mode)`,
      );
      if (strict && skipped > 0)
        log("Acceptance incomplete: all required cases must pass.");
      return {
        passed,
        failed,
        skipped,
        exitCode,
        cases: results,
        errors: [...errors],
      };
    },
  };
}
