import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/http";
import { registerMcpOAuthClient } from "@corgtex/domain";

const registrationSchema = z.object({
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string().url()).min(1),
  scope: z.string().optional(),
}).passthrough();

export async function POST(request: NextRequest) {
  try {
    const parsed = registrationSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_client_metadata", error_description: parsed.error.message }, { status: 400 });
    }
    const body = parsed.data;
    const result = await registerMcpOAuthClient({
      name: body.client_name,
      redirectUris: body.redirect_uris,
      scopes: body.scope?.split(" ").filter(Boolean),
    });

    return NextResponse.json(result, {
      status: 201,
      headers: {
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
