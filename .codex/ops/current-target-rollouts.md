# Current-Target Ops Rollouts

Ops Deploy Latest (single deployment, explicit selection, and all eligible) requires
the deployment's owning `CustomerAccount.primaryDeploymentId` to equal that
deployment's ID. An ACTIVE status, recent creation, visible row, or queued job is
not current-target authority. Bulk queries select designated primaries; shared
preflight also verifies the owning account correspondence for every candidate.

Missing, inconsistent, or superseded primary bindings fail closed. Explicit
selection reports `preflight_failed`; execution throws `RELEASE_PREFLIGHT_FAILED`
with a current-target explanation. Verify the intended live account target through
the existing authorized account-management process before retrying. Do not infer
or automatically rewrite a primary from ACTIVE/newest rows to unblock a rollout.

The worker reloads this binding before release execution, including retries and
previously queued jobs. Health override does not bypass current-target, retained
history, suspended, backup, Azure, or shared-workspace exclusions. A legitimately
designated live Railway legacy target remains eligible under existing checks.
Deployments remains an infrastructure inventory; visibility is not eligibility.

This is an execution-time recheck, not a lease or cancellation mechanism. A
concurrent reassignment after the check can race even before the first provider
call. Serialize target reassignment/retirement against the entire release writer,
from its preflight read through completion. External fleet/recovery scripts and monitor selection are not
changed by this Ops Deploy Latest policy. No schema migration or retirement-data
rewrite is required. Keep existing authorization guards when integrating workspace
administration changes; primary designation never grants actor permissions.
