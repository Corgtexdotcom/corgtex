import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import {
  declineCommunicationSuggestionAction,
  failCommunicationSuggestionAction,
  markCommunicationSuggestionSentAction,
  requestCommunicationSuggestionExecutionAction,
  updateCommunicationSuggestionAction,
} from "./actions";
import { accountHref } from "./view-model";

type CommunicationSuggestion = {
  id: string;
  status: string;
  channel: string;
  title: string;
  subject?: string | null;
  bodyMd: string;
  recipientEmail?: string | null;
  recipientName?: string | null;
  source: string;
  requestedAt?: Date | string | null;
  sentAt?: Date | string | null;
  declinedAt?: Date | string | null;
  failedAt?: Date | string | null;
  failureReason?: string | null;
  account?: { id: string; name: string } | null;
  contact?: { id: string; name?: string | null; email: string } | null;
  deal?: { id: string; title: string } | null;
};

type Labels = {
  title: string;
  status: Record<string, string>;
  recipient: string;
  subject: string;
  body: string;
  source: string;
  account: string;
  contact: string;
  deal: string;
  noRecipient: string;
  noSubject: string;
  copyDraft: string;
  edit: string;
  save: string;
  requestExecution: string;
  markSent: string;
  decline: string;
  failureReason: string;
  fail: string;
  requestedAt: string;
  sentAt: string;
  declinedAt: string;
  failedAt: string;
  externalExecutionNote: string;
};

export function CommunicationSuggestionCard({
  workspaceId,
  suggestion,
  labels,
  formatDate,
}: {
  workspaceId: string;
  suggestion: CommunicationSuggestion;
  labels: Labels;
  formatDate: (value: Date | string) => string;
}) {
  const isFinal = suggestion.status === "SENT" || suggestion.status === "DECLINED";
  const statusLabel = labels.status[suggestion.status] ?? suggestion.status;
  const recipient = suggestion.recipientName || suggestion.recipientEmail
    ? [suggestion.recipientName, suggestion.recipientEmail].filter(Boolean).join(" · ")
    : labels.noRecipient;

  return (
    <div className="item" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: "1rem" }}>{suggestion.title}</strong>
          <div className="muted" style={{ fontSize: "0.84rem", marginTop: 4 }}>
            {recipient}
          </div>
        </div>
        <span className="tag" style={{ marginLeft: "auto" }}>{statusLabel}</span>
      </div>

      <div className="nr-tag-group">
        <span className="tag-sm">{suggestion.channel}</span>
        <span className="tag-sm">{labels.source}: {suggestion.source}</span>
        {suggestion.account && (
          <span className="tag-sm">
            {labels.account}: <a href={accountHref(workspaceId, suggestion.account.id)}>{suggestion.account.name}</a>
          </span>
        )}
        {suggestion.contact && (
          <span className="tag-sm">{labels.contact}: {suggestion.contact.name || suggestion.contact.email}</span>
        )}
        {suggestion.deal && (
          <span className="tag-sm">{labels.deal}: {suggestion.deal.title}</span>
        )}
      </div>

      <div>
        <div className="muted" style={{ fontSize: "0.78rem", marginBottom: 4 }}>{labels.subject}</div>
        <div style={{ fontWeight: 600 }}>{suggestion.subject || labels.noSubject}</div>
      </div>

      <label>
        {labels.copyDraft}
        <textarea readOnly value={suggestion.bodyMd} rows={5} style={{ fontSize: "0.86rem" }} />
      </label>

      {suggestion.failureReason && (
        <div style={{ background: "var(--danger-soft)", border: "1px solid var(--danger-border)", color: "var(--danger)", borderRadius: 8, padding: 12, fontSize: "0.86rem" }}>
          {suggestion.failureReason}
        </div>
      )}

      <div className="nr-tag-group">
        {suggestion.requestedAt && <span className="tag-sm">{labels.requestedAt}: {formatDate(suggestion.requestedAt)}</span>}
        {suggestion.sentAt && <span className="tag-sm">{labels.sentAt}: {formatDate(suggestion.sentAt)}</span>}
        {suggestion.declinedAt && <span className="tag-sm">{labels.declinedAt}: {formatDate(suggestion.declinedAt)}</span>}
        {suggestion.failedAt && <span className="tag-sm">{labels.failedAt}: {formatDate(suggestion.failedAt)}</span>}
      </div>

      {!isFinal && (
        <details>
          <summary className="link-button small" style={{ cursor: "pointer", width: "fit-content" }}>{labels.edit}</summary>
          <form action={updateCommunicationSuggestionAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>{labels.title} <input name="title" defaultValue={suggestion.title} required /></label>
              <label>{labels.recipient} <input type="email" name="recipientEmail" defaultValue={suggestion.recipientEmail ?? ""} /></label>
              <label>{labels.subject} <input name="subject" defaultValue={suggestion.subject ?? ""} /></label>
            </div>
            <label>
              {labels.body}
              <MarkdownEditor name="bodyMd" defaultValue={suggestion.bodyMd} rows={4} required />
            </label>
            <button type="submit" className="small" style={{ width: "fit-content" }}>{labels.save}</button>
          </form>
        </details>
      )}

      <div className="row" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }}>
        {!isFinal && (
          <>
            <form action={requestCommunicationSuggestionExecutionAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="suggestionId" value={suggestion.id} />
              <button type="submit" className="small">{labels.requestExecution}</button>
            </form>
            <form action={markCommunicationSuggestionSentAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="suggestionId" value={suggestion.id} />
              <button type="submit" className="secondary small">{labels.markSent}</button>
            </form>
            <form action={declineCommunicationSuggestionAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="suggestionId" value={suggestion.id} />
              <button type="submit" className="danger small">{labels.decline}</button>
            </form>
          </>
        )}
      </div>

      {!isFinal && (
        <details>
          <summary className="link-button small" style={{ cursor: "pointer", width: "fit-content" }}>{labels.fail}</summary>
          <form action={failCommunicationSuggestionAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <label>{labels.failureReason} <input name="failureReason" /></label>
            <button type="submit" className="danger small" style={{ width: "fit-content" }}>{labels.fail}</button>
          </form>
        </details>
      )}

      <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>{labels.externalExecutionNote}</p>
    </div>
  );
}
