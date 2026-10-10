import type { Metadata } from "next";
import Link from "next/link";
import { getWorkspaceMcpInstallUrl } from "@corgtex/domain";
import { WorkspacePicker } from "./WorkspacePicker";
import { firstInstallerParam, installerReturnTo, installerTileHref } from "./installer-navigation";
import { requireInstallerWorkspace } from "./installer-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Corgtex to your AI tool",
  description: "Add Corgtex as a connector to Claude, ChatGPT, Codex, Cursor, or another MCP client.",
};

const TILES = [
  {
    id: "openwork",
    title: "OpenWork",
    body: "Recommended default work surface. Copy the MCP URL, open OpenWork, then authorize in Corgtex.",
    primary: true,
  },
  {
    id: "claude",
    title: "Claude (web, desktop, Cowork)",
    body: "Copy the workspace URL, add a custom connector in Claude, then approve Corgtex access.",
    primary: false,
  },
  {
    id: "chatgpt",
    title: "ChatGPT web",
    body: "Create a custom app in ChatGPT Apps settings, scan tools, then approve Corgtex access.",
    primary: false,
  },
  {
    id: "codex",
    title: "Codex CLI and IDE",
    body: "Copy a workspace-specific MCP command for Codex, then sign in through OAuth.",
    primary: false,
  },
  {
    id: "cursor",
    title: "Cursor",
    body: "Copy a workspace-specific mcp.json entry, then authorize in Corgtex.",
    primary: false,
  },
  {
    id: "copilot",
    title: "GitHub Copilot",
    body: "Use the VS Code MCP config or Copilot CLI command from a guided setup page.",
    primary: false,
  },
  {
    id: "gemini",
    title: "Gemini CLI",
    body: "Copy the Gemini CLI command or settings JSON, then authenticate through Corgtex.",
    primary: false,
  },
  {
    id: "claude-code",
    title: "Claude Code",
    body: "One terminal command, then sign in through your browser.",
    primary: false,
  },
  {
    id: "generic-mcp",
    title: "Generic MCP client",
    body: "Copy the Corgtex MCP URL for any client that supports remote MCP or Streamable HTTP.",
    primary: false,
  },
];

export default async function InstallIndexPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ workspaceId?: string | string[]; returnTo?: string | string[] }>;
}) {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  const workspaceId = firstInstallerParam(search.workspaceId);
  if (!workspaceId) return <WorkspacePicker path="/install" locale={locale} />;
  await requireInstallerWorkspace(workspaceId);
  const connectorUrl = getWorkspaceMcpInstallUrl(workspaceId);
  const returnTo = installerReturnTo(search.returnTo, workspaceId, locale);

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-[720px] space-y-8">
        <header className="text-center">
          <div className="mb-3 inline-flex items-center justify-center rounded-xl bg-[var(--surface-strong)] px-4 py-2 ring-1 ring-[var(--line-subtle)]">
            <span className="text-sm font-bold text-[var(--danger)]">Corgtex</span>
          </div>
          <h1 className="text-2xl font-bold text-[var(--text-strong)]">Connect Corgtex to your AI tool</h1>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            Pick the AI tool you use. Each guide prepares the workspace URL or config; finish setup and OAuth in that tool.
          </p>
        </header>

        <ul className="grid gap-4 sm:grid-cols-2">
          {TILES.map((tile) => (
            <li key={tile.id}>
              <Link
                href={installerTileHref(locale, tile.id, workspaceId, returnTo)}
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
          <h2 className="text-sm font-medium text-[var(--text-strong)]">Manual setup</h2>
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
