"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { FormMessage } from "./FormMessage";

type DeliberationComposerProps = {
  postAction: (formData: FormData) => Promise<void>;
  hiddenFields: Record<string, string>;
  entryTypes: Array<{ value: string; label: string; variant: string }>;
  targetOptions?: Array<{ value: string; label: string }>;
  defaultTargetValue?: string;
  title?: string;
};

export function DeliberationComposer({ postAction, hiddenFields, entryTypes, targetOptions = [], defaultTargetValue = "", title }: DeliberationComposerProps) {
  const [selectedType, setSelectedType] = useState(entryTypes[0]?.value || "REACTION");
  const [selectedTarget, setSelectedTarget] = useState(defaultTargetValue);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const t = useTranslations("deliberation");

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    formData.set("entryType", selectedType);
    formData.delete("targetCircleId");
    formData.delete("targetMemberId");
    if (selectedTarget.startsWith("circle:")) {
      formData.set("targetCircleId", selectedTarget.slice("circle:".length));
    } else if (selectedTarget.startsWith("member:")) {
      formData.set("targetMemberId", selectedTarget.slice("member:".length));
    }

    startTransition(async () => {
      try {
        await postAction(formData);
        setMessage({ type: "success", text: t("entryPosted") });
        const form = e.target as HTMLFormElement;
        form.reset();
        // Clear message after a short delay or just leave it
        setTimeout(() => setMessage(null), 3000);
      } catch (err: any) {
        setMessage({ type: "error", text: err.message || t("entryPostFailed") });
      }
    });
  };

  return (
    <div className="delib-composer">
      {title && <h3 className="font-playfair font-semibold mb-4 text-[1.1rem]">{title}</h3>}
      
      {message && (
        <div className="mb-4">
          <FormMessage type={message.type} message={message.text} />
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {Object.entries(hiddenFields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}

        <textarea
          name="bodyMd"
          required
          placeholder={t("entryPlaceholder")}
          rows={4}
          disabled={isPending}
          style={{ width: "100%", padding: "12px", borderRadius: "8px", border: "1px solid var(--line)" }}
        />

        <div className="delib-composer-toolbar">
          <div className="delib-inline-tags">
            {entryTypes.map((type) => (
              <button
                key={type.value}
                type="button"
                className={`delib-inline-tag ${selectedType === type.value ? "delib-inline-tag-active" : ""}`}
                onClick={() => setSelectedType(type.value)}
              >
                {type.label}
              </button>
            ))}
          </div>
          {targetOptions.length > 0 && (
            <select
              aria-label={t("targetAriaLabel")}
              value={selectedTarget}
              onChange={(event) => setSelectedTarget(event.target.value)}
              disabled={isPending}
              className="delib-target-select"
            >
              <option value="">{t("noTarget")}</option>
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          )}
          <button type="submit" disabled={isPending} className="small">
            {isPending ? t("posting") : t("postEntry")}
          </button>
        </div>
      </form>
    </div>
  );
}
