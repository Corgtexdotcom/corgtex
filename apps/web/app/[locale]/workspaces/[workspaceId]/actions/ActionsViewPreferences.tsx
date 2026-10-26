"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ACTION_VIEW_KEYS, actionsViewStorageKey, restoredActionsView } from "./view-preferences";

export function ActionsViewPreferences({ userId, workspaceId, href, children }: {
  userId: string | null;
  workspaceId: string;
  href: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const [ready, setReady] = useState<string | null>(null);
  const snapshot = JSON.stringify([userId, workspaceId, href, search]);

  useEffect(() => {
    if (userId) {
      try {
        const key = actionsViewStorageKey(userId, workspaceId);
        const restored = restoredActionsView(workspaceId, search, window.localStorage.getItem(key));
        if (restored && restored !== href) {
          const query = new URL(restored, window.location.origin).searchParams;
          // Keep transient feedback (e.g. versionConflict) on this visit only.
          new URLSearchParams(search).forEach((value, key) => {
            if (!ACTION_VIEW_KEYS.has(key)) query.append(key, value);
          });
          router.replace(`${pathname}?${query}`, { scroll: false });
          return;
        }
        window.localStorage.setItem(key, href);
      } catch {
        // Storage may be disabled/full. Ordinary URL navigation still works.
      }
    }
    setReady(snapshot);
  }, [userId, workspaceId, href, search, pathname, router, snapshot]);

  return <div hidden={ready !== snapshot}>{children}</div>;
}
