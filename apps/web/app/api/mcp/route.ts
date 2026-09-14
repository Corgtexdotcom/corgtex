import type { NextRequest } from "next/server";
import { POST as handlePost } from "@/lib/mcp-transport";
export { GET, DELETE } from "@/lib/mcp-transport";

export async function POST(request: NextRequest) {
  return handlePost(request);
}
