import type { NextRequest } from "next/server";
import { forwardDemoRequest } from "../../../../lib/demo-backend";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return forwardDemoRequest(request, "qualify");
}
