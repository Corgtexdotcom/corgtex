import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AppError } from "@corgtex/domain";
import { isDatabaseUnavailableError } from "@corgtex/shared";
import { z } from "zod";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    { status },
  );
}

export function serviceUnavailableResponse(
  code = "SERVICE_UNAVAILABLE",
  message = "Service is temporarily unavailable. Try again.",
) {
  return errorResponse(503, code, message);
}

export function handleRouteError(error: unknown) {
  if (error instanceof AppError) {
    return errorResponse(error.status, error.code, error.message);
  }

  if (isDatabaseUnavailableError(error)) {
    console.error("Route failed because the database is unavailable.", error);
    return serviceUnavailableResponse();
  }

  console.error(error);
  return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
}

export async function validateBody<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new AppError(400, "VALIDATION_ERROR", details || "Request body failed validation.");
  }

  return parsed.data;
}
