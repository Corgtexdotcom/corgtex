"use client";

import { useState } from "react";

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
  command: string;
  fallbackInstallHref: string;
};

export function ClaudeCodeInstaller({ command, fallbackInstallHref }: Props) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const handleCopy = () => {
    void writeClipboard(command).then((ok) => {
      setCopied(ok);
      setCopyFailed(!ok);
    });
  };

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-8">
      <header className="text-center">
        <div className="mb-3 inline-flex items-center justify-center rounded-xl bg-[var(--surface-strong)] px-4 py-2 ring-1 ring-[var(--line-subtle)]">
          <span className="text-sm font-bold text-[var(--danger)]">Corgtex</span>
          <span className="mx-2 text-[var(--text-muted)]">→</span>
          <span className="text-sm font-bold text-[var(--text-strong)]">Claude Code</span>
        </div>
        <h1 className="text-2xl font-bold text-[var(--text-strong)]">Connect Corgtex to Claude Code</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          Claude Code runs in your terminal. If you don't use a terminal, use the Claude web/desktop installer instead.
        </p>
      </header>

      <div className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface-sunken)] p-4">
        <p className="text-sm text-[var(--text-strong)]">
          Not a developer? <a href={fallbackInstallHref} className="font-medium underline">Use the Claude installer instead</a> — it works the same way and connects through your browser.
        </p>
      </div>

      <ol className="space-y-4">
        <li className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface)] p-4">
          <div className="text-sm font-medium text-[var(--text-strong)]">1. Copy the install command</div>
          <code className="mt-2 block break-all rounded border border-[var(--line)] bg-[var(--surface-sunken)] p-2 font-mono text-xs">
            {command}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="button secondary mt-2 text-sm"
          >
            {copied ? "Copied ✓" : "Copy command"}
          </button>
          {copyFailed ? (
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Your browser blocked clipboard access. Select the command above and copy it manually.
            </p>
          ) : null}
        </li>

        <li className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface)] p-4">
          <div className="text-sm font-medium text-[var(--text-strong)]">2. Paste it into Terminal</div>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Open the Terminal app, paste the command, press Enter. The <code className="font-mono">--scope user</code> flag makes Corgtex available across every project.
          </p>
        </li>

        <li className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface)] p-4">
          <div className="text-sm font-medium text-[var(--text-strong)]">3. Authenticate from Claude Code</div>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-[var(--text-muted)]">
            <li>Run <code className="font-mono">claude</code> to start Claude Code.</li>
            <li>Type <code className="font-mono">/mcp</code>, choose <span className="font-medium text-[var(--text-strong)]">corgtex</span>, then <span className="font-medium text-[var(--text-strong)]">authenticate</span>.</li>
            <li>Sign in to Corgtex in the browser popup, choose your workspace, click <span className="font-medium text-[var(--text-strong)]">Allow access</span>.</li>
          </ul>
        </li>
      </ol>

      <footer className="border-t border-[var(--line-subtle)] pt-4 text-center text-xs text-[var(--text-muted)]">
        Need a different AI tool? <a href="../" className="underline">See all integrations</a>
      </footer>
    </div>
  );
}
