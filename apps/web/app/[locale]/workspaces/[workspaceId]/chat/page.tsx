import { listConversations } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getTranslations } from "next-intl/server";
import { ChatInterface } from "./ChatInterface";

export const dynamic = "force-dynamic";


export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ session?: string }>;
}) {
  const { workspaceId } = await params;
  const { session: activeSessionId } = await searchParams;
  const actor = await requirePageActor();
  const t = await getTranslations("chat");

  const { items: conversations } = await listConversations(actor, workspaceId, { take: 30 });

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>
      <ChatInterface
        workspaceId={workspaceId}
        conversations={conversations.map((c) => ({
          id: c.id,
          topic: c.topic,
          agentKey: c.agentKey,
          status: c.status,
          updatedAt: c.updatedAt.toISOString(),
          lastMessage: c.turns[0]?.assistantMessage.slice(0, 100) ?? null,
        }))}
        activeSessionId={activeSessionId ?? null}
      />
    </>
  );
}
