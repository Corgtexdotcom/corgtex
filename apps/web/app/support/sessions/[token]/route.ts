import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return new NextResponse(`<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><title>Support session retired</title>
    </head><body><main><h1>Support session retired</h1>
    <p>One-time support login links are no longer available. Sign in with your named account.
    A verified workspace owner must grant support access.</p>
    <a href="/support">Support sign in</a></main></body></html>`, {
    status: 410,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export const POST = GET;
