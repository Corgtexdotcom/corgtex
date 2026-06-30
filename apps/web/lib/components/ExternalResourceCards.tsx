import type { ReactNode } from "react";

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

export function ExternalResourceAttachForm({ action, hiddenFields, children }: {
  action: (formData: FormData) => void | Promise<void>;
  hiddenFields: Record<string, string>;
  children?: ReactNode;
}) {
  return (
    <form action={action} className="stack nr-form-section" style={{ gap: 10, marginTop: 12 }}>
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
      <button type="submit" className="secondary small" style={{ alignSelf: "flex-start" }}>
        Save reference
      </button>
      {children}
    </form>
  );
}
