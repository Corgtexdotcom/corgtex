"""Runnable synthetic wire demonstration. No live transport/credentials are created."""
import copy
import csv
import hashlib
import io
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit
import xml.etree.ElementTree as ET

import azure_billing_azure as azure
import azure_billing_ingestion as ingestion
import azure_billing_ledger as ledger
import azure_billing_runtime as runtime

HEADERS = ("SubscriptionId", "Date", "ConsumedService", "BillingCurrency", "CostInBillingCurrency", "MeterCategory")
PROFILE = ingestion.CsvProfile("synthetic-mca-v1", "2023-05-01", HEADERS, "SubscriptionId", "Date", "ConsumedService",
                               "BillingCurrency", "CostInBillingCurrency", None, "MeterCategory")
POLICY = {"version": "provisional-v1", "provisional": True, "mappingVersion": "synthetic-map-v1",
          "expectedSubscriptionId": azure.SUBSCRIPTION, "services": [f"service-{x}" for x in range(1, 7)],
          "minimumQualifyingServices": 6, "thresholdUsd": "1.00", "maturityHours": 72, "freshnessHours": 36}


class Clock:
    def __init__(self):
        self.seconds = 0.0
        self.now = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)
    def monotonic(self): return self.seconds
    def utc(self): return self.now


class FakeCredentials:
    def __init__(self, clock): self.clock, self.calls = clock, []
    def get_token(self, **kwargs):
        self.calls.append(kwargs)
        return azure.Token("synthetic-test-token", self.clock.now + timedelta(hours=1), kwargs["client_id"], kwargs["tenant"])


class MemoryWire:
    """Azure-shaped deterministic HTTP responses, not a service emulator guarantee."""
    def __init__(self):
        self.objects, self.requests, self.counter, self.closed = {}, [], 0, 0
        self.before, self.after_put = None, None
    def put_fixture(self, path, body):
        self.counter += 1
        self.objects[path] = (body, f'"synthetic-{self.counter}"')
    def reply(self, request, status=200, body=b"", headers=None, url=None):
        pairs = [("Content-Length", str(len(body)))] + list((headers or {}).items())
        def close(): self.closed += 1
        return azure.Response(status, pairs, (body[i:i + 65536] for i in range(0, len(body), 65536)), url or request.url, close)
    def execute(self, request, **_):
        self.requests.append(request)
        if self.before:
            result = self.before(request)
            if result is not None: return result
        parsed = urlsplit(request.url)
        query = parse_qs(parsed.query)
        if query.get("comp") == ["list"]:
            prefix = query["prefix"][0]
            root = ET.Element("EnumerationResults", ServiceEndpoint=f"https://azure-placeholder/", ContainerName="billing-exports")
            root.set("ServiceEndpoint", f"https://{azure.HOST}/")
            blobs = ET.SubElement(root, "Blobs")
            for path, (body, tag) in sorted(self.objects.items()):
                name = path.removeprefix("/billing-exports/")
                if not path.startswith("/billing-exports/") or not name.startswith(prefix): continue
                blob = ET.SubElement(blobs, "Blob"); ET.SubElement(blob, "Name").text = name
                properties = ET.SubElement(blob, "Properties")
                ET.SubElement(properties, "Etag").text = tag
                ET.SubElement(properties, "Content-Length").text = str(len(body))
            ET.SubElement(root, "NextMarker")
            return self.reply(request, body=ET.tostring(root))
        current = self.objects.get(parsed.path)
        if request.method == "GET":
            if current is None: return self.reply(request, 404, headers={"x-ms-error-code": "BlobNotFound"})
            body, tag = current
            if "If-Match" in request.headers and request.headers["If-Match"] != tag:
                return self.reply(request, 412, headers={"x-ms-error-code": "ConditionNotMet"})
            return self.reply(request, body=body, headers={"ETag": tag})
        if request.headers.get("If-None-Match") == "*" and current is not None or "If-Match" in request.headers and (current is None or current[1] != request.headers["If-Match"]):
            return self.reply(request, 412, headers={"x-ms-error-code": "ConditionNotMet"})
        self.put_fixture(parsed.path, request.body)
        if self.after_put: self.after_put(request)
        return self.reply(request, 201, headers={"ETag": self.objects[parsed.path][1]})


class SyntheticAuthority:
    """Tests only; no Azure multi-object guarantee or live proof verifier."""
    def __init__(self, sequences): self.sequences = sequences
    def verify(self, receipt, manifest):
        run = manifest["runInfo"]["runId"]
        return {"captureDigest": ledger.digest(receipt), "period": manifest["runInfo"]["startDate"][:7],
                "authorityId": "synthetic-authority", "authoritySequence": self.sequences[run],
                "proofId": ledger.digest({"synthetic": run, "receipt": ledger.digest(receipt)})}


class SyntheticRetention:
    def __init__(self, clock): self.clock = clock
    def inspect(self):
        return {"generation": "synthetic-generation", "totalBytes": 0, "includesVersionsAndTemporaryAndLogs": True,
                "verifiedAt": self.clock.now.strftime("%Y-%m-%dT%H:%M:%SZ")}


def source_fixture(wire, run="run-1", charge="1.125", submitted="2026-10-29T09:00:00.1234567Z"):
    prefix = "mtd/synthetic/" + run
    stream = io.StringIO(newline=""); writer = csv.writer(stream); writer.writerow(HEADERS)
    writer.writerows([[azure.SUBSCRIPTION, "2026-10-20", "Example.Compute", "USD", charge, "compute"],
                     [azure.SUBSCRIPTION, "2026-10-20", "Example.Compute", "USD", charge, "compute"],
                     [azure.SUBSCRIPTION, "2026-10-20", "Example.Adjustment", "USD", "-0.25", "unallocated"]])
    part = stream.getvalue().encode(); name = prefix + "/part0.csv"
    manifest = {"manifestVersion": "2024-04-01", "byteCount": len(part), "blobCount": 1, "dataRowCount": 3,
        "exportConfig": {"exportName": "corgtex-actualcost-mtd", "resourceId": f"/subscriptions/{azure.SUBSCRIPTION}/providers/Microsoft.CostManagement/exports/corgtex-actualcost-mtd",
        "dataVersion": "2023-05-01", "apiVersion": "2025-03-01", "type": "ActualCost", "timeFrame": "MonthToDate", "granularity": "Daily"},
        "deliveryConfig": {"partitionData": True, "dataOverwriteBehavior": "OverwritePreviousReport", "fileFormat": "Csv",
        "compressionMode": "None", "containerUri": azure.STORAGE_ID, "rootFolderPath": "mtd"},
        "runInfo": {"executionType": "Scheduled", "submittedTime": submitted, "runId": run,
        "startDate": "2026-10-01T00:00:00Z", "endDate": "2026-10-28T00:00:00Z"},
        "blobs": [{"blobName": name, "byteCount": len(part), "dataRowCount": 3}]}
    wire.put_fixture("/billing-exports/" + name, part)
    wire.put_fixture("/billing-exports/" + prefix + "/manifest.json", ledger.canonical(manifest).encode())
    return prefix


def harness(bootstrap=True):
    clock, wire = Clock(), MemoryWire()
    credentials = FakeCredentials(clock)
    client = azure.AzureClient(azure.Scope("00000000-0000-4000-8000-000000000001"), credentials, wire,
                               azure.Budget(clock.monotonic), clock.utc)
    permit = runtime.BootstrapPermit("synthetic-generation", "synthetic-explicit-first-run") if bootstrap else None
    store = runtime.BlobCASStore(client, "synthetic-generation", 1, permit)
    prefix = source_fixture(wire)
    return clock, wire, client, store, prefix


def run(store, prefix, *, sequences=None, emit=None, verifier=True, retention=None):
    return runtime.run_once(store, [(prefix, "manifest.json")], profile=PROFILE, policy=copy.deepcopy(POLICY),
        mapping={"compute": "service-1"}, proof_verifier=SyntheticAuthority(sequences or {"run-1": 1}) if verifier else None,
        authority_id="synthetic-authority", approved_profile_digest=ledger.digest(PROFILE.__dict__),
        approved_policy_mapping_digest=ledger.digest({"policy": POLICY, "mapping": {"compute": "service-1"}}),
        retention=retention or SyntheticRetention(store.client.utc_now.__self__), emit_summary=emit or (lambda _: None))


def main():
    _, wire, _, store, prefix = harness()
    summaries = []
    result = run(store, prefix, emit=summaries.append)
    print(json.dumps({"mode": "synthetic-http-only", "liveCalls": 0, "requests": len(wire.requests),
                      "commitSequence": result["summary"]["commitSequence"], "summaryCount": len(summaries),
                      "dataStatus": result["summary"]["dataStatus"], "providerConsistency": "synthetic-proof-only"}, sort_keys=True))


if __name__ == "__main__":
    main()
