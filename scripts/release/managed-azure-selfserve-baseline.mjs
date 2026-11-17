import { SELFSERVE_RELEASE_HOST_ID, SELFSERVE_RELEASE_ORIGIN, SELFSERVE_RELEASE_PROFILE } from "./managed-azure-selfserve-profile.mjs";

// Only these two historical revisions predate digest-only Container App templates.
// The app and revision APIs serialize defaults differently. Both original hashes
// are retained; all new templates (including compatible recovery) use @sha256.
const BASELINE_SHA = "eb423aca0618638cf7cd742dcb84397c492ba09b";
const TARGET = Object.freeze({
  subscriptionId: "227eb707-bc46-415e-a09b-7d2b69fb14b2",
  resourceGroup: "rg-corgtex-selfserve-production-wus3",
  acrName: "acrcorgtexssstgwus3", acrServer: "acrcorgtexssstgwus3.azurecr.io",
  webAppName: "ca-corgtex-ss-prod-web", workerAppName: "ca-corgtex-ss-prod-worker",
});
const ORIGINAL = {
  web: {
    revision: "ca-corgtex-ss-prod-web--0000130",
    digest: "sha256:afce6e505bc89e48ec06a2f9b915fb700b666d5d7c21d50b2cd32b4e78bbb110",
    appTemplate: "sha256:c51a96a84110a7196dab399d32e7ab8d053af0d787dcfa4dd41b2eb5feeaf06e",
    revisionTemplate: "sha256:a57766a4e36d5d7e94498bb9999624395be5874458b8c5cea24ea3de52d5f16e",
    tagCreated: "2026-10-04T22:11:44.6923579Z", revisionCreated: "2026-10-04T22:14:06+00:00",
  },
  worker: {
    revision: "ca-corgtex-ss-prod-worker--0000116",
    digest: "sha256:61b4e199e8f247dd4abb7e0b380a4cdb7ea3e71285c53b6902f0749b700f4a7c",
    appTemplate: "sha256:3ebdeaefc859693f255e3676f11d25a25ad60b09bb2b67cdf26dac79233d51ef",
    revisionTemplate: "sha256:eb03cd2fd07721fab2ccfef6756af754a2dae23be336255dc8f6e21d14bf0bcb",
    tagCreated: "2026-10-04T22:12:49.1316362Z", revisionCreated: "2026-10-04T22:16:19+00:00",
  },
};

const BINDINGS = Object.fromEntries(Object.entries(ORIGINAL).map(([role, original]) => {
  const repo = `corgtex/${role}`;
  const tag = `sha-${BASELINE_SHA}`;
  return [role, Object.freeze({ ...original, repo, tag,
    image: `${TARGET.acrServer}/${repo}@${original.digest}`, taggedImage: `${TARGET.acrServer}/${repo}:${tag}` })];
}));

export function matchesSelfserveBaseline(binding, target, role, release) {
  return ["web", "worker"].includes(role) && binding === BINDINGS[role]
    && Object.entries(TARGET).every(([key, value]) => target?.[key] === value)
    && release.gitSha === BASELINE_SHA && release.imageTag === binding.tag && release.version === "main-eb423aca0618";
}

export function selfserveBaselineBinding(status, release, activationPolicy, role, previous) {
  const binding = BINDINGS[role];
  if (status.deploymentId !== SELFSERVE_RELEASE_HOST_ID || status.origin !== SELFSERVE_RELEASE_ORIGIN
    || status.protectedReleaseProfile !== SELFSERVE_RELEASE_PROFILE || ![2, 3].includes(status.writeIntentProtocolVersion)
    || activationPolicy !== "EXCLUSIVE" || !matchesSelfserveBaseline(binding, status.target, role, release)) return undefined;
  if (previous !== undefined && (previous?.containerName !== role || previous.image !== binding.image || previous.readyRevision !== binding.revision
    || previous.templateDigest !== binding.appTemplate)) return undefined;
  return binding;
}
