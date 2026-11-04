# Selected legacy history recovery

An authenticated workspace admin can recover existing company Actions, Documents,
BrainSources, Roles, and Circles through `/api/workspaces/{workspaceId}/history-recovery`.
Conversation sessions and turns are recoverable only by their actual owner and
remain private. Finance records are excluded.

Use GET with `kind` and `id` to inspect the selected record's current fingerprint
without returning its body. POST that selection with `expectedFingerprint`, a
stable UUID `requestId`, and `consent: "RESTORE_SELECTED_HISTORY"`. This records a
current recovery attestation under the already authorized company recovery policy;
it does not claim that historical generated text was a human submission. Preserve
the same complete POST body on retries. Reusing the request ID for different
content or another record returns a conflict.

An operator can process an explicitly selected list sequentially, keeping one
request UUID per selection and recording each result. Recover a parent Document
before its bound file BrainSource, a Circle before its Roles, and a private
conversation session before its turns. Role recovery is scoped through its
current Circle workspace; no Role or Circle assignments, memberships, or
permissions are created. Known restricted contributors stay restricted. Do not batch by rewriting database rows or historical lineage. There is no
automatic migration over customer history or privileged background recovery job.

Successful recovery preserves the original row and old lineage, adds an immutable
current attestation, and makes normal Action/conversation/file and Role/Circle readers available
subject to all current category, circle, private-contributor and tenant controls.
A known unavailable contributor remains a concrete rejection; regenerate that
record from currently authorized sources instead of replacing its old proof.

Document and BrainSource POSTs also run the existing projection pipeline under the
actual authenticated caller after the durable recovery commits. Inspect the
separate `projection` result. `FAILED` is retryable using the same POST; it does not
undo or duplicate the durable receipt. Saved Brain proposals are reindexed on a
retry after embedding failure. No serialized actor or generic worker grant is
created. Model work may incur the workspace's ordinary authorized model usage.

For original files, recovery verifies the exact workspace upload namespace,
Document binding, streamed size and SHA-256. It attests the stored bytes observed
now, not an invented historical digest. Normal download re-verifies these bytes
and current access before and during delivery. Foreign or ambiguous storage keys,
missing objects, conflicting sizes/hashes, over-limit distinct evidence or bodies
require explicit source-specific repair and are not silently adopted.

Recovering-admin identity and original operation epochs are retained for audit and
checked through publication/projection. They do not become new serving governors
for company history. Genuine target authors, owners, original contributors and
saved permission vectors remain governors. Conversation/private owners do not
receive this company treatment.
