"""Azure Storage wire adapters. All credentials and transport are explicit injections.

No environment/CLI/shared-key/SAS discovery. Importing this module performs no IO.
Source capture establishes authenticated object identity, not multi-object finality.
"""
from __future__ import annotations

import hashlib
import http.client
import re
import ssl
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from urllib.parse import urlencode, urlsplit

import azure_billing_ingestion as ingestion
import azure_billing_ledger as ledger

API_VERSION = "2023-11-03"
SUBSCRIPTION = "227eb707-bc46-415e-a09b-7d2b69fb14b2"
TENANT = "f6f245dd-ad33-4fed-8624-c44efa093b21"
RESOURCE_GROUP = "rg-corgtex-selfserve-production-wus3"
ACCOUNT = "corgtexssyfi4c2fhwqzh2"
STORAGE_ID = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{RESOURCE_GROUP}/providers/Microsoft.Storage/storageAccounts/{ACCOUNT}"
IDENTITY_ID = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{RESOURCE_GROUP}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-corgtex-billing-monitor-prod"
HOST = ACCOUNT + ".blob.core.windows.net"
LEDGER_BLOB = "v1/current.json"
ERROR_CODES = {"BlobNotFound", "ContainerNotFound", "ConditionNotMet", "AuthorizationPermissionMismatch",
               "AuthenticationFailed", "LeaseIdMissing", "LeaseIdMismatchWithBlobOperation", "BlobAlreadyExists"}


@dataclass(frozen=True)
class Scope:
    client_id: str
    subscription: str = SUBSCRIPTION
    tenant: str = TENANT
    storage_id: str = STORAGE_ID
    host: str = HOST
    identity_id: str = IDENTITY_ID
    source_container: str = "billing-exports"
    ledger_container: str = "billing-ledger"

    def validate(self):
        ledger.subscription_id(self.client_id)
        ledger.require((self.subscription, self.tenant, self.storage_id, self.host, self.identity_id,
                        self.source_container, self.ledger_container) ==
                       (SUBSCRIPTION, TENANT, STORAGE_ID, HOST, IDENTITY_ID, "billing-exports", "billing-ledger"),
                       "UNAPPROVED_AZURE_SCOPE")


@dataclass(frozen=True, repr=False)
class Token:
    value: str
    expires_at: datetime
    client_id: str
    tenant: str


@dataclass(frozen=True, repr=False)
class Request:
    method: str
    url: str
    headers: dict
    body: bytes = b""


@dataclass(repr=False)
class Response:
    status: int
    headers: list[tuple[str, str]]
    chunks: object
    url: str
    close: object = lambda: None


class WireError(RuntimeError):
    def __init__(self, status, provider_code):
        super().__init__("AZURE_RESPONSE_REJECTED")
        self.status = status
        self.provider_code = provider_code if provider_code in ERROR_CODES else "Unrecognized"


class Budget:
    def __init__(self, clock=time.monotonic, seconds=540, read_bytes=64 * 1024 * 1024):
        ledger.require(0 < seconds <= 540 and 0 < read_bytes <= 64 * 1024 * 1024, "INVALID_RUNTIME_BUDGET")
        self.clock, self.deadline = clock, clock() + seconds
        self.read_remaining, self.write_remaining, self.requests = read_bytes, 32 * 1024 * 1024, 0

    def check(self):
        ledger.require(self.clock() < self.deadline, "RUNTIME_DEADLINE_EXCEEDED")


class StdlibHTTPS:
    """No retries/redirects/proxies; fixed-host TLS validation and bounded reads.

    Explicitly constructing and injecting this transport enables network IO.
    The supplied mock entry point never constructs it.
    """
    def execute(self, request, *, deadline, clock):
        parsed = urlsplit(request.url)
        ledger.require(parsed.scheme == "https" and parsed.hostname == HOST and parsed.port is None
                       and not parsed.username and not parsed.password and not parsed.fragment, "UNAPPROVED_HTTP_TARGET")
        remaining = deadline - clock()
        ledger.require(remaining > 0, "RUNTIME_DEADLINE_EXCEEDED")
        connection = http.client.HTTPSConnection(HOST, timeout=min(30, remaining), context=ssl.create_default_context())
        try:
            connection.request(request.method, parsed.path + ("?" + parsed.query if parsed.query else ""),
                               body=request.body, headers=request.headers)
            response = connection.getresponse()
            status, headers = response.status, response.getheaders()
        except Exception:
            connection.close()
            raise RuntimeError("AZURE_TRANSPORT_UNCERTAIN") from None
        def chunks():
            try:
                while True:
                    remaining = deadline - clock()
                    ledger.require(remaining > 0, "RUNTIME_DEADLINE_EXCEEDED")
                    if connection.sock:
                        connection.sock.settimeout(min(30, remaining))
                    block = response.read(64 * 1024)
                    if not block:
                        return
                    yield block
            except Exception:
                raise RuntimeError("AZURE_BODY_UNCERTAIN") from None
            finally:
                connection.close()
        return Response(status, headers, chunks(), request.url, connection.close)


def etag(value):
    ledger.require(isinstance(value, str) and re.fullmatch(r'"[\x21\x23-\x7e]{1,200}"', value), "INVALID_BLOB_ETAG")
    return value


class AzureClient:
    def __init__(self, scope, credentials, transport, budget, utc_now=lambda: datetime.now(timezone.utc)):
        scope.validate()
        self.scope, self.credentials, self.transport, self.budget, self.utc_now = scope, credentials, transport, budget, utc_now

    def _request(self, method, container, path="", *, query=None, conditions=None, body=b"", maximum=8 * 1024 * 1024):
        self.scope.validate()
        ledger.require(container in (self.scope.source_container, self.scope.ledger_container), "UNAPPROVED_CONTAINER")
        ledger.require(method == "GET" or method == "PUT" and container == self.scope.ledger_container and path == LEDGER_BLOB,
                       "UNAPPROVED_STORAGE_OPERATION")
        if path: ingestion.blob_path(path)
        if container == self.scope.ledger_container:
            ledger.require(path == LEDGER_BLOB and query is None, "UNAPPROVED_LEDGER_PATH")
        else:
            ledger.require(method == "GET" and (path.startswith(("mtd/", "prior-month/")) or not path and query is not None),
                           "UNAPPROVED_SOURCE_PATH")
        self.budget.check()
        self.budget.requests += 1
        ledger.require(self.budget.requests <= 200, "REQUEST_LIMIT_EXCEEDED")
        now = self.utc_now()
        ledger.require(now.utcoffset() == timedelta(0), "UTC_NOW_REQUIRED")
        # Provider must select this exact user-assigned identity; there is no fallback.
        try:
            token = self.credentials.get_token(tenant=self.scope.tenant, client_id=self.scope.client_id,
                identity_resource_id=self.scope.identity_id, scope="https://storage.azure.com/.default", deadline=self.budget.deadline)
        except Exception:
            raise RuntimeError("CREDENTIAL_PROVIDER_FAILED") from None
        self.budget.check()
        ledger.require(isinstance(token, Token) and token.client_id == self.scope.client_id and token.tenant == self.scope.tenant
                       and token.expires_at.utcoffset() == timedelta(0) and token.expires_at >= now + timedelta(seconds=30)
                       and isinstance(token.value, str) and 0 < len(token.value) <= 16384
                       and all(32 < ord(c) < 127 for c in token.value), "INVALID_SELECTED_IDENTITY_TOKEN")
        headers = {"Authorization": "Bearer " + token.value, "x-ms-version": API_VERSION,
                   "x-ms-date": format_datetime(now, usegmt=True), "Accept-Encoding": "identity"}
        if conditions:
            ledger.require(set(conditions) in ({"If-Match"}, {"If-None-Match"}), "INVALID_CAS_CONDITION")
            if "If-Match" in conditions: etag(conditions["If-Match"])
            else: ledger.require(conditions["If-None-Match"] == "*" and method == "PUT", "INVALID_BOOTSTRAP_CONDITION")
            headers.update(conditions)
        if method == "PUT":
            ledger.require(conditions is not None, "UNCONDITIONAL_WRITE_FORBIDDEN")
            self.budget.write_remaining -= len(body)
            ledger.require(self.budget.write_remaining >= 0, "WRITE_BUDGET_EXCEEDED")
            headers.update({"x-ms-blob-type": "BlockBlob", "Content-Type": "application/json", "Content-Length": str(len(body))})
        url = f"https://{self.scope.host}/{container}" + ("/" + path if path else "")
        if query:
            ledger.require(set(query) <= {"restype", "comp", "prefix", "marker", "maxresults"}
                           and query.get("restype") == "container" and query.get("comp") == "list"
                           and query.get("prefix", "").startswith(("mtd/", "prior-month/")), "UNAPPROVED_QUERY")
            url += "?" + urlencode(query)
        request = Request(method, url, headers, body)
        response = None
        try:
            response = self.transport.execute(request, deadline=self.budget.deadline, clock=self.budget.clock)
            self.budget.check()
            ledger.require(response.url == url and not 300 <= response.status < 400, "REDIRECT_OR_TARGET_CHANGE")
            header_map = {}
            ledger.require(len(response.headers) <= 100, "TOO_MANY_RESPONSE_HEADERS")
            for key, value in response.headers:
                key = key.lower()
                ledger.require(key not in header_map and len(key) <= 256 and len(value) <= 16384, "INVALID_RESPONSE_HEADERS")
                header_map[key] = value
            length = header_map.get("content-length", "")
            ledger.require(re.fullmatch(r"0|[1-9][0-9]{0,9}", length) is not None and int(length) <= maximum,
                           "INVALID_CONTENT_LENGTH")
            ledger.require(header_map.get("content-encoding", "identity") == "identity" and "content-range" not in header_map,
                           "ENCODED_OR_PARTIAL_BODY")
            chunks, total = [], 0
            for chunk in response.chunks:
                self.budget.check()
                ledger.require(isinstance(chunk, bytes) and len(chunk) <= 64 * 1024, "INVALID_HTTP_CHUNK")
                total += len(chunk)
                self.budget.read_remaining -= len(chunk)
                ledger.require(total <= int(length) and self.budget.read_remaining >= 0, "BODY_BUDGET_EXCEEDED")
                chunks.append(chunk)
            self.budget.check()
            ledger.require(total == int(length), "TRUNCATED_BODY")
            if response.status not in (200, 201):
                raise WireError(response.status, header_map.get("x-ms-error-code"))
            return response.status, header_map, b"".join(chunks)
        except (ledger.ContractError, WireError):
            raise
        except Exception:
            raise RuntimeError("AZURE_IO_UNCERTAIN") from None
        finally:
            if response is not None:
                try:
                    if hasattr(response.chunks, "close"):
                        response.chunks.close()
                finally:
                    response.close()

    def get_blob(self, container, name, *, expected_etag=None, maximum=8 * 1024 * 1024):
        status, headers, raw = self._request("GET", container, name, maximum=maximum,
                conditions={"If-Match": expected_etag} if expected_etag else None)
        ledger.require(status == 200, "INVALID_GET_STATUS")
        actual = etag(headers.get("etag"))
        ledger.require(expected_etag is None or actual == expected_etag, "CHANGED_OBJECT_ETAG")
        return raw, actual

    def list_run(self, prefix):
        ingestion.blob_path(prefix)
        ledger.require(prefix.startswith(("mtd/", "prior-month/")), "UNAPPROVED_RUN_PREFIX")
        marker, seen, found = "", set(), {}
        for _ in range(64):
            query = {"restype": "container", "comp": "list", "prefix": prefix + "/", "maxresults": "65"}
            if marker: query["marker"] = marker
            status, _, raw = self._request("GET", self.scope.source_container, query=query, maximum=256 * 1024)
            try:
                text = raw.decode("utf-8")
            except UnicodeError:
                raise ledger.ContractError("UNSUPPORTED_XML_ENCODING") from None
            ledger.require(status == 200 and "\x00" not in text
                           and not re.search(r"<!\s*(?:DOCTYPE|ENTITY)", text, re.I)
                           and not re.search(r'encoding\s*=\s*[\"\'](?!utf-8[\"\'])', text, re.I), "INVALID_LIST_XML")
            try:
                root = ET.fromstring(text)
            except ET.ParseError:
                raise ledger.ContractError("INVALID_LIST_XML") from None
            ledger.require(root.tag == "EnumerationResults" and root.get("ServiceEndpoint") == f"https://{self.scope.host}/"
                           and root.get("ContainerName") == self.scope.source_container
                           and len(root.findall("NextMarker")) == 1 and len(root.findall("Blobs")) == 1,
                           "UNSCOPED_LIST_XML")
            blobs = root.find("Blobs")
            ledger.require(len(blobs) <= 65, "TOO_MANY_LIST_ITEMS")
            for blob in blobs:
                ledger.require(blob.tag == "Blob" and len(blob.findall("Name")) == 1
                               and len(blob.findall("Properties")) == 1, "INVALID_LIST_ITEM")
                name = ingestion.blob_path(blob.findtext("Name"))
                properties = blob.find("Properties")
                ledger.require(name.startswith(prefix + "/") and name not in found and len(properties.findall("Etag")) == 1
                               and len(properties.findall("Content-Length")) == 1, "DUPLICATE_OR_UNSCOPED_OBJECT")
                length = properties.findtext("Content-Length", "")
                ledger.require(re.fullmatch(r"0|[1-9][0-9]{0,8}", length) is not None
                               and int(length) <= ingestion.MAX_EXPORT_BYTES, "INVALID_OBJECT_SIZE")
                found[name] = {"etag": etag(properties.findtext("Etag")), "bytes": int(length)}
                ledger.require(len(found) <= 65, "TOO_MANY_RUN_OBJECTS")
            marker = root.findtext("NextMarker") or ""
            if not marker: return found
            ledger.require(len(marker) <= 4096 and marker not in seen, "REPEATED_OR_INVALID_MARKER")
            seen.add(marker)
        raise ledger.ContractError("LIST_PAGE_LIMIT")


@dataclass(repr=False)
class Capture:
    manifest: bytes
    parts: dict
    receipt: dict


def capture_run(client, prefix, manifest_name="manifest.json"):
    ledger.require(manifest_name in ("manifest.json", "_manifest.json"), "UNSUPPORTED_MANIFEST_NAME")
    objects = client.list_run(prefix)
    path = prefix + "/" + manifest_name
    ledger.require(path in objects, "MISSING_RUN_MANIFEST")
    manifest, manifest_etag = client.get_blob(client.scope.source_container, path,
        expected_etag=objects[path]["etag"], maximum=objects[path]["bytes"])
    ledger.require(len(manifest) == objects[path]["bytes"], "MANIFEST_LENGTH_MISMATCH")
    parts, identities, total = {}, {}, 0
    for name, meta in sorted(objects.items()):
        if name == path: continue
        ledger.require(name.endswith(".csv"), "UNEXPECTED_RUN_OBJECT")
        total += meta["bytes"]
        ledger.require(total <= ingestion.MAX_EXPORT_BYTES, "EXPORT_TOO_LARGE")
        raw, actual = client.get_blob(client.scope.source_container, name, expected_etag=meta["etag"], maximum=meta["bytes"])
        ledger.require(len(raw) == meta["bytes"], "PART_LENGTH_MISMATCH")
        parts[name] = raw
        identities[name] = {"etag": actual, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
    receipt = {"storageResourceId": client.scope.storage_id, "container": client.scope.source_container,
               "prefix": prefix, "manifestPath": path, "manifestETag": manifest_etag,
               "manifestSha256": hashlib.sha256(manifest).hexdigest(), "parts": identities,
               "consistency": "individual_conditional_reads_not_atomic_run_proof"}
    return Capture(manifest, parts, receipt)
