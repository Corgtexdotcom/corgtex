"use client";

import { useLinkStatus } from "next/link";

export function WorkspaceLinkStatus({ slug, openingLabel }: { slug: string; openingLabel: string }) {
  const { pending } = useLinkStatus();
  return (
    <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 2 }} role="status">
      {pending ? openingLabel : slug}
    </span>
  );
}
