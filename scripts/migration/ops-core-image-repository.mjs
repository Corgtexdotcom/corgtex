export function opsCoreImageRepository(acrServer, role) {
  if (!/^[a-z0-9]{5,50}\.azurecr\.io$/.test(acrServer) || !["web", "worker"].includes(role)) {
    throw new Error("OPSCORE_IMAGE_REPOSITORY_INVALID");
  }
  return `${acrServer}/corgtex/${role}`;
}
