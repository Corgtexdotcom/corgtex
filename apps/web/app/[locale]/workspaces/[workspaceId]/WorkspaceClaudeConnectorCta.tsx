"use client";

import { Plug } from "lucide-react";
import { useTranslations } from "next-intl";
import { CLAUDE_INSTALLER_PATH } from "@/lib/install-helpers";

export function WorkspaceClaudeConnectorCta({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("chat");
  const label = t("connectClaudeLabel");
  const description = t("connectClaudeDescription");

  if (compact) {
    return (
      <a
        href={CLAUDE_INSTALLER_PATH}
        target="_blank"
        rel="noreferrer"
        className="ws-claude-cta ws-claude-cta-compact"
        aria-label={`${label}. ${description}`}
        title={`${label}: ${description}`}
      >
        <Plug aria-hidden="true" className="ws-claude-cta-icon" strokeWidth={1.9} />
      </a>
    );
  }

  return (
    <a
      href={CLAUDE_INSTALLER_PATH}
      target="_blank"
      rel="noreferrer"
      className="ws-claude-cta"
      aria-label={`${label}. ${description}`}
    >
      <span className="ws-claude-cta-icon-wrap">
        <Plug aria-hidden="true" className="ws-claude-cta-icon" strokeWidth={1.9} />
      </span>
      <span className="ws-claude-cta-copy">
        <span className="ws-claude-cta-label">{label}</span>
        <span className="ws-claude-cta-description">{description}</span>
      </span>
    </a>
  );
}
