import { NextResponse } from "next/server";
import { AppError } from "@corgtex/domain";
import { isDatabaseUnavailableError } from "@corgtex/shared";

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
