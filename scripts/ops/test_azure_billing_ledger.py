"""Synthetic-only contract tests. No provider, billing data, credentials or transport."""

import copy
import calendar
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import azure_billing_ledger as ledger

NOW = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)
SERVICES = [f"service-{number}" for number in range(1, 7)]
SUBSCRIPTION = "00000000-0000-4000-8000-000000000001"


def policy():
    return {"version": "provisional-v1", "provisional": True, "mappingVersion": "synthetic-map-v1",
            "expectedSubscriptionId": SUBSCRIPTION,
            "services": list(SERVICES), "minimumQualifyingServices": 6,
            "thresholdUsd": "1.00", "maturityHours": 72, "freshnessHours": 36}


def row(service, charge="1.00", suffix="", name="Synthetic service"):
    return {"sourceRecordId": f"{service}{suffix}", "serviceId": service,
            "provider": "Example.Compute", "serviceName": name, "chargeUsd": charge}


def day(value, rows=None, finalized=True):
    rows = rows if rows is not None else [row(service) for service in SERVICES]
    rows = [{**item, "sourceRecordId": value + "-" + item["sourceRecordId"]} for item in rows]
    return {"date": value, "finalized": finalized,
            "finalizationEvidence": "synthetic-finalization-assertion" if finalized else None, "records": rows}


def snapshot(days, period="2026-10", revision=1, complete=True, exported="2026-10-29T09:00:00Z"):
    return {"period": period, "snapshotId": hashlib.sha256(f"synthetic-{period}-{revision}".encode()).hexdigest(),
            "revision": revision, "exportedAt": exported, "ingestionComplete": complete,
            "completenessEvidence": "synthetic-part-validation" if complete else None, "days": days}


def manifest(*snapshots):
    return {"schemaVersion": 1, "subscriptionId": SUBSCRIPTION, "costBasis": "ActualCost", "currency": "USD",
            "mappingVersion": "synthetic-map-v1", "snapshots": list(snapshots)}


def entry(result, value, service="service-1"):
    return next(item for item in result["ledger"] if item["date"] == value and item["serviceId"] == service)


def full_month(period, revision, exported):
    year, month = map(int, period.split("-"))
    return snapshot([day(f"{period}-{number:02d}") for number in range(1, calendar.monthrange(year, month)[1] + 1)],
                    period=period, revision=revision, exported=exported)


class BillingLedgerTests(unittest.TestCase):
    def run_engine(self, source, rule=None, previous=None, now=NOW):
        return ledger.evaluate(source, rule or policy(), now, previous)

    def test_exact_amount_classes_and_offsets_are_distinct(self):
        rows = [row("service-1", "0"), row("service-2", "1", "-charge"),
                row("service-2", "-1", "-refund"), row("service-4", "0.999999999999999999"),
                row("service-5", "0.999999999999999999", "-a"),
                row("service-5", "0.000000000000000001", "-b"), row("service-6", "-2")]
        result = self.run_engine(manifest(snapshot([day("2026-10-20", rows)])))
        expected = ["explicit_zero", "net_zero", "no_matching_records", "below_threshold", "qualifying", "below_threshold"]
        for service, classification in zip(SERVICES, expected):
            self.assertEqual(entry(result, "2026-10-20", service)["amountClass"], classification)
        self.assertEqual(entry(result, "2026-10-20", "service-5")["netUsd"], "1")
        self.assertTrue(entry(result, "2026-10-20", "service-5")["qualifies"])
        self.assertFalse(entry(result, "2026-10-20")["qualifies"])
        self.assertEqual(result["providerView"][0]["netUsd"], "-0.000000000000000001")

    def test_absent_day_is_not_a_zero_or_matching_record(self):
        result = self.run_engine(manifest(snapshot([day("2026-10-20", [])])))
        self.assertEqual(entry(result, "2026-10-19")["amountClass"], "missing")
        self.assertIsNone(entry(result, "2026-10-19")["netUsd"])
        self.assertEqual(entry(result, "2026-10-20")["amountClass"], "no_matching_records")
        self.assertIsNone(entry(result, "2026-10-20")["netUsd"])
        self.assertFalse(entry(result, "2026-10-20")["confirmed"])
        self.assertEqual(result["dataQuality"]["status"], "degraded")
        self.assertIn("missing_export", [issue["code"] for issue in result["dataQuality"]["issues"]])

    def test_old_complete_export_does_not_establish_finality_or_hide_provisional_alerts(self):
        result = self.run_engine(manifest(snapshot([day("2026-10-20", finalized=False),
                                                  day("2026-10-21", finalized=False)])))
        item = entry(result, "2026-10-21")
        self.assertEqual(item["consecutiveDays"], {"observed": 2, "mature": 2, "confirmed": 0})
        self.assertTrue(item["qualifies"])
        self.assertFalse(item["confirmed"])
        self.assertIn("unfinalized_day", item["blockers"])
        self.assertTrue(result["newPendingIntents"])
        self.assertEqual(result["finalizationAuthority"], "upstream_assertion_not_verified")

    def test_maturity_boundary_uses_end_of_utc_day(self):
        source = manifest(snapshot([day("2026-10-25")], exported="2026-10-28T12:00:00Z"))
        before = self.run_engine(source, now=ledger.utc_time("2026-10-28T23:59:59Z"))
        at = self.run_engine(source, now=ledger.utc_time("2026-10-29T00:00:00Z"))
        self.assertTrue(entry(before, "2026-10-25")["basisQualifies"]["observed"])
        self.assertFalse(entry(before, "2026-10-25")["basisQualifies"]["mature"])
        self.assertTrue(entry(at, "2026-10-25")["basisQualifies"]["mature"])

    def test_provisional_maturity_contract_is_exactly_72_hours(self):
        for value in [True, 71, 73, 744]:
            with self.subTest(value=value), self.assertRaisesRegex(ledger.ContractError, "INVALID_MATURITY"):
                self.run_engine(manifest(), {**policy(), "maturityHours": value})

    def test_missing_and_unfinalized_days_do_not_bridge_confirmed_streak(self):
        result = self.run_engine(manifest(snapshot([day("2026-10-20"),
            day("2026-10-21", finalized=False), day("2026-10-22"), day("2026-10-24")])))
        self.assertEqual(entry(result, "2026-10-22")["consecutiveDays"], {"observed": 3, "mature": 3, "confirmed": 1})
        self.assertEqual(entry(result, "2026-10-24")["consecutiveDays"], {"observed": 1, "mature": 1, "confirmed": 1})

    def test_six_of_more_than_six_services_is_supported_without_unknown_service_bridging(self):
        rule = policy()
        rule["services"].append("service-7")
        result = self.run_engine(manifest(snapshot([day("2026-10-20"),
            day("2026-10-21", [row(service) for service in SERVICES[1:] + ["service-7"]])])), rule)
        item = next(item for item in result["simultaneousServiceDays"] if item["date"] == "2026-10-20")
        self.assertTrue(item["qualifies"])
        self.assertEqual(item["qualifyingServices"]["mature"], 6)
        self.assertEqual(entry(result, "2026-10-20", "service-7")["amountClass"], "no_matching_records")
        rotated = next(item for item in result["simultaneousServiceDays"] if item["date"] == "2026-10-21")
        self.assertTrue(rotated["qualifies"])
        self.assertEqual(rotated["consecutiveDays"]["mature"], 2)

    def test_duplicate_mapping_targets_and_source_records_are_rejected(self):
        rule = policy()
        rule["services"][1] = rule["services"][0]
        with self.assertRaisesRegex(ledger.ContractError, "DUPLICATE_SERVICE_ID"):
            self.run_engine(manifest(), rule)
        rows = [row("service-1"), {**row("service-2"), "sourceRecordId": "service-1"}]
        with self.assertRaisesRegex(ledger.ContractError, "DUPLICATE_SOURCE_RECORD"):
            self.run_engine(manifest(snapshot([day("2026-10-20", rows)])))

    def test_provider_and_service_name_views_count_once_and_preserve_unavailable(self):
        rows = [row("service-1", "1.25", name=None), row("service-2", "2.50"),
                {**row("service-3", "3.75"), "provider": "Example.Storage"}]
        result = self.run_engine(manifest(snapshot([day("2026-10-20", rows)])))
        self.assertEqual(result["providerView"][0]["netUsd"], "3.75")
        self.assertEqual({item["serviceName"]: item["netUsd"] for item in result["serviceNameView"]},
                         {None: "1.25", "Synthetic service": "6.25"})
        self.assertFalse(next(item for item in result["serviceNameView"] if item["serviceName"] is None)["available"])
        self.assertEqual(len(result["providerServiceNameView"]), 3)
        self.assertEqual(sum(ledger.money(item["netUsd"]) for item in result["providerServiceNameView"]),
                         ledger.money("7.50"))

    def test_incomplete_or_stale_export_is_not_qualified(self):
        for item in [snapshot([day("2026-10-20")], complete=False),
                     snapshot([day("2026-10-20")], exported="2026-10-27T23:59:59Z")]:
            result = self.run_engine(manifest(item))
            self.assertFalse(entry(result, "2026-10-20")["qualifies"])
            self.assertFalse(result["newPendingIntents"])
            self.assertTrue({"incomplete_export", "stale_export"} &
                            {issue["code"] for issue in result["dataQuality"]["issues"]})
        exact = self.run_engine(manifest(snapshot([day("2026-10-20")], exported="2026-10-28T00:00:00Z")))
        self.assertTrue(entry(exact, "2026-10-20")["qualifies"])

    def test_same_replay_is_idempotent_and_new_snapshot_same_charges_does_not_duplicate_alerts(self):
        source = manifest(snapshot([day("2026-10-20")]))
        first = self.run_engine(source)
        second = self.run_engine(source, previous=first["state"])
        self.assertEqual(second["newPendingIntents"], [])
        self.assertEqual(second["state"], first["state"])
        replacement = manifest(snapshot([day("2026-10-20")], revision=2, exported="2026-10-29T10:00:00Z"))
        third = self.run_engine(replacement, previous=second["state"])
        self.assertEqual(third["newPendingIntents"], [])
        self.assertEqual(third["state"]["outbox"], first["state"]["outbox"])

    def test_replacement_refund_recomputes_streak_and_only_marks_pending_correction(self):
        first = self.run_engine(manifest(snapshot([day("2026-10-20"), day("2026-10-21")])))
        replacement = [day("2026-10-20", [row(service, "1", "-charge") for service in SERVICES]
                           + [row("service-1", "-1", "-refund")]), day("2026-10-21")]
        second = self.run_engine(manifest(snapshot(replacement, revision=2)), previous=first["state"])
        self.assertEqual(entry(second, "2026-10-20")["amountClass"], "net_zero")
        self.assertEqual(entry(second, "2026-10-21")["consecutiveDays"]["mature"], 1)
        correction = next(item for item in second["newPendingIntents"] if item["subject"] == "service:service-1:2026-10-20")
        self.assertEqual(correction["kind"], "correction_pending")
        self.assertEqual(correction["status"], "pending_no_transport")
        self.assertEqual(second["delivery"], "not_configured")
        self.assertTrue(any(item["status"] == "superseded" for item in second["state"]["outbox"]))
        replay = self.run_engine(manifest(snapshot(replacement, revision=2)), previous=second["state"])
        self.assertEqual(replay["newPendingIntents"], [])

    def test_previous_month_late_correction_recomputes_cross_month_streak(self):
        prior = snapshot([day("2026-09-30")], period="2026-09")
        current = snapshot([day("2026-10-01")])
        first = self.run_engine(manifest(prior, current))
        self.assertEqual(entry(first, "2026-10-01")["consecutiveDays"]["mature"], 2)
        corrected = snapshot([day("2026-09-30", [row(service, "0") for service in SERVICES])],
                             period="2026-09", revision=2)
        second = self.run_engine(manifest(current, corrected), previous=first["state"])
        self.assertEqual(entry(second, "2026-10-01")["consecutiveDays"]["mature"], 1)
        self.assertEqual(len(second["previousEvaluation"]["values"]), len(first["state"]["evaluations"]))

    def test_snapshot_day_and_record_order_do_not_change_results(self):
        source = manifest(snapshot([day("2026-09-30")], period="2026-09"),
                          snapshot([day("2026-10-20"), day("2026-10-21")]))
        first = self.run_engine(source)
        shuffled = copy.deepcopy(source)
        shuffled["snapshots"].reverse()
        for snap in shuffled["snapshots"]:
            snap["days"].reverse()
            for item in snap["days"]:
                item["records"].reverse()
        second = self.run_engine(shuffled, previous=first["state"])
        self.assertEqual(second["state"], first["state"])
        self.assertEqual(second["newPendingIntents"], [])

    def test_stale_conflicting_and_reordered_revisions_fail(self):
        first = self.run_engine(manifest(snapshot([day("2026-10-20")], revision=2)))
        for source, code in [
            (manifest(snapshot([day("2026-10-20")], revision=1)), "STALE_REVISION"),
            (manifest(snapshot([day("2026-10-20", [])], revision=2)), "REVISION_CONFLICT"),
            (manifest(snapshot([day("2026-10-20")], revision=3, exported="2026-10-29T08:00:00Z")),
             "REVISION_ORDER_CONFLICT"),
        ]:
            with self.subTest(code=code), self.assertRaisesRegex(ledger.ContractError, code):
                self.run_engine(source, previous=first["state"])
        missing = self.run_engine(manifest(), previous=first["state"])
        with self.assertRaisesRegex(ledger.ContractError, "STALE_REVISION"):
            self.run_engine(manifest(snapshot([day("2026-10-20")], revision=1)), previous=missing["state"])

    def test_mapping_revision_preserves_source_identity_and_previous_evaluation(self):
        rule = policy()
        rule["services"].append("service-7")
        source = manifest(snapshot([day("2026-10-20")]))
        first = self.run_engine(source, rule)
        changed = copy.deepcopy(source)
        changed["snapshots"][0]["days"][0]["records"][0]["serviceId"] = "service-7"
        with self.assertRaisesRegex(ledger.ContractError, "MAPPING_REVISION_CONFLICT"):
            self.run_engine(changed, rule, first["state"])
        new_rule = {**rule, "version": "provisional-v2", "mappingVersion": "synthetic-map-v2"}
        changed["mappingVersion"] = new_rule["mappingVersion"]
        second = self.run_engine(changed, new_rule, first["state"])
        self.assertTrue(entry(second, "2026-10-20", "service-7")["qualifies"])
        self.assertEqual(entry(second, "2026-10-20")["amountClass"], "no_matching_records")
        self.assertEqual(second["previousEvaluation"]["policyFingerprint"], first["state"]["policyFingerprint"])

    def test_snapshot_conflicts_and_invalid_evidence_fail_closed(self):
        source = snapshot([day("2026-10-20")])
        with self.assertRaisesRegex(ledger.ContractError, "DUPLICATE_OR_OUTSIDE_PERIOD"):
            self.run_engine(manifest(source, source))
        prior = snapshot([day("2026-09-30")], period="2026-09")
        prior["snapshotId"] = source["snapshotId"]
        with self.assertRaisesRegex(ledger.ContractError, "DUPLICATE_SNAPSHOT_ID"):
            self.run_engine(manifest(prior, source))
        for key in ["completenessEvidence"]:
            invalid = copy.deepcopy(source)
            invalid[key] = None
            with self.assertRaises(ledger.ContractError):
                self.run_engine(manifest(invalid))
        invalid = copy.deepcopy(source)
        invalid["days"][0]["finalizationEvidence"] = None
        with self.assertRaisesRegex(ledger.ContractError, "FINALIZATION_EVIDENCE_REQUIRED"):
            self.run_engine(manifest(invalid))

    def test_currency_basis_and_schema_are_strict(self):
        for key, value in [("currency", "EUR"), ("costBasis", "AmortizedCost"), ("schemaVersion", 2), ("schemaVersion", True),
                           ("mappingVersion", "unknown")]:
            source = manifest()
            source[key] = value
            with self.subTest(key=key), self.assertRaises(ledger.ContractError):
                self.run_engine(source)
        source = manifest()
        source["unexpected"] = True
        with self.assertRaisesRegex(ledger.ContractError, "INVALID_MANIFEST"):
            self.run_engine(source)

    def test_decimal_precision_exponent_nonfinite_and_float_bounds(self):
        for value in [1.0, "NaN", "Infinity", "-Infinity", "1e999", "1e-999", "1E0",
                      "0.0000000000000000001", "1000000000000000000", "+1", " 1", "01"]:
            with self.subTest(value=value), self.assertRaises(ledger.ContractError):
                ledger.money(value)
        self.assertEqual(ledger.decimal_text(ledger.money("999999999999999999.999999999999999999")),
                         "999999999999999999.999999999999999999")
        self.assertEqual(ledger.decimal_text(ledger.money("-0.000")), "0")

    def test_json_and_resource_bounds(self):
        for raw in [b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1.0}', b'{"x":1e900}', b'{' ]:
            with self.subTest(raw=raw), self.assertRaises(ledger.ContractError):
                ledger.parse_json_bytes(raw)
        with patch.object(ledger, "MAX_INPUT_BYTES", 10), self.assertRaisesRegex(ledger.ContractError, "INPUT_TOO_LARGE"):
            ledger.parse_json_bytes(b" " * 11)
        source = manifest(snapshot([day("2026-10-20")]))
        with patch.object(ledger, "MAX_RECORDS", 5), self.assertRaisesRegex(ledger.ContractError, "TOO_MANY_RECORDS"):
            self.run_engine(source)
        with patch.object(ledger, "MAX_OUTPUT_BYTES", 10), self.assertRaisesRegex(ledger.ContractError, "OUTPUT_CAPACITY_EXCEEDED"):
            self.run_engine(source)
        with patch.object(ledger.time, "monotonic", side_effect=[0, 541]), self.assertRaisesRegex(ledger.ContractError, "DEADLINE_EXCEEDED"):
            self.run_engine(source)

    def test_outbox_cannot_claim_delivery_and_input_state_is_not_mutated(self):
        first = self.run_engine(manifest(snapshot([day("2026-10-20")])))
        before = copy.deepcopy(first["state"])
        self.run_engine(manifest(), previous=first["state"])
        self.assertEqual(first["state"], before)
        invalid = copy.deepcopy(before)
        invalid["outbox"][0]["status"] = "sent"
        with self.assertRaisesRegex(ledger.ContractError, "UNSUPPORTED_DELIVERY_STATE"):
            self.run_engine(manifest(), previous=invalid)

    def test_malformed_previous_revision_is_a_safe_contract_failure(self):
        first = self.run_engine(manifest(snapshot([day("2026-10-20")])))
        for value in [None, True, "1", -1]:
            invalid = copy.deepcopy(first["state"])
            invalid["snapshots"]["2026-10"]["revision"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ledger.ContractError, "INVALID_PREVIOUS_REVISION"):
                self.run_engine(manifest(), previous=invalid)

    def test_initial_below_zero_and_offset_zero_create_distinct_pending_intents(self):
        cases = [
            [row("service-1", "0.50")],
            [row("service-1", "0")],
            [row("service-1", "1", "-charge"), row("service-1", "-1", "-refund")],
        ]
        for rows in cases:
            with self.subTest(rows=rows):
                source = manifest(snapshot([day("2026-10-20", rows, finalized=False)]))
                first = self.run_engine(source)
                intents = [item for item in first["newPendingIntents"] if item["subject"] == "service:service-1:2026-10-20"]
                self.assertEqual(len(intents), 1)
                self.assertEqual(intents[0]["kind"], "below_threshold_pending")
                self.assertTrue(intents[0]["current"]["belowThreshold"])
                self.assertFalse(intents[0]["current"]["confirmed"])
                self.assertEqual(self.run_engine(source, previous=first["state"])["newPendingIntents"], [])

    def test_alert_transitions_both_directions_preserve_pending_history(self):
        first = self.run_engine(manifest(snapshot([day("2026-10-20")])))
        low_source = manifest(snapshot([day("2026-10-20", [row(service, "0.5") for service in SERVICES])], revision=2))
        second = self.run_engine(low_source, previous=first["state"])
        low = next(item for item in second["newPendingIntents"] if item["subject"] == "service:service-1:2026-10-20")
        self.assertEqual(low["kind"], "correction_pending")
        self.assertTrue(low["current"]["belowThreshold"])
        third = self.run_engine(manifest(snapshot([day("2026-10-20")], revision=3)), previous=second["state"])
        high = next(item for item in third["newPendingIntents"] if item["subject"] == low["subject"])
        self.assertEqual(high["kind"], "correction_pending")
        self.assertTrue(high["current"]["qualifies"])
        self.assertFalse(high["current"]["belowThreshold"])
        self.assertEqual({item["status"] for item in third["state"]["outbox"]},
                         {"pending_no_transport", "superseded"})

    def test_unknown_or_immature_amounts_never_generate_initial_below_alert(self):
        for snap in [snapshot([day("2026-10-20", [])]),
                     snapshot([day("2026-10-20", [row("service-1", "0")])], complete=False),
                     snapshot([day("2026-10-20", [row("service-1", "0")])], exported="2026-10-27T00:00:00Z"),
                     snapshot([day("2026-10-28", [row("service-1", "0")])])]:
            result = self.run_engine(manifest(snap))
            self.assertFalse(result["newPendingIntents"])

    def test_month_rollover_preserves_long_streak_and_retained_window_corrections(self):
        oct_end = ledger.utc_time("2026-10-31T12:00:00Z")
        first = self.run_engine(manifest(full_month("2026-09", 1, "2026-10-31T09:00:00Z"),
                                         full_month("2026-10", 1, "2026-10-31T09:00:00Z")), now=oct_end)
        self.assertEqual(entry(first, "2026-10-27")["consecutiveDays"]["mature"], 57)
        nov_start = ledger.utc_time("2026-11-01T12:00:00Z")
        october = full_month("2026-10", 2, "2026-11-01T09:00:00Z")
        second = self.run_engine(manifest(october), previous=first["state"], now=nov_start)
        self.assertEqual(entry(second, "2026-10-27")["consecutiveDays"]["mature"], 57)
        self.assertEqual(entry(second, "2026-10-28")["consecutiveDays"]["mature"], 58)
        combined = next(item for item in second["simultaneousServiceDays"] if item["date"] == "2026-10-27")
        self.assertEqual(combined["consecutiveDays"]["mature"], 57)
        self.assertEqual(second["state"]["carry"]["through"], "2026-09-30")
        self.assertLessEqual(len(second["state"]["carry"]["evaluations"]), 7)
        repeated = self.run_engine(manifest(october), previous=second["state"], now=nov_start)
        self.assertEqual(repeated["state"], second["state"])
        nov_end = ledger.utc_time("2026-11-30T12:00:00Z")
        third = self.run_engine(manifest(full_month("2026-10", 3, "2026-11-30T09:00:00Z"),
                                         full_month("2026-11", 1, "2026-11-30T09:00:00Z")),
                                previous=second["state"], now=nov_end)
        december = ledger.utc_time("2026-12-01T12:00:00Z")
        november = full_month("2026-11", 2, "2026-12-01T09:00:00Z")
        fourth = self.run_engine(manifest(november), previous=third["state"], now=december)
        self.assertEqual(entry(fourth, "2026-11-27")["consecutiveDays"]["mature"], 88)
        combined = next(item for item in fourth["simultaneousServiceDays"] if item["date"] == "2026-11-27")
        self.assertEqual(combined["consecutiveDays"]["mature"], 88)
        corrected = full_month("2026-11", 3, "2026-12-01T10:00:00Z")
        corrected["days"][0] = day("2026-11-01", [row(service, "0") for service in SERVICES])
        fifth = self.run_engine(manifest(corrected), previous=fourth["state"], now=december)
        self.assertEqual(entry(fifth, "2026-11-27")["consecutiveDays"]["mature"], 26)

    def test_year_rollover_preserves_streak_and_unknown_or_changed_policy_does_not_invent_carry(self):
        now = ledger.utc_time("2026-12-31T12:00:00Z")
        source = manifest(full_month("2026-11", 1, "2026-12-31T09:00:00Z"),
                          full_month("2026-12", 1, "2026-12-31T09:00:00Z"))
        first = self.run_engine(source, now=now)
        january = ledger.utc_time("2027-01-01T12:00:00Z")
        december = full_month("2026-12", 2, "2027-01-01T09:00:00Z")
        second = self.run_engine(manifest(december), previous=first["state"], now=january)
        self.assertEqual(entry(second, "2026-12-27")["consecutiveDays"]["mature"], 57)
        unknown = copy.deepcopy(source)
        unknown["snapshots"][0]["days"] = unknown["snapshots"][0]["days"][:-1]
        unknown_first = self.run_engine(unknown, now=now)
        unknown_second = self.run_engine(manifest(december), previous=unknown_first["state"], now=january)
        self.assertEqual(entry(unknown_second, "2026-12-27")["consecutiveDays"]["mature"], 27)
        new_policy = {**policy(), "version": "provisional-v2", "mappingVersion": "synthetic-map-v2"}
        remapped = manifest(december)
        remapped["mappingVersion"] = new_policy["mappingVersion"]
        changed = self.run_engine(remapped, new_policy, first["state"], now=january)
        self.assertEqual(changed["state"]["carry"]["evaluations"], {})
        self.assertEqual(entry(changed, "2026-12-27")["consecutiveDays"]["mature"], 27)

    def test_expired_pending_intents_are_superseded_without_deletion_or_delivery_claim(self):
        source = manifest(snapshot([day("2026-09-20")], period="2026-09"))
        first = self.run_engine(source)
        self.assertEqual(len(first["state"]["outbox"]), 7)
        second = self.run_engine(manifest(), previous=first["state"], now=ledger.utc_time("2026-11-01T12:00:00Z"))
        self.assertEqual({item["status"] for item in second["state"]["outbox"]}, {"superseded"})
        self.assertEqual(len(second["state"]["outbox"]), 7)
        self.assertEqual(second["newPendingIntents"], [])
        self.assertEqual(second["delivery"], "not_configured")

    def test_subscription_binding_rejects_unexpected_or_reused_state_scope(self):
        other = "00000000-0000-4000-8000-000000000002"
        source = manifest()
        source["subscriptionId"] = other
        with self.assertRaisesRegex(ledger.ContractError, "SUBSCRIPTION_MISMATCH"):
            self.run_engine(source)
        for value in ["not-a-guid", "00000000-0000-0000-0000-000000000000", None]:
            invalid = manifest()
            invalid["subscriptionId"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ledger.ContractError, "INVALID_SUBSCRIPTION_ID"):
                self.run_engine(invalid)
        first = self.run_engine(manifest(snapshot([day("2026-10-20")])))
        with self.assertRaisesRegex(ledger.ContractError, "PREVIOUS_SUBSCRIPTION_MISMATCH"):
            self.run_engine(source, {**policy(), "expectedSubscriptionId": other}, first["state"])

    def test_two_legitimate_equal_dimension_rows_are_not_deduplicated(self):
        rows = [row("service-1", "0.60", "-a"), row("service-1", "0.60", "-b")]
        result = self.run_engine(manifest(snapshot([day("2026-10-20", rows)])))
        self.assertEqual(entry(result, "2026-10-20")["matchingRecords"], 2)
        self.assertEqual(entry(result, "2026-10-20")["netUsd"], "1.2")
        self.assertTrue(entry(result, "2026-10-20")["qualifies"])
        self.assertEqual(result["providerView"][0]["netUsd"], "1.2")

    def test_unallocated_adjustments_are_retained_without_assigning_them_to_a_service(self):
        rows = [row("service-1", "1"), row(None, "-0.30", "-adjustment", name=None)]
        result = self.run_engine(manifest(snapshot([day("2026-10-20", rows)])))
        self.assertEqual(entry(result, "2026-10-20")["netUsd"], "1")
        self.assertEqual(result["providerView"][0]["netUsd"], "0.7")
        self.assertEqual(result["unallocatedView"][0]["netUsd"], "-0.3")
        self.assertEqual(result["unallocatedView"][0]["matchingRecords"], 1)

    def test_leap_day_is_a_distinct_utc_day_with_exact_maturity(self):
        source = manifest(snapshot([day("2028-02-28"), day("2028-02-29")], period="2028-02",
                                   exported="2028-03-03T12:00:00Z"))
        before = self.run_engine(source, now=ledger.utc_time("2028-03-03T23:59:59Z"))
        at = self.run_engine(source, now=ledger.utc_time("2028-03-04T00:00:00Z"))
        self.assertFalse(entry(before, "2028-02-29")["basisQualifies"]["mature"])
        self.assertEqual(entry(at, "2028-02-29")["consecutiveDays"]["mature"], 2)
        with self.assertRaisesRegex(ledger.ContractError, "INVALID_DATE"):
            ledger.utc_date("2027-02-29")

    def test_same_source_under_distinct_maps_has_independent_eighteen_vs_one_day_result(self):
        days = []
        for number in range(8, 26):
            rows = [{**row(service), "provider": "Example.Shared" if number < 25 else f"Example.{service}",
                     "serviceName": f"Synthetic name {service}"} for service in SERVICES]
            days.append(day(f"2026-10-{number:02d}", rows))
        source = manifest(snapshot(days))
        first = self.run_engine(source)
        first_day = next(item for item in first["simultaneousServiceDays"] if item["date"] == "2026-10-25")
        self.assertEqual(first_day["consecutiveDays"]["mature"], 18)
        remapped = copy.deepcopy(source)
        for item in remapped["snapshots"][0]["days"]:
            if item["date"] != "2026-10-25":
                for record in item["records"]:
                    record["serviceId"] = "service-1"
        new_rule = {**policy(), "version": "provisional-v2", "mappingVersion": "synthetic-provider-v2"}
        remapped["mappingVersion"] = new_rule["mappingVersion"]
        second = self.run_engine(remapped, new_rule, first["state"])
        second_day = next(item for item in second["simultaneousServiceDays"] if item["date"] == "2026-10-25")
        self.assertEqual(second_day["consecutiveDays"]["mature"], 1)
        self.assertEqual(second["providerView"], first["providerView"])
        self.assertEqual(second["state"]["carry"]["evaluations"], {})

    def test_unknown_seventh_service_is_coverage_issue_without_disqualifying_any_six(self):
        rule = policy()
        rule["services"].append("service-7")
        october = full_month("2026-10", 1, "2026-10-29T09:00:00Z")
        october["days"] = october["days"][:29]
        result = self.run_engine(manifest(full_month("2026-09", 1, "2026-10-29T09:00:00Z"), october), rule)
        self.assertEqual(result["dataQuality"]["status"], "degraded")
        issue = next(item for item in result["dataQuality"]["issues"]
                     if item["code"] == "unmatched_configured_service_days")
        self.assertEqual(issue["count"], 59)
        self.assertEqual(issue["matureCount"], 55)
        combined = next(item for item in result["simultaneousServiceDays"] if item["date"] == "2026-10-20")
        self.assertTrue(combined["qualifies"])
        unknown = entry(result, "2026-10-20", "service-7")
        self.assertIsNone(unknown["netUsd"])
        self.assertFalse(unknown["belowThreshold"])
        self.assertFalse(any(item["subject"].startswith("service:service-7:")
                             for item in result["newPendingIntents"]))

    def test_cli_schema_failure_is_safe_and_preserves_previous_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text('{"privateValue":"do-not-echo"}')
            (root / "policy.json").write_text(json.dumps(policy()))
            state_path = root / "state.json"
            state_path.write_text(json.dumps(ledger.empty_state()))
            before = state_path.read_bytes()
            result = subprocess.run([sys.executable, str(Path(ledger.__file__)), "--manifest", str(root / "manifest.json"),
                                     "--policy", str(root / "policy.json"), "--previous-state", str(state_path),
                                     "--now", "2026-10-29T12:00:00Z"], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertNotIn("do-not-echo", result.stderr)
            self.assertEqual(json.loads(result.stderr)["code"], "INVALID_MANIFEST")
            self.assertEqual(state_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
