// The PITR qualification must finish before either domain can initialize its
// permanent cutover journal. A blob lease serializes these two entry points;
// the durable active record continues to fence cutover between workflow steps
// and after an interrupted runner until exact recovery closes the target.
export const OPSCORE_CUSTODY_URL = 'https://ctcorgtexopojeehb7ikgnxw.blob.core.windows.net/source-objects';
const LOCK = 'guards/opscore-pitr.lock';
const ACTIVE = 'guards/opscore-pitr-active.json';
const need = (ok, code) => { if (!ok) throw new Error(code); };
const missing = error => error?.statusCode === 404 && error?.code === 'BlobNotFound';

async function optional(blob) {
  try { return await blob.download(); }
  catch (error) { if (missing(error)) return null; throw error; }
}

export async function openOpsCorePitrGuard(container, { renewIntervalMs = 20_000 } = {}) {
  need(Number.isSafeInteger(renewIntervalMs) && renewIntervalMs > 0 && renewIntervalMs <= 20_000,
    'OPSCORE_PITR_GUARD_INTERVAL_INVALID');
  const lock = container.getBlockBlobClient(LOCK);
  try { await lock.upload('', 0, { conditions: { ifNoneMatch: '*' } }); }
  catch (error) { if (![409, 412].includes(error?.statusCode)) throw new Error('OPSCORE_PITR_GUARD_UNAVAILABLE'); }
  const lease = lock.getBlobLeaseClient();
  try { await lease.acquireLease(60); }
  catch { throw new Error('OPSCORE_PITR_GUARD_OWNED_OR_UNAVAILABLE'); }
  let closed = false, lost = false, renewal;
  const renew = () => {
    if (!renewal) renewal = lease.renewLease().catch(() => { lost = true; throw new Error('OPSCORE_PITR_GUARD_LOST'); })
      .finally(() => { renewal = null; });
    return renewal;
  };
  const timer = setInterval(() => { if (!closed) void renew().catch(() => {}); }, renewIntervalMs);
  timer.unref();
  async function assertHeld() {
    need(!closed && !lost, 'OPSCORE_PITR_GUARD_LOST');
    await renew();
    need(!closed && !lost, 'OPSCORE_PITR_GUARD_LOST');
  }
  async function active() {
    await assertHeld();
    const response = await optional(container.getBlockBlobClient(ACTIVE));
    if (!response) return null;
    need(response.readableStreamBody && response.contentLength > 0 && response.contentLength <= 1024,
      'OPSCORE_PITR_ACTIVE_INVALID');
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(Buffer.from(chunk));
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('OPSCORE_PITR_ACTIVE_INVALID'); }
    need(Object.keys(value).sort().join() === 'runAttempt,runId'
      && /^[1-9][0-9]*$/.test(value.runId) && /^[1-9][0-9]*$/.test(value.runAttempt),
    'OPSCORE_PITR_ACTIVE_INVALID');
    return { value, etag: response.etag };
  }
  async function assertNoCutover() {
    await assertHeld();
    for (const domain of ['core', 'ops']) {
      need(!(await optional(container.getBlockBlobClient(`cutovers/${domain}.json`))),
        'OPSCORE_PITR_CUTOVER_INITIALIZED');
    }
    await assertHeld();
  }
  async function assertNoPitr() {
    need(!(await active()), 'OPSCORE_PITR_QUALIFICATION_ACTIVE');
  }
  async function assertOwner(owner) {
    need(owner && /^[1-9][0-9]*$/.test(owner.runId) && /^[1-9][0-9]*$/.test(owner.runAttempt),
      'OPSCORE_PITR_OWNER_INVALID');
    const row = await active();
    need(row && row.value.runId === owner.runId && row.value.runAttempt === owner.runAttempt,
      'OPSCORE_PITR_OWNER_MISMATCH');
    return row;
  }
  async function create(owner) {
    await assertNoPitr(); await assertNoCutover(); await assertHeld();
    const text = JSON.stringify({ runId: owner.runId, runAttempt: owner.runAttempt });
    try { await container.getBlockBlobClient(ACTIVE).upload(text, Buffer.byteLength(text),
      { conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'application/json' } }); }
    catch { throw new Error('OPSCORE_PITR_ACTIVE_CREATE_UNPROVEN'); }
    await assertOwner(owner);
  }
  async function clear(owner, { allowAbsent = false } = {}) {
    const row = await active();
    if (!row && allowAbsent) return;
    need(row && row.value.runId === owner.runId && row.value.runAttempt === owner.runAttempt,
      'OPSCORE_PITR_OWNER_MISMATCH');
    await assertHeld();
    try { await container.getBlockBlobClient(ACTIVE).delete({ conditions: { ifMatch: row.etag } }); }
    catch { throw new Error('OPSCORE_PITR_ACTIVE_CLEAR_UNPROVEN'); }
  }
  async function close() {
    if (closed) return;
    closed = true; clearInterval(timer);
    if (renewal) await renewal.catch(() => {});
    try { await lease.releaseLease(); }
    catch { throw new Error('OPSCORE_PITR_GUARD_RELEASE_UNPROVEN'); }
  }
  return { assertHeld, assertNoCutover, assertNoPitr, assertOwner, create, clear, close };
}
