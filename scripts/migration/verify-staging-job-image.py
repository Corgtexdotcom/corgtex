#!/usr/bin/env python3
"""Verify that a staging migration job update changed only its image."""

import json
import sys
from pathlib import Path


def normalize_secret_references(snapshot):
    """Ignore Azure CLI's empty value beside a nonempty secretRef."""
    for container in snapshot["template"]["containers"]:
        for entry in container.get("env", []):
            if entry.get("secretRef") and entry.get("value") == "":
                del entry["value"]
    return snapshot


def verify(before, after, expected_image):
    before_containers = before["template"]["containers"]
    after_containers = after["template"]["containers"]
    if len(before_containers) != 1 or before_containers[0]["name"] != "migrate":
        raise ValueError("Expected one named migration container before update")
    if len(after_containers) != 1 or after_containers[0]["name"] != "migrate":
        raise ValueError("Expected one named migration container after update")
    if after_containers[0]["image"] != expected_image:
        raise ValueError("Migration job image readback does not match the immutable target")

    before_containers[0]["image"] = expected_image
    if normalize_secret_references(before) != normalize_secret_references(after):
        raise ValueError("Migration job settings changed beyond the image; inspect the protected run before execution")


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: verify-staging-job-image.py BEFORE AFTER EXPECTED_IMAGE")
    before = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    after = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    try:
        verify(before, after, sys.argv[3])
    except (KeyError, TypeError, ValueError) as error:
        raise SystemExit(str(error)) from error
    print("Migration job image and unchanged configuration verified")


if __name__ == "__main__":
    main()
