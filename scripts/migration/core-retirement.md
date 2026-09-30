# Core retirement into selfserve

Selfserve is the customer application; Ops remains the separate control plane.
Retirement removes Core dependencies from active workflows. It does not cancel
physical services during the Microsoft milestone and recovery-retention gate.
Keep total Azure spend within the approved monthly ceiling.

## Ownership and public entry points

Refresh active Ops workspace mappings, exact selfserve releases and live release
leases before production changes. Classify source records, objects, identities,
callbacks and jobs by actual customer ownership. Preserve customer-required
material and a minimal governed recovery archive outside the active application.
Core-only internal, demo and validation data are retirement candidates; importing
Core's internal workspace or converting its database is not a cutover gate.

Production site links, demo capture, qualification and link availability checks
use selfserve. A stale Core backend override fails closed. There is no Core
fallback, repeated write retry or transfer of legacy qualification tokens.
Unavailable links show a localized terminal state with a fresh selfserve trial
request. Existing valid selfserve tokens continue to work. A missing token does
not prove which runtime originally issued it.

## Protected delivery and cutover

Deliver the integrated change with independent QA, required CI and normal merge
queue. Release immutable selfserve and site images, then verify their actual
serving SHA/image, database, schema and drift. Exercise public demo navigation,
new capture and qualification, unavailable-link recovery, tenant isolation and
configured customer integrations. Use an isolated internal validation workspace;
never redirect legacy mutating smoke helpers to real customer workspaces.

Disable only specifically attributed Core callbacks and consumers after their
replacement or retirement is accepted. Drain source writers and claims before
source cleanup; preserve exact deletion scope and recovery location. Observe
request and queue activity for the recorded cutover window. Zero workspace-name
matches or a healthy endpoint alone do not establish completed retirement.

Selfserve remains the public data owner during rollback. Restore its last
accepted image through the existing protected release path if needed. Do not
restore Core as a second writable intake or treat a DNS reversal as data rollback.

## Temporary retention

Ops owns physical services until the separate milestone, cost and cancellation
decision permits removal. The delivery owner owns temporary Core recovery and
baseline tooling until replacement validation passes and no required Core
traffic or writer remains; then remove obsolete active tooling and retain only
immutable incident proof. Ops owns governed customer/recovery archives until
its retention and rollback conditions expire. Every retained item needs an
explicit purpose and removal condition; an archive is not an active application.

Keep generic selfserve product capabilities, historical Prisma migrations,
shared tenant recovery machinery and Railway support still used by Ops. Remove
unused Core transfer helpers, application gates, routing/configuration examples
and internal data only after their ownership and dependency checks pass.
