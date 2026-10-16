import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { assertCompanyLegacyRecoveryCaptureCurrent, hasCompanyLegacyRecoveryCapture, isCompanyLegacyRecoveryOutcome, withCompanyLegacyRecoveryCapture } from "./legacy-recovery-context";

describe("company recovery capture scope",()=>{
  it("binds the actual actor/workspace/transaction and revokes detached continuations",async()=>{
    const actor={kind:"user",user:{id:"operator"}} as AppActor;
    const tx={} as Prisma.TransactionClient;
    const current=vi.fn(async()=>{});
    let proceed!:()=>void;
    const gate=new Promise<void>(resolve=>{proceed=resolve;});
    let detached!:Promise<boolean>;
    await withCompanyLegacyRecoveryCapture({actor,workspaceId:"w",targetKind:"Document",targetId:"d",tx,assertCurrent:current},async()=>{
      expect(hasCompanyLegacyRecoveryCapture(actor,"w",tx)).toBe(true);
      expect(hasCompanyLegacyRecoveryCapture({...actor},"w",tx)).toBe(false);
      expect(hasCompanyLegacyRecoveryCapture(actor,"foreign",tx)).toBe(false);
      expect(hasCompanyLegacyRecoveryCapture(actor,"w",{} as Prisma.TransactionClient)).toBe(false);
      await assertCompanyLegacyRecoveryCaptureCurrent(actor,"w",tx);
      detached=(async()=>{await gate;return hasCompanyLegacyRecoveryCapture(actor,"w",tx);})();
    });
    proceed();expect(await detached).toBe(false);
    expect(current).toHaveBeenCalledExactlyOnceWith(tx);
  });
  it("never classifies another outcome or a private target as company issuer provenance",()=>{
    expect(isCompanyLegacyRecoveryOutcome("ConversationOperationOutcome",{operation:"LEGACY_RECOVERY_PUBLICATION",controlJson:{version:1,audience:"COMPANY"}})).toBe(true);
    expect(isCompanyLegacyRecoveryOutcome("ConversationOperationOutcome",{operation:"BRAIN_EXPORT_CONSENT",controlJson:{version:1,audience:"COMPANY"}})).toBe(false);
    expect(isCompanyLegacyRecoveryOutcome("ConversationOperationOutcome",{operation:"LEGACY_RECOVERY_PUBLICATION",controlJson:{version:1,audience:"OWNER"}})).toBe(false);
  });
});
