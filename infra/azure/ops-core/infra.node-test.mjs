import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Compile locally only: no account, deployment, what-if or provider request.
const main = JSON.parse(execFileSync("az", ["bicep", "build", "--file",
  fileURLToPath(new URL("./main.bicep", import.meta.url)), "--stdout"], {
  encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
}));
const hosting = main.resources.hosting.properties.template;
const domains = ["opsDomain", "coreDomain"].map(name => hosting.resources[name].properties.template);
const values = template => Object.values(template.resources);

// Evaluate only the small Boolean ARM grammar used by resource conditions.
// Unknown syntax/functions fail rather than silently assuming a resource is absent.
function condition(expression, parameters, variables) {
  if (expression === undefined) return true;
  const text = expression.slice(1, -1); let offset = 0;
  const take = pattern => {
    const match = pattern.exec(text.slice(offset));
    assert.ok(match, `Unsupported condition at ${text.slice(offset)}`);
    offset += match[0].length; return match[0];
  };
  const parse = () => {
    while (text[offset] === " ") offset++;
    let value;
    if (text[offset] === "'") value = take(/^'[^']*'/).slice(1, -1);
    else {
      const name = take(/^[A-Za-z]+/); assert.equal(text[offset++], "(");
      const args = [];
      if (text[offset] !== ")") {
        args.push(parse());
        while (text[offset] === ",") { offset++; args.push(parse()); }
      }
      assert.equal(text[offset++], ")");
      const functions = { parameters: key => { assert.ok(Object.hasOwn(parameters, key)); return parameters[key]; },
        variables: key => { assert.ok(Object.hasOwn(variables, key)); return condition(variables[key], parameters, variables); },
        equals: (a, b) => a === b, and: (a, b) => a && b, not: a => !a, empty: a => a.length === 0 };
      assert.ok(Object.hasOwn(functions, name), `Unsupported condition function ${name}`);
      value = functions[name](...args);
    }
    while (text[offset] === ".") { offset++; value = value[take(/^[A-Za-z]+/)]; }
    return value;
  };
  const result = parse(); assert.equal(offset, text.length); return result;
}

for (const mode of ["dedicated", "existing-shared"]) test(`${mode} compiles the intended PostgreSQL ownership and endpoint count`, () => {
  const hostParams = { postgresHosting: { mode } };
  const hostResources = values(hosting).filter(r => r.type.includes("DBforPostgreSQL") || r.name?.includes("shared-pg"));
  const enabled = hostResources.filter(r => condition(r.condition, hostParams, hosting.variables));
  let servers = enabled.filter(r => r.type === "Microsoft.DBforPostgreSQL/flexibleServers" && r.existing !== true).length;
  let endpoints = enabled.filter(r => r.type === "Microsoft.Network/privateEndpoints").length;
  for (const domain of domains) {
    const params = { postgresBinding: { mode }, postgresPublicNetworkAccess: "Enabled", temporaryRestoreIpv4: "192.0.2.10" };
    for (const name of ["postgres", "restoreFirewall", "postgresEndpoint", "postgresEndpointDns"]) {
      const resource = domain.resources[name];
      const active = condition(resource.condition, params, domain.variables);
      assert.equal(active, mode === "dedicated", `${name} ownership`);
      if (active && name === "postgres") servers++;
      if (active && name === "postgresEndpoint") endpoints++;
    }
  }
  assert.equal(servers, mode === "dedicated" ? 2 : 0);
  assert.equal(endpoints, mode === "dedicated" ? 2 : 1);
  assert.equal(condition(hosting.resources.sharedPostgresEndpointDns.condition, hostParams, hosting.variables), mode === "existing-shared");
});

test("existing PostgreSQL is a same-subscription read-only reference with no lifecycle body", () => {
  const existing = hosting.resources.existingPostgres;
  assert.equal(existing.existing, true);
  assert.equal(existing.type, "Microsoft.DBforPostgreSQL/flexibleServers");
  assert.equal(existing.subscriptionId, undefined);
  assert.match(existing.resourceGroup, /parameters\('postgresHosting'\)\.resourceGroupName/);
  assert.match(existing.name, /parameters\('postgresHosting'\)\.serverName/);
  for (const key of ["properties", "sku", "tags", "location"]) assert.equal(existing[key], undefined);
  const endpoint = hosting.resources.sharedPostgresEndpoint;
  assert.equal(endpoint.properties.subnet.id, "[variables('privateEndpointsSubnetId')]");
  assert.deepEqual(endpoint.properties.privateLinkServiceConnections[0].properties.groupIds, ["postgresqlServer"]);
  assert.match(endpoint.properties.privateLinkServiceConnections[0].properties.privateLinkServiceId, /subscription\(\)\.subscriptionId/);
  for (const name of ["opsDomain", "coreDomain"]) {
    const binding = hosting.resources[name].properties.parameters.postgresBinding;
    for (const property of ["fullyQualifiedDomainName", "administratorLogin", "network.publicNetworkAccess"]) {
      assert.ok(binding.includes(`reference('existingPostgres').${property}`));
    }
    assert.match(binding, /shared-pg/);
  }
  assert.equal(hosting.resources.opsDomain.properties.parameters.postgresBinding, hosting.resources.coreDomain.properties.parameters.postgresBinding);
});

test("closed hosting input keeps dedicated default and permits existing mode without creation passwords", () => {
  assert.deepEqual(main.parameters.postgresHosting.defaultValue, { mode: "dedicated" });
  const type = main.definitions.postgresHostingConfig;
  assert.equal(type.discriminator.propertyName, "mode");
  assert.deepEqual(Object.keys(type.discriminator.mapping).sort(), ["dedicated", "existing-shared"]);
  const existing = main.definitions[type.discriminator.mapping["existing-shared"].$ref.split("/").at(-1)];
  assert.equal(existing.additionalProperties, false);
  assert.deepEqual(Object.keys(existing.properties).sort(), ["mode", "resourceGroupName", "serverName"]);
  assert.equal(existing.properties.resourceGroupName.minLength, 1);
  assert.equal(existing.properties.resourceGroupName.maxLength, 90);
  assert.equal(existing.properties.serverName.minLength, 3);
  assert.equal(existing.properties.serverName.maxLength, 63);
  for (const name of ["opsPostgresAdministratorPassword", "corePostgresAdministratorPassword"]) {
    assert.equal(main.parameters[name].type, "securestring");
    assert.equal(main.parameters[name].defaultValue, "");
  }
  const example = JSON.parse(readFileSync(new URL("./existing-shared.parameters.example.json", import.meta.url), "utf8"));
  assert.equal(example.parameters.postgresHosting.value.mode, "existing-shared");
  assert.ok(Object.keys(example.parameters).every(name => !/Password|AdministratorLogin|TemporaryRestore|PublicNetworkAccess/.test(name)));
});

test("domain and custody isolation remain and no application database is deployed", () => {
  const walk = template => {
    for (const resource of values(template)) {
      assert.notEqual(resource.type.toLowerCase(), "microsoft.dbforpostgresql/flexibleservers/databases");
      if (resource.type === "Microsoft.Resources/deployments") walk(resource.properties.template);
    }
  };
  walk(main);
  for (const domain of domains) {
    for (const name of ["identity", "objects", "runtimeSecretsWriter"]) assert.equal(domain.resources[name].condition, undefined);
    const output = domain.outputs.resources.value;
    for (const property of ["host", "administratorLogin", "publicNetworkAccess"]) {
      assert.ok(JSON.stringify(output).includes(`parameters('postgresBinding').${property}`));
    }
    assert.equal(output.temporaryRestoreFirewallName, "[if(variables('provisionPostgres'), 'temporary-migration-operator', null())]");
  }
  assert.ok(main.resources.custody);
  assert.notEqual(hosting.resources.opsDomain.properties.parameters.namePrefix.value, hosting.resources.coreDomain.properties.parameters.namePrefix.value);
});
