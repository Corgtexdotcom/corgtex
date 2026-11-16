import { describe, expect, it, vi } from "vitest";
import { reconstructBaselineTemplate } from "./managed-azure-release-recovery.mjs";
import * as adoption from "./managed-azure-selfserve-baseline.mjs";
import { assertManagedAzureRevisionProjection, buildManagedAzureReleaseTemplate, createManagedAzureContainerAppTransport,
  managedAzureTemplateDigest } from "./managed-azure-container-app-transport.mjs";
import { buildManagedAzureRecoveryIntent, readManagedAzureRecoveryIntentPlan } from "./managed-azure-recovery-intent.mjs";

const gitSha = "eb423aca0618638cf7cd742dcb84397c492ba09b";
const release = { gitSha, imageTag: `sha-${gitSha}`, version: "main-eb423aca0618" };
const target = {
  subscriptionId: "227eb707-bc46-415e-a09b-7d2b69fb14b2", resourceGroup: "rg-corgtex-selfserve-production-wus3",
  acrName: "acrcorgtexssstgwus3", acrServer: "acrcorgtexssstgwus3.azurecr.io",
  webAppName: "ca-corgtex-ss-prod-web", workerAppName: "ca-corgtex-ss-prod-worker",
};
const status = { deploymentId: "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16", origin: "https://selfserve.corgtex.com",
  protectedReleaseProfile: "SELF_SERVE_IMPORTER_FENCE_V1", writeIntentProtocolVersion: 2, target };
const next = { gitSha: "a".repeat(40), imageTag: `sha-${"a".repeat(40)}`, version: "next" };

describe("attested original selfserve revisions", () => {
  it.each(["web", "worker"])("binds the protected owner, release, exact ARM target and durable %s rollback", (role) => {
    const bind = (s = status, r = release, policy = "EXCLUSIVE", previous) => adoption.selfserveBaselineBinding(s, r, policy, role, previous);
    const pin = bind();
    const previous = { containerName: role, image: pin.image, readyRevision: pin.revision, templateDigest: pin.appTemplate };
    expect(bind(status, release, "EXCLUSIVE", previous)).toBe(pin);
    for (const key of ["origin", "deploymentId", "protectedReleaseProfile", "writeIntentProtocolVersion"]) expect(bind({ ...status, [key]: "other" })).toBeUndefined();
    for (const key of Object.keys(target)) expect(bind({ ...status, target: { ...target, [key]: "other" } })).toBeUndefined();
    for (const key of Object.keys(release)) expect(bind(status, { ...release, [key]: "other" })).toBeUndefined();
    for (const key of Object.keys(previous)) expect(bind(status, release, "EXCLUSIVE", { ...previous, [key]: "other" })).toBeUndefined();
    expect(bind(status, release, "STANDARD")).toBeUndefined();
    expect(adoption.matchesSelfserveBaseline({ ...pin }, target, role, release)).toBe(false);
  });

  // Substitute only synthetic template hashes so private production environment
  // settings never become test fixtures. Scope and digest pins are tested above.
  it("checks registry and ARM evidence again on each read and retains both rollback representations", async () => {
    const role = "web", binding = adoption.selfserveBaselineBinding(status, release, "EXCLUSIVE", role);
    const template = { revisionSuffix: "", containers: [{ name: role, image: binding.taggedImage, env: [
      { name: "CORGTEX_RELEASE_GIT_SHA", value: gitSha }, { name: "CORGTEX_RELEASE_IMAGE_TAG", value: release.imageTag },
      { name: "CORGTEX_RELEASE_VERSION", value: release.version }, { name: "CORGTEX_STARTUP_MODE", value: "web" },
    ] }] };
    const revisionTemplate = structuredClone(template);
    revisionTemplate.revisionSuffix = null;
    const pin = { ...binding, appTemplate: managedAzureTemplateDigest(template), revisionTemplate: managedAzureTemplateDigest(revisionTemplate) };
    const attrs = { writeEnabled: false, deleteEnabled: false, readEnabled: true };
    const metadata = { name: pin.tag, digest: pin.digest, createdTime: pin.tagCreated, lastUpdateTime: pin.tagCreated, changeableAttributes: attrs };
    const readRegistryTag = vi.fn(async () => structuredClone(metadata));
    const app = { location: "West US 3", properties: { template, provisioningState: "Succeeded", configuration: { activeRevisionsMode: "Single" },
      latestRevisionName: pin.revision, latestReadyRevisionName: pin.revision } };
    const revision = { name: pin.revision, properties: { template: revisionTemplate, createdTime: pin.revisionCreated } };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init.method).toBe("GET");
      return Response.json(url.includes("/revisions/") ? revision : app);
    });
    const apps = createManagedAzureContainerAppTransport({ fetchImpl, readRegistryTag, getAccessToken: async () => "test" });
    const request = { role, release, target, originalBaseline: pin };
    const spy = vi.spyOn(adoption, "matchesSelfserveBaseline").mockImplementation((b, t, r, rel) =>
      b === pin && t === target && r === role && rel === release);
    try {
      const baseline = await apps.readApp(request);
      expect(baseline).toMatchObject({ image: pin.image, templateDigest: pin.appTemplate, imageDigest: pin.digest, revisionName: pin.revision, template });
      const imageDigest = `sha256:${"e".repeat(64)}`, image = `${target.acrServer}/corgtex/web@${imageDigest}`;
      const forward = buildManagedAzureReleaseTemplate({ baseline, image, role, release: next, revisionSuffix: "candidate", migrateWeb: true });
      expect(forward.containers[0].image).toBe(image);
      expect(baseline.template.containers[0].image).toBe(pin.taggedImage);
      expect(() => buildManagedAzureReleaseTemplate({ baseline, image: pin.taggedImage, role, release: next, revisionSuffix: "candidate" })).toThrow();
      const originatingLease = { leaseId: "123e4567-e89b-42d3-a456-426614174003", fence: 7 };
      const plan = buildManagedAzureRecoveryIntent({ originatingLease, target, role, predecessor: baseline, release: next, image, imageDigest });
      const planInput = { originatingLease, target, role, release: next, image, intent: plan.intent, releases: [
        { release: next, imageDigest }, { release, imageDigest: pin.digest, originalBaseline: pin }] };
      expect((await readManagedAzureRecoveryIntentPlan(apps, planInput)).intent).toEqual(plan.intent);
      expect(plan.intent.predecessorTemplateDigest).toBe(pin.appTemplate);
      expect(plan.template.containers[0].image).toBe(image);
      const rollback = { schemaVersion: 3, compatibleRecovery: { activationPolicy: "EXCLUSIVE" },
        previous: { web: { image: pin.image, containerName: role, readyRevision: pin.revision, templateDigest: pin.appTemplate } } };
      const lookup = vi.spyOn(adoption, "selfserveBaselineBinding").mockImplementation((owner, rel, policy, requestedRole, previous) =>
        owner === status && rel === release && policy === "EXCLUSIVE" && requestedRole === role
          && previous?.templateDigest === pin.appTemplate && previous.image === pin.image ? pin : undefined);
      try {
        for (const template of [forward, plan.template]) {
          const candidate = { ...baseline, image, imageDigest, template };
          expect(reconstructBaselineTemplate(role, candidate, status, rollback, release)).toEqual(baseline.template);
          const changed = structuredClone(candidate);
          changed.template.containers[0].env.push({ name: "OTHER", value: "changed" });
          expect(() => reconstructBaselineTemplate(role, changed, status, rollback, release)).toThrow();
          expect(() => reconstructBaselineTemplate(role, candidate, { ...status, deploymentId: "other" }, rollback, release)).toThrow();
          expect(() => reconstructBaselineTemplate(role, candidate, status, { ...rollback, schemaVersion: 2 }, release)).toThrow();
        }
      } finally { lookup.mockRestore(); }

      await expect(apps.readApp({ ...request, originalBaseline: undefined })).rejects.toMatchObject({ code: "AZURE_IMAGE_MISMATCH" });
      await expect(apps.readApp({ ...request, imageDigest })).rejects.toMatchObject({ code: "AZURE_LEGACY_BASELINE_DRIFT" });
      for (const bad of [{ digest: imageDigest }, { name: "other-tag" }, { createdTime: "later" }, { lastUpdateTime: "later" },
        ...Object.keys(attrs).map(key => ({ changeableAttributes: { ...attrs, [key]: !attrs[key] } }))]) {
        readRegistryTag.mockResolvedValueOnce({ ...metadata, ...bad });
        await expect(apps.readApp(request)).rejects.toMatchObject({ code: "AZURE_LEGACY_TAG_DRIFT" });
      }
      readRegistryTag.mockRejectedValueOnce(new Error("private provider response"));
      await expect(apps.readAppTemplate(request)).rejects.toMatchObject({ code: "AZURE_LEGACY_TAG_UNREADABLE" });
      revision.properties.template.containers[0].name = "foreign";
      await expect(apps.readApp(request)).rejects.toMatchObject({ code: "AZURE_LEGACY_REVISION_UNPROVEN" });
      app.properties.latestRevisionName = pin.revision + "1";
      await expect(apps.readApp(request)).rejects.toMatchObject({ code: "AZURE_LEGACY_BASELINE_DRIFT" });
    } finally { spy.mockRestore(); }
  });

  it("normalizes only the empty value placeholder on an unchanged secret reference", () => {
    const template = { revisionSuffix: "abc", containers: [{ name: "web", env: [{ name: "X", secretRef: "x", value: "" }] }] };
    const revision = structuredClone(template);
    delete revision.containers[0].env[0].value;
    const check = () => assertManagedAzureRevisionProjection(template, revision, "web", "web--abc");
    expect(check()).toBe(true);
    template.containers[0].env[0].value = "a";
    expect(check).toThrow();
    template.containers[0].env[0].value = "";
    revision.containers[0].env[0].secretRef = "changed";
    expect(check).toThrow();
  });
});

describe("exclusive revision census", () => {
  const role = "web", appName = target.webAppName, current = appName + "--0000130";
  const root = `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/containerApps/${appName}/revisions`;
  const nextPage = root + "?api-version=2025-01-01&pageSize=20&skipToken=cursor";
  function rig(link = nextPage, lastName = current) {
    const fetchImpl = vi.fn(async (url, { method }) => {
      expect(method).toBe("GET");
      if (url.includes("/replicas?")) return Response.json({ value: url.includes(current) ? [{}] : [] });
      if (url.includes("/revisions?")) {
        if (url === nextPage) return Response.json({ value: [{ name: lastName, properties: { active: true } }] });
        return Response.json({ value: [{ name: appName + "--old", properties: { active: false, runningState: "Stopped", replicas: 0, provisioningState: "Provisioned" } }], nextLink: link });
      }
      return Response.json({ properties: { latestRevisionName: current, latestReadyRevisionName: current,
        configuration: { activeRevisionsMode: "Single", ingress: { traffic: [{ latestRevision: true, weight: 100 }] } } } });
    });
    return { fetchImpl, apps: createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "test" }) };
  }
  it("covers selected and foreign revisions across pages", async () => {
    const { apps, fetchImpl } = rig();
    expect((await apps.readExclusiveState({ target, role })).revisions).toEqual([
      { revisionName: appName + "--old", active: false, replicaCount: 0 }, { revisionName: current, active: true, replicaCount: 1 }]);
    expect(fetchImpl.mock.calls.some(([url]) => url.includes(appName + "--old/replicas?"))).toBe(true);
    await expect(rig(nextPage, appName + "--old").apps.readExclusiveState({ target, role })).rejects.toThrow();
  });
  it.each([nextPage.replace("management.azure.com", "foreign.example"), nextPage.replace(appName, "foreign-app"),
    nextPage.replace("2025-01-01", "2024-01-01"), nextPage + "&extra=1", nextPage + "#x", nextPage.replace("=cursor", "=")])(
    "rejects an invalid continuation before fetching it", async (link) => {
      const { apps, fetchImpl } = rig(link);
      await expect(apps.readExclusiveState({ target, role })).rejects.toMatchObject({ code: "AZURE_EXCLUSIVE_REVISION_LIST_INVALID" });
      expect(fetchImpl.mock.calls.some(([url]) => url === link)).toBe(false);
    });
});
