"use client";

import { useMemo, useState } from "react";

const CHATGPT_APPS_URL = "https://chatgpt.com/apps";
const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

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

type CursorMcpConfig = {
  type: "http";
  url: string;
};

const SETUP_CARDS: SetupCard[] = [
  {
    id: "chatgpt",
    title: "ChatGPT",
    actionLabel: "Copy URL and open ChatGPT Apps",
    automation: "Copies the connector URL and opens ChatGPT Apps.",
    userWork: "Create the custom Corgtex app in ChatGPT before OAuth can start.",
    steps: [
      "In ChatGPT, open Settings -> Apps -> Advanced settings and turn on Developer mode if asked.",
      "Click Create app, name it Corgtex, paste the Corgtex connector URL as the MCP server URL, choose OAuth or dynamic client registration if ChatGPT asks, then click Create.",
      "Start a new chat, open the + menu, choose Apps or Developer Mode, select Corgtex, and complete the browser sign-in.",
    ],
    note:
      "For Business, Enterprise, or Edu workspaces, an admin may need to create or publish the app from Workspace settings -> Apps -> Create or Drafts before members can use it.",
  },
  {
    id: "claude",
    title: "Claude",
    actionLabel: "Copy URL and open Claude Connectors",
    automation: "Copies the connector URL and opens Claude connector settings.",
    userWork: "Add the custom connector in Claude before OAuth can start.",
    steps: [
      "In Claude, open Customize -> Connectors.",
      "Click +, choose Add custom connector, and paste the Corgtex connector URL as the remote MCP server URL.",
      "Click Add, then Connect, and finish the browser sign-in.",
    ],
    note:
      "For Team or Enterprise, owners add it from Organization settings -> Connectors -> Add -> Custom -> Web. Members then connect it from Customize -> Connectors.",
  },
  {
    id: "cursor",
    title: "Cursor",
    actionLabel: "Add to Cursor",
    automation: "Opens Cursor's MCP installer with the Corgtex HTTP server already encoded.",
    userWork: "Approve the Cursor install prompt and finish browser sign-in when Cursor asks.",
    steps: [
      "Click Add to Cursor.",
      "Approve the install prompt in Cursor.",
      "When Cursor asks to authenticate, complete the browser sign-in.",
    ],
  },
  {
    id: "claude-code",
    title: "Claude Code",
    actionLabel: "Copy Claude Code command",
    automation: "Copies the exact terminal command with the Corgtex connector URL.",
    userWork: "Paste the command into Terminal, then authenticate Corgtex from Claude Code.",
    steps: [
      "Paste the copied command into Terminal.",
      "Open Claude Code and type /mcp.",
      "Select corgtex, choose authenticate or connect, and finish the browser sign-in.",
    ],
    note: "User scope makes Corgtex available across projects. Use local scope only if you want it for one project.",
  },
  {
    id: "other",
    title: "Other MCP client",
    actionLabel: "Copy connector URL",
    automation: "Copies the Corgtex connector URL for any remote MCP client.",
    userWork: "Choose remote MCP or Streamable HTTP in your client and use browser OAuth when prompted.",
    steps: [
      "Choose remote MCP, Streamable HTTP, or HTTP MCP server in your client.",
      "Paste the Corgtex connector URL.",
      "Use browser OAuth when the client asks for authentication.",
    ],
  },
];

export function buildCursorMcpConfig(connectorUrl: string): CursorMcpConfig {
  return {
    type: "http",
    url: connectorUrl,
  };
}

export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;

    output += alphabet[(chunk >> 18) & 63];
    output += alphabet[(chunk >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(chunk >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[chunk & 63] : "=";
  }

  return output;
}

export function buildCursorInstallLinks(connectorUrl: string): { app: string; browser: string } {
  const encodedConfig = encodeURIComponent(encodeBase64Utf8(JSON.stringify(buildCursorMcpConfig(connectorUrl))));
  const name = encodeURIComponent("Corgtex");

  return {
    app: `cursor://anysphere.cursor-deeplink/mcp/install?name=${name}&config=${encodedConfig}`,
    browser: `https://cursor.com/en/install-mcp?name=${name}&config=${encodedConfig}`,
  };
}

export function buildClaudeCodeCommand(connectorUrl: string): string {
  return `claude mcp add --transport http corgtex --scope user ${connectorUrl}`;
}

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
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const cursorLinks = useMemo(() => buildCursorInstallLinks(connectorUrl), [connectorUrl]);
  const claudeCodeCommand = useMemo(() => buildClaudeCodeCommand(connectorUrl), [connectorUrl]);

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
          <button className="button secondary" type="button" onClick={() => handleCopyAndOpen(card.id, connectorUrl, CHATGPT_APPS_URL, "ChatGPT Apps")}>
            {card.actionLabel}
          </button>
          <a className="button secondary" href={CHATGPT_APPS_URL} target="_blank" rel="noreferrer">
            Open only
          </a>
        </div>
      );
    }

    if (card.id === "claude") {
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button className="button secondary" type="button" onClick={() => handleCopyAndOpen(card.id, connectorUrl, CLAUDE_CONNECTORS_URL, "Claude Connectors")}>
            {card.actionLabel}
          </button>
          <a className="button secondary" href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noreferrer">
            Open only
          </a>
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

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="panel" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 16 }}>
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong className="nr-item-title">Corgtex connector</strong>
            <div className="nr-item-meta" style={{ fontSize: "0.85rem", marginTop: 4 }}>
              One connector for ChatGPT, Claude, Cursor, Claude Code, and other MCP clients.
              {workspaceName ? ` This workspace appears during sign-in as ${workspaceName}.` : ""}
            </div>
          </div>
          <span className="tag" style={{ background: "var(--accent-soft)", fontWeight: "bold" }}>
            Browser sign-in
          </span>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
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
            Copy connector URL
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
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
    </div>
  );
}
