"use client";

import { useState } from "react";

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

const STARTER_PROMPTS = [
  "What proposals are open in my Corgtex workspace?",
  "Summarize this week's meetings from Corgtex.",
  "Show me my current actions in Corgtex.",
];

function buildClaudeChatUrl(prompt: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
}

async function writeClipboard(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

type Props = {
  connectorUrl: string;
};

export function ClaudeInstaller({ connectorUrl }: Props) {
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const handleCopy = () => {
    void writeClipboard(connectorUrl).then((ok) => {
      setCopied(ok);
      setCopyFailed(!ok);
    });
  };

  const handleOpenClaude = () => {
    if (typeof window === "undefined") return;
    const w = window.open(CLAUDE_CONNECTORS_URL, "_blank", "noopener,noreferrer");
    setOpened(w !== null);
  };

  const handleCopyAndOpen = () => {
    handleCopy();
    handleOpenClaude();
  };

  const stepDone = (n: number) => {
    if (n === 1) return copied;
    if (n === 2) return opened;
    return false;
  };

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-8">
      <header className="text-center">
        <div className="mb-3 inline-flex items-center justify-center rounded-xl bg-[var(--surface-strong)] px-4 py-2 ring-1 ring-[var(--line-subtle)]">
          <span className="text-sm font-bold text-[var(--danger)]">Corgtex</span>
          <span className="mx-2 text-[var(--text-muted)]">→</span>
          <span className="text-sm font-bold text-[var(--text-strong)]">Claude</span>
        </div>
        <h1 className="text-2xl font-bold text-[var(--text-strong)]">Connect Corgtex to Claude</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          Three clicks. No terminal, no install. Works with Claude.ai (web and desktop) and Claude Cowork.
        </p>
      </header>

      <button
        type="button"
        onClick={handleCopyAndOpen}
        className="button w-full py-3 text-base"
      >
        {copied && opened
          ? "URL copied. Claude is open in another tab."
          : "Copy URL and open Claude Connectors"}
      </button>

      <ol className="space-y-4">
        <Step
          n={1}
          done={stepDone(1)}
          title="Copy your Corgtex connector URL"
          body={
            <>
              <code className="mt-1 block break-all rounded border border-[var(--line)] bg-[var(--surface-sunken)] p-2 font-mono text-xs">
                {connectorUrl}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="button secondary mt-2 text-sm"
              >
                {copied ? "Copied ✓" : "Copy URL"}
              </button>
              {copyFailed ? (
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  Your browser blocked clipboard access. Select the URL above and copy it manually.
                </p>
              ) : null}
            </>
          }
        />

        <Step
          n={2}
          done={stepDone(2)}
          title="Open Claude Connectors"
          body={
            <>
              <p className="text-sm text-[var(--text-muted)]">
                In Claude, this is at <span className="font-medium">Settings → Connectors</span>.
              </p>
              <button
                type="button"
                onClick={handleOpenClaude}
                className="button secondary mt-2 text-sm"
              >
                {opened ? "Opened ✓" : "Open Claude Connectors"}
              </button>
            </>
          }
        />

        <Step
          n={3}
          done={false}
          title="Add Corgtex as a custom connector"
          body={
            <ul className="list-disc space-y-1 pl-4 text-sm text-[var(--text-muted)]">
              <li>Click <span className="font-medium text-[var(--text-strong)]">Add custom connector</span>.</li>
              <li>Paste the connector URL you copied.</li>
              <li>Click <span className="font-medium text-[var(--text-strong)]">Add</span>, then <span className="font-medium text-[var(--text-strong)]">Connect</span>.</li>
              <li>Sign in to Corgtex when the popup appears, choose your workspace, click <span className="font-medium text-[var(--text-strong)]">Allow access</span>.</li>
            </ul>
          }
        />
      </ol>

      <section className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface-sunken)] p-5">
        <h2 className="text-sm font-medium text-[var(--text-strong)]">Try it once you're connected</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Open Claude and try one of these. Claude will use Corgtex automatically.
        </p>
        <ul className="mt-3 space-y-2">
          {STARTER_PROMPTS.map((prompt) => (
            <li key={prompt}>
              <a
                href={buildClaudeChatUrl(prompt)}
                target="_blank"
                rel="noreferrer"
                className="block rounded border border-[var(--line-subtle)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-strong)] hover:border-[var(--line)]"
              >
                {prompt} <span className="text-[var(--text-muted)]">↗</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-[var(--line-subtle)] pt-4 text-center text-xs text-[var(--text-muted)]">
        Need a different AI tool? <a href="../" className="underline">See all integrations</a>
      </footer>
    </div>
  );
}

function Step({ n, done, title, body }: { n: number; done: boolean; title: string; body: React.ReactNode }) {
  return (
    <li className="flex gap-4 rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface)] p-4">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ring-1"
        style={{
          background: done ? "var(--accent-soft)" : "var(--surface-sunken)",
          color: done ? "var(--accent)" : "var(--text-strong)",
          boxShadow: done ? "inset 0 0 0 1px var(--accent)" : undefined,
        }}
        aria-hidden
      >
        {done ? "✓" : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--text-strong)]">{title}</div>
        <div className="mt-1 text-sm">{body}</div>
      </div>
    </li>
  );
}
