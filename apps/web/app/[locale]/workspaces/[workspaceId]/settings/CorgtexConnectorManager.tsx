"use client";

import { useEffect, useState } from "react";
import {
  buildClaudeInstallerShareUrl,
  buildClaudeCodeCommand,
  buildCursorInstallLinks,
  buildCursorMcpConfig,
  buildInstallerPath,
  buildInstallerShareUrl,
  encodeBase64Utf8,
  type CursorMcpConfig,
} from "@/lib/install-helpers";

// Re-export so the existing test in CorgtexConnectorManager.test.ts keeps working.
export {
  buildClaudeCodeCommand,
  buildClaudeInstallerShareUrl,
  buildCursorInstallLinks,
  buildCursorMcpConfig,
  encodeBase64Utf8,
};
export type { CursorMcpConfig };

type Props = {
  connectorUrl: string;
  workspaceName?: string;
  workspaceId?: string;
};

type SetupCardId = "openwork" | "chatgpt" | "claude" | "cursor" | "copilot" | "gemini" | "claude-code" | "other";

type SetupCard = {
  id: SetupCardId;
  title: string;
  actionLabel: string;
  automation: string;
  userWork: string;
  steps: string[];
  note?: string;
};

type ActionStatus = {
  cardId: SetupCardId;
  message: string;
  tone: "success" | "warning";
  manualValue?: string;
};

const SETUP_CARDS: SetupCard[] = [
  {
    id: "openwork",
    title: "OpenWork",
    actionLabel: "Open guided installer",
    automation: "Opens the Corgtex-guided OpenWork installer.",
    userWork: "Add the Corgtex MCP URL in OpenWork from the installer, then authorize it in Corgtex.",
    steps: [
      "Open your OpenWork workspace.",
      "Go to Extensions, then Advanced Settings, then Add MCP server.",
      "When OpenWork opens Corgtex, authorize the connector as your current Corgtex user for the selected workspace.",
    ],
    note: "OpenWork is the recommended free work surface when the team does not already prefer another AI tool.",
  },
  {
    id: "chatgpt",
    title: "ChatGPT",
    actionLabel: "Open guided installer",
    automation: "Opens the Corgtex-guided ChatGPT installer.",
    userWork: "Create the custom Corgtex app in ChatGPT from the installer, then authorize it in Corgtex.",
    steps: [
      "In ChatGPT, open Settings -> Connectors -> Advanced settings and turn on Developer Mode if asked.",
      "Click Create app, name it Corgtex, paste the Corgtex connector URL as the MCP server URL, choose OAuth or dynamic client registration if ChatGPT asks, then click Create.",
      "When ChatGPT opens Corgtex, authorize the connector as your current Corgtex user for the selected workspace.",
      "Start a new chat, open the + menu, choose Apps or Developer Mode, and select Corgtex.",
    ],
    note:
      "For Business, Enterprise, or Edu workspaces, an admin may need to approve or publish the app before members can use it. Corgtex does not match ChatGPT email to Corgtex email.",
  },
  {
    id: "claude",
    title: "Claude",
    actionLabel: "Open guided installer",
    automation: "Opens the Corgtex-guided Claude installer.",
    userWork: "Add the custom connector in Claude from the installer, then authorize it in Corgtex.",
    steps: [
      "In Claude, open Customize -> Connectors.",
      "Click +, choose Add custom connector, and paste the Corgtex connector URL as the remote MCP server URL.",
      "Click Add, then Connect. When Claude opens Corgtex, authorize the connector as your current Corgtex user for the selected workspace.",
    ],
    note:
      "For Team or Enterprise, owners add it from Organization settings -> Connectors -> Add -> Custom -> Web. Members then connect it from Customize -> Connectors. Corgtex does not match Claude email to Corgtex email.",
  },
  {
    id: "cursor",
    title: "Cursor",
    actionLabel: "Open guided installer",
    automation: "Opens the Corgtex-guided Cursor installer.",
    userWork: "Approve the Cursor install prompt from the installer, then authorize it in Corgtex when Cursor asks.",
    steps: [
      "Click Add to Cursor.",
      "Approve the install prompt in Cursor.",
      "When Cursor opens Corgtex, authorize the connector as your current Corgtex user for the selected workspace.",
    ],
  },
  {
    id: "copilot",
    title: "GitHub Copilot",
    actionLabel: "Open guided installer",
    automation: "Opens the Corgtex-guided Copilot installer.",
    userWork: "Use the VS Code config or Copilot CLI command from the installer, then authorize it in Corgtex.",
    steps: [
      "Use the VS Code MCP setup path or Copilot CLI command from the installer.",
      "When Copilot opens Corgtex, authorize the connector as your current Corgtex user for the selected workspace.",
      "Return to Corgtex and verify the completed OAuth connection.",
    ],
    note: "Repository and cloud-agent Copilot OAuth setup is not offered here.",
  },
  {
    id: "gemini",
    title: "Gemini CLI",
    actionLabel: "Open guided installer",
    automation: "Opens the Corgtex-guided Gemini CLI installer.",
    userWork: "Copy the Gemini command or settings JSON from the installer, then authorize it in Corgtex.",
    steps: [
      "Paste the command in Terminal, or use the settings JSON fallback.",
      "Open Gemini CLI and run /mcp.",
      "When Gemini opens Corgtex, authorize the connector as your current Corgtex user for the selected workspace.",
    ],
    note: "Consumer Gemini web support is not assumed; this path is for technical CLI users.",
  },
  {
    id: "claude-code",
    title: "Claude Code",
    actionLabel: "Open guided installer",
    automation: "Opens the Corgtex-guided Claude Code installer.",
    userWork: "Copy the command from the installer, paste it into Terminal, then authorize Corgtex from Claude Code.",
    steps: [
      "Paste the copied command into Terminal.",
      "Open Claude Code and type /mcp.",
      "Select corgtex, choose authenticate or connect, and authorize in Corgtex as your current Corgtex user for the selected workspace.",
    ],
    note: "User scope makes Corgtex available across projects. Use local scope only if you want it for one project.",
  },
  {
    id: "other",
    title: "Other MCP client",
    actionLabel: "Open guided installer",
    automation: "Opens the Corgtex-guided generic MCP installer.",
    userWork: "Choose remote MCP or Streamable HTTP in your client, then authorize in Corgtex when prompted.",
    steps: [
      "Choose remote MCP, Streamable HTTP, or HTTP MCP server in your client.",
      "Paste the Corgtex connector URL.",
      "When the client opens Corgtex, authorize as your current Corgtex user for the selected workspace.",
    ],
  },
];

async function writeClipboard(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function setupProviderKey(cardId: SetupCardId) {
  if (cardId === "claude-code") return "claude_code";
  if (cardId === "other") return "generic_mcp";
  return cardId;
}

function setupReturnTo(workspaceId: string | undefined, providerKey: string) {
  return workspaceId ? `/workspaces/${workspaceId}/settings?tab=ai-workspaces&provider=${providerKey}` : null;
}

export function CorgtexConnectorManager({ connectorUrl, workspaceName, workspaceId }: Props) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [claudeInstallerShareUrl, setClaudeInstallerShareUrl] = useState<string | null>(null);

  useEffect(() => {
    setIsHydrated(true);
    setClaudeInstallerShareUrl(buildInstallerShareUrl(window.location.origin, "claude", {
      workspaceId,
      returnTo: setupReturnTo(workspaceId, "claude"),
    }));
  }, [workspaceId]);

  const setCopyResult = (cardId: SetupCardId, copied: boolean, copiedMessage: string, fallbackMessage: string, value: string) => {
    setStatus({
      cardId,
      message: copied ? copiedMessage : fallbackMessage,
      tone: copied ? "success" : "warning",
      manualValue: copied ? undefined : value,
    });
  };

  const handleCopy = (cardId: SetupCardId, value: string, copiedMessage: string, fallbackMessage: string) => {
    void writeClipboard(value).then((copied) => {
      setCopyResult(cardId, copied, copiedMessage, fallbackMessage, value);
    });
  };

  const renderConnectorUrl = (cardId: SetupCardId) => (
    <div style={{ display: "grid", gap: 6 }}>
      <span className="nr-item-meta" style={{ fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase" }}>
        Connector URL
      </span>
      <code
        style={{
          display: "block",
          border: "1px solid var(--line)",
          borderRadius: 6,
          fontFamily: "monospace",
          fontSize: "0.82rem",
          overflowWrap: "anywhere",
          padding: "8px 10px",
        }}
      >
        {connectorUrl}
      </code>
      {status?.cardId === cardId && status.manualValue === connectorUrl ? (
        <textarea
          readOnly
          value={status.manualValue}
          aria-label={`${cardId} manual copy value`}
          style={{ minHeight: 42, resize: "vertical", fontFamily: "monospace", fontSize: "0.82rem" }}
        />
      ) : null}
    </div>
  );

  const renderAction = (card: SetupCard) => {
    const providerKey = setupProviderKey(card.id);
    const href = buildInstallerPath(providerKey, {
      workspaceId,
      returnTo: setupReturnTo(workspaceId, providerKey),
    });
    return (
      <a className="button" href={href} target="_blank" rel="noreferrer">
        {card.actionLabel}
      </a>
    );
  };

  if (!isHydrated) {
    return (
      <div className="stack" style={{ gap: 16 }} aria-hidden="true">
        <div
          className="panel"
          style={{
            border: "1px solid var(--line)",
            borderRadius: 8,
            minHeight: 210,
            padding: 20,
            background: "var(--surface-strong, var(--surface))",
          }}
        />
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div
        className="panel"
        style={{
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: 20,
          background: "var(--surface-strong, var(--surface))",
        }}
      >
        <div className="row" style={{ alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong className="nr-item-title" style={{ fontSize: "1.05rem" }}>
              Add Corgtex to Claude
            </strong>
            <div className="nr-item-meta" style={{ fontSize: "0.88rem", marginTop: 6 }}>
              The fastest path for non-technical teammates. The guided installer copies the connector URL, opens Claude
              settings, and walks the user through Corgtex authorization for the current Corgtex user and workspace.
              {workspaceName ? ` The consent page can authorize ${workspaceName}.` : ""}
            </div>
          </div>
          <span className="tag" style={{ background: "var(--accent-soft)", fontWeight: "bold" }}>
            Corgtex OAuth
          </span>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
          <a
            className="button"
            href={buildInstallerPath("claude", {
              workspaceId,
              returnTo: setupReturnTo(workspaceId, "claude"),
            })}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: "0.95rem", padding: "8px 16px" }}
          >
            Open guided installer ↗
          </a>
          <button
            className="button secondary"
            type="button"
            onClick={() =>
              handleCopy(
                "other",
                connectorUrl,
                "Copied the connector URL.",
                "Your browser blocked clipboard access. Select and copy the URL from any setup card below.",
              )
            }
          >
            Copy URL only
          </button>
        </div>

        {status?.cardId === "claude" || status?.cardId === "other" ? (
          <div
            role="status"
            className="nr-item-meta"
            style={{
              background: status.tone === "success" ? "var(--accent-soft)" : "rgba(255, 165, 0, 0.12)",
              border: `1px solid ${status.tone === "success" ? "var(--line)" : "rgba(255, 165, 0, 0.35)"}`,
              borderRadius: 6,
              color: "var(--text)",
              fontSize: "0.82rem",
              marginTop: 12,
              padding: "8px 10px",
            }}
          >
            {status.message}
          </div>
        ) : null}

        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", fontSize: "0.88rem", color: "var(--text)" }}>
            Share a link with a teammate instead
          </summary>
          <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 8 }}>
            Send this URL to anyone with a Corgtex login. The page walks them through three clicks — no terminal, no install:
            <code
              style={{
                display: "block",
                border: "1px solid var(--line)",
                borderRadius: 6,
                fontFamily: "monospace",
                fontSize: "0.82rem",
                marginTop: 8,
                overflowWrap: "anywhere",
                padding: "8px 10px",
              }}
            >
              {claudeInstallerShareUrl ?? "Preparing share link..."}
            </code>
            <button
              className="button secondary small"
              type="button"
              disabled={!claudeInstallerShareUrl}
              style={{ marginTop: 8 }}
              onClick={() => {
                if (!claudeInstallerShareUrl) return;
                handleCopy(
                  "other",
                  claudeInstallerShareUrl,
                  "Copied the share link.",
                  "Clipboard blocked. Select and copy the link above.",
                );
              }}
            >
              Copy share link
            </button>
          </div>
        </details>
      </div>

      <details>
        <summary style={{ cursor: "pointer", fontSize: "0.95rem", fontWeight: 600, padding: "8px 0" }}>
          Other AI tools (OpenWork, ChatGPT, Cursor, Copilot, Gemini, Claude Code, Other)
        </summary>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginTop: 12 }}>
        {SETUP_CARDS.map((card) => (
          <section
            key={card.id}
            className="panel"
            aria-labelledby={`mcp-setup-${card.id}`}
            style={{ border: "1px solid var(--line)", borderRadius: 8, display: "grid", gap: 14, padding: 16 }}
          >
            <div>
              <h3 id={`mcp-setup-${card.id}`} style={{ fontSize: "1rem", margin: 0 }}>
                {card.title}
              </h3>
              <p className="nr-item-meta" style={{ fontSize: "0.84rem", marginTop: 6 }}>
                {card.automation}
              </p>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              <div className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                <strong style={{ color: "var(--text)" }}>Corgtex can automate: </strong>
                {card.automation}
              </div>
              <div className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                <strong style={{ color: "var(--text)" }}>You still need to do: </strong>
                {card.userWork}
              </div>
            </div>

            {renderConnectorUrl(card.id)}

            {renderAction(card)}

            {status?.cardId === card.id ? (
              <div
                role="status"
                className="nr-item-meta"
                style={{
                  background: status.tone === "success" ? "var(--accent-soft)" : "rgba(255, 165, 0, 0.12)",
                  border: `1px solid ${status.tone === "success" ? "var(--line)" : "rgba(255, 165, 0, 0.35)"}`,
                  borderRadius: 6,
                  color: "var(--text)",
                  fontSize: "0.82rem",
                  margin: 0,
                  padding: "8px 10px",
                }}
              >
                {status.message}
              </div>
            ) : null}

            <ol className="stack" style={{ gap: 8, margin: 0, paddingLeft: 18 }}>
              {card.steps.map((step) => (
                <li key={step} className="nr-item-meta" style={{ fontSize: "0.86rem" }}>
                  {step}
                </li>
              ))}
            </ol>

            {card.note ? (
              <p className="nr-item-meta" style={{ borderTop: "1px solid var(--line)", fontSize: "0.8rem", margin: 0, paddingTop: 10 }}>
                {card.note}
              </p>
            ) : null}
          </section>
        ))}
      </div>
      </details>
    </div>
  );
}
