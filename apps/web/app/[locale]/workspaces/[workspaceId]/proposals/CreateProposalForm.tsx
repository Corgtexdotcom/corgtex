"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import { createProposalAction } from "../actions";
import { ProposalDraftFields } from "./ProposalDraftFields";

function CreateProposalButton({ label }: { label: string }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "..." : label}
    </button>
  );
}

export function CreateProposalForm({ workspaceId }: { workspaceId: string }) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const router = useRouter();
  const t = useTranslations("proposals");

  async function handleCreateProposal(formData: FormData) {
    await createProposalAction(formData);
    formRef.current?.reset();
    setEditorKey((key) => key + 1);
    router.refresh();
  }

  return (
    <form ref={formRef} action={handleCreateProposal} className="stack nr-form-section mt-4">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <ProposalDraftFields key={editorKey} />
      <label className="nr-checkbox-label">
        <input type="checkbox" name="isPrivate" defaultChecked />
        <span>{t("formPrivateDraft")}</span>
      </label>
      <CreateProposalButton label={t("btnCreateDraft")} />
    </form>
  );
}
