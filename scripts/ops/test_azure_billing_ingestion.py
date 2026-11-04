"""Synthetic CSV/manifest fixtures; never imports real billing/customer data."""
import copy
import csv
import hashlib
import io
import json
import unittest
from dataclasses import replace

import azure_billing_ingestion as ingestion
import azure_billing_ledger as ledger
from test_azure_billing_ledger import NOW, SUBSCRIPTION, policy

EXPORT = f"/subscriptions/{SUBSCRIPTION}/providers/Microsoft.CostManagement/exports/corgtex-actualcost-mtd"
STORAGE = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/synthetic/providers/Microsoft.Storage/storageAccounts/synthetic"
PREFIX = "mtd/synthetic/run-1"
HEADERS = ("SubscriptionId", "Date", "ConsumedService", "BillingCurrency", "CostInBillingCurrency", "MeterCategory")
PROFILE = ingestion.CsvProfile("synthetic-mca-v1", "2023-05-01", HEADERS, "SubscriptionId", "Date",
                               "ConsumedService", "BillingCurrency", "CostInBillingCurrency", None, "MeterCategory")


def csv_bytes(rows, headers=HEADERS):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(headers)
    writer.writerows(rows)
    return stream.getvalue().encode()


def fixture():
    rows = [[SUBSCRIPTION, "2026-10-20", "Example.Compute", "USD", "1.125", "compute"],
            [SUBSCRIPTION, "2026-10-20", "Example.Compute", "USD", "1.125", "compute"],
            [SUBSCRIPTION, "2026-10-20", "Example.Adjustment", "USD", "-0.000000000000000001", "unallocated"]]
    parts = {f"{PREFIX}/part0.csv": csv_bytes(rows[:2]), f"{PREFIX}/part1.csv": csv_bytes(rows[2:])}
    manifest = {"manifestVersion": "2024-04-01", "byteCount": sum(map(len, parts.values())), "blobCount": 2,
        "dataRowCount": 3, "exportConfig": {"exportName": "corgtex-actualcost-mtd", "resourceId": EXPORT, "dataVersion": "2023-05-01",
        "apiVersion": "2025-03-01", "type": "ActualCost", "timeFrame": "MonthToDate", "granularity": "Daily"},
        "deliveryConfig": {"partitionData": True, "dataOverwriteBehavior": "OverwritePreviousReport", "fileFormat": "Csv",
        "compressionMode": "None", "containerUri": STORAGE, "rootFolderPath": "mtd"},
        "runInfo": {"executionType": "Scheduled", "submittedTime": "2026-10-29T09:00:00Z", "runId": "run-1",
        "startDate": "2026-10-01T00:00:00Z", "endDate": "2026-10-28T00:00:00Z"},
        "blobs": [{"blobName": name, "byteCount": len(raw), "dataRowCount": 2 if name.endswith("part0.csv") else 1}
                  for name, raw in parts.items()]}
    return manifest, parts


class IngestionTests(unittest.TestCase):
    def setUp(self):
        self.manifest, self.parts = fixture()
        self.pages = None
        self.fetch_calls = []

    def run_ingest(self, **overrides):
        def list_page(source, prefix, token):
            self.assertEqual(source, {"storageResourceId": STORAGE, "container": "billing-exports"})
            self.assertEqual(prefix, PREFIX)
            if self.pages:
                return self.pages[0 if token is None else 1]
            return {"items": [{"name": name, "sha256": hashlib.sha256(raw).hexdigest()} for name, raw in self.parts.items()],
                    "nextToken": None}
        def fetch(source, name, sha, limit):
            self.assertEqual(source, {"storageResourceId": STORAGE, "container": "billing-exports"})
            self.fetch_calls.append(name)
            self.assertLessEqual(limit, ingestion.MAX_EXPORT_BYTES + 1)
            return self.parts[name]
        args = dict(profile=PROFILE, policy=policy(), export_id=EXPORT, storage_id=STORAGE, root_folder="mtd", run_prefix=PREFIX,
                    period="2026-10", revision=1, mapping={"compute": "service-1"}, list_page=list_page, fetch_blob=fetch)
        args.update(overrides)
        return ingestion.ingest(json.dumps(self.manifest).encode(), **args)

    def replace_part(self, index, raw, rows):
        part = self.manifest["blobs"][index]
        self.parts[part["blobName"]] = raw
        part["byteCount"], part["dataRowCount"] = len(raw), rows
        self.manifest["byteCount"] = sum(x["byteCount"] for x in self.manifest["blobs"])
        self.manifest["dataRowCount"] = sum(x["dataRowCount"] for x in self.manifest["blobs"])

    def test_all_parts_exact_reconciliation_duplicates_refund_and_no_finality(self):
        result = self.run_ingest()
        self.assertEqual(result["reconciliation"]["rawUsd"], "2.249999999999999999")
        self.assertEqual(result["reconciliation"]["mappedUsd"], "2.25")
        self.assertEqual(result["reconciliation"]["unallocatedUsd"], "-0.000000000000000001")
        day = result["manifest"]["snapshots"][0]["days"][0]
        self.assertFalse(day["finalized"])
        self.assertEqual(len({r["sourceRecordId"] for r in day["records"]}), 3)
        self.assertTrue(all(r["serviceName"] is None for r in day["records"]))
        evaluated = ledger.evaluate(result["manifest"], policy(), NOW)
        entry = next(x for x in evaluated["ledger"] if x["date"] == "2026-10-20" and x["serviceId"] == "service-1")
        self.assertEqual(entry["netUsd"], "2.25")
        self.assertFalse(entry["confirmed"])

    def test_page_and_part_order_do_not_change_snapshot(self):
        expected = self.run_ingest()
        entries = [{"name": n, "sha256": hashlib.sha256(b).hexdigest()} for n, b in reversed(list(self.parts.items()))]
        self.pages = [{"items": entries[:1], "nextToken": "second"}, {"items": entries[1:], "nextToken": None}]
        self.manifest["blobs"].reverse()
        # Manifest order is admitted source evidence, so hash normalizes it explicitly.
        actual = self.run_ingest()
        self.assertEqual(expected["manifest"], actual["manifest"])

    def test_repeated_token_and_duplicate_inventory_fail_before_fetch(self):
        self.pages = [{"items": [], "nextToken": "loop"}, {"items": [], "nextToken": "loop"}]
        with self.assertRaisesRegex(ledger.ContractError, "REPEATED_OR_INVALID_PAGE_TOKEN"):
            self.run_ingest()
        self.assertEqual(self.fetch_calls, [])
        name, raw = next(iter(self.parts.items()))
        item = {"name": name, "sha256": hashlib.sha256(raw).hexdigest()}
        self.pages = [{"items": [item, item], "nextToken": None}]
        with self.assertRaisesRegex(ledger.ContractError, "DUPLICATE_OR_UNSCOPED_PART"):
            self.run_ingest()

    def test_missing_extra_duplicate_and_path_escape_parts(self):
        for mutation in ("missing", "extra", "duplicate", "escape"):
            with self.subTest(mutation=mutation):
                self.setUp()
                if mutation == "missing": self.parts.pop(next(iter(self.parts)))
                if mutation == "extra": self.parts[PREFIX + "/extra.csv"] = b"x"
                if mutation == "duplicate": self.manifest["blobs"][1] = copy.deepcopy(self.manifest["blobs"][0])
                if mutation == "escape": self.manifest["blobs"][0]["blobName"] = "mtd/../secret.csv"
                with self.assertRaises(ledger.ContractError): self.run_ingest()

    def test_manifest_count_and_byte_mismatch(self):
        for key in ("blobCount", "byteCount", "dataRowCount"):
            with self.subTest(key=key):
                self.setUp()
                self.manifest[key] += 1
                with self.assertRaises(ledger.ContractError): self.run_ingest()

    def test_download_hash_and_byte_mismatch(self):
        name = next(iter(self.parts))
        with self.assertRaisesRegex(ledger.ContractError, "PART_BYTE_MISMATCH"):
            self.run_ingest(fetch_blob=lambda *_: b"x")
        with self.assertRaisesRegex(ledger.ContractError, "PART_HASH_MISMATCH"):
            self.run_ingest(fetch_blob=lambda *_: b"x" * len(self.parts[name]))

    def test_header_each_partition_extra_column_repeated_header_and_partial_rows(self):
        invalid = [b"Wrong,Header\n", csv_bytes([list(HEADERS)]), csv_bytes([["partial"]]),
                   csv_bytes([[SUBSCRIPTION, "2026-10-20", "P", "USD", "1", "compute", "extra"]]),
                   b'"SubscriptionId\n']
        for raw in invalid:
            with self.subTest(raw=raw[:20]):
                self.setUp()
                self.replace_part(1, raw, 1)
                with self.assertRaises(ledger.ContractError): self.run_ingest()

    def test_wrong_scope_schema_actualcost_currency_date_and_money_fail_closed(self):
        for column, value in ((0, "wrong"), (1, "2026-11-01"), (1, "10/20/2026"), (3, "EUR"),
                              (4, "1e3"), (4, "NaN"), (4, "0.1234567890123456789")):
            with self.subTest(column=column, value=value):
                self.setUp()
                row = [SUBSCRIPTION, "2026-10-20", "P", "USD", "1", "compute"]
                row[column] = value
                self.replace_part(1, csv_bytes([row]), 1)
                with self.assertRaises(ledger.ContractError): self.run_ingest()
        for section, field, value in (("exportConfig", "type", "AmortizedCost"), ("exportConfig", "dataVersion", "future"),
                                      ("exportConfig", "resourceId", EXPORT + "other"), ("runInfo", "submittedTime", "2026-10-29T09:00:00")):
            self.setUp()
            self.manifest[section][field] = value
            with self.assertRaises(ledger.ContractError): self.run_ingest()

    def test_profile_is_explicit_and_mapping_cannot_double_count(self):
        with self.assertRaisesRegex(ledger.ContractError, "INVALID_PROFILE_HEADERS"):
            self.run_ingest(profile=replace(PROFILE, headers=HEADERS + (HEADERS[0],)))
        with self.assertRaisesRegex(ledger.ContractError, "UNKNOWN_MAPPED_SERVICE"):
            self.run_ingest(mapping={"compute": ["service-1", "service-2"]})
        with self.assertRaisesRegex(ledger.ContractError, "INVALID_PROFILE_ROLES"):
            self.run_ingest(profile=replace(PROFILE, service_name="ServiceName"))

    def test_timeframe_month_and_exact_export_root_authority_are_bound(self):
        self.manifest["exportConfig"]["timeFrame"] = "TheLastMonth"
        with self.assertRaisesRegex(ledger.ContractError, "TIMEFRAME_AUTHORITY_MISMATCH"):
            self.run_ingest()
        self.setUp()
        self.manifest["runInfo"]["submittedTime"] = "2026-11-01T09:00:00Z"
        with self.assertRaisesRegex(ledger.ContractError, "TIMEFRAME_AUTHORITY_MISMATCH"):
            self.run_ingest()
        self.setUp()
        prior = EXPORT.replace("-mtd", "-prior-month")
        with self.assertRaisesRegex(ledger.ContractError, "EXPORT_ROOT_AUTHORITY_MISMATCH"):
            self.run_ingest(export_id=prior)

    def test_prior_month_admits_exact_root_and_complete_month_only(self):
        prior = EXPORT.replace("-mtd", "-prior-month")
        prefix = "prior-month/synthetic/run-1"
        self.manifest["exportConfig"].update(exportName="corgtex-actualcost-prior-month", resourceId=prior, timeFrame="TheLastMonth")
        self.manifest["deliveryConfig"]["rootFolderPath"] = "prior-month"
        self.manifest["runInfo"].update(submittedTime="2026-11-01T09:00:00Z", endDate="2026-10-31T00:00:00Z")
        parts = {name.replace(PREFIX, prefix): raw for name, raw in self.parts.items()}
        for part in self.manifest["blobs"]:
            part["blobName"] = part["blobName"].replace(PREFIX, prefix)
        args = dict(export_id=prior, root_folder="prior-month", run_prefix=prefix,
                    list_page=lambda *_: {"items": [{"name": n, "sha256": hashlib.sha256(b).hexdigest()} for n, b in parts.items()], "nextToken": None},
                    fetch_blob=lambda source, name, sha, limit: parts[name])
        self.assertEqual(self.run_ingest(**args)["reconciliation"]["rows"], 3)
        self.manifest["runInfo"]["endDate"] = "2026-10-28T00:00:00Z"
        with self.assertRaisesRegex(ledger.ContractError, "INCOMPLETE_PRIOR_MONTH_WINDOW"):
            self.run_ingest(**args)

    def test_service_name_cannot_alias_amount_or_other_semantic_role(self):
        for header in ("CostInBillingCurrency", "ConsumedService", "BillingCurrency", "MeterCategory"):
            with self.subTest(header=header):
                with self.assertRaisesRegex(ledger.ContractError, "INVALID_PROFILE_ROLES"):
                    self.run_ingest(profile=replace(PROFILE, service_name=header))
        headers = HEADERS + ("ServiceName",)
        self.replace_part(0, csv_bytes([[SUBSCRIPTION, "2026-10-20", "P", "USD", "1", "compute", "Explicit source name"]], headers), 1)
        self.replace_part(1, csv_bytes([], headers), 0)
        result = self.run_ingest(profile=replace(PROFILE, headers=headers, service_name="ServiceName"))
        self.assertEqual(result["manifest"]["snapshots"][0]["days"][0]["records"][0]["serviceName"], "Explicit source name")

    def test_empty_partition_does_not_invent_zero_day(self):
        self.replace_part(0, csv_bytes([]), 0)
        self.replace_part(1, csv_bytes([]), 0)
        result = self.run_ingest()
        self.assertEqual(result["manifest"]["snapshots"][0]["days"], [])
        self.assertEqual(result["reconciliation"]["rows"], 0)
        self.assertEqual(ledger.evaluate(result["manifest"], policy(), NOW)["dataQuality"]["status"], "degraded")


if __name__ == "__main__":
    unittest.main()
