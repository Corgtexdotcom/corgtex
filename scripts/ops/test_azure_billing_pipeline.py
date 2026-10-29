"""Fake durable-store and idempotent-destination fault injection only."""
import copy
import hashlib
import unittest
from datetime import timedelta

import azure_billing_pipeline as pipeline
from test_azure_billing_ledger import NOW, day, manifest, policy, snapshot


class FakeStore:
    def __init__(self):
        self.document, self.version = None, 0
        self.before = None
        self.after = None
        self.conflicts = 0
        self.writes = 0

    def read(self):
        return copy.deepcopy(self.document), str(self.version) if self.document else None

    def compare_and_swap(self, expected_etag, document):
        if self.before:
            callback, self.before = self.before, None
            callback()
        if self.conflicts:
            self.conflicts -= 1
            raise pipeline.Conflict("synthetic competing update")
        if expected_etag != (str(self.version) if self.document else None):
            raise pipeline.Conflict("synthetic stale ETag")
        self.document = copy.deepcopy(document)
        self.version += 1
        self.writes += 1
        if self.after:
            callback, self.after = self.after, None
            callback()
        return str(self.version)


class FakeDelivery:
    def __init__(self):
        self.receipts, self.sent = set(), []
        self.lookup_unknown = False
        self.timeout_after_send = False
        self.on_send = None
        self.lookups = 0

    def lookup(self, event_id):
        self.lookups += 1
        status = "unknown" if self.lookup_unknown else "acknowledged" if event_id in self.receipts else "absent"
        return {"status": status, "eventId": event_id,
                "receiptId": hashlib.sha256(("synthetic-receipt-" + event_id).encode()).hexdigest() if status == "acknowledged" else None}

    def send(self, event_id, event):
        if event_id not in self.receipts:
            self.sent.append(event_id)
            self.receipts.add(event_id)
        if self.on_send: self.on_send()
        if self.timeout_after_send: raise TimeoutError("synthetic response lost")
        return "acknowledged"


def fail():
    raise OSError("synthetic persistence unavailable")


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.store, self.delivery = FakeStore(), FakeDelivery()
        self.source = manifest(snapshot([day("2026-10-20")]))

    def publish(self):
        return pipeline.publish(self.store, self.source, policy(), NOW)

    def event_id(self):
        return next(x["id"] for x in self.store.document["state"]["outbox"] if x["status"] == "pending_no_transport")

    def dispatch(self, owner="worker-a", now=NOW):
        return pipeline.dispatch_one(self.store, self.delivery, self.event_id(), owner, now)

    def test_summary_only_after_durable_commit_and_contains_no_source_rows(self):
        result = self.publish()
        self.assertEqual(result["summary"], self.store.document["summary"])
        self.assertEqual(result["etag"], "1")
        self.assertNotIn("ledger", result["summary"])
        self.assertNotIn("sourceRecordId", str(result["summary"]))
        self.assertEqual(result["summary"]["dataStatus"], "degraded")

    def test_persist_failure_before_commit_has_no_summary_or_delivery(self):
        self.store.before = fail
        with self.assertRaises(OSError): self.publish()
        self.assertIsNone(self.store.document)
        self.assertEqual(self.delivery.sent, [])

    def test_crash_after_commit_is_unknown_and_recoverable_without_loss(self):
        self.store.after = fail
        with self.assertRaises(OSError): self.publish()
        committed = self.store.read()[0]
        self.assertIsNotNone(committed)
        self.assertEqual(self.publish()["summary"]["commitSequence"], 2)
        self.assertEqual(self.store.document["state"], committed["state"])

    def test_overlapping_publish_cas_loser_cannot_replace_winner(self):
        self.store.before = lambda: self.publish()
        with self.assertRaises(pipeline.Conflict): self.publish()
        self.assertEqual(self.store.writes, 1)

    def test_stale_delivery_claim_never_calls_destination(self):
        self.publish()
        self.store.conflicts = 1
        with self.assertRaises(pipeline.Conflict): self.dispatch()
        self.assertEqual(self.delivery.lookups, 0)
        self.assertEqual(self.delivery.sent, [])

    def test_ack_is_idempotent_and_survives_replay(self):
        self.publish()
        event = self.event_id()
        self.assertEqual(self.dispatch(), "acknowledged")
        self.assertEqual(self.dispatch(), "acknowledged")
        self.publish()
        self.assertEqual(self.dispatch(), "acknowledged")
        self.assertEqual(self.delivery.sent, [event])

    def test_timeout_unknown_does_not_blindly_resend_and_lookup_recovers_ack(self):
        self.publish()
        self.delivery.timeout_after_send = True
        self.assertEqual(self.dispatch(), "unknown")
        with self.assertRaises(pipeline.Busy): self.dispatch("worker-b")
        with self.assertRaises(pipeline.Busy): self.publish()
        self.assertEqual(self.dispatch("worker-b", NOW + timedelta(seconds=121)), "acknowledged")
        self.assertEqual(len(self.delivery.sent), 1)
        self.publish()

    def test_unknown_lookup_defers_send_even_after_lease_expiry(self):
        self.publish()
        self.delivery.lookup_unknown = True
        self.assertEqual(self.dispatch(), "unknown")
        self.assertEqual(self.dispatch("worker-b", NOW + timedelta(seconds=121)), "unknown")
        self.assertEqual(self.delivery.sent, [])
        status = pipeline.recovery_status(self.store, NOW + timedelta(seconds=242))
        self.assertEqual(status["status"], "delivery_reconciliation_required")
        self.assertTrue(status["ledgerPublicationBlocked"])
        self.assertTrue(status["pending"][0]["reconciliationDue"])
        self.delivery.lookup_unknown = False
        self.assertEqual(self.dispatch("worker-c", NOW + timedelta(seconds=242)), "acknowledged")
        self.assertFalse(pipeline.recovery_status(self.store, NOW)["ledgerPublicationBlocked"])
        self.publish()

    def test_crash_after_claim_recovers_by_lookup_then_sends_once(self):
        self.publish()
        self.store.after = fail
        with self.assertRaises(OSError): self.dispatch()
        self.assertEqual(self.delivery.sent, [])
        self.assertEqual(self.dispatch("worker-b", NOW + timedelta(seconds=121)), "acknowledged")
        self.assertEqual(len(self.delivery.sent), 1)

    def test_ack_write_failure_recovers_receipt_without_second_send(self):
        self.publish()
        self.delivery.on_send = lambda: setattr(self.store, "before", fail)
        with self.assertRaises(OSError): self.dispatch()
        self.assertEqual(len(self.delivery.sent), 1)
        self.delivery.on_send = None
        self.assertEqual(self.dispatch("worker-b", NOW + timedelta(seconds=121)), "acknowledged")
        self.assertEqual(len(self.delivery.sent), 1)

    def test_ack_cas_retry_does_not_repeat_delivery(self):
        self.publish()
        self.delivery.on_send = lambda: setattr(self.store, "conflicts", 2)
        self.assertEqual(self.dispatch(), "acknowledged")
        self.assertEqual(len(self.delivery.sent), 1)

    def test_inflight_delivery_blocks_correction_commit(self):
        self.publish()
        def correction():
            self.source = manifest(snapshot([day("2026-10-20", [])], revision=2))
            with self.assertRaises(pipeline.Busy): self.publish()
        self.delivery.on_send = correction
        self.dispatch()
        self.publish()
        self.assertEqual(len(self.delivery.sent), 1)

    def test_no_caller_status_transition_can_clear_unknown_without_destination_receipt(self):
        self.publish()
        self.delivery.lookup_unknown = True
        self.dispatch()
        self.assertFalse(hasattr(pipeline, "update_claim"))
        for unsafe in ("cancelled", "acknowledged"):
            with self.assertRaisesRegex(pipeline.ledger.ContractError, "INVALID_RECONCILIATION_MODE"):
                pipeline._record_destination_evidence(self.store, self.delivery, self.event_id(), "worker-a", reconcile=unsafe)
        self.assertEqual(pipeline._record_destination_evidence(self.store, self.delivery, self.event_id(), "worker-a"), "unknown")
        with self.assertRaises(pipeline.Busy): self.publish()
        self.delivery.lookup = lambda event_id: {"status": "acknowledged", "eventId": "wrong-event", "receiptId": "0" * 64}
        with self.assertRaisesRegex(pipeline.ledger.ContractError, "INVALID_DESTINATION_EVIDENCE"):
            pipeline._record_destination_evidence(self.store, self.delivery, self.event_id(), "worker-a")
        self.assertTrue(pipeline.recovery_status(self.store, NOW)["ledgerPublicationBlocked"])

    def test_same_second_correction_has_durable_monotonic_order(self):
        first = self.publish()["summary"]
        self.source = manifest(snapshot([day("2026-10-20", [])], revision=2))
        second = self.publish()["summary"]
        self.assertEqual(first["committedAt"], second["committedAt"])
        self.assertNotEqual(first["commitId"], second["commitId"])
        self.assertEqual((first["commitSequence"], second["commitSequence"]), (1, 2))
        for arrival in ([first, second], [second, first]):
            self.assertEqual(max(arrival, key=lambda x: x["commitSequence"]), second)
        self.assertEqual(self.store.document["commitSequence"], 2)

    def test_downtime_without_publish_never_sends_stale_pending_event(self):
        self.publish()
        self.assertEqual(self.dispatch(now=NOW.replace(year=2027, month=1, day=1)), "ineligible")
        self.assertEqual((self.delivery.sent, self.delivery.lookups, self.store.document["journal"]), ([], 0, {}))

    def test_send_freshness_uses_recorded_policy_and_source_boundary(self):
        for seconds, expected in ((-1, "ineligible"), (3600, "acknowledged"), (3601, "ineligible")):
            with self.subTest(seconds=seconds):
                self.setUp()
                self.source = manifest(snapshot([day("2026-10-20")], exported=NOW.strftime("%Y-%m-%dT%H:%M:%SZ")))
                pipeline.publish(self.store, self.source, dict(policy(), freshnessHours=1), NOW)
                self.assertEqual(self.dispatch(now=NOW + timedelta(seconds=seconds)), expected)
        for seconds, expected in ((33 * 3600, "acknowledged"), (33 * 3600 + 1, "ineligible")):
            self.setUp()
            self.publish()  # Source was exported three hours before publication.
            self.assertEqual(self.dispatch(now=NOW + timedelta(seconds=seconds)), expected)

    def test_current_calendar_window_is_checked_even_with_fresh_publication(self):
        now = NOW.replace(day=31, hour=23)
        source = manifest(snapshot([day("2026-09-30")], period="2026-09", exported=now.strftime("%Y-%m-%dT%H:%M:%SZ")))
        pipeline.publish(self.store, source, policy(), now)
        self.assertEqual(self.dispatch(now=now + timedelta(hours=1)), "ineligible")
        self.assertEqual(self.delivery.sent, [])

    def test_stale_attempted_claim_stays_blocked_but_later_receipt_recovers(self):
        self.publish()
        self.delivery.lookup_unknown = True
        self.dispatch()
        event = self.event_id()
        self.store.document["journal"][event]["attempts"] = 1  # A send may have been in flight.
        later = NOW.replace(year=2027, month=1, day=1)
        self.delivery.lookup_unknown = False
        self.assertEqual(self.dispatch("worker-b", later), "unknown")
        self.assertEqual(self.delivery.sent, [])
        with self.assertRaises(pipeline.Busy): self.publish()
        self.delivery.receipts.add(event)
        self.assertEqual(self.dispatch("worker-c", later + timedelta(seconds=121)), "acknowledged")
        self.assertFalse(pipeline.recovery_status(self.store, later)["ledgerPublicationBlocked"])

    def test_stale_zero_send_claim_retires_only_after_authoritative_absence(self):
        self.publish()
        self.delivery.lookup_unknown = True
        self.assertEqual(self.dispatch(), "unknown")
        later = NOW + timedelta(days=2)
        self.assertEqual(self.dispatch("worker-b", later), "unknown")
        self.assertTrue(pipeline.recovery_status(self.store, later)["ledgerPublicationBlocked"])
        self.delivery.lookup_unknown = False
        self.assertEqual(self.dispatch("worker-c", later + timedelta(seconds=121)), "retired_no_send")
        self.assertEqual(self.delivery.sent, [])
        self.assertFalse(pipeline.recovery_status(self.store, later)["ledgerPublicationBlocked"])
        retired_sequence = self.store.document["commitSequence"]
        self.assertEqual(self.dispatch("delayed-worker", NOW), "retired_no_send")
        self.assertEqual(self.store.document["commitSequence"], retired_sequence)
        self.assertEqual(self.delivery.sent, [])
        republished = later + timedelta(seconds=121)
        self.source = manifest(snapshot([day("2026-10-20")], revision=2, exported=republished.strftime("%Y-%m-%dT%H:%M:%SZ")))
        pipeline.publish(self.store, self.source, policy(), republished)
        self.assertEqual(self.dispatch(now=republished), "acknowledged")  # Fresh republication can admit the intent again.

    def test_retirement_cas_fences_stale_workers_send_reservation(self):
        self.publish()
        original_lookup = self.delivery.lookup
        interrupted = False
        def lookup(event):
            nonlocal interrupted
            if not interrupted:
                interrupted = True
                self.assertEqual(self.dispatch("worker-b", NOW + timedelta(days=2)), "retired_no_send")
            return original_lookup(event)
        self.delivery.lookup = lookup
        with self.assertRaises(pipeline.Conflict): self.dispatch("worker-a")
        self.assertEqual(self.delivery.sent, [])
        self.assertEqual(self.store.document["journal"][self.event_id()]["status"], "retired_no_send")
        self.publish()

    def test_legacy_zero_counter_does_not_prove_no_send_provenance(self):
        self.publish()
        self.delivery.lookup_unknown = True
        self.dispatch()
        document = self.store.document
        document["schemaVersion"] = 1
        document["summary"].pop("freshnessHours")
        document["commitId"] = pipeline.ledger.digest({"state": document["state"], "at": document["committedAt"], "sequence": document["commitSequence"]})
        document["summary"]["commitId"] = document["commitId"]
        self.delivery.lookup_unknown = False
        self.assertEqual(self.dispatch("worker-b", NOW + timedelta(days=2)), "unknown")
        self.assertEqual(self.delivery.sent, [])
        with self.assertRaises(pipeline.Busy): self.publish()

    def test_legacy_unclaimed_pending_event_requires_republication(self):
        self.publish()
        document = self.store.document
        document["schemaVersion"] = 1
        document["summary"].pop("freshnessHours")
        document["commitId"] = pipeline.ledger.digest({"state": document["state"], "at": document["committedAt"], "sequence": document["commitSequence"]})
        document["summary"]["commitId"] = document["commitId"]
        self.assertEqual(self.dispatch(), "ineligible")
        self.assertEqual((self.delivery.sent, self.delivery.lookups), ([], 0))
        self.publish()
        self.assertEqual(self.dispatch(), "acknowledged")

    def test_legacy_v6_budget_cap_cannot_prevent_evidence_only_recovery(self):
        self.publish()
        self.delivery.lookup_unknown = True
        self.dispatch()
        event = self.event_id()
        self.store.document["journal"][event]["attempts"] = 100
        self.delivery.lookup_unknown = False
        self.assertEqual(self.dispatch("worker-b", NOW + timedelta(seconds=121)), "unknown")
        self.assertEqual(self.delivery.sent, [])
        document = self.store.document
        document["schemaVersion"] = 1
        document["summary"].pop("freshnessHours")
        document["commitId"] = pipeline.ledger.digest({"state": document["state"], "at": document["committedAt"], "sequence": document["commitSequence"]})
        document["summary"]["commitId"] = document["commitId"]
        document["journal"][event]["attempts"] = 100
        self.delivery.lookup_unknown = False
        self.assertEqual(self.dispatch("worker-c", NOW + timedelta(seconds=242)), "unknown")
        self.assertEqual(self.delivery.sent, [])
        self.delivery.receipts.add(event)
        self.assertEqual(self.dispatch("worker-d", NOW + timedelta(seconds=363)), "acknowledged")
        self.publish()
        self.assertEqual(self.store.document["schemaVersion"], 2)

    def test_repeated_unknown_lookups_do_not_consume_send_budget(self):
        self.publish()
        self.delivery.lookup_unknown = True
        for attempt in range(101):
            self.assertEqual(self.dispatch(now=NOW + timedelta(seconds=121 * attempt)), "unknown")
        self.assertEqual(self.store.document["journal"][self.event_id()]["attempts"], 0)
        self.delivery.lookup_unknown = False
        self.assertEqual(self.dispatch(now=NOW + timedelta(seconds=121 * 101)), "acknowledged")
        self.assertEqual(self.store.document["journal"][self.event_id()]["attempts"], 1)

    def test_superseded_and_out_of_window_intents_never_delivered(self):
        self.publish()
        old = self.event_id()
        self.source = manifest(snapshot([day("2026-10-20", [])], revision=2))
        self.publish()
        self.assertEqual(pipeline.dispatch_one(self.store, self.delivery, old, "worker-a", NOW), "ineligible")
        pipeline.publish(self.store, manifest(), policy(), NOW.replace(month=12, day=1))
        self.assertEqual(pipeline.dispatch_one(self.store, self.delivery, old, "worker-a", NOW), "ineligible")
        self.assertEqual(self.delivery.sent, [])


if __name__ == "__main__":
    unittest.main()
