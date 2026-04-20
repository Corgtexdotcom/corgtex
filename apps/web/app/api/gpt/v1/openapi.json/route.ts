import { NextResponse } from "next/server";
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
              title: { type: "string" },
              bodyMd: { type: "string" },
              summary: { type: "string" },
            },
            ["title", "bodyMd"],
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
}
