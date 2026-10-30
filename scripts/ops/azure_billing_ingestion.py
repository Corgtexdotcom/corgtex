"""Offline CSV/manifest admission with injected, bounded source reads only.

No Azure SDK, HTTP, credentials, discovery, invoice-finality inference or live
schema defaults. Profiles and immutable part hashes require an approved adapter.
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal, localcontext

import azure_billing_ledger as ledger

MAX_PARTS = 64
MAX_PAGES = 64
MAX_EXPORT_BYTES = 8 * 1024 * 1024
MAX_COLUMNS = 128
MAX_CELL = 4096


@dataclass(frozen=True)
class CsvProfile:
    """Explicit schema snapshot; no inferred aliases or optional ignored columns."""
    profile_id: str
    data_version: str
    headers: tuple[str, ...]
    subscription: str
    date: str
    provider: str
    currency: str
    amount: str
    service_name: str | None
    mapping_column: str

    def validate(self):
        ledger.identifier(self.profile_id, "INVALID_PROFILE_ID")
        ledger.require(self.data_version == "2023-05-01", "UNSUPPORTED_DATA_VERSION")
        ledger.require(isinstance(self.headers, tuple) and 1 <= len(self.headers) <= MAX_COLUMNS
                       and len(set(self.headers)) == len(self.headers), "INVALID_PROFILE_HEADERS")
        for header in self.headers:
            ledger.label(header, "INVALID_PROFILE_HEADER")
        roles = [self.subscription, self.date, self.provider, self.currency, self.amount]
        ledger.require(len(set(roles)) == len(roles) and all(x in self.headers for x in roles)
                       and self.mapping_column in self.headers
                       and (self.service_name is None or self.service_name == "ServiceName"
                           and self.service_name in self.headers and self.service_name not in roles), "INVALID_PROFILE_ROLES")


def blob_path(value):
    ledger.require(isinstance(value, str) and len(value) <= 1024
                   and re.fullmatch(r"[A-Za-z0-9._/-]+", value)
                   and all(x not in ("", ".", "..") for x in value.split("/")), "INVALID_BLOB_PATH")
    return value


def count(value, maximum, code):
    ledger.require(type(value) is int and 0 <= value <= maximum, code)
    return value


def inventory(list_page, source, prefix):
    """list_page(source, prefix, token) -> {items:[{name,sha256}], nextToken:str|None}.

    Listing and hashes must describe a single immutable run, not a mutable prefix.
    The future network implementation must enforce request deadlines/byte limits.
    """
    parts, tokens, token = {}, set(), None
    for _ in range(MAX_PAGES):
        page = list_page(source, prefix, token)
        ledger.exact_keys(page, ["items", "nextToken"], "INVALID_PAGE")
        ledger.require(isinstance(page["items"], list) and len(page["items"]) <= MAX_PARTS, "INVALID_PAGE_ITEMS")
        for item in page["items"]:
            ledger.exact_keys(item, ["name", "sha256"], "INVALID_PART_IDENTITY")
            name = blob_path(item["name"])
            ledger.require(name.startswith(prefix + "/") and name not in parts, "DUPLICATE_OR_UNSCOPED_PART")
            ledger.require(isinstance(item["sha256"], str) and ledger.DIGEST.fullmatch(item["sha256"]), "INVALID_PART_HASH")
            parts[name] = item["sha256"]
            ledger.require(len(parts) <= MAX_PARTS, "TOO_MANY_PARTS")
        token = page["nextToken"]
        if token is None:
            return parts
        ledger.require(isinstance(token, str) and 0 < len(token) <= 1024 and token not in tokens,
                       "REPEATED_OR_INVALID_PAGE_TOKEN")
        tokens.add(token)
    raise ledger.ContractError("PAGE_LIMIT_EXCEEDED")


def ingest(raw_manifest, *, profile, policy, export_id, storage_id, root_folder,
           run_prefix, period, revision, mapping, list_page, fetch_blob):
    """Return a normalized single-period manifest and an exact reconciliation.

    fetch_blob(source, name, expected_sha256, max_bytes) returns bytes from an immutable
    version. Injected IO is intentionally mandatory. No trusted Azure profile is
    shipped. revision is a monotonic admitted source revision, never list order.
    All represented days remain unfinalized. Missing dates remain unknown.
    """
    services, _ = ledger.policy_contract(policy)
    profile.validate()
    ledger.require(isinstance(mapping, dict) and len(mapping) <= 512, "INVALID_MAPPING")
    for key, service in mapping.items():
        ledger.label(key, "INVALID_MAPPING_KEY")
        ledger.require(service in services, "UNKNOWN_MAPPED_SERVICE")
    # A dict is one exact-value mapping in one view: each row has at most one owner.
    subscription = policy["expectedSubscriptionId"]
    ledger.require(isinstance(export_id, str) and re.fullmatch(
        rf"/subscriptions/{subscription}/providers/Microsoft.CostManagement/exports/[A-Za-z0-9_-]+", export_id),
        "INVALID_EXPORT_SCOPE")
    ledger.require(isinstance(storage_id, str) and re.fullmatch(
        rf"/subscriptions/{subscription}/resourceGroups/[A-Za-z0-9._-]+/providers/Microsoft.Storage/storageAccounts/[a-z0-9]+",
        storage_id), "INVALID_STORAGE_SCOPE")
    blob_path(root_folder)
    blob_path(run_prefix)
    ledger.require(root_folder in ("mtd", "prior-month") and run_prefix.startswith(root_folder + "/"), "RUN_PREFIX_OUTSIDE_ROOT")
    approved_name = {"mtd": "corgtex-actualcost-mtd", "prior-month": "corgtex-actualcost-prior-month"}[root_folder]
    ledger.require(export_id == f"/subscriptions/{subscription}/providers/Microsoft.CostManagement/exports/{approved_name}",
                   "EXPORT_ROOT_AUTHORITY_MISMATCH")
    ledger.require(isinstance(period, str) and re.fullmatch(r"\d{4}-\d{2}", period), "INVALID_PERIOD")
    period_start = ledger.utc_date(period + "-01")
    count(revision, 1_000_000, "INVALID_REVISION")
    ledger.require(revision > 0, "INVALID_REVISION")
    manifest = ledger.parse_json_bytes(raw_manifest)
    ledger.exact_keys(manifest, ["manifestVersion", "byteCount", "blobCount", "dataRowCount", "exportConfig",
                                 "deliveryConfig", "runInfo", "blobs"], "INVALID_EXPORT_MANIFEST")
    ledger.require(manifest["manifestVersion"] == "2024-04-01", "UNSUPPORTED_MANIFEST_VERSION")
    config = manifest["exportConfig"]
    ledger.exact_keys(config, ["exportName", "resourceId", "dataVersion", "apiVersion", "type", "timeFrame", "granularity"],
                      "INVALID_EXPORT_CONFIG")
    ledger.require(config["resourceId"] == export_id and config["exportName"] == export_id.rsplit("/", 1)[1]
                   and config["dataVersion"] == profile.data_version and config["apiVersion"] == "2025-03-01"
                   and config["type"] == "ActualCost" and config["granularity"] == "Daily"
                   and config["timeFrame"] in ("MonthToDate", "TheLastMonth"), "EXPORT_PROFILE_MISMATCH")
    delivery = manifest["deliveryConfig"]
    ledger.exact_keys(delivery, ["partitionData", "dataOverwriteBehavior", "fileFormat", "compressionMode", "containerUri",
                               "rootFolderPath"], "INVALID_DELIVERY_CONFIG")
    ledger.require(delivery["partitionData"] is True and delivery == {"partitionData": True, "dataOverwriteBehavior": "OverwritePreviousReport", "fileFormat": "Csv",
                               "compressionMode": "None", "containerUri": storage_id, "rootFolderPath": root_folder},
                   "DELIVERY_PROFILE_MISMATCH")
    run = manifest["runInfo"]
    ledger.exact_keys(run, ["executionType", "submittedTime", "runId", "startDate", "endDate"], "INVALID_RUN")
    ledger.require(run["executionType"] in ("Scheduled", "OnDemand"), "INVALID_EXECUTION_TYPE")
    ledger.identifier(run["runId"], "INVALID_RUN_ID")
    submitted = ledger.utc_time(run["submittedTime"])
    submitted_month = submitted.date().replace(day=1)
    prior_end = submitted_month - timedelta(days=1)
    expected_month = submitted_month if root_folder == "mtd" else prior_end.replace(day=1)
    expected_timeframe = "MonthToDate" if root_folder == "mtd" else "TheLastMonth"
    ledger.require(config["timeFrame"] == expected_timeframe and period_start == expected_month, "TIMEFRAME_AUTHORITY_MISMATCH")
    start, end = ledger.utc_time(run["startDate"]), ledger.utc_time(run["endDate"])
    ledger.require(start.date() == period_start and start.hour == start.minute == start.second == 0
                   and start <= end <= submitted and end.date().strftime("%Y-%m") == period,
                   "INVALID_RUN_WINDOW")
    ledger.require(root_folder == "mtd" or end.date() == prior_end, "INCOMPLETE_PRIOR_MONTH_WINDOW")
    expected_bytes = count(manifest["byteCount"], MAX_EXPORT_BYTES, "EXPORT_TOO_LARGE")
    expected_rows = count(manifest["dataRowCount"], ledger.MAX_RECORDS, "TOO_MANY_RECORDS")
    expected_parts = count(manifest["blobCount"], MAX_PARTS, "TOO_MANY_PARTS")
    ledger.require(isinstance(manifest["blobs"], list) and 1 <= expected_parts == len(manifest["blobs"]), "PART_COUNT_MISMATCH")
    described = {}
    for part in manifest["blobs"]:
        ledger.exact_keys(part, ["blobName", "byteCount", "dataRowCount"], "INVALID_PART")
        name = blob_path(part["blobName"])
        ledger.require(name.startswith(run_prefix + "/") and name.endswith(".csv") and name not in described,
                       "DUPLICATE_OR_UNSCOPED_PART")
        count(part["byteCount"], MAX_EXPORT_BYTES, "PART_TOO_LARGE")
        count(part["dataRowCount"], ledger.MAX_RECORDS, "PART_TOO_MANY_ROWS")
        described[name] = part
    ledger.require(sum(x["byteCount"] for x in described.values()) == expected_bytes
                   and sum(x["dataRowCount"] for x in described.values()) == expected_rows, "MANIFEST_TOTAL_MISMATCH")
    source = {"storageResourceId": storage_id, "container": "billing-exports"}
    found = inventory(list_page, source, run_prefix)
    ledger.require(set(found) == set(described), "MISSING_OR_EXTRA_PART")
    days, byte_total, row_total = {}, 0, 0
    raw_total = mapped_total = unallocated_total = Decimal(0)
    with localcontext() as context:
        context.prec = 80
        for name, part in sorted(described.items()):
            raw = fetch_blob(source, name, found[name], part["byteCount"] + 1)
            ledger.require(isinstance(raw, bytes) and len(raw) == part["byteCount"], "PART_BYTE_MISMATCH")
            ledger.require(hashlib.sha256(raw).hexdigest() == found[name], "PART_HASH_MISMATCH")
            byte_total += len(raw)
            try:
                reader = csv.reader(io.StringIO(raw.decode("utf-8"), newline=""), strict=True)
                ledger.require(tuple(next(reader, [])) == profile.headers, "CSV_HEADER_MISMATCH")
                rows = 0
                for ordinal, cells in enumerate(reader, 1):
                    ledger.require(len(cells) == len(profile.headers) and tuple(cells) != profile.headers
                                   and all(len(x) <= MAX_CELL and all(ord(c) >= 32 for c in x) for x in cells), "MALFORMED_CSV_ROW")
                    rows += 1
                    row_total += 1
                    ledger.require(rows <= part["dataRowCount"] and row_total <= ledger.MAX_RECORDS, "ROW_COUNT_MISMATCH")
                    row = dict(zip(profile.headers, cells))
                    ledger.require(row[profile.subscription] == subscription and row[profile.currency] == "USD", "ROW_SCOPE_OR_CURRENCY_MISMATCH")
                    date = ledger.utc_date(row[profile.date])
                    ledger.require(start.date() <= date <= end.date(), "ROW_DATE_OUTSIDE_RUN")
                    amount = ledger.money(row[profile.amount])
                    provider = ledger.label(row[profile.provider], "INVALID_PROVIDER")
                    service_name = ledger.label(row[profile.service_name], "INVALID_SERVICE_NAME") if profile.service_name else None
                    service = mapping.get(row[profile.mapping_column])
                    raw_total += amount
                    if service is None:
                        unallocated_total += amount
                    else:
                        mapped_total += amount
                    source_id = ledger.digest({"export": export_id, "run": run["runId"], "part": name,
                                               "hash": found[name], "ordinal": ordinal})
                    days.setdefault(date.isoformat(), []).append({"sourceRecordId": source_id, "serviceId": service,
                        "provider": provider, "serviceName": service_name, "chargeUsd": ledger.decimal_text(amount)})
                ledger.require(rows == part["dataRowCount"], "ROW_COUNT_MISMATCH")
            except (csv.Error, UnicodeError) as error:
                raise ledger.ContractError("INVALID_CSV") from error
        ledger.require(byte_total == expected_bytes and row_total == expected_rows
                       and raw_total == mapped_total + unallocated_total, "RECONCILIATION_MISMATCH")
    evidence = ledger.digest({"manifest": dict(manifest, blobs=sorted(manifest["blobs"], key=lambda x: x["blobName"])),
                              "parts": found, "profile": {k: v for k, v in profile.__dict__.items() if k != "mapping_column"}})
    normalized = {"schemaVersion": 1, "subscriptionId": subscription, "costBasis": "ActualCost", "currency": "USD",
                  "mappingVersion": policy["mappingVersion"], "snapshots": [{
        "period": period, "snapshotId": ledger.digest({"export": export_id, "run": run["runId"], "evidence": evidence}),
        "revision": revision, "exportedAt": run["submittedTime"], "ingestionComplete": True,
        "completenessEvidence": "reconciled-parts-" + evidence, "days": [
            {"date": date, "finalized": False, "finalizationEvidence": None, "records": records}
            for date, records in sorted(days.items())]}]}
    ledger.require(len(ledger.canonical(normalized).encode()) <= ledger.MAX_INPUT_BYTES, "NORMALIZED_INPUT_TOO_LARGE")
    return {"manifest": normalized, "reconciliation": {"profileId": profile.profile_id, "evidence": evidence,
            "parts": expected_parts, "bytes": byte_total, "rows": row_total, "rawUsd": ledger.decimal_text(raw_total),
            "mappedUsd": ledger.decimal_text(mapped_total), "unallocatedUsd": ledger.decimal_text(unallocated_total),
            "billingFinality": "not_asserted"}}
