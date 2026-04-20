import type { Prisma } from "@prisma/client";

export type DomainEventInput = {
  workspaceId?: string | null;
  type: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  payload: Prisma.InputJsonValue;
};

export async function appendEvents(tx: Prisma.TransactionClient, events: DomainEventInput[]) {
  if (events.length === 0) {
    return;
  }

  await tx.event.createMany({
    data: events.map((event) => ({
      workspaceId: event.workspaceId ?? null,
      type: event.type,
      aggregateType: event.aggregateType ?? null,
      aggregateId: event.aggregateId ?? null,
      payload: event.payload,
    })),
  });
}
