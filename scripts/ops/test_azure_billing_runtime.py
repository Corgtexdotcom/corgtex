"""Synthetic Azure wire/runtime acceptance. No real identity, data or network calls."""
import copy
import json
import unittest
from dataclasses import replace
from datetime import timedelta
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import xml.etree.ElementTree as ET

import azure_billing_azure as azure
import azure_billing_ledger as ledger
import azure_billing_pipeline as pipeline
import azure_billing_runtime as runtime
import azure_billing_mock as mock


class AzureRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.wire, self.client, self.store, self.prefix = mock.harness()

    def test_actual_wire_shapes_exact_scope_identity_and_no_unconditional_write(self):
        summaries = []
        result = mock.run(self.store, self.prefix, emit=summaries.append)
        self.assertEqual(result["summary"]["commitSequence"], 1)
        self.assertEqual(len(summaries), 1)
        self.assertEqual(result["summary"]["dataStatus"], "degraded")
        for request in self.wire.requests:
            self.assertEqual(urlsplit(request.url).hostname, azure.HOST)
            self.assertEqual(request.headers["x-ms-version"], "2023-11-03")
        put = next(x for x in self.wire.requests if x.method == "PUT")
        self.assertEqual(put.headers["If-None-Match"], "*")
        self.assertEqual(put.headers["x-ms-blob-type"], "BlockBlob")
        self.assertTrue(all(x["client_id"] == self.client.scope.client_id and x["identity_resource_id"] == azure.IDENTITY_ID
                            and x["scope"] == "https://storage.azure.com/.default" for x in self.client.credentials.calls))
        outer, _ = self.store.read_outer()
        entry = outer["admissions"]["2026-10"]
        self.assertEqual(entry["revision"], outer["envelope"]["state"]["snapshots"]["2026-10"]["revision"])
        self.assertEqual(entry["normalizationProfile"], runtime.NORMALIZATION)
        values = outer["envelope"]["state"]["evaluations"]
        self.assertEqual(values["service:service-1:2026-10-20"]["value"]["netUsd"], "2.25")
        self.assertFalse(values["service:service-1:2026-10-20"]["value"]["confirmed"])
        self.assertNotIn("synthetic-test-token", repr(put))

    def test_wrong_scope_path_and_encoded_escape_rejected_before_credentials(self):
        for scope in (replace(self.client.scope, host="other.blob.core.windows.net"),
                      replace(self.client.scope, storage_id=azure.STORAGE_ID + "other"),
                      replace(self.client.scope, source_container="other"), replace(self.client.scope, tenant="wrong")):
            with self.assertRaises(ledger.ContractError): azure.AzureClient(scope, self.client.credentials, self.wire, self.client.budget)
        for name in ("mtd/../escape", "mtd/%2e%2e/escape", "https://evil.test/file", "mtd/a?sig=secret"):
            with self.assertRaises(ledger.ContractError): self.client.get_blob("billing-exports", name)
        self.assertEqual(self.client.credentials.calls, [])

    def test_selected_identity_mismatch_has_no_fallback(self):
        self.client.credentials.get_token = lambda **_: azure.Token("synthetic", self.clock.now + timedelta(hours=1), "wrong", azure.TENANT)
        with self.assertRaisesRegex(ledger.ContractError, "INVALID_SELECTED_IDENTITY_TOKEN"):
            self.client.list_run(self.prefix)
        self.assertEqual(self.wire.requests, [])

    def test_redirect_invalid_headers_and_partial_body_close_without_leaking(self):
        for kind in ("redirect", "headers", "partial", "missing_length", "oversize"):
            with self.subTest(kind=kind):
                self.setUp()
                def reply(request):
                    response = self.wire.reply(request, body=b"x")
                    if kind == "redirect": response.status = 302
                    if kind == "headers": response.headers.append(("Content-Length", "1"))
                    if kind == "partial": response.headers = [("Content-Length", "2")]
                    if kind == "missing_length": response.headers = []
                    if kind == "oversize": response.headers = [("Content-Length", "999999999")]
                    return response
                self.wire.before = reply
                with self.assertRaises(ledger.ContractError): self.client.list_run(self.prefix)
                self.assertEqual(self.wire.closed, 1)
                self.assertEqual(len(self.wire.requests), 1)

    def test_stdlib_socket_close_is_independent_of_generator_start(self):
        class Connection:
            sock = None
            closed = False
            def request(self, *args, **kwargs): pass
            def getresponse(self): return self
            status = 302
            def getheaders(self): return [("Content-Length", "0")]
            def read(self, *_): raise AssertionError("body must not start")
            def close(self): self.closed = True
        connection = Connection()
        with patch.object(azure.http.client, "HTTPSConnection", return_value=connection):
            self.client.transport = azure.StdlibHTTPS()
            with self.assertRaisesRegex(ledger.ContractError, "REDIRECT"):
                self.client.list_run(self.prefix)
        self.assertTrue(connection.closed)

    def test_stdlib_header_extraction_failure_closes_before_response_exists(self):
        class Connection:
            closed = False
            status = 200
            def request(self, *args, **kwargs): pass
            def getresponse(self): return self
            def getheaders(self): raise ValueError("synthetic header failure")
            def close(self): self.closed = True
        connection = Connection()
        with patch.object(azure.http.client, "HTTPSConnection", return_value=connection):
            self.client.transport = azure.StdlibHTTPS()
            with self.assertRaisesRegex(RuntimeError, "^AZURE_IO_UNCERTAIN$"):
                self.client.list_run(self.prefix)
        self.assertTrue(connection.closed)

    def test_short_page_opaque_marker_continues_and_cycles_fail(self):
        original = self.wire.execute
        token = "opaque + /?&sig=not-a-query"
        calls = []
        def pages(request):
            query = parse_qs(urlsplit(request.url).query); calls.append(query)
            root = ET.Element("EnumerationResults", ServiceEndpoint=f"https://{azure.HOST}/", ContainerName="billing-exports")
            ET.SubElement(root, "Blobs")
            ET.SubElement(root, "NextMarker").text = token if len(calls) == 1 else ""
            return self.wire.reply(request, body=ET.tostring(root))
        self.wire.before = pages
        self.assertEqual(self.client.list_run(self.prefix), {})
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]["marker"], [token])
        self.assertNotIn("sig", calls[1])
        calls.clear()
        def cycle(request):
            response = pages(request)
            root = ET.fromstring(b"".join(response.chunks)); root.find("NextMarker").text = token
            return self.wire.reply(request, body=ET.tostring(root))
        self.wire.before = cycle
        with self.assertRaisesRegex(ledger.ContractError, "REPEATED_OR_INVALID_MARKER"):
            self.client.list_run(self.prefix)

    def test_xml_dtd_entities_utf16_and_malformed_payloads_fail_closed(self):
        malicious = '<!DOCTYPE x [<!ENTITY e "expanded">]><EnumerationResults>&e;</EnumerationResults>'
        for raw in (malicious.encode(), malicious.encode("utf-16"), b"<broken", b"<x>\x00</x>"):
            self.setUp()
            self.wire.before = lambda request: self.wire.reply(request, body=raw)
            with self.assertRaises(ledger.ContractError): self.client.list_run(self.prefix)
            self.assertEqual(self.wire.closed, 1)

    def test_listing_page_limit_and_policy_mapping_content_are_pinned(self):
        count = 0
        def endless(request):
            nonlocal count
            count += 1
            body = f'<EnumerationResults ServiceEndpoint="https://{azure.HOST}/" ContainerName="billing-exports"><Blobs/><NextMarker>opaque-{count}</NextMarker></EnumerationResults>'.encode()
            return self.wire.reply(request, body=body)
        self.wire.before = endless
        with self.assertRaisesRegex(ledger.ContractError, "LIST_PAGE_LIMIT"):
            self.client.list_run(self.prefix)
        self.assertEqual(count, 64)
        self.setUp()
        with self.assertRaisesRegex(ledger.ContractError, "UNAPPROVED_POLICY_OR_MAPPING_CONTENT"):
            runtime.run_once(self.store, [(self.prefix, "manifest.json")], profile=mock.PROFILE,
                policy=dict(mock.POLICY, thresholdUsd="2.00"), mapping={"compute": "service-1"},
                proof_verifier=mock.SyntheticAuthority({"run-1": 1}), authority_id="synthetic-authority",
                approved_profile_digest=ledger.digest(mock.PROFILE.__dict__),
                approved_policy_mapping_digest=ledger.digest({"policy": mock.POLICY, "mapping": {"compute": "service-1"}}),
                retention=mock.SyntheticRetention(self.clock), emit_summary=lambda _: None)
        self.assertEqual(self.wire.requests, [])

    def test_if_match_drift_and_missing_parts_never_publish(self):
        part = "/billing-exports/" + self.prefix + "/part0.csv"
        def overwrite(request):
            if urlsplit(request.url).path == part:
                self.wire.put_fixture(part, b"changed")
                self.wire.before = None
        self.wire.before = overwrite
        with self.assertRaises(azure.WireError): mock.run(self.store, self.prefix)
        self.assertFalse(any(x.method == "PUT" for x in self.wire.requests))
        self.setUp(); self.wire.objects.pop(part)
        with self.assertRaises(ledger.ContractError): mock.run(self.store, self.prefix)
        self.assertFalse(any(x.method == "PUT" for x in self.wire.requests))

    def test_stable_source_is_not_provider_consistency_proof(self):
        with self.assertRaisesRegex(ledger.ContractError, "PROVIDER_CONSISTENT_RUN_PROOF_REQUIRED"):
            mock.run(self.store, self.prefix, verifier=False)
        self.assertFalse(any(x.method == "PUT" for x in self.wire.requests))

    def test_timestamp_profile_preserves_raw_fraction_and_rejects_unknown_timezone(self):
        capture = azure.capture_run(self.client, self.prefix)
        normalized = runtime.normalize_manifest(capture.manifest)
        self.assertEqual(normalized["runInfo"]["submittedTime"], "2026-10-29T09:00:00Z")
        self.assertIn(b".1234567Z", capture.manifest)
        value = json.loads(capture.manifest)
        value["runInfo"]["startDate"] = "2026-10-01T00:00:00"
        with self.assertRaisesRegex(ledger.ContractError, "INVALID_UTC_TIME"):
            runtime.normalize_manifest(ledger.canonical(value).encode())
        value["runInfo"]["submittedTime"] = "2026-10-29T09:00:00+00:00"
        with self.assertRaisesRegex(ledger.ContractError, "UNSUPPORTED_SOURCE_TIMESTAMP_PROFILE"):
            runtime.normalize_manifest(ledger.canonical(value).encode())

    def test_automatic_previous_month_under_mtd_is_not_relabelled(self):
        path = "/billing-exports/" + self.prefix + "/manifest.json"
        value = json.loads(self.wire.objects[path][0])
        value["runInfo"]["submittedTime"] = "2026-11-01T09:00:00Z"
        self.wire.put_fixture(path, ledger.canonical(value).encode())
        self.clock.now = self.clock.now.replace(month=11, day=1)
        with self.assertRaisesRegex(ledger.ContractError, "TIMEFRAME_AUTHORITY_MISMATCH"):
            mock.run(self.store, self.prefix)

    def test_deadline_and_stream_budget_stop_without_summary(self):
        def late(request): self.clock.seconds = 541
        self.wire.before = late
        with self.assertRaisesRegex(ledger.ContractError, "RUNTIME_DEADLINE_EXCEEDED"):
            mock.run(self.store, self.prefix)
        self.setUp(); self.client.budget.read_remaining = 1
        with self.assertRaisesRegex(ledger.ContractError, "BODY_BUDGET_EXCEEDED"):
            mock.run(self.store, self.prefix)

    def test_default_absence_and_initialized_loss_do_not_bootstrap(self):
        self.store = runtime.BlobCASStore(self.client, "synthetic-generation", 1)
        with self.assertRaisesRegex(ledger.ContractError, "NO_RESET"): self.store.read()
        self.setUp(); mock.run(self.store, self.prefix)
        self.wire.objects.pop("/billing-ledger/" + azure.LEDGER_BLOB)
        with self.assertRaisesRegex(ledger.ContractError, "NO_RESET"): self.store.read()
        for status, code in ((404, "ContainerNotFound"), (403, "AuthorizationPermissionMismatch")):
            self.setUp()
            self.wire.before = lambda request: self.wire.reply(request, status, headers={"x-ms-error-code": code})
            with self.assertRaisesRegex(ledger.ContractError, "NO_RESET"): self.store.read()

    def test_put_timeout_reconciles_entire_atomic_object(self):
        def dropped(_):
            self.wire.after_put = None
            raise TimeoutError("synthetic drop")
        self.wire.after_put = dropped
        summaries = []
        mock.run(self.store, self.prefix, emit=summaries.append)
        self.assertEqual(len(summaries), 1)
        self.assertEqual(sum(x.method == "PUT" for x in self.wire.requests), 1)
        self.assertEqual(self.store.read_outer()[0]["admissions"]["2026-10"]["revision"], 1)

    def test_uncertain_journal_write_cannot_match_commit_id_alone(self):
        mock.run(self.store, self.prefix)
        document, tag = self.store.read()
        event = document["state"]["outbox"][0]["id"]
        document["journal"][event] = {"status": "claimed", "owner": "worker-a", "attempts": 0,
                                    "leaseUntil": "2026-10-29T12:02:00Z", "receiptId": None}
        def lost_before_write(request):
            if request.method == "PUT":
                self.wire.before = None
                raise TimeoutError("synthetic lost request")
        self.wire.before = lost_before_write
        with self.assertRaises(runtime.UnknownWrite): self.store.compare_and_swap(tag, document)
        actual, _ = self.store.read()
        self.assertEqual(actual["commitId"], document["commitId"])
        self.assertEqual(actual["journal"], {})

    def test_only_verified_condition_failure_is_clean_conflict(self):
        mock.run(self.store, self.prefix)
        document, tag = self.store.read()
        for code, expected in (("ConditionNotMet", pipeline.Conflict), ("LeaseIdMissing", runtime.UnknownWrite)):
            changed = copy.deepcopy(document); changed["journal"][document["state"]["outbox"][0]["id"]] = {
                "status": "unknown", "owner": "worker-a", "attempts": 0, "leaseUntil": "2026-10-29T12:02:00Z", "receiptId": None}
            self.wire.before = lambda request: self.wire.reply(request, 412, headers={"x-ms-error-code": code}) if request.method == "PUT" else None
            with self.assertRaises(expected): self.store.compare_and_swap(tag, changed)
            self.wire.before = None; document, tag = self.store.read()

    def test_concurrent_higher_authority_wins_atomically_and_stale_retry_is_rejected(self):
        mock.run(self.store, self.prefix)
        a = mock.source_fixture(self.wire, "run-2", "2")
        b = mock.source_fixture(self.wire, "run-3", "3")
        sequences = {"run-1": 1, "run-2": 2, "run-3": 3}
        other = runtime.BlobCASStore(self.client, "synthetic-generation", 1)
        winner = []
        def race(request):
            if request.method == "PUT":
                self.wire.before = None
                mock.run(other, b, sequences=sequences, emit=winner.append)
        self.wire.before = race
        loser = []
        with self.assertRaises(pipeline.Conflict): mock.run(self.store, a, sequences=sequences, emit=loser.append)
        self.assertEqual(loser, []); self.assertEqual(len(winner), 1)
        outer, _ = self.store.read_outer()
        self.assertEqual(outer["admissions"]["2026-10"]["authoritySequence"], 3)
        self.assertEqual(outer["admissions"]["2026-10"]["revision"], 2)
        with self.assertRaisesRegex(ledger.ContractError, "STALE_SOURCE_AUTHORITY"):
            mock.run(self.store, a, sequences=sequences)
        self.assertTrue(all(urlsplit(x.url).path == "/billing-ledger/v1/current.json" for x in self.wire.requests if x.method == "PUT"))

    def test_equal_source_reuses_revision_changed_identity_is_rejected(self):
        mock.run(self.store, self.prefix); mock.run(self.store, self.prefix)
        self.assertEqual(self.store.read_outer()[0]["admissions"]["2026-10"]["revision"], 1)
        mock.source_fixture(self.wire, "run-1", "2")
        with self.assertRaisesRegex(ledger.ContractError, "SOURCE_IDENTITY_CONFLICT"):
            mock.run(self.store, self.prefix)

    def test_generation_floor_and_aggregate_capacity_gates(self):
        mock.run(self.store, self.prefix)
        with self.assertRaisesRegex(ledger.ContractError, "LEDGER_ROLLBACK_DETECTED"):
            runtime.BlobCASStore(self.client, "synthetic-generation", 2).read()
        with self.assertRaisesRegex(ledger.ContractError, "WRONG_LEDGER_GENERATION"):
            runtime.BlobCASStore(self.client, "other-generation", 1).read()
        retention = mock.SyntheticRetention(self.clock)
        original = retention.inspect
        retention.inspect = lambda: dict(original(), totalBytes=1024 ** 3)
        with self.assertRaisesRegex(ledger.ContractError, "RETENTION_CAPACITY_UNPROVEN"):
            mock.run(self.store, self.prefix, retention=retention)

    def test_retention_attestation_must_still_be_fresh_at_publication(self):
        retention = mock.SyntheticRetention(self.clock)
        original = retention.inspect()
        retention.inspect = lambda: copy.deepcopy(original)
        def advance(request):
            if "part0.csv" in request.url:
                self.clock.now += timedelta(seconds=301)
                self.clock.seconds += 301
        self.wire.before = advance
        with self.assertRaisesRegex(ledger.ContractError, "RETENTION_CAPACITY_UNPROVEN"):
            mock.run(self.store, self.prefix, retention=retention)
        self.assertFalse(any(x.method == "PUT" for x in self.wire.requests))

    def test_malformed_success_etag_requires_exact_readback(self):
        def malformed(request):
            if request.method == "PUT":
                self.wire.before = None
                self.wire.put_fixture(urlsplit(request.url).path, request.body)
                return self.wire.reply(request, 201, headers={"ETag": "unquoted"})
        self.wire.before = malformed
        summaries = []
        mock.run(self.store, self.prefix, emit=summaries.append)
        self.assertEqual(len(summaries), 1)
        self.assertEqual(sum(x.method == "PUT" for x in self.wire.requests), 1)

    def test_fresh_runtime_clock_and_postcommit_output_crash(self):
        def advance(request):
            if "part0.csv" in request.url: self.clock.now += timedelta(seconds=2)
        self.wire.before = advance
        def crash(_): raise RuntimeError("synthetic output failure")
        with self.assertRaisesRegex(RuntimeError, "synthetic output failure"):
            mock.run(self.store, self.prefix, emit=crash)
        outer, _ = self.store.read_outer()
        self.assertEqual(outer["envelope"]["committedAt"], self.clock.now.strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.assertEqual(outer["envelope"]["commitSequence"], 1)


if __name__ == "__main__": unittest.main()
