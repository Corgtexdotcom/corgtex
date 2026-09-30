# Existing Core incident recovery

This protected GitHub path is bound to Fleet failure `36757068293`, the crashed
Core web candidate, and the immutable accepted Core receipt. Ordinary Fleet
admission remains unchanged. It does not authorize direct Railway rollback.

Run **Recover Existing Core** on main with its default read-only plan first.
The existing `fleet-release-production` environment and `fleet-release`
concurrency govern execution. Both source images are read directly by their
accepted digests through the existing durable package reader. Verify the root
image/index digest and its unique linux/amd64 platform manifest separately;
an image index and its platform image have different digests. Database reads
require the reviewed public CA, independent leaf pin, localhost certificate
identity, actual database binding, unchanged catalog fingerprint and accepted
migration ledger. No migration, seed or database restore runs.

Recovery restores only the four release settings and source images on the
existing Core services. Image references are pinned to accepted digests. Setting
`web` deliberately disables startup migrations; its historical value was not
captured. Each staging mutation is read back, credentials and command overrides
are retained, and only web deploys. The old worker deployment stays running.

A started protected recovery step is a durable GitHub once-per-incident barrier.
A previous started step or rerun requires reconciliation; do not reissue an
uncertain deployment request. Ordinary read-only plans do not reserve deployment.

Success requires actual provider digests, one successful web and the unchanged
worker, matching release health, fresh login/session smoke, and unchanged
catalog/ledger. Authentication smoke creates normal session activity. The
recovery receipt is separate from the original accepted evidence.

The new web deployment ID invalidates the old baseline's deployment expectation.
A successful recovery therefore still requires independently reviewed baseline
adoption and its monitoring checks. Neither the original receipt nor its pin is
rewritten by recovery. Do not claim baseline monitoring, migration, retirement,
or customer workflow acceptance from runtime recovery alone.
