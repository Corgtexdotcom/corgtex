"""Static safety checks only. Bicep compilation/provider/KQL acceptance is separate."""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2] / "infra/azure/billing-monitor"


class BillingTemplateTests(unittest.TestCase):
    def test_only_additive_named_monitor_resources_and_no_grants_or_network_changes(self):
        text = "\n".join(x.read_text() for x in ROOT.glob("*.bicep"))
        types = re.findall(r"resource \w+ '([^@]+)@[^']+'(?: existing)? =", text)
        self.assertEqual(set(types), {
            "Microsoft.CostManagement/exports", "Microsoft.Storage/storageAccounts",
            "Microsoft.Storage/storageAccounts/blobServices", "Microsoft.Storage/storageAccounts/blobServices/containers",
            "Microsoft.App/managedEnvironments", "Microsoft.OperationalInsights/workspaces",
            "Microsoft.ManagedIdentity/userAssignedIdentities", "Microsoft.App/jobs", "Microsoft.Insights/scheduledQueryRules"})
        for name in ("account", "blobs", "environment", "workspace"):
            self.assertRegex(text, rf"resource {name} '[^']+' existing =")
        self.assertNotIn("Microsoft.Authorization/", text)
        self.assertNotIn("Microsoft.Network/", text)
        self.assertNotIn("Microsoft.Cache/", text)
        self.assertNotIn("Microsoft.ContainerRegistry/registries@", text)
        self.assertNotIn("listKeys(", text)
        self.assertNotIn("listSecrets(", text)
        self.assertNotIn("scheduleTriggerConfig", text)
        self.assertNotIn("cronExpression", text)

    def test_exports_inactive_job_manual_inert_and_alerts_disabled(self):
        exports = (ROOT / "exports.bicep").read_text()
        resources = (ROOT / "resources.bicep").read_text()
        self.assertIn("status: 'Inactive'", exports)
        self.assertNotIn("status: 'Active'", exports)
        self.assertIn("triggerType: 'Manual'", resources)
        self.assertIn("replicaTimeout: 600", resources)
        self.assertIn("replicaRetryLimit: 0", resources)
        self.assertIn("cpu: json('0.25'), memory: '0.5Gi'", resources)
        self.assertIn("raise SystemExit", resources)
        self.assertIn("enabled: false", resources)
        self.assertIn("actionGroups: []", resources)
        self.assertNotIn("health-sweep", re.sub(r"//[^\n]*", "", resources))
        self.assertNotIn("${summaryQuery}", resources)  # Multiline Bicep strings cannot interpolate.
        self.assertIn("summarize arg_max(commitSequence, *)", resources)
        self.assertIn("ago(36h)", resources)

    def test_scope_resource_names_and_limits_agree_with_reviewable_contract(self):
        contract = json.loads((ROOT / "preparation-contract.json").read_text())
        text = "\n".join(x.read_text() for x in ROOT.glob("*.bicep"))
        for key in ("subscriptionId", "resourceGroup", "location", "existingStorageAccount", "existingEnvironment",
                    "existingLogWorkspace", "jobName", "identityName"):
            self.assertIn(contract[key], text)
        for name in contract["newContainers"] + contract["alertRules"] + [x["name"] for x in contract["exports"]]:
            self.assertIn(name, text)
        self.assertEqual(contract["runtimeLimits"]["retainedBytes"], 1024 ** 3)
        self.assertIn("scope: subscription(approvedSubscriptionId)", text)
        self.assertIn("scope: resourceGroup(approvedSubscriptionId, productionResourceGroup)", text)


if __name__ == "__main__":
    unittest.main()
