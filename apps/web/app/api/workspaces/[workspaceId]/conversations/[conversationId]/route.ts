import { NextRequest, NextResponse } from "next/server";
import { getConversation, addConversationTurn, renameConversation, deleteConversation, completeRoleOnboardingConversation } from "@corgtex/domain";
import { processConversationTurnStream, sanitizeConversationPageContext } from "@corgtex/agents";
import { defaultModelGateway } from "@corgtex/models";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

const MAX_MESSAGE_LENGTH = 100_000;
const STREAM_KEEPALIVE_INTERVAL_MS = 10_000;
const EMPTY_ASSISTANT_STREAM_MESSAGE = "The assistant did not return a response. Please retry or ask a more specific question.";

type ConversationStreamResult = {
  assistantMessage: string;
  contextUsed: {
    knowledgeResults?: unknown[];
    knowledgeSearch?: unknown;
    memories?: unknown[];
    pageContext?: unknown;
    mapGraphChanged?: boolean;
  };
};

function encodeStreamPayload(encoder: TextEncoder, payload: Record<string, unknown>) {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function keepAliveTimeout() {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<{ type: "keepalive" }>((resolve) => {
    timeout = setTimeout(() => resolve({ type: "keepalive" }), STREAM_KEEPALIVE_INTERVAL_MS);
  });

  return {
    cancel() {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    },
    promise,
  };
}

function enqueueKeepAlive(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder) {
  controller.enqueue(encodeStreamPayload(encoder, { keepAlive: true }));
}

function unstreamedAssistantText(streamedAssistantMessage: string, assistantMessage: string) {
  if (!assistantMessage) return "";
  if (!streamedAssistantMessage.trim()) return assistantMessage;
  if (assistantMessage.startsWith(streamedAssistantMessage)) {
    return assistantMessage.slice(streamedAssistantMessage.length);
  }
  return "";
}

function resolvedAssistantMessage(finalResult: ConversationStreamResult | undefined, streamedAssistantMessage: string) {
  if (finalResult?.assistantMessage?.trim()) return finalResult.assistantMessage;
  if (streamedAssistantMessage.trim()) return streamedAssistantMessage;
  return EMPTY_ASSISTANT_STREAM_MESSAGE;
}

async function nextConversationStreamResult(
  iterator: AsyncGenerator<string, ConversationStreamResult>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<IteratorResult<string, ConversationStreamResult>> {
  const nextChunk = iterator.next();

  while (true) {
    const timeout = keepAliveTimeout();
    const result = await Promise.race([
      nextChunk.then((chunk) => ({ type: "chunk" as const, chunk })),
      timeout.promise,
    ]).finally(() => timeout.cancel());

    if (result.type === "keepalive") {
      enqueueKeepAlive(controller, encoder);
      continue;
    }

    return result.chunk;
  }
}

function catalogUsageContext(actor: Awaited<ReturnType<typeof resolveRequestActor>>) {
  if (actor.kind === "agent" && actor.authProvider === "credential") {
    return {
      catalogItemId: actor.catalogItemId ?? undefined,
      agentCredentialId: actor.credentialId,
    };
  }

  return {};
}

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
    const body = (await request.json()) as { message?: string; pageContext?: unknown };
    const userMessage = String(body.message ?? "").trim();
    const pageContext = sanitizeConversationPageContext(body.pageContext);
    if (!userMessage) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json(
        { error: `Message is too long (${userMessage.length.toLocaleString()} characters). Maximum is ${MAX_MESSAGE_LENGTH.toLocaleString()} characters. For long transcripts, use the attachment (+) button to upload as a file.` },
        { status: 413 }
      );
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
      pageContext,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          enqueueKeepAlive(controller, encoder);
          let finalResult: ConversationStreamResult | undefined;
          let streamedAssistantMessage = "";

          while (true) {
            const { done, value } = await nextConversationStreamResult(iterator, controller, encoder);
            if (done) {
              finalResult = value;
              break;
            }
            if (value) {
              streamedAssistantMessage += value;
              controller.enqueue(encodeStreamPayload(encoder, { text: value }));
            }
          }

          const assistantMessage = resolvedAssistantMessage(finalResult, streamedAssistantMessage);
          if (assistantMessage) {
            const missingText = unstreamedAssistantText(streamedAssistantMessage, assistantMessage);
            if (missingText) {
              streamedAssistantMessage += missingText;
              controller.enqueue(encodeStreamPayload(encoder, { text: missingText }));
            }

            await addConversationTurn(actor, {
              workspaceId,
              conversationId,
              userMessage,
              assistantMessage,
              contextJson: finalResult?.contextUsed ?? {},
            });

            // Auto-name: generate a title from the first message if none exists
            if (!conversation.topic) {
              try {
                const titleResponse = await defaultModelGateway.chat({
                  workspaceId,
                  ...catalogUsageContext(actor),
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
                  await renameConversation(actor, {
                    workspaceId,
                    conversationId,
                    topic: generatedTopic,
                  });
                  controller.enqueue(encodeStreamPayload(encoder, { topic: generatedTopic }));
                }
              } catch {
                // Auto-naming is best-effort; don't break the stream
              }
            }

            if (finalResult.contextUsed.mapGraphChanged) {
              controller.enqueue(encodeStreamPayload(encoder, { refreshCurrentRoute: true }));
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
    const body = (await request.json()) as { topic?: string; roleOnboardingStatus?: string };
    if (body.roleOnboardingStatus === "COMPLETED") {
      const updated = await completeRoleOnboardingConversation(actor, { workspaceId, conversationId });
      return NextResponse.json({ roleOnboarding: updated });
    }

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
