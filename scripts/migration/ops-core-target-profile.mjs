// Exact targets only. A workflow input must never become an arbitrary ARM ID.
export const TARGET_PROFILE = process.env.TARGET_PROFILE ?? 'rehearsal';
if (!['rehearsal', 'opscore'].includes(TARGET_PROFILE)) throw new Error('TARGET_PROFILE_UNSUPPORTED');

export const TARGETS = Object.freeze({
  rehearsal: Object.freeze({
    group: 'rg-corgtex-migration-rehearsal',
    server: 'corgtex-mig-reh-restore-pg',
    host: 'corgtex-mig-reh-restore-pg.postgres.database.azure.com',
    storageGiB: 128,
    backupDays: 7,
    initialPublicAccess: 'Enabled',
    kind: 'ops-target-qualification',
    tags: Object.freeze({ authority: 'non-authoritative-restore-target',
      purpose: 'railway-to-azure-migration-foundation', managedBy: 'github-oidc' }),
  }),
  opscore: Object.freeze({
    group: 'rg-corgtex-opscore-hosting',
    server: 'corgtex-opscore-pg18',
    host: 'corgtex-opscore-pg18.postgres.database.azure.com',
    storageGiB: 32,
    backupDays: 14,
    initialPublicAccess: 'Disabled',
    kind: 'opscore-target-qualification',
    adminSecretId: 'https://kv-corgtex-opscore-boot.vault.azure.net/secrets/ops-core-shared-pg18-admin-password/f7a9b67c299e4061b1e15334c1857777',
    tags: Object.freeze({ application: 'corgtex',
      purpose: 'ops-core-shared-postgres-target', managedBy: 'migration-operator' }),
  }),
});

export const target = TARGETS[TARGET_PROFILE];
export const targetResource = `/subscriptions/227eb707-bc46-415e-a09b-7d2b69fb14b2/resourceGroups/${target.group}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${target.server}`;
