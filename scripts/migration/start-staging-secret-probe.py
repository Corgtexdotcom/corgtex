#!/usr/bin/env python3
"""Start one staging job execution and resolve its Azure operation result."""

import json
import os
import re
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPHandler, HTTPSHandler, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def management_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "management.azure.com" or not parsed.path.startswith("/"):
        raise ValueError("AZURE_OPERATION_LOCATION_INVALID")
    return url


def response_name(body, job_name):
    try:
        result = json.loads(body) if body else {}
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("AZURE_OPERATION_RESPONSE_INVALID") from error
    name = result.get("name") if isinstance(result, dict) else None
    if name is None:
        return None
    if not isinstance(name, str) or not re.fullmatch(re.escape(job_name) + r"-[a-z0-9]+", name):
        raise ValueError("AZURE_EXECUTION_IDENTITY_INVALID")
    return name


def start_once(job_id, job_name, request_body, token, *, send, sleep=time.sleep, now=time.monotonic):
    expected_job = "caj-corgtex-ss-stg-migrate"
    expected_id = ("/subscriptions/227eb707-bc46-415e-a09b-7d2b69fb14b2/"
                   "resourceGroups/rg-corgtex-selfserve-staging-wus3/providers/Microsoft.App/jobs/"
                   + expected_job)
    if job_name != expected_job or job_id.lower() != expected_id.lower():
        raise ValueError("AZURE_JOB_IDENTITY_INVALID")
    start_url = management_url(f"https://management.azure.com{job_id}/start?api-version=2026-07-01")
    deadline = now() + 120
    url, method, body = start_url, "POST", request_body
    while True:
        if now() >= deadline:
            raise ValueError("AZURE_START_OUTCOME_INDETERMINATE")
        status, headers, payload = send(url, method, body, token)
        if status not in (200, 202):
            raise ValueError("AZURE_START_REQUEST_FAILED")
        name = response_name(payload, job_name)
        if name:
            return name
        location = headers.get("Location")
        if location:
            url = management_url(location)
        elif method == "POST" or status == 200:
            raise ValueError("AZURE_START_OUTCOME_INDETERMINATE")
        method, body = "GET", None
        delay = headers.get("Retry-After", "5")
        try:
            seconds = max(1, min(15, int(delay)))
        except ValueError:
            seconds = 5
        sleep(min(seconds, max(0, deadline - now())))


def send_http(url, method, body, token):
    request = Request(url, data=body, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json",
    })
    opener = build_opener(HTTPHandler(), HTTPSHandler(), NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            return response.status, response.headers, response.read(65536)
    except (HTTPError, URLError, TimeoutError) as error:
        raise ValueError("AZURE_START_OUTCOME_INDETERMINATE") from error


def main():
    if len(sys.argv) != 4:
        raise ValueError("USAGE: start-staging-secret-probe.py JOB_ID JOB_NAME REQUEST_JSON")
    job_id, job_name, request_path = sys.argv[1:]
    with open(request_path, "rb") as source:
        request_body = source.read()
    if not request_body or len(request_body) > 65536:
        raise ValueError("AZURE_PROBE_REQUEST_INVALID")
    account = subprocess.check_output([
        "az", "account", "show", "--query", "id", "--output", "tsv", "--only-show-errors",
    ], text=True, env={**os.environ, "AZURE_CORE_COLLECT_TELEMETRY": "no"}).strip()
    if account != job_id.split("/")[2]:
        raise ValueError("AZURE_SUBSCRIPTION_MISMATCH")
    token = subprocess.check_output([
        "az", "account", "get-access-token", "--subscription", account,
        "--resource", "https://management.azure.com/", "--query", "accessToken",
        "--output", "tsv", "--only-show-errors",
    ], text=True, env={**os.environ, "AZURE_CORE_COLLECT_TELEMETRY": "no"}).strip()
    if not token:
        raise ValueError("AZURE_TOKEN_MISSING")
    print(start_once(job_id, job_name, request_body, token, send=send_http))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"::error::{str(error) if isinstance(error, ValueError) else 'AZURE_AUTH_FAILED'}; inspect exact job executions before any retry.", file=sys.stderr)
        sys.exit(1)
