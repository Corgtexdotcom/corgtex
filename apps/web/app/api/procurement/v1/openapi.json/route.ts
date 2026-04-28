import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DEFAULT_PLAN_LABEL, MAX_EMPLOYEE_INVITES } from "@corgtex/domain";
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
        },
      },
    },
  };
}

const setupSessionAuthParameter = {
  name: "Authorization",
  in: "header",
  required: true,
  schema: {
    type: "string",
    pattern: "^Bearer setup_",
  },
  description: "Bearer setup session token returned once from workspace creation.",
};

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
    const employeeInvite = {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        displayName: { type: "string" },
        role: {
          type: "string",
          enum: ["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD"],
          default: "CONTRIBUTOR",
        },
      },
      required: ["email"],
      additionalProperties: false,
    };

    const schema = {
      openapi: "3.1.0",
      info: {
        title: "Corgtex Procurement Setup API",
        version: "1.0.0",
        description: "Agent-readable public API for discovering Corgtex and provisioning a company workspace without automated payment.",
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
            summary: "Get public Corgtex product and setup metadata",
            responses: { "200": { description: "Product metadata" } },
          },
        },
        "/workspaces": {
          post: {
            operationId: "createProcurementWorkspace",
            summary: "Create a company workspace and email setup links",
            parameters: [idempotencyParameter],
            requestBody: jsonBodySchema(
              {
                companyName: { type: "string" },
                slug: { type: "string" },
                adminEmail: { type: "string", format: "email" },
                adminName: { type: "string" },
                employees: {
                  type: "array",
                  maxItems: MAX_EMPLOYEE_INVITES,
                  items: employeeInvite,
                },
                billingContactEmail: { type: "string", format: "email" },
                acceptedTermsVersion: { type: "string" },
                sourceAgent: { type: "object", additionalProperties: true },
                planLabel: { type: "string", default: DEFAULT_PLAN_LABEL },
              },
              ["companyName", "adminEmail", "billingContactEmail", "acceptedTermsVersion"],
            ),
            responses: {
              "201": { description: "Workspace created. The setupSessionToken is returned only in this response." },
              "400": { description: "Invalid setup request" },
              "409": { description: "Idempotency conflict or setup conflict" },
              "429": { description: "Rate limit exceeded" },
            },
          },
        },
        "/setup-sessions/{id}": {
          get: {
            operationId: "getSetupSessionStatus",
            summary: "Read a setup session status",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              setupSessionAuthParameter,
            ],
            responses: {
              "200": { description: "Setup session status" },
              "401": { description: "Missing, invalid, or expired setup session token" },
            },
          },
        },
        "/setup-sessions/{id}/members/bulk-invite": {
          post: {
            operationId: "bulkInviteSetupSessionMembers",
            summary: "Invite additional initial employees during setup",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              setupSessionAuthParameter,
              idempotencyParameter,
            ],
            requestBody: jsonBodySchema(
              {
                members: {
                  type: "array",
                  minItems: 1,
                  maxItems: MAX_EMPLOYEE_INVITES,
                  items: employeeInvite,
                },
              },
              ["members"],
            ),
            responses: {
              "200": { description: "Members invited and setup emails attempted" },
              "400": { description: "Invalid invite request" },
              "401": { description: "Missing, invalid, or expired setup session token" },
              "409": { description: "Idempotency conflict or inactive setup session" },
              "429": { description: "Rate limit exceeded" },
            },
          },
        },
      },
      components: {
        schemas: {
          EmployeeInvite: employeeInvite,
        },
      },
    };

    return NextResponse.json(schema);
  } catch (error) {
    return handleRouteError(error);
  }
}
