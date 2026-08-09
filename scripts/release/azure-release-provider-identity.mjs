export const AZURE_RELEASE_CONTRACT_STATUS = Object.freeze({
  READY: "ready",
  BLOCKED: "blocked"
});

export const AZURE_RELEASE_PROVIDER_BLOCKER_CODE = Object.freeze({
  AZURE_PROVIDER_MISMATCH: "azure_provider_mismatch"
});

function createAzureProviderMismatchBlock() {
  return {
    status: "blocked",
    blockerCodes: ["azure_provider_mismatch"],
    identity: null
  };
}

export function assessAzureReleaseProviderIdentity(target) {
  if (typeof target !== "object") {
    return createAzureProviderMismatchBlock();
  }
  if (target === null) {
    return createAzureProviderMismatchBlock();
  }

  let proto;
  try {
    proto = Object.getPrototypeOf(target);
  } catch (error) {
    return createAzureProviderMismatchBlock();
  }

  if (proto !== Object.prototype) {
    if (proto !== null) {
      return createAzureProviderMismatchBlock();
    }
  }

  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, "provider");
  } catch (error) {
    return createAzureProviderMismatchBlock();
  }

  if (descriptor === undefined) {
    return createAzureProviderMismatchBlock();
  }

  if (typeof descriptor.get === "function") {
    return createAzureProviderMismatchBlock();
  }
  if (typeof descriptor.set === "function") {
    return createAzureProviderMismatchBlock();
  }

  if (descriptor.value !== "azure") {
    return createAzureProviderMismatchBlock();
  }

  return {
    status: "ready",
    blockerCodes: [],
    identity: {
      provider: "azure"
    }
  };
}
