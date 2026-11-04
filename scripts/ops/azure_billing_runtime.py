"""Single-blob admission/ledger CAS runtime; network and authority are injected.

No delivery adapter or live entry point. Default-deny bootstrap, run-consistency
proof and aggregate-retention gates are intentional production prerequisites.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import re
from datetime import timedelta

import azure_billing_azure as azure
import azure_billing_ingestion as ingestion
import azure_billing_ledger as ledger
import azure_billing_pipeline as pipeline

MAX_OBJECT_BYTES = 8 * 1024 * 1024
NORMALIZATION = "azure-manifest-utc-z-floor-v1"


class UnknownWrite(RuntimeError):
    pass


class BootstrapPermit:
    """One explicit operator-approved first-run generation; never a restart flag."""
    def __init__(self, generation, approval_id):
        self.generation = ledger.identifier(generation, "INVALID_GENERATION")
        self.approval_id = ledger.identifier(approval_id, "INVALID_BOOTSTRAP_APPROVAL")
        self.used = False


def validate_outer(value, generation, minimum_sequence):
    ledger.exact_keys(value, ["runtimeSchemaVersion", "generation", "admissions", "envelope"], "INVALID_RUNTIME_OBJECT")
    ledger.require(type(value["runtimeSchemaVersion"]) is int and value["runtimeSchemaVersion"] == 1
                   and value["generation"] == generation, "WRONG_LEDGER_GENERATION")
    pipeline.validate(value["envelope"])
    ledger.require(value["envelope"] is not None and value["envelope"]["commitSequence"] >= minimum_sequence,
                   "LEDGER_ROLLBACK_DETECTED")
    ledger.require(value["envelope"]["state"]["subscriptionId"] == azure.SUBSCRIPTION, "LEDGER_SUBSCRIPTION_MISMATCH")
    admissions = value["admissions"]
    snapshots = value["envelope"]["state"]["snapshots"]
    ledger.require(isinstance(admissions, dict) and set(admissions) == set(snapshots) and len(admissions) <= 2,
                   "ADMISSION_LEDGER_MISMATCH")
    for period, record in admissions.items():
        ledger.exact_keys(record, ["sourceIdentity", "captureDigest", "authorityId", "authoritySequence", "proofId", "revision",
                                  "snapshotId", "receipt", "manifestBase64", "normalizationProfile"], "INVALID_ADMISSION")
        for name in ("sourceIdentity", "captureDigest", "proofId", "snapshotId"):
            ledger.require(isinstance(record[name], str) and ledger.DIGEST.fullmatch(record[name]), "INVALID_ADMISSION_HASH")
        ledger.identifier(record["authorityId"], "INVALID_AUTHORITY_ID")
        ledger.require(type(record["authoritySequence"]) is int and 1 <= record["authoritySequence"] <= 1_000_000
                       and type(record["revision"]) is int and record["revision"] == snapshots[period]["revision"]
                       and record["snapshotId"] == snapshots[period]["snapshotId"]
                       and record["normalizationProfile"] == NORMALIZATION
                       and ledger.digest(record["receipt"]) == record["captureDigest"], "ADMISSION_LEDGER_MISMATCH")
        ledger.require(record["receipt"].get("storageResourceId") == azure.STORAGE_ID
                       and record["receipt"].get("container") == "billing-exports", "ADMISSION_SCOPE_MISMATCH")
        try:
            raw = base64.b64decode(record["manifestBase64"], validate=True)
        except Exception:
            raise ledger.ContractError("INVALID_ADMISSION_MANIFEST") from None
        ledger.require(len(raw) <= 256 * 1024 and hashlib.sha256(raw).hexdigest() == record["receipt"].get("manifestSha256"),
                       "ADMISSION_MANIFEST_MISMATCH")
    ledger.require(len(ledger.canonical(value).encode()) <= MAX_OBJECT_BYTES, "RUNTIME_OBJECT_TOO_LARGE")
    return value


class BlobCASStore:
    """Exact primary blob, one atomic outer object for admissions + every mutation.

    minimum_sequence is an approved restore floor, not inferred from a missing blob.
    Cross-process rollback detection requires a separately durable approved floor.
    """
    def __init__(self, client, generation, minimum_sequence, bootstrap_permit=None):
        self.client, self.generation = client, ledger.identifier(generation, "INVALID_GENERATION")
        ledger.require(type(minimum_sequence) is int and minimum_sequence >= 1, "INVALID_SEQUENCE_FLOOR")
        ledger.require(bootstrap_permit is None or isinstance(bootstrap_permit, BootstrapPermit)
                       and bootstrap_permit.generation == generation, "INVALID_BOOTSTRAP_PERMIT")
        self.minimum_sequence, self.permit, self.initialized = minimum_sequence, bootstrap_permit, False
        self.cache = {}

    def read_outer(self):
        try:
            raw, tag = self.client.get_blob(self.client.scope.ledger_container, azure.LEDGER_BLOB, maximum=MAX_OBJECT_BYTES)
        except azure.WireError as error:
            if error.status == 404 and error.provider_code == "BlobNotFound" and not self.initialized and self.permit and not self.permit.used:
                return None, None
            raise ledger.ContractError("LEDGER_READ_UNAVAILABLE_NO_RESET") from None
        value = validate_outer(ledger.parse_json_bytes(raw), self.generation, self.minimum_sequence)
        self.initialized = True
        self.minimum_sequence = max(self.minimum_sequence, value["envelope"]["commitSequence"])
        self.cache = {tag: copy.deepcopy(value)}
        return value, tag

    def read(self):
        outer, tag = self.read_outer()
        return (copy.deepcopy(outer["envelope"]) if outer else None), tag

    def write_outer(self, expected_etag, outer):
        validate_outer(outer, self.generation, self.minimum_sequence)
        if expected_etag is None:
            ledger.require(not self.initialized and self.permit is not None and not self.permit.used, "BOOTSTRAP_NOT_APPROVED")
            self.permit.used = True  # Uncertain writes cannot silently reuse first-run authority.
            conditions = {"If-None-Match": "*"}
        else:
            azure.etag(expected_etag)
            conditions = {"If-Match": expected_etag}
        raw = ledger.canonical(outer).encode()
        try:
            status, headers, body = self.client._request("PUT", self.client.scope.ledger_container, azure.LEDGER_BLOB,
                                                       body=raw, conditions=conditions, maximum=256 * 1024)
            ledger.require(status == 201 and not body, "INVALID_PUT_RESPONSE")
            tag = azure.etag(headers.get("etag"))
        except azure.WireError as error:
            if error.status == 412 and error.provider_code == "ConditionNotMet":
                raise pipeline.Conflict("BLOB_CONDITION_FAILED") from None
            return self._reconcile(outer)
        except Exception:
            return self._reconcile(outer)
        self.initialized = True
        self.minimum_sequence = max(self.minimum_sequence, outer["envelope"]["commitSequence"])
        self.cache = {tag: copy.deepcopy(outer)}
        return tag

    def _reconcile(self, intended):
        try:
            actual, tag = self.read_outer()
            if actual is not None and ledger.canonical(actual) == ledger.canonical(intended):
                return tag
        except Exception:
            pass
        raise UnknownWrite("WRITE_OUTCOME_UNKNOWN") from None

    def compare_and_swap(self, expected_etag, document):
        ledger.require(expected_etag in self.cache, "DETACHED_READ_REQUIRED")
        outer = copy.deepcopy(self.cache[expected_etag])
        outer["envelope"] = document
        return self.write_outer(expected_etag, outer)


class PublicationStore:
    """Bind one evaluated source admission set to exactly one ledger ETag."""
    def __init__(self, store, outer, etag, admissions, pre_write):
        self.store, self.outer, self.etag, self.admissions = store, copy.deepcopy(outer), etag, copy.deepcopy(admissions)
        self.pre_write = pre_write

    def read(self):
        return (copy.deepcopy(self.outer["envelope"]) if self.outer else None), self.etag

    def compare_and_swap(self, expected_etag, document):
        ledger.require(expected_etag == self.etag, "ADMISSION_TRANSACTION_CHANGED")
        self.pre_write()
        self.store.client.budget.check()
        return self.store.write_outer(expected_etag, {"runtimeSchemaVersion": 1, "generation": self.store.generation,
                                                     "admissions": self.admissions, "envelope": document})


def normalize_manifest(raw):
    """Versioned UTC-Z-only conversion; fractional submitted seconds floor conservatively.

    Exact raw bytes/precision remain in the atomic admission receipt. Offset-less
    or non-Z times are unsupported; no timezone is guessed. Authority is not time.
    """
    ledger.require(len(raw) <= 256 * 1024, "MANIFEST_METADATA_TOO_LARGE")
    value = ledger.parse_json_bytes(raw)
    run = value.get("runInfo") if isinstance(value, dict) else None
    ledger.require(isinstance(run, dict), "INVALID_RUN")
    submitted = run.get("submittedTime")
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.[0-9]{1,7})?Z", submitted or "")
    ledger.require(match is not None, "UNSUPPORTED_SOURCE_TIMESTAMP_PROFILE")
    ledger.utc_time(match[1] + "Z")
    ledger.utc_time(run.get("startDate"))
    ledger.utc_time(run.get("endDate"))
    run["submittedTime"] = match[1] + "Z"
    return value


def admit_capture(capture, scope, profile, policy, mapping, old, verifier, authority_id):
    ledger.require(verifier is not None, "PROVIDER_CONSISTENT_RUN_PROOF_REQUIRED")
    ledger.require(capture.receipt["storageResourceId"] == scope.storage_id
                   and capture.receipt["container"] == scope.source_container, "CAPTURE_SCOPE_MISMATCH")
    manifest = normalize_manifest(capture.manifest)
    run = manifest["runInfo"]
    period = ledger.utc_time(run["startDate"]).strftime("%Y-%m")
    root = capture.receipt["prefix"].split("/", 1)[0]
    export_id = manifest.get("exportConfig", {}).get("resourceId")
    identity = ledger.digest({"export": export_id, "runId": run.get("runId")})
    capture_digest = ledger.digest(capture.receipt)
    proof = verifier.verify(copy.deepcopy(capture.receipt), copy.deepcopy(manifest))
    ledger.exact_keys(proof, ["captureDigest", "period", "authorityId", "authoritySequence", "proofId"], "INVALID_RUN_PROOF")
    ledger.require(proof["captureDigest"] == capture_digest and proof["period"] == period and proof["authorityId"] == authority_id
                   and type(proof["authoritySequence"]) is int and 1 <= proof["authoritySequence"] <= 1_000_000
                   and isinstance(proof["proofId"], str) and ledger.DIGEST.fullmatch(proof["proofId"]), "UNBOUND_RUN_PROOF")
    if old:
        ledger.require(old["authorityId"] == authority_id, "AUTHORITY_LINEAGE_CHANGED")
        if old["sourceIdentity"] == identity:
            ledger.require(old["captureDigest"] == capture_digest and old["authoritySequence"] == proof["authoritySequence"],
                           "SOURCE_IDENTITY_CONFLICT")
            revision = old["revision"]
        else:
            ledger.require(proof["authoritySequence"] > old["authoritySequence"], "STALE_SOURCE_AUTHORITY")
            revision = old["revision"] + 1
    else:
        revision = 1
    def page(source, prefix, token):
        ledger.require(source == {"storageResourceId": scope.storage_id, "container": scope.source_container}
                       and prefix == capture.receipt["prefix"] and token is None, "CAPTURE_SCOPE_MISMATCH")
        return {"items": [{"name": name, "sha256": meta["sha256"]} for name, meta in capture.receipt["parts"].items()], "nextToken": None}
    def fetch(source, name, sha, limit):
        ledger.require(source == {"storageResourceId": scope.storage_id, "container": scope.source_container}
                       and name in capture.parts and hashlib.sha256(capture.parts[name]).hexdigest() == sha
                       and len(capture.parts[name]) <= limit, "CAPTURE_CONTENT_MISMATCH")
        return capture.parts[name]
    normalized = ingestion.ingest(ledger.canonical(manifest).encode(), profile=profile, policy=policy, export_id=export_id,
        storage_id=scope.storage_id, root_folder=root, run_prefix=capture.receipt["prefix"], period=period, revision=revision,
        mapping=mapping, list_page=page, fetch_blob=fetch)
    snapshot = normalized["manifest"]["snapshots"][0]
    snapshot["snapshotId"] = ledger.digest({"capture": capture_digest, "normalization": NORMALIZATION})
    record = {"sourceIdentity": identity, "captureDigest": capture_digest, "authorityId": authority_id,
              "authoritySequence": proof["authoritySequence"], "proofId": proof["proofId"], "revision": revision,
              "snapshotId": snapshot["snapshotId"], "receipt": copy.deepcopy(capture.receipt),
              "manifestBase64": base64.b64encode(capture.manifest).decode(), "normalizationProfile": NORMALIZATION}
    return snapshot, record


def verify_retention(retention, store):
    """Explicit aggregate attestation; rechecked immediately before publication CAS."""
    ledger.require(retention is not None, "AGGREGATE_RETENTION_PROOF_REQUIRED")
    capacity = retention.inspect()
    ledger.exact_keys(capacity, ["generation", "totalBytes", "includesVersionsAndTemporaryAndLogs", "verifiedAt"], "INVALID_RETENTION_PROOF")
    now = store.client.utc_now()
    ledger.require(capacity["generation"] == store.generation and type(capacity["totalBytes"]) is int
                   and 0 <= capacity["totalBytes"] <= 1024 ** 3 - MAX_OBJECT_BYTES
                   and capacity["includesVersionsAndTemporaryAndLogs"] is True
                   and timedelta(0) <= now - ledger.utc_time(capacity["verifiedAt"]) <= timedelta(minutes=5), "RETENTION_CAPACITY_UNPROVEN")

def run_once(store, candidates, *, profile, policy, mapping, proof_verifier, authority_id,
             approved_profile_digest, approved_policy_mapping_digest, retention, emit_summary):
    """Publish a bounded run using a fresh trusted UTC clock after source IO.

    candidates are explicit (run_prefix, manifest_name), never selected by listing
    order. A trusted provider-consistent proof authority is required. None ships.
    """
    client = store.client
    client.budget.check()
    ledger.require(policy["expectedSubscriptionId"] == client.scope.subscription
                   and ledger.digest(profile.__dict__) == approved_profile_digest, "UNAPPROVED_RUNTIME_PROFILE")
    ledger.require(ledger.digest({"policy": policy, "mapping": mapping}) == approved_policy_mapping_digest,
                   "UNAPPROVED_POLICY_OR_MAPPING_CONTENT")
    ledger.require(proof_verifier is not None, "PROVIDER_CONSISTENT_RUN_PROOF_REQUIRED")
    ledger.identifier(authority_id, "INVALID_AUTHORITY_ID")
    ledger.require(isinstance(candidates, list) and 1 <= len(candidates) <= 2, "INVALID_RUNTIME_CANDIDATES")
    verify_retention(retention, store)
    captures = [azure.capture_run(client, prefix, name) for prefix, name in candidates]
    outer, tag = store.read_outer()
    now = client.utc_now()  # Never reuse pre-fetch time for eligibility/publication.
    first = now.date().replace(day=1)
    periods = {first.strftime("%Y-%m"), (first - timedelta(days=1)).strftime("%Y-%m")}
    admissions = {k: copy.deepcopy(v) for k, v in (outer["admissions"] if outer else {}).items() if k in periods}
    snapshots, seen = [], set()
    for capture in captures:
        period = ledger.utc_time(normalize_manifest(capture.manifest)["runInfo"]["startDate"]).strftime("%Y-%m")
        ledger.require(period in periods and period not in seen, "DUPLICATE_OR_OUTSIDE_PERIOD")
        seen.add(period)
        snapshot, record = admit_capture(capture, client.scope, profile, policy, mapping, admissions.get(period), proof_verifier, authority_id)
        snapshots.append(snapshot)
        admissions[period] = record
    manifest = {"schemaVersion": 1, "subscriptionId": client.scope.subscription, "costBasis": "ActualCost", "currency": "USD",
                "mappingVersion": policy["mappingVersion"], "snapshots": snapshots}
    client.budget.check()
    result = pipeline.publish(PublicationStore(store, outer, tag, admissions, lambda: verify_retention(retention, store)),
                              manifest, policy, client.utc_now())
    client.budget.check()
    emit_summary(copy.deepcopy(result["summary"]))  # No output before durable CAS/reconciliation.
    return result
