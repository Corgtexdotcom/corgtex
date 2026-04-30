import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { PROCUREMENT_TRIAL_LIMITS, PROCUREMENT_TRIAL_TTL_DAYS, TRIAL_CONNECTOR_SCOPES } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";

function jsonBodySchema(properties: Record<string, unknown>, required: string[]) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
    },
  };
}

const idempotencyParameter = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: {
    type: "string",
    minLength: 1,
  },
};

export async function GET(request: NextRequest) {
  try {
    const origin = getPublicOrigin(request);
    const baseUrl = `${origin}/api/procurement/v1`;
    const schema = {
      openapi: "3.1.0",
      info: {
        title: "Corgtex Procurement Trial API",
        version: "1.0.0",
        description: "Agent-readable public API for discovering Corgtex and requesting a capped trial workspace with MCP connector access.",
      },
      servers: [{ url: baseUrl }],
      paths: {
        "/openapi.json": {
          get: {
            operationId: "getProcurementOpenApi",
            summary: "Get this OpenAPI document",
            responses: { "200": { description: "OpenAPI schema" } },
          },
        },
        "/product": {
          get: {
            operationId: "getCorgtexProduct",
            summary: "Get public Corgtex product and trial metadata",
            responses: { "200": { description: "Product metadata" } },
          },
        },
        "/trials": {
          post: {
            operationId: "createProcurementTrial",
            summary: "Create a capped trial workspace or review-gated trial request",
            parameters: [idempotencyParameter],
            requestBody: jsonBodySchema(
              {
                companyName: { type: "string", maxLength: 180 },
                adminEmail: { type: "string", format: "email" },
                adminName: { type: "string", maxLength: 160 },
                billingContactEmail: { type: "string", format: "email" },
                acceptedTermsVersion: { type: "string", maxLength: 80 },
                sourceAgent: { type: "object", additionalProperties: true },
              },
              ["companyName", "adminEmail", "acceptedTermsVersion"],
            ),
            responses: {
              "201": {
                description: "Instant trial created. The connector token is returned in this response and is encrypted at rest.",
              },
              "202": {
                description: "Trial request recorded for review. No connector token is returned.",
              },
              "400": { description: "Invalid trial request" },
              "409": { description: "Idempotency conflict" },
              "429": { description: "Rate limit exceeded" },
            },
          },
        },
        "/trials/{trialId}": {
          get: {
            operationId: "getProcurementTrialStatus",
            summary: "Read non-sensitive trial status",
            parameters: [
              { name: "trialId", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": { description: "Trial status" },
              "404": { description: "Trial not found" },
            },
          },
        },
      },
      components: {
        schemas: {
          TrialLimits: {
            type: "object",
            properties: {
              trialDays: { type: "integer", default: PROCUREMENT_TRIAL_TTL_DAYS },
              modelMonthlyBudgetCents: { type: "integer", default: PROCUREMENT_TRIAL_LIMITS.modelMonthlyBudgetCents },
              storageLimitMb: { type: "integer", default: PROCUREMENT_TRIAL_LIMITS.storageLimitMb },
              memberLimit: { type: "integer", default: PROCUREMENT_TRIAL_LIMITS.memberLimit },
              mcpDailyCallLimit: { type: "integer", default: PROCUREMENT_TRIAL_LIMITS.mcpDailyCallLimit },
            },
          },
          TrialConnector: {
            type: "object",
            properties: {
              token: { type: "string", description: "Bearer token for the MCP connector. Returned only for active instant trials." },
              scopes: { type: "array", items: { type: "string", enum: TRIAL_CONNECTOR_SCOPES } },
              mcpConnectorUrl: { type: "string", format: "uri" },
            },
          },
        },
      },
    };

    return NextResponse.json(schema);
  } catch (error) {
    return handleRouteError(error);
  }
}
