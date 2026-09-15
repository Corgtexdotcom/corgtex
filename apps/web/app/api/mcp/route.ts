import type { NextRequest } from "next/server";
import * as handler from "@/lib/mcp-handler";

export const GET = handler.GET;
export const DELETE = handler.DELETE;
export async function POST(request: NextRequest) { return handler.POST(request); }
