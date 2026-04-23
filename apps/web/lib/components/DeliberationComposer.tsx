"use client";

import { useState, useTransition } from "react";
import { FormMessage } from "./FormMessage";

type DeliberationComposerProps = {
  postAction: (formData: FormData) => Promise<void>;
  hiddenFields: Record<string, string>;
  entryTypes: Array<{ value: string; label: string; variant: string }>;
};

export function DeliberationComposer({ postAction, hiddenFields, entryTypes }: DeliberationComposerProps) {
  const [selectedType, setSelectedType] = useState(entryTypes[0]?.value || "REACTION");
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    formData.set("entryType", selectedType);

    startTransition(async () => {
      try {
        await postAction(formData);
        setMessage({ type: "success", text: "Entry posted successfully." });
        const form = e.target as HTMLFormElement;
        form.reset();
        // Clear message after a short delay or just leave it
        setTimeout(() => setMessage(null), 3000);
      } catch (err: any) {
        setMessage({ type: "error", text: err.message || "Failed to post entry." });
      }
    });
  };

  return (
    <div className="delib-composer">
      <h3 className="font-playfair font-semibold mb-4 text-[1.1rem]">Add to deliberation</h3>
      
      {message && (
        <div className="mb-4">
          <FormMessage type={message.type} message={message.text} />
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {Object.entries(hiddenFields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        
        <div className="delib-type-selector">
          {entryTypes.map((type) => (
            <button
              key={type.value}
              type="button"
              className={`delib-type-btn ${selectedType === type.value ? "delib-type-btn-active" : "bg-white text-muted"}`}
              onClick={() => setSelectedType(type.value)}
            >
              {type.label}
            </button>
          ))}
        </div>

        <textarea
          name="bodyMd"
          required
          placeholder="Write your entry in markdown..."
          rows={4}
          disabled={isPending}
          style={{ width: "100%", padding: "12px", borderRadius: "8px", border: "1px solid var(--line)" }}
        />

        <div>
          <button type="submit" disabled={isPending}>
            {isPending ? "Posting..." : "Post Entry"}
          </button>
        </div>
      </form>
    </div>
  );
}
