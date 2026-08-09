import {
  AZURE_RELEASE_CONTRACT_STATUS,
  assessAzureReleaseProviderIdentity
} from "./azure-release-provider-identity.mjs";

export { AZURE_RELEASE_CONTRACT_STATUS };

export const AZURE_RELEASE_WORKLOAD_BLOCKER_CODE = Object.freeze({
  AZURE_GROUP_MISSING: "azure_group_missing",
  AZURE_GROUP_UNSUPPORTED: "azure_group_unsupported",
  AZURE_WORKLOAD_MISSING: "azure_workload_missing",
  AZURE_WORKLOAD_MISMATCH: "azure_workload_mismatch"
});

function isSupportedGroup(value) {
  return ["managed-customers", "selfserve", "ops", "backup-app"].includes(value);
}

function readOwnDataValue(target, key) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch (error) {
    return undefined;
  }
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function readWorkloadFields(target) {
  if (typeof target !== "object" || target === null) {
    return { group: undefined, workload: undefined };
  }

  let prototype;
  try {
    prototype = Object.getPrototypeOf(target);
  } catch (error) {
    return { group: undefined, workload: undefined };
  }

  if (prototype !== Object.prototype && prototype !== null) {
    return { group: undefined, workload: undefined };
  }

  return { group: readOwnDataValue(target, "group"), workload: readOwnDataValue(target, "workload") };
}

export function assessAzureReleaseWorkloadIdentity(target) {
  const providerResult = assessAzureReleaseProviderIdentity(target);
  const fields = readWorkloadFields(target);
  const blockerCodes = [...providerResult.blockerCodes];

  const groupIsNonblank = typeof fields.group === "string" && fields.group.trim() !== "";
  const groupIsSupported = groupIsNonblank && isSupportedGroup(fields.group);

  if (!groupIsNonblank) {
    blockerCodes.push("azure_group_missing");
  } else if (!groupIsSupported) {
    blockerCodes.push("azure_group_unsupported");
  }

  const workloadIsNonblank = typeof fields.workload === "string" && fields.workload.trim() !== "";

  if (!workloadIsNonblank) {
    blockerCodes.push("azure_workload_missing");
  } else if (groupIsSupported && fields.workload !== fields.group) {
    blockerCodes.push("azure_workload_mismatch");
  }

  if (blockerCodes.length > 0) {
    return {
      status: "blocked",
      blockerCodes,
      identity: null
    };
  }

  return {
    status: "ready",
    blockerCodes,
    identity: {
      provider: providerResult.identity.provider,
      group: fields.group,
      workload: fields.workload
    }
  };
}
