import copy
import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("build-staging-secret-probe.py")
SPEC = importlib.util.spec_from_file_location("build_staging_secret_probe", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
IMAGE = "acr.example.azurecr.io/corgtex/web@sha256:" + "a" * 64


class BuildStagingSecretProbeTests(unittest.TestCase):
    def setUp(self):
        env = [
            {"name": name, "secretRef": secret_ref, "value": ""}
            for name, secret_ref in MODULE.EXPECTED_REFS.items()
        ]
        env.append({"name": "CORGTEX_STARTUP_MODE", "value": "migrate-and-seed"})
        self.job = {
            "registries": [{"server": "acr.example.azurecr.io", "passwordSecretRef": "ghcr-pat"}],
            "template": {"containers": [{"name": "migrate", "image": IMAGE,
                                         "resources": {"cpu": 0.5, "memory": "1Gi"}, "env": env}]},
        }

    def test_overrides_command_and_fails_closed_on_entrypoint(self):
        request = MODULE.build_request(self.job, IMAGE)
        container = request["containers"][0]
        self.assertEqual(container["command"], ["node"])
        self.assertEqual(container["args"][0], "-e")
        self.assertEqual(container["env"][-1], {"name": "CORGTEX_STARTUP_MODE", "value": "secret-probe-no-migration"})
        self.assertEqual(len(container["env"]), len(MODULE.EXPECTED_REFS) + 1)
        self.assertEqual(container["env"][0]["value"], "")
        self.assertNotIn("migrate-and-seed", str(request))
        self.assertNotIn("AGENT_API_KEY", container["args"][1])

    def test_rejects_changed_secret_reference(self):
        self.job["template"]["containers"][0]["env"][0]["secretRef"] = "other"
        with self.assertRaisesRegex(ValueError, "DATABASE_URL"):
            MODULE.build_request(self.job, IMAGE)

    def test_rejects_literal_secret_value(self):
        self.job["template"]["containers"][0]["env"][0]["value"] = "unexpected"
        with self.assertRaisesRegex(ValueError, "DATABASE_URL"):
            MODULE.build_request(self.job, IMAGE)

    def test_rejects_image_drift_and_init_container(self):
        changed = copy.deepcopy(self.job)
        changed["template"]["containers"][0]["image"] = "other"
        with self.assertRaisesRegex(ValueError, "image or resources"):
            MODULE.build_request(changed, IMAGE)
        self.job["template"]["initContainers"] = [{"name": "unexpected"}]
        with self.assertRaisesRegex(ValueError, "init container"):
            MODULE.build_request(self.job, IMAGE)

    def test_accepts_omitted_empty_value_but_keeps_reference(self):
        self.job["template"]["containers"][0]["env"][0].pop("value")
        request = MODULE.build_request(self.job, IMAGE)
        self.assertEqual(request["containers"][0]["env"][0], {"name": "DATABASE_URL", "secretRef": "database-url"})

    def test_verifies_execution_command_and_references(self):
        request = MODULE.build_request(self.job, IMAGE)
        execution = {"template": copy.deepcopy(request)}
        MODULE.verify_execution(execution, request)
        execution["template"]["containers"][0]["command"] = ["sh"]
        with self.assertRaisesRegex(ValueError, "command"):
            MODULE.verify_execution(execution, request)

    def test_rejects_execution_entrypoint_or_secret_drift(self):
        request = MODULE.build_request(self.job, IMAGE)
        execution = {"template": copy.deepcopy(request)}
        execution["template"]["containers"][0]["env"][-1]["value"] = "migrate-and-seed"
        with self.assertRaisesRegex(ValueError, "CORGTEX_STARTUP_MODE"):
            MODULE.verify_execution(execution, request)
        execution = {"template": copy.deepcopy(request)}
        execution["template"]["containers"][0]["env"][0]["secretRef"] = "other"
        with self.assertRaisesRegex(ValueError, "references changed"):
            MODULE.verify_execution(execution, request)

    def test_accepts_observed_azure_execution_readback(self):
        request = MODULE.build_request(self.job, IMAGE)
        execution = {"template": copy.deepcopy(request)}
        container = execution["template"]["containers"][0]
        container["resources"]["ephemeralStorage"] = ""
        for entry in container["env"]:
            if "secretRef" in entry:
                entry["secretRef"] = MODULE.PROVIDER_EXECUTION_REF
        MODULE.verify_execution(execution, request)

    def test_rejects_mixed_or_changed_provider_readback(self):
        request = MODULE.build_request(self.job, IMAGE)
        execution = {"template": copy.deepcopy(request)}
        container = execution["template"]["containers"][0]
        container["env"][0]["secretRef"] = MODULE.PROVIDER_EXECUTION_REF
        with self.assertRaisesRegex(ValueError, "references changed"):
            MODULE.verify_execution(execution, request)
        for entry in container["env"]:
            if "secretRef" in entry:
                entry["secretRef"] = MODULE.PROVIDER_EXECUTION_REF
        container["resources"]["ephemeralStorage"] = "1Gi"
        with self.assertRaisesRegex(ValueError, "resources"):
            MODULE.verify_execution(execution, request)


if __name__ == "__main__":
    unittest.main()
