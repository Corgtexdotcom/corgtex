// Both probes validate their instance binding and quote the remote command before calling this helper.
export function railwayInstanceSsh({ projectId, environmentId, serviceId, instanceId, identityFile }, remoteArgs) {
  if (identityFile === undefined) {
    return ["railway", ["ssh", "-p", projectId, "-e", environmentId, "-s", serviceId, "-d", instanceId, "--", ...remoteArgs]];
  }
  if (typeof identityFile !== "string" || !identityFile.startsWith("/") || /[\0\r\n]/.test(identityFile)) {
    throw new Error("INVALID_RAILWAY_SSH_IDENTITY_PATH");
  }
  return ["ssh", ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=10", "-i", identityFile, `${instanceId}@ssh.railway.com`, ...remoteArgs]];
}
