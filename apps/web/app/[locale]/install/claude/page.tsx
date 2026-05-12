import type { Metadata } from "next";
import { getMcpPublicUrl } from "@corgtex/domain";
import { ClaudeInstaller } from "./ClaudeInstaller";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Corgtex to Claude",
  description: "Add Corgtex as a custom connector in Claude or Claude Cowork. No terminal, no install — three clicks.",
};

export default function ConnectClaudePage() {
  const connectorUrl = getMcpPublicUrl();

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <ClaudeInstaller connectorUrl={connectorUrl} />
    </main>
  );
}
