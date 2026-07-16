"use client";

import type { ReactNode } from "react";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type ExternalResourceAttachment = {
  id: string;
  purpose: string;
  resource: {
    id: string;
    providerKey: string;
    resourceType: string;
    category: string;
    priority: number;
    title: string;
    url: string;
    summaryMd: string | null;
    descriptionMd: string | null;
    lastEnrichmentError: string | null;
  };
};

export function ExternalResourceCards({ attachments }: { attachments: ExternalResourceAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {attachments.map((attachment) => (
        <article key={attachment.id} className="nr-item" style={{ padding: 14 }}>
          <div className="row" style={{ alignItems: "center", gap: 10 }}>
            <div>
              <strong className="nr-item-title">{attachment.resource.title}</strong>
              <p className="nr-item-meta" style={{ margin: "4px 0 0", fontSize: "0.8rem" }}>
                {attachment.resource.providerKey.replace(/_/g, " ").toUpperCase()} · {attachment.resource.category.toLowerCase()} · {attachment.resource.resourceType.replace(/_/g, " ")} · {attachment.purpose.replace(/_/g, " ")}
              </p>
            </div>
            <a href={attachment.resource.url} target="_blank" rel="noreferrer" className="button secondary small">
              Open
            </a>
          </div>
          {(attachment.resource.summaryMd || attachment.resource.descriptionMd) && (
            <p className="nr-item-meta" style={{ margin: "10px 0 0", whiteSpace: "pre-wrap" }}>
              {attachment.resource.summaryMd ?? attachment.resource.descriptionMd}
            </p>
          )}
          {attachment.resource.lastEnrichmentError && (
            <p className="form-message form-message-error" style={{ marginTop: 10 }}>
              Summary unavailable: {attachment.resource.lastEnrichmentError}
            </p>
          )}
        </article>
      ))}
    </div>
  );
}

function formDataJson(formData: FormData) {
  const payload: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && value.length > 0) {
      payload[key] = value;
    }
  }
  return payload;
}

async function responseErrorMessage(response: Response) {
  try {
    const body = await response.json();
    const message = body?.error?.message;
    return typeof message === "string" && message.length > 0 ? message : "Could not save reference.";
  } catch {
    return "Could not save reference.";
  }
}

export function ExternalResourceAttachForm({ action, apiEndpoint, hiddenFields, children }: {
  action?: (formData: FormData) => void | Promise<void>;
  apiEndpoint?: string;
  hiddenFields: Record<string, string>;
  children?: ReactNode;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isHydrated, setIsHydrated] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const submitDisabled = isPending || (Boolean(apiEndpoint) && !isHydrated);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    if (!apiEndpoint) return;

    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    startTransition(async () => {
      try {
        const response = await fetch(apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formDataJson(formData)),
        });
        if (!response.ok) {
          throw new Error(await responseErrorMessage(response));
        }
        form.reset();
        setMessage({ type: "success", text: "Reference saved." });
        router.refresh();
      } catch (error: unknown) {
        setMessage({
          type: "error",
          text: error instanceof Error && error.message.length > 0 ? error.message : "Could not save reference.",
        });
      }
    });
  };

  return (
    <form
      action={apiEndpoint ? undefined : action}
      onSubmit={handleSubmit}
      className="stack nr-form-section"
      data-api-ready={apiEndpoint ? String(isHydrated) : undefined}
      style={{ gap: 10, marginTop: 12 }}
    >
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label>
        Reference link
        <input name="url" type="url" placeholder="https://..." required />
      </label>
      <label>
        Description
        <textarea name="descriptionMd" rows={3} placeholder="What this file is for" />
      </label>
      <button type="submit" className="secondary small" disabled={submitDisabled} style={{ alignSelf: "flex-start" }}>
        Save reference
      </button>
      {message && <div className={`form-message form-message-${message.type}`}>{message.text}</div>}
      {children}
    </form>
  );
}
