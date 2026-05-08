import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { env } from "@corgtex/shared";

function jsonBodySchema(properties: Record<string, unknown>, required: string[]) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties,
          required,
        },
      },
    },
  };
}

const paginationParameters = [
  { name: "take", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
  { name: "skip", in: "query", schema: { type: "integer", minimum: 0 } },
];

const okResponse = { "200": { description: "Successful response" } };

export async function GET() {
  try {
    const origin = env.APP_URL.replace(/\/$/, "");

  const schema = {
    openapi: "3.1.0",
    info: {
      title: "Corgtex Workspace API",
      description: "API for Custom GPT actions to read and update a Corgtex workspace.",
      version: "1.0.0",
    },
    servers: [{ url: `${origin}/api/gpt/v1` }],
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/oauth/authorize`,
              tokenUrl: `${origin}/api/oauth/token`,
              scopes: {
                chat: "Chat with Corgtex",
                read: "Read workspace data",
                write: "Create workspace records",
              },
            },
          },
        },
      },
    },
    paths: {
      "/workspace": {
        get: {
          operationId: "getWorkspaceInfo",
          summary: "Get workspace overview",
          security: [{ oauth2: ["read"] }],
          responses: okResponse,
        },
      },
      "/chat": {
        post: {
          operationId: "sendChatMessage",
          summary: "Chat with Corgtex",
          security: [{ oauth2: ["chat"] }],
          requestBody: jsonBodySchema({ message: { type: "string" } }, ["message"]),
          responses: okResponse,
        },
      },
      "/search": {
        get: {
          operationId: "searchKnowledgeBase",
          summary: "Search workspace knowledge",
          security: [{ oauth2: ["read"] }],
          parameters: [
            { name: "query", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 5, minimum: 1, maximum: 20 } },
          ],
          responses: okResponse,
        },
      },
      "/proposals": {
        get: {
          operationId: "listProposals",
          summary: "List proposals",
          security: [{ oauth2: ["read"] }],
          parameters: paginationParameters,
          responses: okResponse,
        },
        post: {
          operationId: "createProposal",
          summary: "Create a draft proposal",
          security: [{ oauth2: ["write"] }],
          requestBody: jsonBodySchema(
            {
              title: { type: "string", description: "Required unless sourceTensionId is provided." },
              bodyMd: { type: "string", description: "Required unless sourceTensionId is provided. If sourceTensionId is provided, this overrides the generated draft body." },
              summary: { type: "string" },
              sourceTensionId: { type: "string", nullable: true, description: "Optional tension ID to draft this proposal from and link as its source." },
              relatedActionIds: {
                type: "array",
                description: "Optional existing action IDs to link as implementation or follow-up work.",
                items: { type: "string" },
              },
            },
            [],
          ),
          responses: okResponse,
        },
      },
      "/goals": {
        get: {
          operationId: "listGoals",
          summary: "List goals",
          security: [{ oauth2: ["read"] }],
          parameters: [
            ...paginationParameters,
            { name: "cadence", in: "query", schema: { type: "string", enum: ["TEN_YEAR", "FIVE_YEAR", "ANNUAL", "QUARTERLY", "MONTHLY", "WEEKLY"] } },
            { name: "level", in: "query", schema: { type: "string", enum: ["COMPANY", "CIRCLE", "PERSONAL"] } },
            { name: "status", in: "query", schema: { type: "string", enum: ["DRAFT", "ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND", "COMPLETED", "ABANDONED"] } },
          ],
          responses: okResponse,
        },
        post: {
          operationId: "createGoal",
          summary: "Create a goal in the Goals tab",
          security: [{ oauth2: ["write"] }],
          requestBody: jsonBodySchema(
            {
              title: { type: "string" },
              descriptionMd: { type: "string" },
              cadence: { type: "string", enum: ["TEN_YEAR", "FIVE_YEAR", "ANNUAL", "QUARTERLY", "MONTHLY", "WEEKLY"] },
              level: { type: "string", enum: ["COMPANY", "CIRCLE", "PERSONAL"] },
              status: { type: "string", enum: ["DRAFT", "ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND", "COMPLETED", "ABANDONED"] },
              startDate: { type: "string", format: "date-time" },
              targetDate: { type: "string", format: "date-time" },
              parentGoalId: { type: "string", nullable: true },
              circleId: { type: "string", nullable: true },
              ownerMemberId: { type: "string", nullable: true },
              keyResults: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    targetValue: { type: "number" },
                    currentValue: { type: "number" },
                    unit: { type: "string" },
                  },
                  required: ["title"],
                },
              },
            },
            ["title"],
          ),
          responses: okResponse,
        },
      },
      "/actions": {
        get: {
          operationId: "listActions",
          summary: "List actions",
          security: [{ oauth2: ["read"] }],
          parameters: paginationParameters,
          responses: okResponse,
        },
        post: {
          operationId: "createAction",
          summary: "Create an action",
          security: [{ oauth2: ["write"] }],
          requestBody: jsonBodySchema(
            {
              title: { type: "string" },
              bodyMd: { type: "string" },
              raisedByMemberId: { type: "string", nullable: true },
            },
            ["title"],
          ),
          responses: okResponse,
        },
      },
      "/tensions": {
        get: {
          operationId: "listTensions",
          summary: "List tensions",
          security: [{ oauth2: ["read"] }],
          parameters: paginationParameters,
          responses: okResponse,
        },
        post: {
          operationId: "createTension",
          summary: "Create a tension",
          security: [{ oauth2: ["write"] }],
          requestBody: jsonBodySchema(
            {
              title: { type: "string" },
              bodyMd: { type: "string" },
            },
            ["title"],
          ),
          responses: okResponse,
        },
      },
      "/members": {
        get: {
          operationId: "listMembers",
          summary: "List active members",
          security: [{ oauth2: ["read"] }],
          responses: okResponse,
        },
      },
      "/circles": {
        get: {
          operationId: "listCircles",
          summary: "List circles",
          security: [{ oauth2: ["read"] }],
          responses: okResponse,
        },
      },
      "/policies": {
        get: {
          operationId: "listPolicies",
          summary: "List policies",
          security: [{ oauth2: ["read"] }],
          parameters: paginationParameters,
          responses: okResponse,
        },
      },
    },
  };

    return NextResponse.json(schema);
  } catch (error) {
    return handleRouteError(error);
  }
}
