import { createActionEvent } from "./work-item-events";

// Compiled by the aggregate typecheck; never executed as runtime fixtures.
function typeExamples() {
  createActionEvent("action.created", { actionId: "a1", title: "Synthetic" }, "ws1");
  createActionEvent("action.updated", { actionId: "a1", fields: ["title"] }, "ws1");
  // @ts-expect-error Creation requires a title, not an update payload.
  createActionEvent("action.created", { actionId: "a1", fields: ["title"] }, "ws1");
  // @ts-expect-error Updates require a field list, not a creation payload.
  createActionEvent("action.updated", { actionId: "a1", title: "Synthetic" }, "ws1");
  // @ts-expect-error Unmigrated event names have no producer factory.
  createActionEvent("action.published", { actionId: "a1", title: "Synthetic" }, "ws1");
  // @ts-expect-error IDs must be strings.
  createActionEvent("action.created", { actionId: 1, title: "Synthetic" }, "ws1");
  // @ts-expect-error Version interpretation belongs to the contract factory.
  createActionEvent("action.created", { actionId: "a1", title: "Synthetic", eventVersion: 2 }, "ws1");
  const uncertainName = "action.created" as "action.created" | "action.updated";
  // @ts-expect-error A union name cannot safely accept only the creation payload.
  createActionEvent(uncertainName, { actionId: "a1", title: "Synthetic" }, "ws1");
}
void typeExamples;
