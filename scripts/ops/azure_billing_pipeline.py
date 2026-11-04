"""CAS ledger publication and fake-testable outbox protocol; no real store/transport.

A future store must provide linearizable reads, atomic durable conditional writes,
immutable ETags and bounded IO. A future transport must enforce event-ID deduplication
and authoritative lookup. These are acceptance requirements, not implemented Azure IO.
"""
from __future__ import annotations

import copy
from datetime import timedelta
from typing import Protocol

import azure_billing_ledger as ledger

MAX_DOCUMENT_BYTES = 24 * 1024 * 1024
MAX_JOURNAL = 4096
MAX_CAS_RETRIES = 3
LEASE_SECONDS = 120


class Conflict(RuntimeError):
    """CAS lost; no write occurred."""


class Busy(RuntimeError):
    """An outstanding delivery must be reconciled before ledger replacement."""


class Store(Protocol):
    def read(self):
        """Return a detached (document or None, ETag or None)."""

    def compare_and_swap(self, expected_etag, document):
        """Durably write iff ETag matches; return new ETag or raise Conflict.

        Any other exception has an unknown outcome. Never claim rollback on timeout.
        """


class Delivery(Protocol):
    def lookup(self, event_id):
        """Return {status, eventId, receiptId}: acknowledged, authoritative absent, or unknown.

        Acknowledgement must carry an immutable SHA-256 receipt identity scoped to
        the requested event ID; absent/unknown must carry no receipt.

        A real destination must guarantee retries with the same event ID cannot
        produce duplicates, including a send racing a lookup/previous timeout.
        """

    def send(self, event_id, event):
        """Return 'acknowledged' or 'unknown'; timeouts remain unknown."""


def validate(document):
    if document is None:
        return None
    ledger.exact_keys(document, ["schemaVersion", "commitId", "commitSequence", "committedAt", "state", "summary", "journal"], "INVALID_DURABLE_DOCUMENT")
    ledger.require(type(document["schemaVersion"]) is int and document["schemaVersion"] in (1, 2) and isinstance(document["commitId"], str)
                   and ledger.DIGEST.fullmatch(document["commitId"]), "INVALID_COMMIT_ID")
    ledger.utc_time(document["committedAt"])
    ledger.require(type(document["commitSequence"]) is int and 1 <= document["commitSequence"] <= 9_000_000_000_000_000,
                   "INVALID_COMMIT_SEQUENCE")
    ledger.previous_contract(document["state"])
    commit = {"state": document["state"], "at": document["committedAt"], "sequence": document["commitSequence"]}
    ledger.require(isinstance(document["summary"], dict), "INVALID_DURABLE_SUMMARY")
    if document["schemaVersion"] == 2:
        freshness = document["summary"].get("freshnessHours")
        ledger.require(type(freshness) is int and 1 <= freshness <= 36, "INVALID_DISPATCH_FRESHNESS")
        commit["freshnessHours"] = freshness
    ledger.require(document["commitId"] == ledger.digest(commit), "DURABLE_COMMIT_MISMATCH")
    ledger.require(isinstance(document["summary"], dict) and isinstance(document["journal"], dict)
                   and len(document["journal"]) <= MAX_JOURNAL, "INVALID_DELIVERY_JOURNAL")
    ledger.require(document["summary"].get("commitSequence") == document["commitSequence"]
                   and document["summary"].get("commitId") == document["commitId"]
                   and document["summary"].get("committedAt") == document["committedAt"], "DURABLE_SUMMARY_MISMATCH")
    for event_id, item in document["journal"].items():
        ledger.require(isinstance(event_id, str) and ledger.DIGEST.fullmatch(event_id), "INVALID_EVENT_ID")
        ledger.exact_keys(item, ["status", "owner", "leaseUntil", "attempts", "receiptId"]
                          + (["retiredAtCommitSequence"] if item.get("status") == "retired_no_send" else []),
                          "INVALID_DELIVERY_ENTRY")
        ledger.require(item["status"] in ("claimed", "unknown", "acknowledged", "retired_no_send")
                       and type(item["attempts"]) is int and 0 <= item["attempts"] <= 100, "INVALID_DELIVERY_ENTRY")
        ledger.require((item["status"] == "acknowledged" and isinstance(item["receiptId"], str)
                        and ledger.DIGEST.fullmatch(item["receiptId"]))
                       or (item["status"] != "acknowledged" and item["receiptId"] is None), "INVALID_DELIVERY_RECEIPT")
        ledger.require(item["status"] != "retired_no_send" or document["schemaVersion"] == 2
                       and item["attempts"] == 0 and type(item.get("retiredAtCommitSequence")) is int
                       and 1 <= item["retiredAtCommitSequence"] <= document["commitSequence"],
                       "UNPROVEN_NO_SEND_RETIREMENT")
        ledger.identifier(item["owner"], "INVALID_DELIVERY_OWNER")
        ledger.utc_time(item["leaseUntil"])
    ledger.require(len(ledger.canonical(document).encode()) <= MAX_DOCUMENT_BYTES, "DURABLE_CAPACITY_EXCEEDED")
    return document


def eligible(state, event_id):
    event = next((x for x in state["outbox"] if x["id"] == event_id), None)
    current = state["evaluations"].get(event["subject"]) if event else None
    if (event and event["status"] == "pending_no_transport" and current
            and current["sequence"] == event["sequence"] and current["value"] == event["current"]
            and event_id == ledger.digest({"subject": event["subject"], "sequence": event["sequence"],
                "policy": state["policyFingerprint"], "evaluation": current["fingerprint"]})):
        return event
    return None


def fresh_for_send(document, event, now):
    """V6 envelopes lack admitted freshness; only evidence recovery is allowed."""
    if event is None or document["schemaVersion"] != 2:
        return False
    limit = timedelta(hours=document["summary"]["freshnessHours"])
    committed = ledger.utc_time(document["committedAt"])
    first = now.date().replace(day=1)
    window_start = (first - timedelta(days=1)).replace(day=1)
    event_date = ledger.utc_date(event["current"]["date"])
    if not (window_start <= event_date <= now.date() and timedelta(0) <= now - committed <= limit):
        return False
    # A fresh correction may truthfully report unknown data; positive/known-low
    # claims additionally require their source snapshot to remain fresh now.
    if event["current"]["qualifies"] or event["current"].get("belowThreshold"):
        source = document["state"]["snapshots"].get(event_date.strftime("%Y-%m"))
        return source is not None and timedelta(0) <= now - ledger.utc_time(source["exportedAt"]) <= limit
    return True


def publish(store, manifest, policy, now):
    """Evaluate once, conditionally persist, then return a sanitized summary.

    Caller may emit the returned summary only after this function returns. A lost
    or uncertain CAS returns no summary. Crash after persistence is recovered by
    reading the stored commit; it must not be described as failed persistence.
    """
    document, etag = store.read()
    document = validate(document)
    if document and any(x["status"] in ("claimed", "unknown") for x in document["journal"].values()):
        raise Busy("DELIVERY_RECONCILIATION_REQUIRED")
    result = ledger.evaluate(manifest, policy, now, document["state"] if document else None)
    committed = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    sequence = document["commitSequence"] + 1 if document else 1
    commit_id = ledger.digest({"state": result["state"], "at": committed, "sequence": sequence,
                               "freshnessHours": policy["freshnessHours"]})
    mature = [x for x in result["ledger"] if x["mature"]]
    latest = max((x["date"] for x in mature), default=None)
    latest_rows = [x for x in mature if x["date"] == latest]
    summary = {"event": "corgtex.billing.summary", "schemaVersion": 1, "commitId": commit_id,
               "committedAt": committed, "commitSequence": sequence, "policyVersion": policy["version"], "mappingVersion": policy["mappingVersion"],
               "provisional": True, "dataStatus": result["dataQuality"]["status"], "latestMatureDate": latest,
               "belowThresholdCount": sum(x["belowThreshold"] for x in latest_rows),
               "unknownCount": sum(bool(x["observationBlockers"]) for x in latest_rows),
               "delivery": "injected_protocol_only", "freshnessHours": policy["freshnessHours"]}
    next_document = {"schemaVersion": 2, "commitId": commit_id, "commitSequence": sequence, "committedAt": committed,
                     "state": result["state"], "summary": summary,
                     "journal": copy.deepcopy(document["journal"]) if document else {}}
    validate(next_document)
    new_etag = store.compare_and_swap(etag, next_document)
    return {"etag": new_etag, "summary": summary}


def destination_evidence(delivery, event_id):
    """Only the injected destination can supply a scoped acknowledgement receipt."""
    try:
        evidence = delivery.lookup(event_id)
    except TimeoutError:
        evidence = {"status": "unknown", "eventId": event_id, "receiptId": None}
    ledger.exact_keys(evidence, ["status", "eventId", "receiptId"], "INVALID_DESTINATION_EVIDENCE")
    ledger.require(evidence["eventId"] == event_id and evidence["status"] in ("acknowledged", "absent", "unknown"),
                   "INVALID_DESTINATION_EVIDENCE")
    if evidence["status"] == "acknowledged":
        ledger.require(isinstance(evidence["receiptId"], str) and ledger.DIGEST.fullmatch(evidence["receiptId"]),
                       "INVALID_DESTINATION_RECEIPT")
    else:
        ledger.require(evidence["receiptId"] is None, "UNACKNOWLEDGED_RECEIPT")
    return evidence


def _record_destination_evidence(store, delivery, event_id, owner, *, reconcile=True):
    """No status/ack argument. Acknowledgement requires destination lookup evidence.

    reconcile=False can only preserve uncertainty after a timed-out send.
    """
    ledger.require(type(reconcile) is bool, "INVALID_RECONCILIATION_MODE")
    evidence = destination_evidence(delivery, event_id) if reconcile else {
        "status": "unknown", "eventId": event_id, "receiptId": None}
    status = "acknowledged" if evidence["status"] == "acknowledged" else "unknown"
    for _ in range(MAX_CAS_RETRIES):
        document, etag = store.read()
        validate(document)
        item = document["journal"].get(event_id) if document else None
        ledger.require(item is not None, "MISSING_DELIVERY_CLAIM")
        if item["status"] in ("acknowledged", "retired_no_send"):
            return item["status"]
        if item["owner"] != owner:
            raise Busy("DELIVERY_OWNER_CHANGED")
        item["status"] = status
        item["receiptId"] = evidence["receiptId"] if status == "acknowledged" else None
        validate(document)
        try:
            store.compare_and_swap(etag, document)
            return status
        except Conflict:
            continue
    raise Conflict("ACK_CAS_RETRIES_EXHAUSTED")


def dispatch_one(store, delivery, event_id, owner, now):
    """Claim, reconcile unknown history, send by stable ID, and persist outcome.

    No dispatcher is configured by the templates. Unknown IO exceptions propagate;
    the durable claim remains recoverable. A lease is a recovery guard, not an
    exactly-once guarantee. Downstream idempotency is a mandatory dependency.
    """
    ledger.identifier(owner, "INVALID_DELIVERY_OWNER")
    ledger.require(now.utcoffset() == timedelta(0), "UTC_NOW_REQUIRED")
    document, etag = store.read()
    validate(document)
    ledger.require(document is not None, "NO_DURABLE_LEDGER")
    event = eligible(document["state"], event_id)
    existing = document["journal"].get(event_id)
    if existing and existing["status"] == "acknowledged":
        return "acknowledged"
    if existing and existing["status"] == "retired_no_send" and (
            document["commitSequence"] <= existing["retiredAtCommitSequence"] or not fresh_for_send(document, event, now)):
        return "retired_no_send"
    if not existing and not fresh_for_send(document, event, now):
        return "ineligible"
    if existing and existing["status"] in ("claimed", "unknown") and ledger.utc_time(existing["leaseUntil"]) > now:
        raise Busy("DELIVERY_LEASE_ACTIVE")
    attempts = existing["attempts"] if existing else 0
    ledger.require(event_id in document["journal"] or len(document["journal"]) < MAX_JOURNAL,
                   "DELIVERY_CAPACITY_EXCEEDED")
    document["journal"][event_id] = {"status": "claimed", "owner": owner, "attempts": attempts,
        "receiptId": None, "leaseUntil": (now + timedelta(seconds=LEASE_SECONDS)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    validate(document)
    claimed_etag = store.compare_and_swap(etag, document)  # A CAS loser never calls the destination.
    # Always reconcile before a send, even for a first claim. No blind timeout retry.
    observed = destination_evidence(delivery, event_id)["status"]
    if observed == "acknowledged":
        return _record_destination_evidence(store, delivery, event_id, owner)
    if observed == "unknown":
        return _record_destination_evidence(store, delivery, event_id, owner, reconcile=False)
    if not fresh_for_send(document, event, now) and document["schemaVersion"] == 2 and attempts == 0:
        # Only v7-created zero-send claims are proven safe: the absent lookup is
        # event-bound, and this CAS fences every older worker's send reservation.
        # Legacy schema 1 (even a zero counter) cannot establish that provenance.
        document["journal"][event_id]["status"] = "retired_no_send"
        document["journal"][event_id]["retiredAtCommitSequence"] = document["commitSequence"]
        validate(document)
        store.compare_and_swap(claimed_etag, document)
        return "retired_no_send"
    if not fresh_for_send(document, event, now) or attempts >= 100:
        # Authoritative absence cannot fence an old in-flight send. Keep unknown;
        # even stale/capped claims can later reconcile an acknowledgement.
        return _record_destination_evidence(store, delivery, event_id, owner, reconcile=False)
    # Reserve only an actual send attempt, durably, before contacting destination.
    document["journal"][event_id]["attempts"] += 1
    validate(document)
    store.compare_and_swap(claimed_etag, document)
    # Publish is blocked while claimed, so evaluation cannot change under this send.
    try:
        outcome = delivery.send(event_id, copy.deepcopy(event))
    except TimeoutError:
        outcome = "unknown"
    ledger.require(outcome in ("acknowledged", "unknown"), "INVALID_DELIVERY_OUTCOME")
    return _record_destination_evidence(store, delivery, event_id, owner, reconcile=outcome == "acknowledged")


def recovery_status(store, now):
    """Read-only diagnostic; blocked unknown delivery is never silently healthy."""
    ledger.require(now.utcoffset() == timedelta(0), "UTC_NOW_REQUIRED")
    document, _ = store.read()
    validate(document)
    pending = [] if document is None else [
        {"eventId": key, "status": item["status"], "reconciliationDue": ledger.utc_time(item["leaseUntil"]) <= now}
        for key, item in sorted(document["journal"].items()) if item["status"] in ("claimed", "unknown")]
    return {"status": "delivery_reconciliation_required" if pending else "idle",
            "ledgerPublicationBlocked": bool(pending), "pending": pending}
