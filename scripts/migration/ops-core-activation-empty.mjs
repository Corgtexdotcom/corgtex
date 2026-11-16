// Azure Container Apps cannot resolve an empty Key Vault secret. The one optional
// field below has identical application behavior when unset. Credentials and
// every other setting keep their original version-pinned binding.
export const optionalSetting = "POSTHOG_INSTANCE_ID";
export const errorApi = "2025-10-02-preview";

export function optionalBinding(body) {
  const { configuration, template } = body.properties;
  const env = template.containers[0].env;
  const alias = env.find(entry => entry.name === optionalSetting)?.secretRef;
  if (!alias) return null;
  const secret = configuration.secrets.find(entry => entry.name === alias);
  if (!secret || env.filter(entry => entry.secretRef === alias).length !== 1
    || configuration.secrets.some(entry => entry.name !== alias && entry.keyVaultUrl === secret.keyVaultUrl)) return null;
  return secret;
}

export function withoutOptionalBinding(body) {
  const copy = structuredClone(body), secret = optionalBinding(copy);
  if (!secret) throw new Error("ACTIVATION_OPTIONAL_BINDING_INVALID");
  const {configuration, template} = copy.properties;
  configuration.secrets = configuration.secrets.filter(entry => entry.name !== secret.name);
  template.containers[0].env = template.containers[0].env.filter(entry => entry.name !== optionalSetting);
  return copy;
}

export function matchesOptionalFetchFailure(message, secret) {
  if (typeof message !== "string" || !secret) return false;
  const { name, identity } = secret;
  const expected = "The following field(s) are either invalid or missing. Field 'configuration.secrets' is invalid with details: "
    + `'Invalid value: "${name}": Unable to get value using Managed identity ${identity} for secret ${name}. `
    + `Error: unable to fetch secret '${name}' using Managed identity '${identity}'';.`;
  return message.toLowerCase() === expected.toLowerCase();
}

// Reject unrelated response configuration before replacing a failed resource.
// Only observed provider defaults for the original bootstrap request are permitted.
export function failedCreateDefaults(app) {
  const {configuration: c} = app.properties;
  const allowed = (record, keys) => Object.keys(record).every(key => keys.includes(key));
  const empty = v => v == null || Array.isArray(v) && v.length === 0;
  return allowed(c, ["activeRevisionsMode","ingress","registries","secrets","dapr","identitySettings","maxInactiveRevisions","runtime","service"])
    && c.dapr == null && empty(c.identitySettings) && (c.maxInactiveRevisions == null || c.maxInactiveRevisions === 100)
    && c.runtime == null && c.service == null
    && allowed(c.ingress, ["external","targetPort","transport","allowInsecure","traffic","fqdn","customDomains","ipSecurityRestrictions",
      "additionalPortMappings","clientCertificateMode","corsPolicy","exposedPort","stickySessions"])
    && empty(c.ingress.additionalPortMappings) && c.ingress.clientCertificateMode == null && c.ingress.corsPolicy == null
    && c.ingress.exposedPort == null && c.ingress.stickySessions == null
    && empty(app.properties.delegatedIdentities) && Object.keys(app.tags ?? {}).length === 0;
}
