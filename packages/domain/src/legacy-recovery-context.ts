import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";

// Only omission of newly captured observer identity, never a read grant. Target
// governors and every original saved vector remain checked by the real evaluator.
type Scope = {actor:AppActor;workspaceId:string;targetKind:string;targetId:string;receiptId?:string;tx?:Prisma.TransactionClient;assertCurrent?:(tx:Prisma.TransactionClient)=>Promise<void>;active:boolean};
const scopes = new AsyncLocalStorage<Scope>();
export async function withCompanyLegacyRecoveryCapture<T>(binding:Omit<Scope,"active">,work:()=>Promise<T>) {
  const scope={...binding,active:true};
  try{return await scopes.run(scope,work);}finally{scope.active=false;}
}
export function hasCompanyLegacyRecoveryCapture(actor:AppActor,workspaceId:string,tx:Prisma.TransactionClient) {
  const scope=scopes.getStore();
  return Boolean(scope?.active && scope.actor===actor && scope.workspaceId===workspaceId && (!scope.tx || scope.tx===tx));
}
export function isCompanyLegacyRecoveryOutcome(kind:string,row:Record<string,unknown>) {
  const control=row.controlJson;
  return kind==="ConversationOperationOutcome" && row.operation==="LEGACY_RECOVERY_PUBLICATION"
    && control!==null && typeof control==="object" && !Array.isArray(control)
    && (control as Record<string,unknown>).version===1 && (control as Record<string,unknown>).audience==="COMPANY";
}

export async function assertCompanyLegacyRecoveryCaptureCurrent(actor:AppActor,workspaceId:string,tx:Prisma.TransactionClient) {
  const scope=scopes.getStore();
  if(hasCompanyLegacyRecoveryCapture(actor,workspaceId,tx)) await scope?.assertCurrent?.(tx);
}
