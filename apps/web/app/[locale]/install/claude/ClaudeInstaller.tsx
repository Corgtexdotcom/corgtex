"use client";

import { useState } from "react";

import { CLAUDE_CONNECTORS_URL } from "@/lib/install-helpers";

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

function parseRouteError(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return null;
}

type Props = {
  connectorUrl: string;
  workspaceId?: string | null;
  returnTo?: string | null;
};

export function ClaudeInstaller({ connectorUrl, workspaceId, returnTo }: Props) {
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [connected, setConnected] = useState(false);
  const [completionMessage, setCompletionMessage] = useState<string | null>(null);
  const [completionTone, setCompletionTone] = useState<"success" | "warning">("success");
  const [completionPending, setCompletionPending] = useState<"verify" | "mark_connected" | null>(null);

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
    if (n === 4) return connected;
    return connected;
  };

  const updateConnection = async (action: "verify" | "mark_connected") => {
    if (!workspaceId) {
      setConnected(true);
      setCompletionTone("success");
      setCompletionMessage("Done. Open Claude and start using Corgtex.");
      return;
    }

    setCompletionPending(action);
    setCompletionMessage(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/mcp-connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, providerKey: "claude" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data) ?? "Could not check the Claude connection.");
      }
      const verified = Boolean((data as { verified?: unknown }).verified);
      const message = typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : verified
          ? "Claude is connected."
          : "Corgtex has not seen Claude finish sign-in yet.";

      setConnected(verified);
      setCompletionTone(verified ? "success" : "warning");
      setCompletionMessage(message);
    } catch (error) {
      setConnected(false);
      setCompletionTone("warning");
      setCompletionMessage(error instanceof Error ? error.message : "Could not check the Claude connection.");
    } finally {
      setCompletionPending(null);
    }
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
                In Claude, this is at <span className="font-medium">Customize → Connectors</span>.
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
          done={connected}
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

        <Step
          n={4}
          done={stepDone(4)}
          title="Finish in Corgtex"
          body={
            <>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="button secondary text-sm"
                  disabled={completionPending !== null}
                  onClick={() => void updateConnection("verify")}
                >
                  {completionPending === "verify" ? "Checking" : "Verify connection"}
                </button>
                <button
                  type="button"
                  className="button secondary text-sm"
                  disabled={completionPending !== null}
                  onClick={() => void updateConnection("mark_connected")}
                >
                  {completionPending === "mark_connected" ? "Saving" : "I connected it"}
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
            </>
          }
        />
      </ol>

      <section className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface-sunken)] p-5">
        <h2 className="text-sm font-medium text-[var(--text-strong)]">Test in Claude</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Open Claude and try one of these after you connect Corgtex.
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
