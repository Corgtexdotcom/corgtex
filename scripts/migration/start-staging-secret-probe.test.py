import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("start-staging-secret-probe.py")
SPEC = importlib.util.spec_from_file_location("start_staging_secret_probe", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
JOB = "caj-corgtex-ss-stg-migrate"
JOB_ID = ("/subscriptions/227eb707-bc46-415e-a09b-7d2b69fb14b2/resourceGroups/"
          "rg-corgtex-selfserve-staging-wus3/providers/Microsoft.App/jobs/" + JOB)
LOCATION = "https://management.azure.com/subscriptions/227eb707-bc46-415e-a09b-7d2b69fb14b2/providers/Microsoft.App/locations/westus3/operationResults/123?api-version=2026-07-01"


class StartStagingSecretProbeTests(unittest.TestCase):
    def test_immediate_execution_identity(self):
        calls = []

        def send(url, method, body, token):
            calls.append((url, method, body, token))
            return 200, {}, ('{"name":"' + JOB + '-abc123"}').encode()

        name = MODULE.start_once(JOB_ID, JOB, b'{"containers":[]}', "token", send=send)
        self.assertEqual(name, JOB + "-abc123")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], "POST")

    def test_accepted_start_polls_location_without_second_post(self):
        calls = []
        responses = [(202, {"Location": LOCATION, "Retry-After": "1"}, b""),
                     (202, {"Retry-After": "1"}, b""),
                     (200, {}, ('{"name":"' + JOB + '-abc123"}').encode())]

        def send(url, method, body, token):
            calls.append((url, method, body))
            return responses.pop(0)

        name = MODULE.start_once(JOB_ID, JOB, b"request", "token", send=send, sleep=lambda _: None)
        self.assertEqual(name, JOB + "-abc123")
        self.assertEqual([call[1] for call in calls], ["POST", "GET", "GET"])
        self.assertEqual([call[2] for call in calls], [b"request", None, None])
        self.assertEqual(calls[1][0], LOCATION)

    def test_indeterminate_start_never_reposts(self):
        calls = []

        def send(url, method, body, token):
            calls.append(method)
            return 202, {}, b""

        with self.assertRaisesRegex(ValueError, "INDETERMINATE"):
            MODULE.start_once(JOB_ID, JOB, b"request", "token", send=send)
        self.assertEqual(calls, ["POST"])

    def test_rejects_foreign_location_and_execution(self):
        with self.assertRaisesRegex(ValueError, "LOCATION_INVALID"):
            MODULE.start_once(JOB_ID, JOB, b"request", "token",
                              send=lambda *_: (202, {"Location": "https://example.com/operation"}, b""))
        with self.assertRaisesRegex(ValueError, "IDENTITY_INVALID"):
            MODULE.start_once(JOB_ID, JOB, b"request", "token",
                              send=lambda *_: (200, {}, b'{"name":"different-abc123"}'))

    def test_rejects_wrong_subscription_before_post(self):
        with self.assertRaisesRegex(ValueError, "JOB_IDENTITY_INVALID"):
            MODULE.start_once(JOB_ID.replace("227eb707", "117eb707"), JOB, b"request", "token",
                              send=lambda *_: self.fail("must not post"))


if __name__ == "__main__":
    unittest.main()
