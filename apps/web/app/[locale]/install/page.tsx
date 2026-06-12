import type { Metadata } from "next";
import Link from "next/link";
import { getMcpPublicUrl } from "@corgtex/domain";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Corgtex to your AI tool",
  description: "Add Corgtex as a connector to Claude, ChatGPT, Cursor, Claude Code, or any MCP client.",
};

const TILES = [
  {
    id: "claude",
    title: "Claude (web, desktop, Cowork)",
    body: "The smoothest path. Three clicks, no terminal — works for non-technical teammates.",
    href: "/install/claude",
    primary: true,
  },
  {
    id: "claude-code",
    title: "Claude Code",
    body: "One terminal command, then sign in through your browser.",
    href: "/install/claude-code",
    primary: false,
  },
];

const OTHER = [
  { name: "ChatGPT", body: "Add Corgtex as a developer-mode app in ChatGPT Settings -> Connectors." },
  { name: "Cursor", body: "Use the cursor:// install link from your workspace settings." },
  { name: "Other MCP clients", body: "Paste the connector URL into any client that supports remote MCP / Streamable HTTP." },
];

export default function InstallIndexPage() {
  const connectorUrl = getMcpPublicUrl();

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-[720px] space-y-8">
        <header className="text-center">
          <div className="mb-3 inline-flex items-center justify-center rounded-xl bg-[var(--surface-strong)] px-4 py-2 ring-1 ring-[var(--line-subtle)]">
            <span className="text-sm font-bold text-[var(--danger)]">Corgtex</span>
          </div>
          <h1 className="text-2xl font-bold text-[var(--text-strong)]">Connect Corgtex to your AI tool</h1>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            Pick the AI tool you use. Each path opens a guided installer.
          </p>
        </header>

        <ul className="grid gap-4 sm:grid-cols-2">
          {TILES.map((tile) => (
            <li key={tile.id}>
              <Link
                href={tile.href}
                className="block h-full rounded-[var(--radius-lg)] border bg-[var(--surface)] p-5 transition hover:border-[var(--line)]"
                style={{
                  borderColor: tile.primary ? "var(--accent)" : "var(--line-subtle)",
                  boxShadow: tile.primary ? "0 0 0 1px var(--accent-soft)" : undefined,
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold text-[var(--text-strong)]">{tile.title}</span>
                  {tile.primary ? (
                    <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-medium">
                      Recommended
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm text-[var(--text-muted)]">{tile.body}</p>
                <p className="mt-3 text-xs font-medium text-[var(--accent)]">Open installer →</p>
              </Link>
            </li>
          ))}
        </ul>

        <section className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--surface-sunken)] p-5">
          <h2 className="text-sm font-medium text-[var(--text-strong)]">Other tools</h2>
          <ul className="mt-3 space-y-2">
            {OTHER.map((item) => (
              <li key={item.name} className="text-sm">
                <span className="font-medium text-[var(--text-strong)]">{item.name}</span>
                <span className="text-[var(--text-muted)]"> — {item.body}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-[var(--text-muted)]">
            Paste this connector URL anywhere a remote MCP server is accepted:
          </p>
          <code className="mt-2 block break-all rounded border border-[var(--line)] bg-[var(--surface)] p-2 font-mono text-xs">
            {connectorUrl}
          </code>
        </section>
      </div>
    </main>
  );
}
