"""Offline ActualCost ledger over an explicitly admitted normalized manifest.

This module does not fetch exports, establish billing finality, send alerts, or
access credentials. Monetary values are bounded decimal strings, never floats.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import signal
import sys
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, localcontext
from pathlib import Path

MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_RECORDS = 25_000
MAX_LABEL_LENGTH = 160
MAX_REPLAY_DAYS = 62
MAX_SECONDS = 540
MONEY = re.compile(r"-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?\Z")
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
SUBSCRIPTION = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")


class ContractError(ValueError):
    """A safe code, without source records or their values."""


def require(condition, code):
    if not condition:
        raise ContractError(code)


def exact_keys(value, keys, code):
    require(isinstance(value, dict) and set(value) == set(keys), code)


def label(value, code, nullable=False):
    if nullable and value is None:
        return None
    require(isinstance(value, str) and 0 < len(value) <= MAX_LABEL_LENGTH
            and value == value.strip() and all(ord(c) >= 32 for c in value), code)
    return value


def identifier(value, code):
    require(isinstance(value, str) and IDENTIFIER.fullmatch(value), code)
    return value


def subscription_id(value):
    require(isinstance(value, str) and SUBSCRIPTION.fullmatch(value)
            and value != "00000000-0000-0000-0000-000000000000", "INVALID_SUBSCRIPTION_ID")
    return value


def money(value):
    require(isinstance(value, str) and MONEY.fullmatch(value), "INVALID_DECIMAL")
    parsed = Decimal(value)
    require(parsed.is_finite(), "NONFINITE_DECIMAL")
    return parsed


def decimal_text(value):
    if value == 0:
        return "0"
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def utc_time(value):
    require(isinstance(value, str)
            and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value), "INVALID_UTC_TIME")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ContractError("INVALID_UTC_TIME") from error


def utc_date(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value), "INVALID_DATE")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ContractError("INVALID_DATE") from error


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def parse_json_bytes(raw):
    require(len(raw) <= MAX_INPUT_BYTES, "INPUT_TOO_LARGE")
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_float=lambda _: (_ for _ in ()).throw(ContractError("JSON_FLOAT_NOT_ALLOWED")),
                          parse_constant=lambda _: (_ for _ in ()).throw(ContractError("NONFINITE_JSON")))
    except (ValueError, UnicodeError, RecursionError) as error:
        if isinstance(error, ContractError):
            raise
        raise ContractError("INVALID_JSON") from error


def policy_contract(policy):
    exact_keys(policy, ["version", "provisional", "mappingVersion", "expectedSubscriptionId", "services", "minimumQualifyingServices",
                        "thresholdUsd", "maturityHours", "freshnessHours"], "INVALID_POLICY")
    identifier(policy["version"], "INVALID_POLICY_VERSION")
    identifier(policy["mappingVersion"], "INVALID_MAPPING_VERSION")
    subscription_id(policy["expectedSubscriptionId"])
    require(policy["provisional"] is True, "PROVISIONAL_POLICY_REQUIRED")
    require(isinstance(policy["services"], list) and 6 <= len(policy["services"]) <= 64,
            "SERVICE_COUNT_OUT_OF_BOUNDS")
    services = [identifier(item, "INVALID_SERVICE_ID") for item in policy["services"]]
    require(len(set(services)) == len(services), "DUPLICATE_SERVICE_ID")
    require(type(policy["minimumQualifyingServices"]) is int
            and 6 <= policy["minimumQualifyingServices"] <= len(services), "INVALID_MINIMUM_SERVICES")
    threshold = money(policy["thresholdUsd"])
    require(threshold > 0, "POSITIVE_THRESHOLD_REQUIRED")
    require(type(policy["maturityHours"]) is int and policy["maturityHours"] == 72,
            "INVALID_MATURITY")
    require(type(policy["freshnessHours"]) is int and 1 <= policy["freshnessHours"] <= 36,
            "INVALID_FRESHNESS")
    return sorted(services), threshold


def empty_state():
    return {"schemaVersion": 1, "subscriptionId": None, "policyFingerprint": None, "snapshots": {},
            "evaluations": {}, "outbox": [], "carry": None}


def validate_evaluations(entries):
    require(isinstance(entries, dict), "INVALID_PREVIOUS_EVALUATIONS")
    for entry in entries.values():
        exact_keys(entry, ["fingerprint", "sequence", "value"], "INVALID_PREVIOUS_EVALUATION")
        require(isinstance(entry["fingerprint"], str) and DIGEST.fullmatch(entry["fingerprint"])
                and type(entry["sequence"]) is int and 1 <= entry["sequence"] <= 1_000_000
                and isinstance(entry["value"], dict)
                and digest(entry["value"]) == entry["fingerprint"], "INVALID_PREVIOUS_EVALUATION")


def carry_checkpoint(previous, policy_fingerprint, through, services):
    """Retain only one boundary day's evidence, never invent earlier history."""
    checkpoint = {"through": through, "policyFingerprint": policy_fingerprint, "evaluations": {}}
    if previous["policyFingerprint"] != policy_fingerprint:
        return checkpoint
    retained = previous["carry"]
    if retained is not None and retained["through"] == through and retained["policyFingerprint"] == policy_fingerprint:
        return retained
    subjects = [f"service:{service}:{through}" for service in services] + [f"minimum-services:{through}"]
    checkpoint["evaluations"] = {subject: previous["evaluations"][subject] for subject in subjects
                                  if subject in previous["evaluations"]
                                  and previous["evaluations"][subject]["value"].get("date") == through}
    return checkpoint


def seed_streak(checkpoint, subject, basis):
    entry = checkpoint["evaluations"].get(subject)
    if entry is None:
        return 0
    value = entry["value"]
    require(value.get("date") == checkpoint["through"], "INVALID_CARRY_DATE")
    exact_keys(value.get("basisQualifies"), ["observed", "mature", "confirmed"], "INVALID_CARRY_BASES")
    exact_keys(value.get("consecutiveDays"), ["observed", "mature", "confirmed"], "INVALID_CARRY_COUNTS")
    qualified = value["basisQualifies"][basis]
    count = value["consecutiveDays"][basis]
    require(type(qualified) is bool and type(count) is int
            and 0 <= count <= utc_date(checkpoint["through"]).toordinal()
            and (qualified and count > 0 or not qualified and count == 0),
            "INVALID_CARRY_STREAK")
    return count if qualified else 0


def previous_contract(previous):
    if previous is None:
        return empty_state()
    exact_keys(previous, ["schemaVersion", "subscriptionId", "policyFingerprint", "snapshots",
                          "evaluations", "outbox", "carry"], "INVALID_PREVIOUS_STATE")
    require(type(previous["schemaVersion"]) is int and previous["schemaVersion"] == 1
            and isinstance(previous["snapshots"], dict)
            and isinstance(previous["evaluations"], dict)
            and isinstance(previous["outbox"], list), "INVALID_PREVIOUS_STATE")
    require(previous["policyFingerprint"] is None
            or isinstance(previous["policyFingerprint"], str)
            and DIGEST.fullmatch(previous["policyFingerprint"]), "INVALID_PREVIOUS_POLICY")
    if previous["subscriptionId"] is not None:
        subscription_id(previous["subscriptionId"])
    else:
        require(not previous["snapshots"] and not previous["evaluations"] and not previous["outbox"]
                and previous["carry"] is None and previous["policyFingerprint"] is None,
                "UNBOUND_PREVIOUS_STATE")
    require(len(canonical(previous).encode()) <= MAX_INPUT_BYTES, "PREVIOUS_STATE_TOO_LARGE")
    require(len(previous["snapshots"]) <= 2, "INVALID_PREVIOUS_SNAPSHOTS")
    for period, snapshot in previous["snapshots"].items():
        require(isinstance(period, str) and re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", period),
                "INVALID_PREVIOUS_PERIOD")
        exact_keys(snapshot, ["snapshotId", "revision", "exportedAt", "contentHash", "mappingHash",
                              "mappingVersion"], "INVALID_PREVIOUS_SNAPSHOT")
        require(type(snapshot["revision"]) is int and 1 <= snapshot["revision"] <= 1_000_000,
                "INVALID_PREVIOUS_REVISION")
        for field in ("snapshotId", "contentHash", "mappingHash"):
            require(isinstance(snapshot[field], str) and DIGEST.fullmatch(snapshot[field]),
                    "INVALID_PREVIOUS_SNAPSHOT_HASH")
        utc_time(snapshot["exportedAt"])
        identifier(snapshot["mappingVersion"], "INVALID_PREVIOUS_MAPPING_VERSION")
    validate_evaluations(previous["evaluations"])
    if previous["carry"] is not None:
        checkpoint = previous["carry"]
        exact_keys(checkpoint, ["through", "policyFingerprint", "evaluations"], "INVALID_CARRY")
        utc_date(checkpoint["through"])
        require(isinstance(checkpoint["policyFingerprint"], str)
                and DIGEST.fullmatch(checkpoint["policyFingerprint"]), "INVALID_CARRY_POLICY")
        validate_evaluations(checkpoint["evaluations"])
        require(len(checkpoint["evaluations"]) <= 65, "CARRY_TOO_LARGE")
    for entry in previous["outbox"]:
        exact_keys(entry, ["id", "subject", "sequence", "kind", "status", "current", "previous"],
                   "INVALID_PREVIOUS_OUTBOX")
        require(entry["kind"] in ("qualification_pending", "below_threshold_pending", "correction_pending")
                and entry["status"] in ("pending_no_transport", "superseded"),
                "UNSUPPORTED_DELIVERY_STATE")
        require(isinstance(entry["id"], str) and DIGEST.fullmatch(entry["id"])
                and isinstance(entry["subject"], str) and len(entry["subject"]) <= 160
                and type(entry["sequence"]) is int and 1 <= entry["sequence"] <= 1_000_000
                and isinstance(entry["current"], dict)
                and (entry["previous"] is None or isinstance(entry["previous"], dict)), "INVALID_PREVIOUS_OUTBOX")
    require(len({item["id"] for item in previous["outbox"]}) == len(previous["outbox"]),
            "DUPLICATE_OUTBOX_ID")
    return previous


def evaluate(manifest, policy, now, previous=None):
    """Replay both months. Finalization/evidence are upstream assertions, not proof."""
    started = time.monotonic()
    require(len(canonical(manifest).encode()) <= MAX_INPUT_BYTES, "INPUT_TOO_LARGE")
    require(isinstance(now, datetime) and now.utcoffset() == timedelta(0), "UTC_NOW_REQUIRED")
    services, threshold = policy_contract(policy)
    previous = previous_contract(previous)
    policy_fingerprint = digest(dict(policy, services=services, thresholdUsd=decimal_text(threshold)))
    exact_keys(manifest, ["schemaVersion", "subscriptionId", "costBasis", "currency", "mappingVersion",
                          "snapshots"], "INVALID_MANIFEST")
    require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1 and manifest["costBasis"] == "ActualCost"
            and manifest["currency"] == "USD", "ACTUAL_COST_USD_REQUIRED")
    require(subscription_id(manifest["subscriptionId"]) == policy["expectedSubscriptionId"],
            "SUBSCRIPTION_MISMATCH")
    require(previous["subscriptionId"] in (None, manifest["subscriptionId"]), "PREVIOUS_SUBSCRIPTION_MISMATCH")
    require(manifest["mappingVersion"] == policy["mappingVersion"], "MAPPING_VERSION_MISMATCH")
    require(isinstance(manifest["snapshots"], list) and len(manifest["snapshots"]) <= 2,
            "INVALID_SNAPSHOT_COUNT")
    current_start = now.date().replace(day=1)
    previous_start = (current_start - timedelta(days=1)).replace(day=1)
    periods = {previous_start.strftime("%Y-%m"), current_start.strftime("%Y-%m")}
    require((now.date() - previous_start).days + 1 <= MAX_REPLAY_DAYS, "REPLAY_WINDOW_TOO_LARGE")
    snapshots = {period: item for period, item in previous["snapshots"].items() if period in periods}
    days, seen_periods, seen_snapshot_ids, seen_rows, all_rows = {}, set(), set(), set(), 0
    provider_totals, name_totals, provider_name_totals = {}, {}, {}
    unallocated_totals = {}
    quality_issues = []
    for snapshot in manifest["snapshots"]:
        exact_keys(snapshot, ["period", "snapshotId", "revision", "exportedAt",
                              "ingestionComplete", "completenessEvidence", "days"], "INVALID_SNAPSHOT")
        period = snapshot["period"]
        require(isinstance(period, str) and period in periods and period not in seen_periods,
                "DUPLICATE_OR_OUTSIDE_PERIOD")
        seen_periods.add(period)
        require(isinstance(snapshot["snapshotId"], str) and DIGEST.fullmatch(snapshot["snapshotId"]),
                "INVALID_SNAPSHOT_ID")
        require(snapshot["snapshotId"] not in seen_snapshot_ids, "DUPLICATE_SNAPSHOT_ID")
        seen_snapshot_ids.add(snapshot["snapshotId"])
        require(type(snapshot["revision"]) is int and 1 <= snapshot["revision"] <= 1_000_000,
                "INVALID_REVISION")
        exported = utc_time(snapshot["exportedAt"])
        require(exported <= now, "FUTURE_EXPORT")
        require(type(snapshot["ingestionComplete"]) is bool, "INVALID_COMPLETENESS")
        if snapshot["ingestionComplete"]:
            label(snapshot["completenessEvidence"], "COMPLETENESS_EVIDENCE_REQUIRED")
        else:
            require(snapshot["completenessEvidence"] is None, "INCOMPLETE_EVIDENCE_CONFLICT")
            quality_issues.append({"code": "incomplete_export", "period": period})
        if now - exported > timedelta(hours=policy["freshnessHours"]):
            quality_issues.append({"code": "stale_export", "period": period})
        require(isinstance(snapshot["days"], list) and len(snapshot["days"]) <= 31, "INVALID_DAYS")
        # Array ordering has no financial meaning; normalize it before revision checks.
        require(all(isinstance(item, dict) and isinstance(item.get("records"), list)
                    for item in snapshot["days"]), "INVALID_DAY")
        normalized_days = [dict(item, records=sorted(item["records"], key=canonical)) for item in snapshot["days"]]
        normalized = dict(snapshot, days=sorted(normalized_days, key=canonical))
        mapping_hash = digest(normalized)
        # A mapping revision may remap the same immutable source rows, but cannot
        # change their amounts/dimensions without a new source revision.
        raw_days = [dict(item, records=sorted(
            [{key: value for key, value in row.items() if key != "serviceId"}
             if isinstance(row, dict) else row for row in item["records"]], key=canonical))
            for item in normalized["days"]]
        content_hash = digest(dict(normalized, days=raw_days))
        old = previous["snapshots"].get(period)
        if old is not None:
            exact_keys(old, ["snapshotId", "revision", "exportedAt", "contentHash", "mappingHash",
                             "mappingVersion"], "INVALID_PREVIOUS_SNAPSHOT")
            require(type(old["revision"]) is int and snapshot["revision"] >= old["revision"], "STALE_REVISION")
            if snapshot["revision"] == old["revision"]:
                require(snapshot["snapshotId"] == old["snapshotId"] and content_hash == old["contentHash"],
                        "REVISION_CONFLICT")
                if old["mappingVersion"] == policy["mappingVersion"]:
                    require(mapping_hash == old["mappingHash"], "MAPPING_REVISION_CONFLICT")
            else:
                require(snapshot["snapshotId"] != old["snapshotId"]
                        and exported >= utc_time(old["exportedAt"]), "REVISION_ORDER_CONFLICT")
        snapshots[period] = {"snapshotId": snapshot["snapshotId"], "revision": snapshot["revision"],
                             "exportedAt": snapshot["exportedAt"], "contentHash": content_hash,
                             "mappingHash": mapping_hash, "mappingVersion": policy["mappingVersion"]}
        for day in snapshot["days"]:
            exact_keys(day, ["date", "finalized", "finalizationEvidence", "records"], "INVALID_DAY")
            day_date = utc_date(day["date"])
            require(day_date.strftime("%Y-%m") == period and day_date <= now.date()
                    and day["date"] not in days, "DUPLICATE_OR_OUTSIDE_DATE")
            require(type(day["finalized"]) is bool, "INVALID_FINALIZATION")
            if day["finalized"]:
                label(day["finalizationEvidence"], "FINALIZATION_EVIDENCE_REQUIRED")
            else:
                require(day["finalizationEvidence"] is None, "UNFINALIZED_EVIDENCE_CONFLICT")
            require(isinstance(day["records"], list), "INVALID_RECORDS")
            all_rows += len(day["records"])
            require(all_rows <= MAX_RECORDS, "TOO_MANY_RECORDS")
            totals = {service: {"total": Decimal(0), "rows": 0, "nonzero": False} for service in services}
            # Precision 80 exceeds bounded 18 integer + 18 fractional digits plus
            # the carry of at most 25,000 rows. No quantization/rounding is used.
            with localcontext() as context:
                context.prec = 80
                for record in day["records"]:
                    exact_keys(record, ["sourceRecordId", "serviceId", "provider", "serviceName", "chargeUsd"],
                               "INVALID_RECORD")
                    row_id = identifier(record["sourceRecordId"], "INVALID_SOURCE_RECORD_ID")
                    require(row_id not in seen_rows, "DUPLICATE_SOURCE_RECORD")
                    seen_rows.add(row_id)
                    service = record["serviceId"]
                    require(service is None or service in services, "UNKNOWN_MAPPED_SERVICE")
                    provider = label(record["provider"], "INVALID_PROVIDER")
                    service_name = label(record["serviceName"], "INVALID_SERVICE_NAME", nullable=True)
                    amount = money(record["chargeUsd"])
                    if service is not None:
                        total = totals[service]
                        total["total"] += amount
                        total["rows"] += 1
                        total["nonzero"] |= amount != 0
                    provider_key = (day["date"], provider)
                    name_key = (day["date"], service_name)
                    combined_key = (day["date"], provider, service_name)
                    provider_totals[provider_key] = provider_totals.get(provider_key, Decimal(0)) + amount
                    name_totals[name_key] = name_totals.get(name_key, Decimal(0)) + amount
                    provider_name_totals[combined_key] = provider_name_totals.get(combined_key, Decimal(0)) + amount
                    if service is None:
                        unallocated = unallocated_totals.setdefault(combined_key, {"total": Decimal(0), "rows": 0})
                        unallocated["total"] += amount
                        unallocated["rows"] += 1
            require(time.monotonic() - started < MAX_SECONDS, "DEADLINE_EXCEEDED")
            days[day["date"]] = {
                "totals": totals, "ingestionComplete": snapshot["ingestionComplete"],
                "finalized": day["finalized"], "fresh": now - exported <= timedelta(hours=policy["freshnessHours"]),
            }
    ledger, simultaneous, evaluations, sequences = [], [], {}, {}
    through = (previous_start - timedelta(days=1)).isoformat()
    checkpoint = carry_checkpoint(previous, policy_fingerprint, through, services)
    streaks = {basis: {service: seed_streak(checkpoint, f"service:{service}:{through}", basis)
                      for service in services} for basis in ("observed", "mature", "confirmed")}
    simultaneous_streak = {basis: seed_streak(checkpoint, f"minimum-services:{through}", basis) for basis in streaks}
    missing_mature_days = 0
    unmatched_service_days, unmatched_mature_service_days = 0, 0
    cursor = previous_start
    while cursor <= now.date():
        key = cursor.isoformat()
        day = days.get(key)
        mature = now >= datetime.combine(cursor + timedelta(days=1), datetime.min.time(), timezone.utc) + timedelta(hours=policy["maturityHours"])
        if day is None and mature:
            missing_mature_days += 1
        day_entries = []
        for service in services:
            total = day["totals"][service] if day else None
            blockers = []
            if day is None:
                blockers.append("missing_day")
            else:
                if not day["ingestionComplete"]:
                    blockers.append("incomplete_export")
                if not day["fresh"]:
                    blockers.append("stale_export")
                if not day["finalized"]:
                    blockers.append("unfinalized_day")
            if not mature:
                blockers.append("immature_day")
            amount_class = "missing"
            if total:
                if total["rows"] == 0:
                    amount_class = "no_matching_records"
                    blockers.append("no_matching_records")
                    unmatched_service_days += 1
                    unmatched_mature_service_days += int(mature)
                elif total["total"] == 0:
                    amount_class = "net_zero" if total["nonzero"] else "explicit_zero"
                else:
                    amount_class = "qualifying" if total["total"] >= threshold else "below_threshold"
            observation_blockers = [item for item in blockers if item not in ("immature_day", "unfinalized_day")]
            basis_qualifies = {
                "observed": not observation_blockers and amount_class == "qualifying",
                "mature": not observation_blockers and mature and amount_class == "qualifying",
                "confirmed": not blockers and amount_class == "qualifying",
            }
            below_threshold = (not observation_blockers and mature
                               and amount_class in ("explicit_zero", "net_zero", "below_threshold"))
            for basis, qualifies in basis_qualifies.items():
                streaks[basis][service] = streaks[basis][service] + 1 if qualifies else 0
            entry = {"date": key, "serviceId": service, "mappingVersion": policy["mappingVersion"],
                     "policyVersion": policy["version"], "provisional": True,
                     "netUsd": decimal_text(total["total"]) if total and total["rows"] else None,
                     "matchingRecords": total["rows"] if total else None,
                     "amountClass": amount_class, "mature": mature, "confirmed": not blockers,
                     "blockers": blockers, "observationBlockers": observation_blockers,
                     "qualifies": basis_qualifies["mature"], "alertBasis": "mature_observed",
                     "belowThreshold": below_threshold,
                     "basisQualifies": basis_qualifies,
                     "consecutiveDays": {basis: streaks[basis][service] for basis in streaks}}
            ledger.append(entry)
            day_entries.append(entry)
            evaluations[f"service:{service}:{key}"] = entry
        counts = {basis: sum(entry["basisQualifies"][basis] for entry in day_entries) for basis in streaks}
        basis_qualifies = {basis: count >= policy["minimumQualifyingServices"] for basis, count in counts.items()}
        for basis, qualifies in basis_qualifies.items():
            simultaneous_streak[basis] = simultaneous_streak[basis] + 1 if qualifies else 0
        combined = {"date": key, "mappingVersion": policy["mappingVersion"], "policyVersion": policy["version"],
                    "provisional": True, "qualifies": basis_qualifies["mature"], "alertBasis": "mature_observed",
                    "minimumQualifyingServices": policy["minimumQualifyingServices"],
                    "qualifyingServices": counts, "basisQualifies": basis_qualifies,
                    "consecutiveDays": dict(simultaneous_streak)}
        simultaneous.append(combined)
        evaluations[f"minimum-services:{key}"] = combined
        cursor += timedelta(days=1)
    outbox = [dict(item) for item in previous["outbox"]]
    # Expiry changes only pending local state; it does not assert delivery/retraction.
    for item in outbox:
        if item["subject"] not in evaluations and item["status"] == "pending_no_transport":
            item["status"] = "superseded"
    outbox_ids = {item["id"] for item in outbox}
    pending_subjects = {item["subject"] for item in outbox if item["status"] == "pending_no_transport"}
    transitions = []
    same_policy = previous["policyFingerprint"] == policy_fingerprint
    for subject, value in evaluations.items():
        old = previous["evaluations"].get(subject)
        fingerprint = digest(value)
        unchanged = same_policy and old is not None and old["fingerprint"] == fingerprint
        sequence = old["sequence"] if unchanged else (old["sequence"] + 1 if old else 1)
        sequences[subject] = {"fingerprint": fingerprint, "sequence": sequence, "value": value}
        if unchanged:
            continue
        old_value = old["value"] if old else None
        # An absent/unknown/below-threshold initial day is not a qualification alert.
        relevant = (value["qualifies"] or value.get("belowThreshold") is True or subject in pending_subjects
                    or old_value is not None and old_value.get("qualifies") is True)
        if relevant:
            for item in outbox:
                if item["subject"] == subject and item["status"] == "pending_no_transport":
                    item["status"] = "superseded"
            event_id = digest({"subject": subject, "sequence": sequence,
                               "policy": policy_fingerprint, "evaluation": fingerprint})
            event = {"id": event_id, "subject": subject, "sequence": sequence,
                     "kind": "correction_pending" if subject in pending_subjects
                     or old_value is not None and old_value.get("qualifies")
                     else "below_threshold_pending" if value.get("belowThreshold") else "qualification_pending",
                     "status": "pending_no_transport", "current": value, "previous": old_value}
            if event_id not in outbox_ids:
                outbox.append(event)
                outbox_ids.add(event_id)
                pending_subjects.add(subject)
                transitions.append(event)
    state = {"schemaVersion": 1, "subscriptionId": manifest["subscriptionId"], "policyFingerprint": policy_fingerprint, "snapshots": snapshots,
             "evaluations": sequences, "outbox": sorted(outbox, key=lambda item: item["id"]), "carry": checkpoint}
    require(len(canonical(state).encode()) <= MAX_INPUT_BYTES, "STATE_CAPACITY_EXCEEDED")
    quality_issues.extend({"code": "missing_export", "period": period} for period in sorted(periods - seen_periods))
    if missing_mature_days:
        quality_issues.append({"code": "missing_mature_days", "count": missing_mature_days})
    if unmatched_service_days:
        quality_issues.append({"code": "unmatched_configured_service_days", "count": unmatched_service_days,
                               "matureCount": unmatched_mature_service_days})
    result = {
        "schemaVersion": 1, "subscriptionId": manifest["subscriptionId"], "costBasis": "ActualCost", "currency": "USD", "mappingVersion": policy["mappingVersion"],
        "policy": policy, "provisional": True, "finalizationAuthority": "upstream_assertion_not_verified",
        "delivery": "not_configured", "window": {"start": previous_start.isoformat(), "end": now.date().isoformat()},
        "dataQuality": {"status": "degraded" if quality_issues else "ready_for_provisional_evaluation",
                        "issues": sorted(quality_issues, key=canonical),
                        "expectedPeriods": sorted(periods), "receivedPeriods": sorted(seen_periods)},
        "ledger": ledger, "simultaneousServiceDays": simultaneous,
        "providerView": [{"date": day, "provider": provider, "netUsd": decimal_text(total)}
                         for (day, provider), total in sorted(provider_totals.items())],
        "serviceNameView": [{"date": day, "serviceName": name, "available": name is not None,
                            "netUsd": decimal_text(total)}
                           for (day, name), total in sorted(name_totals.items(), key=lambda item: canonical(item[0]))],
        "providerServiceNameView": [{"date": day, "provider": provider, "serviceName": name,
                                    "available": name is not None, "netUsd": decimal_text(total)}
                                   for (day, provider, name), total in sorted(
                                       provider_name_totals.items(), key=lambda item: canonical(item[0]))],
        "unallocatedView": [{"date": day, "provider": provider, "serviceName": name,
                             "matchingRecords": total["rows"], "netUsd": decimal_text(total["total"])}
                            for (day, provider, name), total in sorted(
                                unallocated_totals.items(), key=lambda item: canonical(item[0]))],
        "previousEvaluation": {"policyFingerprint": previous["policyFingerprint"],
                               "values": {key: entry["value"] for key, entry in previous["evaluations"].items()}},
        "newPendingIntents": transitions, "state": state,
    }
    require(len(canonical(result).encode()) <= MAX_OUTPUT_BYTES, "OUTPUT_CAPACITY_EXCEEDED")
    return result


def load_file(path):
    with Path(path).open("rb") as source:
        return parse_json_bytes(source.read(MAX_INPUT_BYTES + 1))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--previous-state")
    parser.add_argument("--now", required=True, help="Explicit UTC evaluation time; YYYY-MM-DDTHH:MM:SSZ")
    args = parser.parse_args(argv)
    def deadline(_signum, _frame):
        raise ContractError("DEADLINE_EXCEEDED")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(MAX_SECONDS)
    try:
        result = evaluate(load_file(args.manifest), load_file(args.policy), utc_time(args.now),
                          load_file(args.previous_state) if args.previous_state else None)
        sys.stdout.write(canonical(result) + "\n")
        return 0
    except (ContractError, OSError) as error:
        code = str(error) if isinstance(error, ContractError) else "INPUT_IO_ERROR"
        sys.stderr.write(canonical({"status": "error", "code": code, "stateChanged": False}) + "\n")
        return 2
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main())
