"use client";

import { useState } from "react";

type Props = {
  connectorUrl: string;
  workspaceName?: string;
};

type Guide = {
  name: string;
  steps: string[];
};

const GUIDES: Guide[] = [
  {
    name: "ChatGPT",
    steps: [
      "Open Apps or Connectors in your ChatGPT workspace.",
      "Add a custom MCP connector.",
      "Paste the Corgtex connector URL and sign in.",
    ],
  },
  {
    name: "Claude",
    steps: [
      "Open Settings and add a custom connector.",
      "Paste the Corgtex connector URL.",
      "Approve the browser sign-in when Claude opens it.",
    ],
  },
  {
    name: "Cursor",
    steps: [
      "Open Settings, then MCP.",
      "Add a remote MCP server.",
      "Paste the Corgtex connector URL and complete sign-in.",
    ],
  },
  {
    name: "Other MCP client",
    steps: [
      "Choose remote MCP or Streamable HTTP.",
      "Use the Corgtex connector URL.",
      "Use browser OAuth when the client asks for authentication.",
    ],
  },
];

export function CorgtexConnectorManager({ connectorUrl, workspaceName }: Props) {
  const [copied, setCopied] = useState(false);
  const [activeGuide, setActiveGuide] = useState(GUIDES[0]?.name ?? "ChatGPT");

  const handleCopy = async () => {
    await navigator.clipboard.writeText(connectorUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const guide = GUIDES.find((item) => item.name === activeGuide) ?? GUIDES[0];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="panel" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 16 }}>
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong className="nr-item-title">Corgtex connector</strong>
            <div className="nr-item-meta" style={{ fontSize: "0.85rem", marginTop: 4 }}>
              One connector for ChatGPT, Claude, Cursor, and other MCP clients.
              {workspaceName ? ` This workspace appears during sign-in as ${workspaceName}.` : ""}
            </div>
          </div>
          <span className="tag" style={{ background: "var(--accent-soft)", fontWeight: "bold" }}>
            Browser sign-in
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <input
            readOnly
            value={connectorUrl}
            aria-label="Corgtex connector URL"
            style={{ flex: 1, fontFamily: "monospace", fontSize: "0.85rem" }}
          />
          <button className="button secondary" type="button" onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="panel" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 16 }}>
        <div className="nr-tab-bar" style={{ marginBottom: 16 }}>
          {GUIDES.map((item) => (
            <button
              key={item.name}
              type="button"
              className={`nr-tab ${activeGuide === item.name ? "nr-tab-active" : ""}`}
              onClick={() => setActiveGuide(item.name)}
            >
              {item.name}
            </button>
          ))}
        </div>

        <ol className="stack" style={{ gap: 10, margin: 0, paddingLeft: 18 }}>
          {guide.steps.map((step) => (
            <li key={step} className="nr-item-meta" style={{ fontSize: "0.9rem" }}>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
