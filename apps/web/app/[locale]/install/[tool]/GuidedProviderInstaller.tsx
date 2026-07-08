"use client";

import { useMemo, useState } from "react";
import {
  CHATGPT_CONNECTORS_ADVANCED_URL,
  CHATGPT_CONNECTORS_URL,
  COPILOT_DOCS_URL,
  COPILOT_VSCODE_MCP_DOCS_URL,
  CURSOR_MCP_DOCS_URL,
  GEMINI_MCP_DOCS_URL,
  OPENWORK_DOWNLOAD_URL,
  buildCopilotCliCommand,
  buildCursorInstallLinks,
  buildCursorMcpJsonConfig,
  buildGeminiMcpCommand,
  buildGeminiMcpConfig,
  buildVsCodeMcpConfig,
  type InstallerProviderKey,
} from "@/lib/install-helpers";

const OPENAI_APPS_SDK_QUICKSTART_URL = "https://developers.openai.com/apps-sdk/quickstart#add-your-app-to-chatgpt";

type ProviderConfig = {
  apiProviderKey: string;
  productName: string;
  title: string;
  intro: string;
  primaryAction: InstallerAction;
  secondaryActions: InstallerAction[];
  steps: string[];
  notes: string[];
};

type InstallerAction =
  | {
      kind: "copy";
      label: string;
      value: string;
      copiedMessage: string;
      fallbackMessage: string;
      variant?: "primary" | "secondary";
    }
  | {
      kind: "copyAndOpen";
      label: string;
      value: string;
      href: string;
      productName: string;
      variant?: "primary" | "secondary";
    }
  | {
      kind: "open";
      label: string;
      href: string;
      variant?: "primary" | "secondary";
    }
  | {
      kind: "cursorInstall";
      label: string;
      appHref: string;
      browserHref: string;
      variant?: "primary" | "secondary";
    };

type ActionStatus = {
  message: string;
  tone: "success" | "warning";
  manualValue?: string;
};

type Props = {
  providerKey: InstallerProviderKey;
  connectorUrl: string;
  workspaceId?: string | null;
  returnTo?: string | null;
};

async function writeClipboard(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): boolean {
  if (typeof window === "undefined") return false;
  return window.open(url, "_blank", "noopener,noreferrer") !== null;
}

function openCurrentWindow(url: string): boolean {
  if (typeof window === "undefined") return false;
  window.location.href = url;
  return true;
}

function parseRouteError(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return null;
}

function copyMcpUrlAction(connectorUrl: string, productName: string): InstallerAction {
  return {
    kind: "copy",
    label: "Copy MCP URL",
    value: connectorUrl,
    copiedMessage: `Copied the Corgtex MCP URL for ${productName}.`,
    fallbackMessage: "Clipboard access was blocked. Select and copy the MCP URL.",
    variant: "secondary",
  };
}

function buildProviderConfig(providerKey: InstallerProviderKey, connectorUrl: string): ProviderConfig {
  const cursorLinks = buildCursorInstallLinks(connectorUrl);

  if (providerKey === "openwork") {
    return {
      apiProviderKey: "openwork",
      productName: "OpenWork",
      title: "Connect Corgtex to OpenWork",
      intro: "Use OpenWork as the work surface while Corgtex supplies governed context, policy, audit, and write-back.",
      primaryAction: {
        kind: "copyAndOpen",
        label: "Copy URL and open OpenWork",
        value: connectorUrl,
        href: OPENWORK_DOWNLOAD_URL,
        productName: "OpenWork",
        variant: "primary",
      },
      secondaryActions: [copyMcpUrlAction(connectorUrl, "OpenWork")],
      steps: [
        "Open your OpenWork workspace.",
        "Go to Extensions, then Advanced Settings, then Add MCP server.",
        "Paste the Corgtex MCP URL, enable OAuth, and let OpenWork open Corgtex.",
        "Authorize as your current Corgtex user for this workspace.",
      ],
      notes: [
        "OpenWork must support dynamic client registration for the OAuth connection.",
        "Provider email is not used for authorization; Corgtex uses the signed-in Corgtex user and workspace.",
      ],
    };
  }

  if (providerKey === "chatgpt") {
    return {
      apiProviderKey: "chatgpt",
      productName: "ChatGPT",
      title: "Connect Corgtex to ChatGPT",
      intro: "ChatGPT requires connector setup inside ChatGPT settings. This page gets the Corgtex URL ready and points you to the documented setup flow.",
      primaryAction: {
        kind: "copyAndOpen",
        label: "Copy URL and open ChatGPT Connectors",
        value: connectorUrl,
        href: CHATGPT_CONNECTORS_URL,
        productName: "ChatGPT connector settings",
        variant: "primary",
      },
      secondaryActions: [
        { kind: "open", label: "Open advanced settings", href: CHATGPT_CONNECTORS_ADVANCED_URL, variant: "secondary" },
        { kind: "open", label: "OpenAI setup guide", href: OPENAI_APPS_SDK_QUICKSTART_URL, variant: "secondary" },
        copyMcpUrlAction(connectorUrl, "ChatGPT"),
      ],
      steps: [
        "In ChatGPT, open Settings, then Connectors, then Advanced settings.",
        "Turn on Developer Mode if it is not already enabled.",
        "Create an app named Corgtex, paste the HTTPS Corgtex MCP URL, scan tools, and save it.",
        "When ChatGPT opens Corgtex, authorize as your current Corgtex user for this workspace.",
      ],
      notes: [
        "Business, Enterprise, or Edu workspaces may require an admin to approve or publish the app before members can use it.",
        "Corgtex can streamline the handoff, but ChatGPT still requires setup through its own settings UI.",
      ],
    };
  }

  if (providerKey === "cursor") {
    return {
      apiProviderKey: "cursor",
      productName: "Cursor",
      title: "Connect Corgtex to Cursor",
      intro: "Install the Corgtex MCP server in Cursor, then finish browser authorization in Corgtex.",
      primaryAction: {
        kind: "cursorInstall",
        label: "Add to Cursor",
        appHref: cursorLinks.app,
        browserHref: cursorLinks.browser,
        variant: "primary",
      },
      secondaryActions: [
        {
          kind: "copy",
          label: "Copy manual mcp.json",
          value: JSON.stringify(buildCursorMcpJsonConfig(connectorUrl), null, 2),
          copiedMessage: "Copied the Cursor MCP configuration.",
          fallbackMessage: "Clipboard access was blocked. Select and copy the Cursor MCP configuration.",
          variant: "secondary",
        },
        { kind: "open", label: "Cursor MCP docs", href: CURSOR_MCP_DOCS_URL, variant: "secondary" },
      ],
      steps: [
        "Click Add to Cursor.",
        "Approve the Corgtex MCP install prompt in Cursor.",
        "When Cursor opens Corgtex, authorize as your current Corgtex user for this workspace.",
        "If the app prompt does not open, use the browser fallback or paste the manual mcp.json.",
      ],
      notes: ["Ask Cursor for a no-change Corgtex readiness report before editing files."],
    };
  }

  if (providerKey === "copilot") {
    return {
      apiProviderKey: "copilot",
      productName: "GitHub Copilot",
      title: "Connect Corgtex to GitHub Copilot",
      intro: "Use the VS Code or Copilot CLI MCP path. Repository and cloud-agent OAuth setup is intentionally not offered here.",
      primaryAction: {
        kind: "copy",
        label: "Copy VS Code config",
        value: JSON.stringify(buildVsCodeMcpConfig(connectorUrl), null, 2),
        copiedMessage: "Copied the VS Code MCP configuration.",
        fallbackMessage: "Clipboard access was blocked. Select and copy the VS Code MCP configuration.",
        variant: "primary",
      },
      secondaryActions: [
        {
          kind: "copy",
          label: "Copy Copilot CLI command",
          value: buildCopilotCliCommand(connectorUrl),
          copiedMessage: "Copied the Copilot CLI command.",
          fallbackMessage: "Clipboard access was blocked. Select and copy the Copilot CLI command.",
          variant: "secondary",
        },
        { kind: "open", label: "VS Code MCP docs", href: COPILOT_VSCODE_MCP_DOCS_URL, variant: "secondary" },
        { kind: "open", label: "Copilot CLI docs", href: COPILOT_DOCS_URL, variant: "secondary" },
      ],
      steps: [
        "In VS Code, run MCP: Add Server or paste the copied user or workspace mcp.json entry.",
        "For Copilot CLI, use /mcp add or paste the copied command.",
        "When Copilot opens Corgtex, authorize as your current Corgtex user for this workspace.",
      ],
      notes: ["OAuth-backed remote MCP is not assumed for GitHub's repository or cloud-agent path."],
    };
  }

  if (providerKey === "gemini") {
    return {
      apiProviderKey: "gemini",
      productName: "Gemini CLI",
      title: "Connect Corgtex to Gemini CLI",
      intro: "Add Corgtex as an HTTP MCP server in Gemini CLI, then finish browser authorization in Corgtex.",
      primaryAction: {
        kind: "copy",
        label: "Copy Gemini command",
        value: buildGeminiMcpCommand(connectorUrl),
        copiedMessage: "Copied the Gemini CLI MCP command.",
        fallbackMessage: "Clipboard access was blocked. Select and copy the Gemini CLI MCP command.",
        variant: "primary",
      },
      secondaryActions: [
        {
          kind: "copy",
          label: "Copy settings JSON",
          value: JSON.stringify(buildGeminiMcpConfig(connectorUrl), null, 2),
          copiedMessage: "Copied the Gemini CLI MCP settings.",
          fallbackMessage: "Clipboard access was blocked. Select and copy the Gemini CLI MCP settings.",
          variant: "secondary",
        },
        { kind: "open", label: "Gemini MCP docs", href: GEMINI_MCP_DOCS_URL, variant: "secondary" },
      ],
      steps: [
        "Paste the command in Terminal, or use the settings JSON fallback with httpUrl.",
        "Open Gemini CLI and run /mcp.",
        "Run /mcp auth corgtex if Gemini asks for authentication.",
        "When Gemini opens Corgtex, authorize as your current Corgtex user for this workspace.",
      ],
      notes: ["Consumer Gemini web support is not assumed; this path is for technical CLI users."],
    };
  }

  return {
    apiProviderKey: "generic_mcp",
    productName: "MCP client",
    title: "Connect Corgtex to any MCP client",
    intro: "Use this path for internal tools or AI workspaces that support remote MCP, Streamable HTTP, or HTTP MCP servers.",
    primaryAction: {
      kind: "copy",
      label: "Copy MCP URL",
      value: connectorUrl,
      copiedMessage: "Copied the Corgtex MCP URL.",
      fallbackMessage: "Clipboard access was blocked. Select and copy the Corgtex MCP URL.",
      variant: "primary",
    },
    secondaryActions: [],
    steps: [
      "Choose remote MCP, Streamable HTTP, or HTTP MCP server in the client.",
      "Paste the Corgtex MCP URL.",
      "When the client opens Corgtex, authorize as your current Corgtex user for this workspace.",
      "Return here after the client shows the Corgtex tools.",
    ],
    notes: ["Unknown clients appear as Generic MCP after Corgtex OAuth completes."],
  };
}

export function GuidedProviderInstaller({ providerKey, connectorUrl, workspaceId, returnTo }: Props) {
  const config = useMemo(() => buildProviderConfig(providerKey, connectorUrl), [connectorUrl, providerKey]);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [completionMessage, setCompletionMessage] = useState<string | null>(null);
  const [completionTone, setCompletionTone] = useState<"success" | "warning">("success");
  const [completionPending, setCompletionPending] = useState<"verify" | null>(null);

  const setCopyResult = (copied: boolean, copiedMessage: string, fallbackMessage: string, value: string) => {
    setStatus({
      message: copied ? copiedMessage : fallbackMessage,
      tone: copied ? "success" : "warning",
      manualValue: copied ? undefined : value,
    });
  };

  const copyValue = (action: Extract<InstallerAction, { kind: "copy" }>) => {
    void writeClipboard(action.value).then((copied) => {
      setCopyResult(copied, action.copiedMessage, action.fallbackMessage, action.value);
    });
  };

  const copyAndOpen = (action: Extract<InstallerAction, { kind: "copyAndOpen" }>) => {
    const opened = openExternalUrl(action.href);
    void writeClipboard(action.value).then((copied) => {
      if (copied && opened) {
        setStatus({
          message: `Copied the Corgtex MCP URL and opened ${action.productName}.`,
          tone: "success",
        });
        return;
      }

      if (copied) {
        setStatus({
          message: `Copied the Corgtex MCP URL. If ${action.productName} did not open, use the setup link.`,
          tone: "warning",
        });
        return;
      }

      setStatus({
        message: opened
          ? `${action.productName} opened, but clipboard access was blocked. Select and copy the MCP URL.`
          : `Could not open ${action.productName}, and clipboard access was blocked. Select and copy the MCP URL.`,
        tone: "warning",
        manualValue: action.value,
      });
    });
  };

  const verifyConnection = async () => {
    if (!workspaceId) {
      setCompletionTone("warning");
      setCompletionMessage("Open this installer from your Corgtex workspace to save connection status.");
      return;
    }

    setCompletionPending("verify");
    setCompletionMessage(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/mcp-connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", providerKey: config.apiProviderKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data) ?? `Could not check the ${config.productName} connection.`);
      }
      const verified = Boolean((data as { verified?: unknown }).verified);
      const message = typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : verified
          ? `${config.productName} is connected.`
          : `Corgtex has not seen ${config.productName} finish OAuth yet.`;

      setCompletionTone(verified ? "success" : "warning");
      setCompletionMessage(message);
    } catch (error) {
      setCompletionTone("warning");
      setCompletionMessage(error instanceof Error ? error.message : `Could not check the ${config.productName} connection.`);
    } finally {
      setCompletionPending(null);
    }
  };

  const renderAction = (action: InstallerAction) => {
    const className = action.variant === "primary" ? "button text-sm" : "button secondary text-sm";
    const linkClassName = action.variant === "primary" ? "link-button text-sm" : "link-button secondary text-sm";

    if (action.kind === "open") {
      return (
        <a key={action.label} className={linkClassName} href={action.href} target="_blank" rel="noreferrer">
          {action.label}
        </a>
      );
    }

    if (action.kind === "copyAndOpen") {
      return (
        <button key={action.label} type="button" className={className} onClick={() => copyAndOpen(action)}>
          {action.label}
        </button>
      );
    }

    if (action.kind === "cursorInstall") {
      return (
        <span key={action.label} className="inline-flex flex-wrap gap-2">
          <button
            type="button"
            className={className}
            onClick={() => {
              const opened = openCurrentWindow(action.appHref);
              setStatus({
                message: opened
                  ? "Opening Cursor's MCP installer. Use the browser fallback if Cursor does not open."
                  : "Cursor could not be opened here. Use the browser fallback.",
                tone: opened ? "success" : "warning",
              });
            }}
          >
            {action.label}
          </button>
          <a className="link-button secondary text-sm" href={action.browserHref} target="_blank" rel="noreferrer">
            Browser fallback
          </a>
        </span>
      );
    }

    return (
      <button key={action.label} type="button" className={className} onClick={() => copyValue(action)}>
        {action.label}
      </button>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[680px] space-y-8">
      <header className="text-center">
        <div className="mb-3 inline-flex items-center justify-center rounded-xl bg-[var(--surface-strong)] px-4 py-2 ring-1 ring-[var(--line-subtle)]">
          <span className="text-sm font-bold text-[var(--danger)]">Corgtex</span>
          <span className="mx-2 text-[var(--text-muted)]">to</span>
          <span className="text-sm font-bold text-[var(--text-strong)]">{config.productName}</span>
        </div>
        <h1 className="text-2xl font-bold text-[var(--text-strong)]">{config.title}</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">{config.intro}</p>
      </header>

      <section className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface)] p-5">
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase text-[var(--text-muted)]">Corgtex MCP URL</p>
          <code className="block break-all rounded border border-[var(--line)] bg-[var(--surface-sunken)] p-2 font-mono text-xs">
            {connectorUrl}
          </code>
          <div className="flex flex-wrap gap-2">
            {renderAction(config.primaryAction)}
            {config.secondaryActions.map((action) => renderAction(action))}
          </div>
          {status ? (
            <div
              role="status"
              className="rounded border px-3 py-2 text-xs"
              style={{
                background: status.tone === "success" ? "var(--accent-soft)" : "rgba(255, 165, 0, 0.12)",
                borderColor: status.tone === "success" ? "var(--line)" : "rgba(255, 165, 0, 0.35)",
                color: "var(--text-strong)",
              }}
            >
              {status.message}
              {status.manualValue ? (
                <textarea
                  readOnly
                  aria-label="Manual copy value"
                  value={status.manualValue}
                  className="mt-2 min-h-[72px] w-full resize-y rounded border border-[var(--line)] bg-[var(--surface)] p-2 font-mono text-xs"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <ol className="space-y-4">
        {config.steps.map((step, index) => (
          <Step key={step} n={index + 1} body={step} />
        ))}
      </ol>

      <section className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface-sunken)] p-5">
        <h2 className="text-sm font-medium text-[var(--text-strong)]">Finish in Corgtex</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          After the AI tool opens Corgtex and you approve access, verify that Corgtex saw the completed OAuth sign-in.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="button secondary text-sm"
            disabled={completionPending !== null}
            onClick={() => void verifyConnection()}
          >
            {completionPending === "verify" ? "Checking" : "Verify connection"}
          </button>
          {returnTo ? (
            <a href={returnTo} className="button secondary text-sm">
              Back to Corgtex
            </a>
          ) : null}
        </div>
        {completionMessage ? (
          <p
            role="status"
            className="mt-3 rounded border px-3 py-2 text-xs"
            style={{
              background: completionTone === "success" ? "var(--accent-soft)" : "rgba(255, 165, 0, 0.12)",
              borderColor: completionTone === "success" ? "var(--line)" : "rgba(255, 165, 0, 0.35)",
              color: "var(--text-strong)",
            }}
          >
            {completionMessage}
          </p>
        ) : null}
      </section>

      {config.notes.length > 0 ? (
        <section className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface)] p-5">
          <h2 className="text-sm font-medium text-[var(--text-strong)]">Notes</h2>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-[var(--text-muted)]">
            {config.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="border-t border-[var(--line-subtle)] pt-4 text-center text-xs text-[var(--text-muted)]">
        Need a different AI tool? <a href="../" className="underline">See all integrations</a>
      </footer>
    </div>
  );
}

function Step({ n, body }: { n: number; body: string }) {
  return (
    <li className="flex gap-4 rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface)] p-4">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ring-1 ring-[var(--line)]"
        aria-hidden
      >
        {n}
      </div>
      <p className="min-w-0 flex-1 text-sm text-[var(--text-muted)]">{body}</p>
    </li>
  );
}
