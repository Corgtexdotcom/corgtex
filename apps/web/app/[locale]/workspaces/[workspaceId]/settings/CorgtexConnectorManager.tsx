"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildClaudeInstallerShareUrl,
  buildClaudeCodeCommand,
  buildCursorInstallLinks,
  buildCursorMcpConfig,
  encodeBase64Utf8,
  CHATGPT_CONNECTORS_URL,
  CLAUDE_CONNECTORS_URL,
  CLAUDE_INSTALLER_PATH,
  CLAUDE_CODE_INSTALLER_PATH,
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
};

type SetupCardId = "chatgpt" | "claude" | "cursor" | "claude-code" | "other";

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
    id: "chatgpt",
    title: "ChatGPT",
    actionLabel: "Connect ChatGPT",
    automation: "Copies the connector URL and opens ChatGPT connector settings.",
    userWork: "Create the custom Corgtex app in ChatGPT, then authorize it in Corgtex.",
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
    actionLabel: "Copy URL and open Claude Connectors",
    automation: "Copies the connector URL and opens Claude connector settings.",
    userWork: "Add the custom connector in Claude, then authorize it in Corgtex.",
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
    actionLabel: "Add to Cursor",
    automation: "Opens Cursor's MCP installer with the Corgtex HTTP server already encoded.",
    userWork: "Approve the Cursor install prompt, then authorize it in Corgtex when Cursor asks.",
    steps: [
      "Click Add to Cursor.",
      "Approve the install prompt in Cursor.",
      "When Cursor opens Corgtex, authorize the connector as your current Corgtex user for the selected workspace.",
    ],
  },
  {
    id: "claude-code",
    title: "Claude Code",
    actionLabel: "Copy Claude Code command",
    automation: "Copies the exact terminal command with the Corgtex connector URL.",
    userWork: "Paste the command into Terminal, then authorize Corgtex from Claude Code.",
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
    actionLabel: "Copy connector URL",
    automation: "Copies the Corgtex connector URL for any remote MCP client.",
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

function openExternalUrl(url: string): boolean {
  if (typeof window === "undefined") return false;
  const target = window.open(url, "_blank", "noopener,noreferrer");
  return target !== null;
}

function openCurrentWindow(url: string): boolean {
  if (typeof window === "undefined") return false;
  window.location.href = url;
  return true;
}

export function CorgtexConnectorManager({ connectorUrl, workspaceName }: Props) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [claudeInstallerShareUrl, setClaudeInstallerShareUrl] = useState<string | null>(null);
  const cursorLinks = useMemo(() => buildCursorInstallLinks(connectorUrl), [connectorUrl]);
  const claudeCodeCommand = useMemo(() => buildClaudeCodeCommand(connectorUrl), [connectorUrl]);

  useEffect(() => {
    setIsHydrated(true);
    setClaudeInstallerShareUrl(buildClaudeInstallerShareUrl(window.location.origin));
  }, []);

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

  const handleCopyAndOpen = (cardId: SetupCardId, value: string, url: string, productName: string) => {
    const opened = openExternalUrl(url);

    void writeClipboard(value).then((copied) => {
      if (copied && opened) {
        setStatus({
          cardId,
          message: `Copied the connector URL and opened ${productName}.`,
          tone: "success",
        });
        return;
      }

      if (copied) {
        setStatus({
          cardId,
          message: `Copied the connector URL. If ${productName} did not open, use the setup link below.`,
          tone: "warning",
        });
        return;
      }

      setStatus({
        cardId,
        message: `${productName} opened, but your browser blocked clipboard access. Select and copy the URL below.`,
        tone: "warning",
        manualValue: value,
      });
    });
  };

  const handleCursorInstall = () => {
    const opened = openCurrentWindow(cursorLinks.app);
    setStatus({
      cardId: "cursor",
      message: opened
        ? "Opening Cursor's MCP installer. If nothing happens, use the browser fallback link below."
        : "Cursor could not be opened here. Use the browser fallback link below.",
      tone: opened ? "success" : "warning",
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
    if (card.id === "chatgpt") {
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button className="button secondary" type="button" onClick={() => handleCopyAndOpen(card.id, connectorUrl, CHATGPT_CONNECTORS_URL, "ChatGPT connector settings")}>
            {card.actionLabel}
          </button>
          <a className="button secondary" href={CHATGPT_CONNECTORS_URL} target="_blank" rel="noreferrer">
            Open only
          </a>
        </div>
      );
    }

    if (card.id === "claude") {
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <a className="button" href={CLAUDE_INSTALLER_PATH} target="_blank" rel="noreferrer">
            Open guided installer ↗
          </a>
          <button className="button secondary" type="button" onClick={() => handleCopyAndOpen(card.id, connectorUrl, CLAUDE_CONNECTORS_URL, "Claude Connectors")}>
            {card.actionLabel}
          </button>
        </div>
      );
    }

    if (card.id === "cursor") {
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button className="button secondary" type="button" onClick={handleCursorInstall}>
            {card.actionLabel}
          </button>
          <a className="button secondary" href={cursorLinks.browser} target="_blank" rel="noreferrer">
            Browser fallback
          </a>
        </div>
      );
    }

    if (card.id === "claude-code") {
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <a className="button" href={CLAUDE_CODE_INSTALLER_PATH} target="_blank" rel="noreferrer">
            Open guided installer ↗
          </a>
          <button
            className="button secondary"
            type="button"
            onClick={() =>
              handleCopy(
                card.id,
                claudeCodeCommand,
                "Copied the Claude Code command.",
                "Your browser blocked clipboard access. Select and copy the command below.",
              )
            }
          >
            {card.actionLabel}
          </button>
        </div>
      );
    }

    return (
      <button
        className="button secondary"
        type="button"
        onClick={() =>
          handleCopy(
            card.id,
            connectorUrl,
            "Copied the connector URL.",
            "Your browser blocked clipboard access. Select and copy the URL below.",
          )
        }
      >
        {card.actionLabel}
      </button>
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
              The fastest path for non-technical teammates. We open Claude with the connector URL on your clipboard;
              the user pastes it once, then Claude opens Corgtex to authorize the current Corgtex user and workspace.
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
            href={CLAUDE_INSTALLER_PATH}
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
              handleCopyAndOpen("claude", connectorUrl, CLAUDE_CONNECTORS_URL, "Claude Connectors")
            }
          >
            Copy URL and open Claude Connectors
          </button>
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
          Other AI tools (ChatGPT, Cursor, Claude Code, Other)
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

            {card.id === "claude-code" ? (
              <div style={{ display: "grid", gap: 6 }}>
                <span className="nr-item-meta" style={{ fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase" }}>
                  Claude Code command
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
                  {claudeCodeCommand}
                </code>
                {status?.cardId === card.id && status.manualValue === claudeCodeCommand ? (
                  <textarea
                    readOnly
                    value={status.manualValue}
                    aria-label="Claude Code manual copy value"
                    style={{ minHeight: 70, resize: "vertical", fontFamily: "monospace", fontSize: "0.82rem" }}
                  />
                ) : null}
              </div>
            ) : null}

            {renderAction(card)}

            {card.id === "cursor" ? (
              <div className="nr-item-meta" style={{ fontSize: "0.8rem", margin: 0, overflowWrap: "anywhere" }}>
                Browser fallback: <a href={cursorLinks.browser} target="_blank" rel="noreferrer">{cursorLinks.browser}</a>
              </div>
            ) : null}

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
