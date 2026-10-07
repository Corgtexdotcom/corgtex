"use client";

import React, { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, Check } from "lucide-react";
import { ActionMenu } from "@/lib/components/ui/ActionMenu";
import { Dialog } from "@/lib/components/Dialog";
import {
  workspaceHomeHref,
  workspaceOptions,
} from "./workspace-switcher-model";

export type SwitchableWorkspace = {
  id: string;
  name: string;
  slug: string;
  primaryName: string;
  secondaryLabel: string;
};

export function WorkspaceSwitcher({
  workspaceId,
  workspaces,
  mobile = false,
}: {
  workspaceId: string;
  workspaces: SwitchableWorkspace[];
  mobile?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("workspaceSwitcher");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [switching, setSwitching] = useState(false);
  const navigating = useRef(false);
  useEffect(() => {
    // Back/forward cache can restore the departing document with its click lock.
    function restore() {
      navigating.current = false;
      setSwitching(false);
    }
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  if (!current) return null;
  const branding = current;
  const identity = (
    <>
      <span className="workspace-switcher-identity">
        <strong>{branding.primaryName}</strong>
        <small>{branding.secondaryLabel}</small>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </>
  );

  function select(workspace: SwitchableWorkspace, close: () => void) {
    if (navigating.current) return;
    if (workspace.id === workspaceId) {
      close();
      return;
    }
    // Editors do not share a dirty-state contract. A bounded warning protects
    // drafts everywhere, including chat and contenteditable editors.
    if (!window.confirm(t("leaveWarning", { name: workspace.name }))) return;
    navigating.current = true;
    setSwitching(true);
    // A document navigation preserves the session cookie while discarding all
    // mounted workspace state and pending responses. Never translate entity URLs.
    window.location.assign(workspaceHomeHref(locale, workspace.id));
  }

  function content(close: () => void) {
    const options = workspaceOptions(workspaces, query);
    return (
      <div className="workspace-switcher-content">
        {workspaces.length > 8 && (
          <label className="workspace-switcher-search">
            {t("search")}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
        <div className="workspace-switcher-list" aria-label={t("title")}>
          {options.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className="workspace-switcher-option"
              disabled={switching}
              aria-current={workspace.id === workspaceId ? "true" : undefined}
              onClick={() => select(workspace, close)}
            >
              <span>
                <strong>{workspace.name}</strong>
                {workspace.disambiguator && (
                  <small>{workspace.disambiguator}</small>
                )}
              </span>
              {workspace.id === workspaceId && (
                <>
                  <Check size={16} aria-hidden="true" />
                  <span className="sr-only">{t("current")}</span>
                </>
              )}
            </button>
          ))}
          {options.length === 0 && <p role="status">{t("empty")}</p>}
        </div>
        {switching && <p role="status">{t("switching")}</p>}
      </div>
    );
  }

  if (workspaces.length < 2)
    return (
      <a
        className="workspace-switcher-static"
        href={workspaceHomeHref(locale, workspaceId)}
      >
        <span className="workspace-switcher-identity">
          <strong>{branding.primaryName}</strong>
          <small>{branding.secondaryLabel}</small>
        </span>
      </a>
    );
  if (mobile)
    return (
      <>
        <button
          className="workspace-switcher-trigger"
          type="button"
          aria-label={t("trigger", { name: branding.primaryName })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
        >
          {identity}
        </button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title={t("title")}
          className="workspace-switcher-dialog"
        >
          {content(() => setOpen(false))}
        </Dialog>
      </>
    );
  return (
    <ActionMenu
      label={t("trigger", { name: branding.primaryName })}
      trigger={identity}
      triggerClassName="workspace-switcher-trigger"
      panelClassName="workspace-switcher-panel"
      panelRole="dialog"
    >
      {content}
    </ActionMenu>
  );
}
