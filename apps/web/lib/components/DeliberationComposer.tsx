"use client";

import { useState, useTransition } from "react";


export type DeliberationComposerProps = {
  postAction: (formData: FormData) => Promise<{ success: boolean; error?: string }>;
  hiddenFields?: Record<string, string>;
};

const TYPES = ["SUPPORT", "QUESTION", "CONCERN", "OBJECTION", "REACTION"];

export function DeliberationComposer({ postAction, hiddenFields = {} }: DeliberationComposerProps) {
  const [entryType, setEntryType] = useState("REACTION");
  const [bodyMd, setBodyMd] = useState("");
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!bodyMd.trim()) return;

    setMessage(null);
    const formData = new FormData();
    formData.append("entryType", entryType);
    formData.append("bodyMd", bodyMd);
    Object.entries(hiddenFields).forEach(([key, val]) => {
      formData.append(key, val);
    });

    startTransition(async () => {
      try {
        const res = await postAction(formData);
        if (res.success) {
          setBodyMd("");
          setEntryType("REACTION");
          setMessage({ type: "success", text: "Entry posted successfully." });
        } else {
          setMessage({ type: "error", text: res.error || "Failed to post entry." });
        }
      } catch (err: any) {
        setMessage({ type: "error", text: err.message || "An unexpected error occurred." });
      }
    });
  };

  return (
    <div className="delib-composer">
      <h3 className="text-lg font-bold mb-4">Add to deliberation</h3>
      
      {message && (
        <div className={`p-3 mb-4 rounded border text-sm ${message.type === "success" ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800"}`}>
          {message.text}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="delib-type-selector">
          {TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={`delib-type-btn ${entryType === t ? "delib-type-btn-active" : ""}`}
              onClick={() => setEntryType(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <textarea
          className="input w-full min-h-[100px] mb-3 p-3"
          placeholder="Type your entry here (Markdown supported)..."
          value={bodyMd}
          onChange={(e) => setBodyMd(e.target.value)}
          disabled={isPending}
          required
        />

        <div className="flex justify-end">
          <button type="submit" className="btn btn-primary" disabled={isPending || !bodyMd.trim()}>
            {isPending ? "Posting..." : "Post Entry"}
          </button>
        </div>
      </form>
    </div>
  );
}
