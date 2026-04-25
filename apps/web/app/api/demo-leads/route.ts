import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@corgtex/shared";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rateLimited = await rateLimitAuth(request);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = typeof body === "object" && body ? (body as Record<string, unknown>) : {};
  const email = typeof payload.email === "string" ? payload.email.trim() : "";

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  try {
    // upsert the workspace to ensure it exists
    const workspace = await prisma.workspace.upsert({
      where: { slug: "corgtex" },
      update: {},
      create: {
        slug: "corgtex",
        name: "Corgtex",
        description: "Internal company operating environment for Corgtex",
      },
    });

    // Upsert the DemoLead (for backward compatibility)
    await prisma.demoLead.upsert({
      where: {
        workspaceId_email: {
          workspaceId: workspace.id,
          email,
        },
      },
      update: {
        lastSeenAt: new Date(),
        visitCount: { increment: 1 },
      },
      create: {
        workspaceId: workspace.id,
        email,
        source: "demo_gate",
      },
    });

    // Upsert into CRM Contact
    const nameStr = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, ' ');
    const companyStr = email.split('@')[1];

    await prisma.crmContact.upsert({
      where: {
        workspaceId_email: {
          workspaceId: workspace.id,
          email,
        },
      },
      update: {
        lastSeenAt: new Date(),
      },
      create: {
        workspaceId: workspace.id,
        email,
        name: nameStr,
        company: companyStr,
        source: "demo_gate",
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to capture demo lead:", error);
    return NextResponse.json({ error: "Failed to capture lead" }, { status: 500 });
  }
}
