"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { createProposalAction } from "../actions";

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
    <form ref={formRef} action={handleCreateProposal} className="stack nr-form-section" style={{ marginTop: "16px" }}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label>
        {t("formTitle")}
        <input name="title" required />
      </label>
      <label>
        {t("formSummary")}
        <input name="summary" />
      </label>
      <label>
        {t("formBody")}
        <MarkdownEditor key={editorKey} name="bodyMd" required placeholder={t("formBodyPlaceholder")} />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "normal", cursor: "pointer" }}>
        <input type="checkbox" name="isPrivate" defaultChecked />
        <span>{t("formPrivateDraft")}</span>
      </label>
      <CreateProposalButton label={t("btnCreateDraft")} />
    </form>
  );
}
