import copy
import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify-staging-job-image.py")
SPEC = importlib.util.spec_from_file_location("verify_staging_job_image", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VerifyStagingJobImageTests(unittest.TestCase):
    def setUp(self):
        self.before = {
            "identity": {"type": "UserAssigned"},
            "configuration": {"triggerType": "Manual", "secrets": [{"name": "password"}]},
            "template": {"containers": [{"name": "migrate", "image": "old", "env": [
                {"name": "DATABASE_URL", "secretRef": "database-url"},
                {"name": "MODE", "value": "migrate"},
            ]}]},
        }
        self.after = copy.deepcopy(self.before)
        self.after["template"]["containers"][0]["image"] = "new"

    def test_accepts_cli_empty_value_only_for_secret_reference(self):
        self.after["template"]["containers"][0]["env"][0]["value"] = ""
        MODULE.verify(self.before, self.after, "new")

    def test_rejects_changed_secret_reference(self):
        self.after["template"]["containers"][0]["env"][0].update(value="", secretRef="other-secret")
        with self.assertRaisesRegex(ValueError, "beyond the image"):
            MODULE.verify(self.before, self.after, "new")

    def test_rejects_nonempty_value_beside_secret_reference(self):
        self.after["template"]["containers"][0]["env"][0]["value"] = "unexpected"
        with self.assertRaisesRegex(ValueError, "beyond the image"):
            MODULE.verify(self.before, self.after, "new")

    def test_rejects_other_setting_change(self):
        self.after["configuration"]["triggerType"] = "Schedule"
        with self.assertRaisesRegex(ValueError, "beyond the image"):
            MODULE.verify(self.before, self.after, "new")

    def test_rejects_unexpected_image(self):
        with self.assertRaisesRegex(ValueError, "immutable target"):
            MODULE.verify(self.before, self.after, "wrong")


if __name__ == "__main__":
    unittest.main()
