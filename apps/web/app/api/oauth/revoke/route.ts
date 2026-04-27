import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { revokeMcpToken } from "@corgtex/domain";

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") || "";
    let bodyData: Record<string, string> = {};

    if (contentType.includes("application/json")) {
      bodyData = await request.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        bodyData[key] = value.toString();
      });
    }

    if (bodyData.token) {
      await revokeMcpToken({
        token: bodyData.token,
        clientId: bodyData.client_id,
      });
    }

    return new NextResponse(null, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
