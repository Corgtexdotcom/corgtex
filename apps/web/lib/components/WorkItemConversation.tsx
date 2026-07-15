import type { ReactNode } from "react";

import { MarkdownRenderer } from "./MarkdownRenderer";

export type WorkItemRequestReply = {
  id: string;
  authorName: string;
  createdAtLabel: string | null;
  bodyMd?: string | null;
};

export type WorkItemRequestCard = {
  id: string;
  audienceLabel: string;
  channelLabel: string;
  requestedByLabel: string;
  deadlineLabel?: string | null;
  reminderLabel?: string | null;
  messageMd: string;
  copyableMessage: string;
  linkedReplies: WorkItemRequestReply[];
  replyForm?: ReactNode;
};

export type WorkItemRequestListLabels = {
  copyableMessage: string;
  linkedReplies: (count: number) => string;
  replyToRequest?: string;
};

export function WorkItemConversationSurface({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`work-conversation ${className}`.trim()}>
      <div className="work-conversation-header">
        <h2 className="nr-section-header">{title}</h2>
      </div>
      <div className="work-conversation-body">
        {children}
      </div>
    </section>
  );
}

export function WorkItemRequestList({
  requests,
  labels,
}: {
  requests: WorkItemRequestCard[];
  labels: WorkItemRequestListLabels;
}) {
  if (requests.length === 0) return null;

  return (
    <div className="work-request-list">
      {requests.map((request) => (
        <article key={request.id} className="work-request-card">
          <header className="work-request-card-header">
            <div className="work-request-card-title">
              <strong>{request.audienceLabel}</strong>
              <span>{request.requestedByLabel}</span>
            </div>
            <div className="work-request-card-tags">
              <span className="tag info">{request.channelLabel}</span>
              {request.deadlineLabel && <span className="tag warning">{request.deadlineLabel}</span>}
            </div>
          </header>

          {request.reminderLabel && (
            <p className="work-request-meta">{request.reminderLabel}</p>
          )}

          <div className="work-request-message">
            <MarkdownRenderer markdown={request.messageMd} variant="document" />
          </div>

          <details className="work-request-copy">
            <summary className="work-request-action nr-hide-marker">{labels.copyableMessage}</summary>
            <textarea readOnly rows={6} value={request.copyableMessage} />
          </details>

          {request.linkedReplies.length > 0 && (
            <div className="work-request-replies">
              <div className="work-request-replies-title">{labels.linkedReplies(request.linkedReplies.length)}</div>
              <div className="work-request-reply-list">
                {request.linkedReplies.map((reply) => (
                  <article key={reply.id} className="work-request-reply">
                    <div className="work-request-reply-meta">
                      <span>{reply.authorName}</span>
                      {reply.createdAtLabel && <span>{reply.createdAtLabel}</span>}
                    </div>
                    {reply.bodyMd && <MarkdownRenderer markdown={reply.bodyMd} variant="document" />}
                  </article>
                ))}
              </div>
            </div>
          )}

          {request.replyForm && labels.replyToRequest && (
            <details className="work-request-reply-form">
              <summary className="work-request-action nr-hide-marker">{labels.replyToRequest}</summary>
              <div className="work-request-reply-form-body">
                {request.replyForm}
              </div>
            </details>
          )}
        </article>
      ))}
    </div>
  );
}
