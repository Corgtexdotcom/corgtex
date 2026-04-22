import { NextRequest, NextResponse } from "next/server";
import { getConversation, addConversationTurn, renameConversation, deleteConversation } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { processConversationTurnStream } from "@corgtex/agents";
import { defaultModelGateway } from "@corgtex/models";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; conversationId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, conversationId } = await params;
    const conversation = await getConversation(actor, workspaceId, conversationId);
    return NextResponse.json({ conversation });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; conversationId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, conversationId } = await params;
    const body = (await request.json()) as { message?: string };
    const userMessage = String(body.message ?? "").trim();
    if (!userMessage) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    const conversation = await getConversation(actor, workspaceId, conversationId);
    const userId = actor.kind === "user" ? actor.user.id : "";

    const iterator = processConversationTurnStream({
      workspaceId,
      sessionId: conversationId,
      userId,
      agentKey: conversation.agentKey,
      userMessage,
      systemPrompt: conversation.systemPrompt,
      actor,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let finalResult: {
            assistantMessage: string;
            contextUsed: { knowledgeResults?: unknown[]; memories?: unknown[] };
          } | undefined;

          while (true) {
            const { done, value } = await iterator.next();
            if (done) {
              finalResult = value;
              break;
            }
            if (value) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: value })}\n\n`));
            }
          }

          if (finalResult && finalResult.assistantMessage) {
            await addConversationTurn(actor, {
              workspaceId,
              conversationId,
              userMessage,
              assistantMessage: finalResult.assistantMessage,
              contextJson: finalResult.contextUsed,
            });

            // Auto-name: generate a title from the first message if none exists
            if (!conversation.topic) {
              try {
                const titleResponse = await defaultModelGateway.chat({
                  workspaceId,
                  taskType: "CLASSIFICATION",
                  messages: [
                    {
                      role: "system",
                      content: "Generate a very short title (max 6 words) for this conversation based on the user's message. Return ONLY the title text, nothing else. No quotes, no punctuation at the end.",
                    },
                    { role: "user", content: userMessage },
                  ],
                });
                const generatedTopic = titleResponse.content.trim().slice(0, 80);
                if (generatedTopic) {
                  await prisma.conversationSession.update({
                    where: { id: conversationId },
                    data: { topic: generatedTopic },
                  });
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ topic: generatedTopic })}\n\n`)
                  );
                }
              } catch {
                // Auto-naming is best-effort; don't break the stream
              }
            }
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; conversationId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, conversationId } = await params;
    const body = (await request.json()) as { topic?: string };
    const topic = String(body.topic ?? "").trim();
    if (!topic) {
      return NextResponse.json({ error: "Topic is required." }, { status: 400 });
    }
    const updated = await renameConversation(actor, { workspaceId, conversationId, topic });
    return NextResponse.json({ conversation: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; conversationId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, conversationId } = await params;
    await deleteConversation(actor, { workspaceId, conversationId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
