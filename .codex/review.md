# Independent QA and review

A separate GPT-6 agent evaluates the integrated outcome after implementation.
Use `beepto-codex` for protected GitHub review. Do not edit, fix, push, merge, or
approve your own work; the delivery owner handles corrections in the same PR.

1. Read the user's outcome, PR description, complete current diff, relevant tests,
   and available CI/behavior evidence. Assess the whole feature and its integration.
2. Exercise changed behavior where existing evidence leaves a real question. Check
   usability for visible changes and auth, tenant, secrets, data, and recovery
   boundaries when affected. Reuse sufficient evidence; do not duplicate whole suites.
3. Report all concrete blockers in one review, with impact and a useful correction.
   Block on incorrect/incomplete behavior, meaningful uncovered risk, inadequate proof,
   secrets, failed required CI, or explicit hold labels. Do not block on size, taste,
   speculative hardening, lack of a new test file, or lack of a file allowlist.
4. After fixes, review changed code and affected integration; carry forward unaffected
   findings. New pushes need current-head approval, not repetition of unchanged tests.
5. Verify the live head, reviewer identity, required checks, and unresolved discussions
   before submitting approval. A changed base requires assessing integration impact;
   merge-queue CI validates the combined result. No custom attestation is required.

Keep the PR description accurate: outcome, completed acceptance, validation, risk and
rollback. Protected changes need `critical` risk and a concrete Scope explanation.
Visible UI behavior needs running proof; API changes and nonvisual refactors do not.
Test adequacy depends on coverage of behavior, not whether a test file was edited.

Approve when acceptance and relevant evidence establish a shippable result and the
required gates pass. Minor reversible imperfections can be follow-up work. Respect
`halt-agents` and `needs-replan`; ordinary corrections do not automatically set them.
An explicit bypass is limited to the named operation and never permits secret leaks.
