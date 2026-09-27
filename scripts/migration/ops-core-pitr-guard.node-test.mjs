import assert from 'node:assert/strict';
import test from 'node:test';
import { openOpsCorePitrGuard } from './ops-core-pitr-guard.mjs';

function fixture() {
  const blobs = new Map(); let sequence = 0;
  const container = {
    getBlockBlobClient(key) {
      return {
        async upload(text, bytes, { conditions } = {}) {
          assert.equal(Buffer.byteLength(text), bytes);
          if (conditions?.ifNoneMatch && blobs.has(key)) throw { statusCode: 412 };
          blobs.set(key, { text, etag: `etag-${++sequence}`, lease: null });
        },
        async download() {
          const row = blobs.get(key);
          if (!row) throw { statusCode: 404, code: 'BlobNotFound' };
          return { etag: row.etag, contentLength: Buffer.byteLength(row.text),
            readableStreamBody: (async function* () { yield Buffer.from(row.text); })() };
        },
        async delete({ conditions }) {
          const row = blobs.get(key);
          assert.equal(row?.etag, conditions.ifMatch);
          blobs.delete(key);
        },
        getBlobLeaseClient() {
          const id = `lease-${++sequence}`;
          return {
            async acquireLease() {
              const row = blobs.get(key);
              if (row.lease) throw new Error('owned');
              row.lease = id; return { leaseId: id };
            },
            async renewLease() { assert.equal(blobs.get(key).lease, id); },
            async releaseLease() { assert.equal(blobs.get(key).lease, id); blobs.get(key).lease = null; },
          };
        },
      };
    },
  };
  return { blobs, container };
}

test('active PITR fences both cutovers through run and cleanup; exact owner releases it', async () => {
  const f = fixture(), owner = { runId: '123', runAttempt: '1' };
  let guard = await openOpsCorePitrGuard(f.container);
  try {
    await guard.create(owner);
    await assert.rejects(guard.assertNoPitr(), /OPSCORE_PITR_QUALIFICATION_ACTIVE/);
    await assert.rejects(openOpsCorePitrGuard(f.container), /OPSCORE_PITR_GUARD_OWNED_OR_UNAVAILABLE/);
  } finally { await guard.close(); }
  guard = await openOpsCorePitrGuard(f.container);
  try {
    await guard.assertOwner(owner);
    await assert.rejects(guard.clear({ runId: '124', runAttempt: '1' }), /OPSCORE_PITR_OWNER_MISMATCH/);
    await guard.clear(owner);
    await guard.assertNoPitr();
  } finally { await guard.close(); }
});

test('an initialized journal for either domain prevents PITR even if no transfer started', async () => {
  for (const domain of ['core', 'ops']) {
    const f = fixture();
    f.blobs.set(`cutovers/${domain}.json`, { text: '{}', etag: 'existing', lease: null });
    const guard = await openOpsCorePitrGuard(f.container);
    try {
      await assert.rejects(guard.create({ runId: '123', runAttempt: '1' }), /OPSCORE_PITR_CUTOVER_INITIALIZED/);
      assert.equal(f.blobs.has('guards/opscore-pitr-active.json'), false);
    } finally { await guard.close(); }
  }
});

test('no-START recovery can close an absent guard but never clears a foreign owner', async () => {
  const f = fixture(), owner = { runId: '123', runAttempt: '1' };
  const guard = await openOpsCorePitrGuard(f.container);
  try {
    await guard.clear(owner, { allowAbsent: true });
    await guard.create({ runId: '124', runAttempt: '1' });
    await assert.rejects(guard.clear(owner, { allowAbsent: true }), /OPSCORE_PITR_OWNER_MISMATCH/);
  } finally { await guard.close(); }
});
