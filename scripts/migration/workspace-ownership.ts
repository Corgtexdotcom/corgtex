import { Prisma } from "@prisma/client";
import { TENANT_PURGE_DERIVED_SELECTORS, assertTenantPurgeDerivedSelectorRegistry } from "../../packages/domain/src/tenant-purge-derived-selectors";

export type WorkspaceOwnershipStep = { table: string; from: string[]; to: string[] };
export type WorkspaceOwnershipRule = { steps: WorkspaceOwnershipStep[]; field: string };
export type WorkspaceModelMetadata = (typeof Prisma.dmmf.datamodel.models)[number];

// Pure schema/ownership metadata shared by the DB guards and tenant mover.
// Purge dispositions and deletion semantics do not authorize any transfer.
// Steps follow local String-key joins; field contains the terminal Workspace id.
// Multiple rules describe all known ownership paths, not a choice of one owner.
export function getWorkspaceModelMetadata(): Map<string, WorkspaceModelMetadata> {
  return new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, model]));
}

export function getWorkspaceOwnershipRules(): Map<string, WorkspaceOwnershipRule[]> {
  assertTenantPurgeDerivedSelectorRegistry(Prisma.dmmf.datamodel.models);
  const models = getWorkspaceModelMetadata();
  const rules = new Map<string, WorkspaceOwnershipRule[]>();
  function add(model: string, rule: WorkspaceOwnershipRule) {
    const current = rules.get(model) ?? [];
    if (!current.some((candidate) => JSON.stringify(candidate) === JSON.stringify(rule))) current.push(rule);
    rules.set(model, current);
  }
  for (const model of models.values()) {
    for (const relation of model.fields) {
      if (relation.kind === "object" && relation.type === "Workspace" && relation.relationFromFields?.length) {
        if (relation.relationFromFields.length !== 1 || relation.relationToFields?.[0] !== "id") throw new Error(`Unsupported Workspace relation ${model.name}.${relation.name}`);
        add(model.name, { steps: [], field: relation.relationFromFields[0] });
      }
    }
  }
  for (const selector of TENANT_PURGE_DERIVED_SELECTORS) {
    if (!("target" in selector) || selector.target !== "WORKSPACE" || selector.kind === "SHARED_PRESERVE") continue;
    if (selector.kind === "DIRECT_SCALAR") add(selector.model, { steps: [], field: selector.path[0] });
    if (selector.kind === "DERIVED_UNIQUE_JOIN") add(selector.model, {
      steps: [{ table: selector.joinedModel, from: [selector.sourceField], to: [selector.uniqueField] }], field: selector.terminalField,
    });
    if (selector.kind === "RELATION_PATH") {
      let model = selector.model as string;
      const steps: WorkspaceOwnershipStep[] = [];
      let field = "";
      for (const segment of selector.path) {
        const relation = models.get(model)?.fields.find((candidate) => candidate.name === segment);
        if (!relation?.relationFromFields?.length || !relation.relationToFields?.length) throw new Error(`Unsupported ownership path ${selector.model}.${selector.path.join(".")}`);
        if (relation.type === "Workspace") {
          if (relation.relationFromFields.length !== 1 || relation.relationToFields[0] !== "id") throw new Error("Unsupported workspace terminal");
          field = relation.relationFromFields[0];
        } else steps.push({ table: relation.type, from: [...relation.relationFromFields], to: [...relation.relationToFields] });
        model = relation.type;
      }
      add(selector.model, { steps, field });
    }
  }
  return rules;
}
