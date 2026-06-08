"use client";

import { useState } from "react";

type AiReadinessPromptPanelProps = {
  closeLabel: string;
  copiedLabel: string;
  copyLabel: string;
  guidance: string;
  openLabel: string;
  prompt: string;
  promptTitle: string;
};

export function AiReadinessPromptPanel({
  closeLabel,
  copiedLabel,
  copyLabel,
  guidance,
  openLabel,
  prompt,
  promptTitle,
}: AiReadinessPromptPanelProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyPrompt() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(prompt);
      } else {
        copyPromptFallback();
      }
    } catch {
      copyPromptFallback();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2400);
  }

  function copyPromptFallback() {
    const textarea = document.createElement("textarea");
    textarea.value = prompt;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }

  return (
    <div className="ai-prompt-shell">
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="ai-readiness-prompt"
      >
        {open ? closeLabel : openLabel}
      </button>

      {open ? (
        <div id="ai-readiness-prompt" className="ai-prompt-panel">
          <div className="ai-prompt-panel-header">
            <div>
              <span className="section-label">{promptTitle}</span>
              <p>{guidance}</p>
            </div>
            <button type="button" className="btn btn-secondary" onClick={copyPrompt}>
              {copied ? copiedLabel : copyLabel}
            </button>
          </div>
          <pre className="ai-prompt-code">
            <code>{prompt}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}
