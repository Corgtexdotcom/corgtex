import { readFileSync, readdirSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  PRISMA_REFERENTIAL_ACTIONS,
  TENANT_PURGE_DIRECT_RELATIONS,
  TENANT_PURGE_DISPOSITIONS,
  TENANT_PURGE_MODEL_DISPOSITIONS,
  assertTenantPurgeDispositionCoverage,
  assertTenantPurgeScopeRegistry,
  decodeDirectRelations,
  parseTenantPurgeDirectRelations,
  type TenantPurgeDisposition,
} from "./tenant-purge-scope-registry";

const schema = (() => { const repository = new URL("../../../", import.meta.url); const prismaDirectory = new URL("prisma/", repository); const packageJson = JSON.parse(readFileSync(new URL("package.json", repository), "utf8")); const files = readdirSync(prismaDirectory, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".prisma")).sort(); if (!files.length || packageJson.prisma?.schema || readdirSync(repository).some((file) => /^prisma\.config\./.test(file))) throw new Error("Unsupported or missing Prisma schema layout."); return files.map((file) => readFileSync(new URL(file, prismaDirectory), "utf8")).join("\n"); })();

function syntheticSchema(options: {
  provider?: string;
  optional?: boolean;
  onDelete?: string | null;
  onUpdate?: string | null;
  references?: boolean;
} = {}) {
  const optional = options.optional ?? false;
  const args = [
    "fields: [workspaceId]",
    options.references === false ? null : "references: [id]",
    options.onDelete ? `onDelete: ${options.onDelete}` : null,
    options.onUpdate ? `onUpdate: ${options.onUpdate}` : null,
  ].filter(Boolean).join(", ");
  return `
datasource db { provider = "${options.provider ?? "postgresql"}" url = env("DATABASE_URL") }
model Workspace { id String @id synthetic Synthetic[] }
model Synthetic {
  id String @id
  workspaceId String${optional ? "?" : ""}
  workspace Workspace${optional ? "?" : ""} @relation(${args})
}
`;
}

function dispositionFixture() {
  return Object.fromEntries(
    TENANT_PURGE_DISPOSITIONS.map((disposition) => [disposition, [...TENANT_PURGE_MODEL_DISPOSITIONS[disposition]]]),
  ) as Record<TenantPurgeDisposition, Prisma.ModelName[]>;
}

describe("tenant purge scope registry", () => {
  it("covers every generated model exactly once and rejects duplicate, missing, and unknown entries", () => {
    expect(() => assertTenantPurgeDispositionCoverage(TENANT_PURGE_MODEL_DISPOSITIONS)).not.toThrow();
    const models = Object.values(TENANT_PURGE_MODEL_DISPOSITIONS).flat();
    expect(models).toHaveLength(Object.values(Prisma.ModelName).length);
    expect(new Set(models).size).toBe(models.length);

    const duplicate = dispositionFixture();
    duplicate.RETAIN.push(duplicate.TARGET[0]);
    expect(() => assertTenantPurgeDispositionCoverage(duplicate)).toThrow(/duplicate=/);

    const missing = dispositionFixture();
    missing.TARGET.shift();
    expect(() => assertTenantPurgeDispositionCoverage(missing)).toThrow(/missing=/);

    const unknown = dispositionFixture();
    unknown.RETAIN.push("FutureTenantModel" as Prisma.ModelName);
    expect(() => assertTenantPurgeDispositionCoverage(unknown)).toThrow(/unknown=/);

    const movedRoot = dispositionFixture();
    movedRoot.RETAIN.push(movedRoot.TARGET.shift()!);
    expect(() => assertTenantPurgeDispositionCoverage(movedRoot)).toThrow(/target=/);
  });

  it("matches every current owning direct target relation and preserves named composite selectors", () => {
    expect(() => assertTenantPurgeScopeRegistry(schema)).not.toThrow();
    expect(TENANT_PURGE_DIRECT_RELATIONS).toHaveLength(157);
    const cutovers = TENANT_PURGE_DIRECT_RELATIONS.filter((entry) => entry.model === "ProviderCutover");
    expect(cutovers).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationField: "sourceDeployment", relationName: "SourceDeployment", fields: ["sourceDeploymentId", "customerAccountId"], references: ["id", "customerAccountId"], fieldOptional: [false, false], onDelete: "Restrict", onUpdate: "Restrict", onUpdateSource: "EXPLICIT" }),
      expect.objectContaining({ relationField: "destinationDeployment", relationName: "DestinationDeployment", fields: ["destinationDeploymentId", "customerAccountId"], fieldOptional: [true, false], relationOptional: true }),
    ]));
    expect(TENANT_PURGE_DIRECT_RELATIONS.find((entry) => entry.model === "WorkspaceFeatureFlag")).toMatchObject({ onUpdate: "Cascade", onUpdateSource: "POSTGRESQL_DEFAULT" });
    expect(TENANT_PURGE_DIRECT_RELATIONS.filter((entry) => entry.model === "CrmProspectWorkspace").map((entry) => entry.relationField).sort()).toEqual(["crmWorkspace", "targetWorkspace"]);
    expect(TENANT_PURGE_DIRECT_RELATIONS.find((entry) => entry.model === "ConstitutionSourceReference")).toMatchObject({ relationName: "ConstitutionSourceWorkspace" });
  });

  it("recognizes every explicit referential action without a two-action blind spot", () => {
    for (const action of PRISMA_REFERENTIAL_ACTIONS) {
      const [relation] = parseTenantPurgeDirectRelations(syntheticSchema({ onDelete: action, onUpdate: action }));
      expect(relation).toMatchObject({ onDelete: action, onDeleteSource: "EXPLICIT", onUpdate: action, onUpdateSource: "EXPLICIT" });
    }
  });

  it("applies only verified PostgreSQL connector defaults and rejects unsupported interpretation", () => {
    expect(parseTenantPurgeDirectRelations(syntheticSchema())[0]).toMatchObject({
      onDelete: "Restrict", onDeleteSource: "POSTGRESQL_DEFAULT", onUpdate: "Cascade", onUpdateSource: "POSTGRESQL_DEFAULT",
    });
    expect(parseTenantPurgeDirectRelations(syntheticSchema({ optional: true }))[0]).toMatchObject({
      relationOptional: true, fieldOptional: [true], onDelete: "SetNull", onUpdate: "Cascade",
    });
    const mixed = syntheticSchema({ optional: true }).replace("model Workspace { id String @id synthetic Synthetic[] }", "model Workspace {\n  id String @id\n  id2 String @unique\n  synthetic Synthetic[]\n}").replace("workspaceId String?", "workspaceId String?\n  requiredId String").replace("fields: [workspaceId]", "fields: [workspaceId, requiredId]").replace("references: [id]", "references: [id, id2]");
    expect(parseTenantPurgeDirectRelations(mixed)[0]).toMatchObject({ relationOptional: true, fieldOptional: [true, false], onDelete: "Restrict", onDeleteSource: "POSTGRESQL_DEFAULT" });
    const decoded = decodeDirectRelations("WorkspaceFeatureFlag|workspace|Workspace||workspaceId|id|0|0|Restrict|Cascade;WorkspaceFeatureFlag|workspace|Workspace||workspaceId|id|1|1|SetNull|Cascade", "0100");
    expect(decoded).toMatchObject([{ onDeleteSource: "POSTGRESQL_DEFAULT", onUpdateSource: "EXPLICIT" }, { onDeleteSource: "POSTGRESQL_DEFAULT", onUpdateSource: "POSTGRESQL_DEFAULT" }]);
    expect(() => decodeDirectRelations("WorkspaceFeatureFlag|workspace|Workspace||workspaceId|id|0|0|Restrict|Cascade", "1")).toThrow(/source encoding/);
    const indented = syntheticSchema().replace("\nmodel Synthetic {", "\n  model Synthetic {").replace("\n}\n", "\n  }\n");
    expect(parseTenantPurgeDirectRelations(indented)).toHaveLength(1);
    const view = syntheticSchema().replace("model Synthetic {\n  id String @id", "view Synthetic {\n  id String @unique");
    expect(parseTenantPurgeDirectRelations(view)).toHaveLength(1); expect(() => assertTenantPurgeScopeRegistry(view)).toThrow(/relation registry drift/);
    const decorated = syntheticSchema().replace(
      "@relation(fields: [workspaceId], references: [id])",
      "@relation(\n    name: \"NamedWorkspace\",\n    fields: [workspaceId],\n    references: [id]\n  ) // valid trailing comment",
    );
    expect(parseTenantPurgeDirectRelations(decorated)[0]).toMatchObject({ relationName: "NamedWorkspace", fields: ["workspaceId"] });
    expect(parseTenantPurgeDirectRelations(syntheticSchema().replace("@relation(", "@relation(\"onDelete: SetNull\", "))[0]).toMatchObject({ relationName: "onDelete: SetNull", onDelete: "Restrict", onDeleteSource: "POSTGRESQL_DEFAULT" });
    const blockCommented = syntheticSchema().replace("synthetic Synthetic[]", "/* synthetic Synthetic[] */").replace("workspace Workspace @relation", "/* workspace Workspace @relation").replace("references: [id])", "references: [id]) */");
    expect(parseTenantPurgeDirectRelations(blockCommented)).toHaveLength(0);
    expect(() => parseTenantPurgeDirectRelations(syntheticSchema({ provider: "mysql" }))).toThrow(/connector default policy/);
    expect(() => parseTenantPurgeDirectRelations(syntheticSchema({ onDelete: "FutureAction" }))).toThrow(/Unsupported Prisma onDelete/);
    expect(() => parseTenantPurgeDirectRelations(syntheticSchema().replace("references: [id])", "references: [id], onDelete: )"))).toThrow(/Malformed Prisma onDelete/);
    expect(() => parseTenantPurgeDirectRelations(syntheticSchema({ references: false }))).toThrow(/Malformed direct target relation/);
    expect(() => parseTenantPurgeDirectRelations(syntheticSchema().replace("@relation(", "@relation @ignore("))).toThrow(/Unparsed direct target relation/);
  });

  it("fails on action, default-source, optionality, and new target-relation drift", () => {
    expect(() => assertTenantPurgeScopeRegistry(schema.replace("onDelete: Cascade)", "onDelete: SetNull)"))).toThrow(/relation registry drift/);
    expect(() => assertTenantPurgeScopeRegistry(schema.replace("onDelete: Cascade)", "onDelete: Cascade, onUpdate: Cascade)"))).toThrow(/relation registry drift/);
    const optionalDrift = schema
      .replace("model Workspace {", "model Workspace {\n  shadowFeatures WorkspaceFeatureFlag[] @relation(\"ShadowWorkspace\")")
      .replace(
        "model WorkspaceFeatureFlag {",
        "model WorkspaceFeatureFlag {\n  shadowWorkspaceId String?\n  shadowWorkspace Workspace?\n    @ignore\n    @relation(name: \"ShadowWorkspace\", fields: [shadowWorkspaceId], references: [id], onDelete: SetNull) // valid trailing comment",
      );
    expect(parseTenantPurgeDirectRelations(optionalDrift)).toContainEqual(expect.objectContaining({ model: "WorkspaceFeatureFlag", relationField: "shadowWorkspace", relationName: "ShadowWorkspace" }));
    expect(() => assertTenantPurgeScopeRegistry(optionalDrift)).toThrow(/relation registry drift/);
    const fieldDrift = schema.replace("  workspaceId String\n", "  workspaceId String?\n").replace("  workspace Workspace @relation(fields: [workspaceId]", "  workspace Workspace? @relation(fields: [workspaceId]");
    expect(() => assertTenantPurgeScopeRegistry(fieldDrift)).toThrow(/relation registry drift/);
  });
});
