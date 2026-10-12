# CI dependency image supply

## Decision

For the public repository, use immutable public upstream images and verified
GitHub Actions caching now. An anonymously readable upstream-only GHCR mirror is
the recommended next step for cold-pull availability, after exact publication and
visibility approval. A private registry dependency adds grants and fork-access
problems without protecting client data: these images contain public PostgreSQL
and pgvector only. Client data must never enter the supply path.

| Approach | Integrity | Availability and contributor access |
| --- | --- | --- |
| Upstream digest pull | Fixes bytes and platform selection | Every cold runner still depends on Docker Hub and its limits |
| Verified upstream blob cache | Checks manifest, config and every layer against committed pins | Warm CI avoids Hub; cache misses, eviction and outages require upstream |
| Public upstream-only mirror | Preserve full indexes and every referenced digest | Removes Hub from routine cold CI; anonymous pulls work for forks; requires publication approval |
| Private mirror | Same possible integrity checks | Requires package/Actions grants; unsuitable as the sole public fork dependency |

[Docker Hub limits](https://docs.docker.com/docker-hub/usage/pulls/) apply to
anonymous and Personal pulls. Authentication does not eliminate shared-IP abuse
limits. A digest pin is an integrity control, not a rate-limit workaround.
[BuildKit caches](https://docs.docker.com/build/ci/github-actions/cache/) are build
acceleration; this change caches already-built upstream image blobs.

## Implemented path

The `check` and `db-sync` jobs start PostgreSQL after cache restoration, rather
than in pre-step service initialization. Their required check names, database
URLs, migration checks and integration tests are retained. The composite action:

1. Selects a committed Linux AMD64 or ARM64 PG16 child digest and an exact
   platform/digest/format cache key. It has no broad restore keys.
2. Restores only original upstream files from Skopeo's `dir` transport.
3. Verifies the manifest against the committed digest, then the config and all
   compressed layer hashes and sizes. Checks Linux, architecture and PG major;
   rejects symlinks. Cache-supplied checksum files are not trusted.
4. On a missing/invalid cache, clears that runner-local blob directory and copies
   the same pinned public upstream child with `--preserve-digests`. Three attempts
   have bounded command timeouts and 5/10 second retry delays; exhaustion fails CI.
5. Imports verified blobs to Docker and checks the image config ID and platform.
   Saves upstream blobs only on main pushes, before a database exists. Cache
   restore/save service failures are optional; image verification is mandatory.
6. Starts the imported image with `--pull=never`, fixture credentials, loopback
   port 5432 and a new disposable database. Waits for readiness and exercises an
   actual pgvector operation. An always-run step removes its container/volumes.

[GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
allows fork PRs to restore base-branch caches. This action saves only on main
pushes. A standalone fork with no cache can cold-fetch anonymously. No PAT,
registry login or package grant is required. Do not cache Docker's entire data
directory, container exports, running volumes, builds, dumps or application files.

An exact corrupt cache cannot be overwritten. Delete only the affected cache key
through the normal authorized cache-maintenance path, or bump the format version;
until then verification discards it and cold-fetches. For Hub 429/unavailability
after retries, rerun after recovery. Never fall back to a mutable tag, different
digest, unverified archive or an application/production image. The cache reduces
repeat pulls; it does **not** guarantee cold-run availability.

## Pins and upstream provenance

Read-only registry inspection on 2026-10-12 verified the original PR1510 indexes
and the hashes of their two runnable child manifests/configs. PG16 is PostgreSQL
16.15 / pgvector 0.8.7, PG18 is PostgreSQL 18.6 / pgvector 0.8.6. This change uses
PG16 only; it does not move any PG18 rehearsal or production consumers.

| Image | Pinned index |
| --- | --- |
| `docker.io/pgvector/pgvector` PG16 | `sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a` |
| `docker.io/pgvector/pgvector` PG18 | `sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a` |

PG16 runnable children are `sha256:a97d77306ff47cc1d8add4d000cec2207da2e110746318df3137ce53c337ca30`
(AMD64) and `sha256:a45475a5bc7882f19e9ca17d49b67f665fa04d500350de2c47af325662445aec`
(ARM64). Both indexes also reference two non-runnable `unknown/unknown` manifests;
a full mirror must retain them. Pinning verifies byte identity to the reviewed
upstream artifact. It is not independent verification of the upstream publisher's
build identity or a signature claim. Any signature/attestation verification needs
an explicit trusted upstream identity and policy, not merely copied attachments.

## Licensing and notices

[pgvector 0.8.7's PostgreSQL license](https://github.com/pgvector/pgvector/blob/v0.8.7/LICENSE)
and [PostgreSQL's license](https://www.postgresql.org/about/licence/) permit
redistribution with required copyright/license notices retained. The pinned
images' config history records installing `LICENSE` and `README.md` under
`/usr/share/doc/pgvector`; preserve these files. The Debian-based image includes
other packages and their notices under `/usr/share/doc`.
[Official PostgreSQL image documentation](https://github.com/docker-library/docs/blob/master/postgres/README.md#license)
explicitly warns that bundled software has additional licenses. Check the exact
image's installed notices and any corresponding-source obligations before mirror
publication; do not describe the entire image as covered by pgvector's license.
Local anonymous ARM64 inspection also verified `/usr/share/doc/pgvector/LICENSE`,
`/usr/share/doc/postgresql-16/copyright` and `/usr/share/doc/bash/copyright` in
the exact PG16 image. Copy original bytes without stripping notices or adding
proprietary layers.

## Separate mirror activation approval

PR1510's `ci-pgvector-cache.yml` is dormant, manual, main-only **private** mirror
tooling. Keep `CI_PGVECTOR_PRIVATE_ACCESS_CONFIRMED` unset and do not dispatch it
as a public mirror. Its existing permission model must be deliberately superseded
in a reviewed change before public activation. Repository admin/write access is
not proof of GHCR publish rights, organization package policy or package grants.
A package API 404 is not proof that a package is absent or inaccessible to everyone.

Before any publication, obtain approval naming the exact package, source digests,
visibility, publisher and affected grants. Use a dedicated upstream-only namespace
such as `ghcr.io/corgtexdotcom/ci-pgvector-upstream`, distinct from application and
private cache images. **Making a GHCR package public is irreversible.**

After that separate approval:

1. Verify organization creation policy and existing package visibility/ownership,
   and the exact workflow repository's package write access. Use job-scoped
   `packages: write` with its `GITHUB_TOKEN`, manual main-only publishing and
   operator approval. Fork CI must never receive publisher credentials.
2. Copy only allowlisted public registry sources by digest, with no checkout,
   Dockerfile, application build context or client input. Use
   [Skopeo `--all --preserve-digests`](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md)
   to retain indexes, platform manifests, configs, layers and embedded attestations.
   Detached signatures/referrers need separate inventory and verification.
3. Verify destination index bytes and every child/config/layer digest, check both
   runnable platforms, retain license/source references and installed notices, and
   read back actual visibility and publishing grants. Abort on a changed digest or
   unexpected preexisting package. Partial copies must not become consumer pins.
4. Prove anonymous pulls by exact digest from both platforms and a fork workflow.
   Only then switch consumers to the approved public mirror by the same digest.
   Retain upstream as a bounded verified fallback; never rebuild the dependency.

[GHCR authentication and anonymous reads](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
and [visibility/inheritance/grants](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
are separate controls. This implementation publishes no package and changes no
credentials, grants, visibility, deployment or production access. Revert the
composite-action callers to restore the former CI service setup; removal of cache
entries is optional and does not affect runtime data.
